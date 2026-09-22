/** init 总编排（Task 13）：parseVpsSpec 录入 VPS 列表 → 生成全部署统一密钥 → 收集 Supabase
 *  凭据 → bootstrapSupabase → 逐台 provisionVps（串行，失败即停）→ saveConfig → 打印安全组
 *  清单 + `p2p-net service install` 建议。
 *
 *  断点续跑（plan 裁决语义：重生成 → 重推 → 幂等重开，不做跳过）：
 *  - init-state.json 记录 {supabaseDone, projectRef, vpsDone}（projectRef 非秘密，0600），绝无密钥；
 *  - 续跑时密钥全部重新生成，凭 state.projectRef 仅重收 Access Token 重推 setSecrets(turnSecret)
 *    （project 不再新建）；state 缺 projectRef（旧版/残缺）则回退完整 bootstrapSupabase（幂等）；
 *  - 随后幂等重开列表内全部 VPS（init-node.sh 重渲配置并重启），并重写 config.json（含新 tunnelSecret）——
 *    保证 Supabase、每台 VPS、本地 config 三处的 turnSecret/tunnelSecret 永远同属一轮。
 *
 *  秘密纪律（与 supabase.ts/vps.ts/ssh.ts 同一标准）：
 *  - turnSecret 每次运行 randomBytes 现生成，只存内存并写入 Supabase/VPS，绝不落本地盘、不进日志/stdout；
 *  - tunnelSecret 写入 VPS 隧道与本地 0600 config.json（plan 裁决的 start 运行时凭证），不进日志/stdout；
 *  - Supabase Access Token / 管理员密码 / VPS 密码只进 prompt 答案与对应编排器入参，绝不落盘；
 *  - VPS 失败重包装前对错误文本按全部在册秘密脱敏，防御下游漏脱敏。
 *
 *  全注入可测：mgmt/runnerFactory/promptFn/log + fetchImpl/验证探针/configDir/pwaDistDir/out
 *  全部可注入，测试零真实网络/ssh/readline。生产路径全部走默认值。
 */

import { randomBytes } from 'node:crypto';
import { existsSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { PORTS } from '../contracts.js';
import { createLogger, type Logger } from '../log/logger.js';
import { loadConfig, saveConfig } from '../server/store.js';
import { SupabaseMgmt } from './init/mgmt.js';
import { prompt } from './init/prompt.js';
import { parseVpsSpec, SshRunner, type VpsCreds } from './init/ssh.js';
import { bootstrapSupabase, InitError } from './init/supabase.js';
import { provisionVps, type SshRunnerLike } from './init/vps.js';

/** 交互提问 seam：生产默认 readline + prompt()；测试注入脚本化回答。 */
export type PromptFn = (question: string, opts?: { secret?: boolean }) => Promise<string>;

export interface RunInitDeps {
  /** Supabase Management API client（→ bootstrapSupabase）。 */
  mgmt?: SupabaseMgmt;
  /** SSH runner 工厂（→ provisionVps 的 connectRunner）。 */
  runnerFactory?: (creds: VpsCreds) => Promise<SshRunnerLike>;
  promptFn?: PromptFn;
  log?: Logger;
  /** Supabase 数据面/认证面与 VPS HTTP 探针的 fetch（→ bootstrapSupabase / provisionVps）。 */
  fetchImpl?: typeof fetch;
  /** 以下两个探针 → provisionVps 验证层；生产默认真实 TLS/HTTPS 探测。 */
  certDaysLeftProbe?: (host: string, timeoutMs: number) => Promise<number>;
  tunnelStatusProbe?: (host: string, timeoutMs: number) => Promise<number>;
  /** 配置目录（config.json / init-state.json / 日志），默认 ~/.p2p-net。 */
  configDir?: string;
  /** PWA 构建产物目录，默认包内 pwa-dist/。 */
  pwaDistDir?: string;
  /** 面向用户的 stdout 输出行 seam（清单/结果/下一步建议），默认 console.log。 */
  out?: (line: string) => void;
}

/** init-state.json 的形状：完成阶段 + projectRef（非秘密，续跑重推 secrets 所需），绝无密钥。 */
interface InitState {
  supabaseDone: boolean;
  vpsDone: string[];
  projectRef?: string;
}

const STATE_FILE = 'init-state.json';
/** 包内 dist/cli → <pkg>/pwa-dist，源码态 src/cli → 仓库 pwa-dist（同 supabase.ts/vps.ts 的资产寻址先例）。 */
const DEFAULT_PWA_DIST_DIR = fileURLToPath(new URL('../../pwa-dist/', import.meta.url));

export async function runInit(deps: RunInitDeps = {}): Promise<void> {
  const dir = deps.configDir ?? join(homedir(), '.p2p-net');
  const log = deps.log ?? createLogger({ dir: join(dir, 'logs'), comp: 'cli-init' });
  const out = deps.out ?? ((line: string) => console.log(line));

  // 未注入 promptFn 时自建 readline（生产交互路径）；注入路径不碰 stdio
  const rl = deps.promptFn ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask: PromptFn = deps.promptFn ?? ((q, o) => prompt(rl!, q, o));
  try {
    // 1) 逐行录入 VPS 列表（密码段在同一行，整行 secret 不回显）
    out('请逐台输入 VPS（格式：user@ip 密码，密码可含空格），空行结束：');
    const vpsList: VpsCreds[] = [];
    for (let n = 1; ; n++) {
      const line = (await ask(`VPS #${n}: `, { secret: true })).trim();
      if (!line) break;
      vpsList.push(parseVpsSpec(line, n));
    }
    if (vpsList.length === 0) {
      throw new InitError('input', '至少需要一台 VPS：请按 "user@ip 密码" 格式输入后重跑 p2p-net init');
    }
    const ips = vpsList.map((v) => v.host);
    log.info('vps', 'VPS 列表录入完成', { count: vpsList.length, ips });

    const state = readState(dir);

    // 2) 生成全部署统一密钥（每轮重新生成；重推+幂等重开保证三处同轮，无漂移）
    const turnSecret = randomBytes(32).toString('hex');
    const tunnelSecret = randomBytes(32).toString('hex');

    // 3)+4) Supabase 阶段：全新 → 完整 bootstrap；续跑有 projectRef → 仅重收 token 重推 secrets；
    //       state 缺 projectRef（旧版/残缺）→ 回退完整 bootstrap（幂等）
    const runBootstrap = async (): Promise<{ supabaseUrl: string; publishableKey: string }> => {
      const token = await ask('Supabase Access Token（supabase.com → Account → Access Tokens）: ', { secret: true });
      const projectRef = (await ask('Supabase projectRef（留空自动新建）: ')).trim() || undefined;
      const region = (await ask('新建 project 的 region（留空默认 ap-southeast-1）: ')).trim() || undefined;
      const adminEmail = (await ask('首个账号邮箱: ')).trim();
      const adminPassword = await ask('首个账号密码: ', { secret: true });
      const r = await bootstrapSupabase(
        { token, projectRef, region, adminEmail, adminPassword, turnSecret, turnHosts: ips, log },
        { mgmt: deps.mgmt, fetchImpl: deps.fetchImpl },
      );
      state.supabaseDone = true;
      state.projectRef = r.projectRef;
      writeState(dir, state);
      // 尽早落 config（relays 先记已完成的）：Supabase 成功后、VPS 失败也能凭 state+config 续跑
      saveConfig(dir, { supabaseUrl: r.supabaseUrl, publishableKey: r.publishableKey, tunnelSecret, relays: state.vpsDone.map((ip) => ({ ip })) });
      return { supabaseUrl: r.supabaseUrl, publishableKey: r.publishableKey };
    };
    let supabaseUrl: string;
    let publishableKey: string;
    if (!state.supabaseDone) {
      ({ supabaseUrl, publishableKey } = await runBootstrap());
    } else if (state.projectRef) {
      if (!existsSync(join(dir, 'config.json'))) {
        throw new InitError(
          'resume',
          `init-state 显示 Supabase 阶段已完成，但 ${join(dir, 'config.json')} 缺失：` +
            `请删除 ${join(dir, STATE_FILE)} 后重跑 p2p-net init`,
        );
      }
      const cfg = loadConfig(dir);
      supabaseUrl = cfg.supabaseUrl;
      publishableKey = cfg.publishableKey;
      // 新 turnSecret 必须送达 Supabase：重收 token（不落盘）重推 secrets；project 不新建
      const token = await ask('Supabase Access Token（续跑需重推 TURN secrets，不落盘）: ', { secret: true });
      const mgmt = deps.mgmt ?? new SupabaseMgmt(token);
      try {
        log.info('supabase', '断点续跑：重推 TURN secrets（本轮新 turnSecret）', {
          projectRef: state.projectRef,
          turnHostCount: ips.length,
        });
        await mgmt.setSecrets(state.projectRef, {
          TURN_STATIC_AUTH_SECRET: turnSecret,
          TURN_HOSTS: JSON.stringify(ips),
        });
      } catch (e) {
        const why = scrub(e instanceof Error ? e.message : String(e), [token, turnSecret]);
        throw new InitError(
          'setSecrets',
          `secrets 重推失败，请到控制台 Edge Functions → Secrets 手动设置 TURN_STATIC_AUTH_SECRET 与 TURN_HOSTS 后重跑 init（原因：${why}）`,
          e,
        );
      }
      // 立即用本轮 tunnelSecret 重写 config，缩小密钥漂移窗口
      saveConfig(dir, { supabaseUrl, publishableKey, tunnelSecret, relays: state.vpsDone.map((ip) => ({ ip })) });
    } else {
      log.warn('supabase', 'init-state 缺 projectRef，回退完整 Supabase 引导（幂等）');
      ({ supabaseUrl, publishableKey } = await runBootstrap());
    }

    // 5) 逐台 provisionVps（串行；幂等重开全部 VPS——新密钥必须送达每台；失败即停并重包装带安全组清单）
    for (const creds of vpsList) {
      try {
        await provisionVps(
          creds,
          {
            turnSecret,
            tunnelSecret,
            pwaDistDir: deps.pwaDistDir ?? DEFAULT_PWA_DIST_DIR,
            supabaseUrl,
            publishableKey,
          },
          log,
          {
            connectRunner: deps.runnerFactory ?? ((c: VpsCreds) => SshRunner.connect(c)),
            fetchImpl: deps.fetchImpl,
            certDaysLeftProbe: deps.certDaysLeftProbe,
            tunnelStatusProbe: deps.tunnelStatusProbe,
          },
        );
      } catch (e) {
        const why = scrub(e instanceof Error ? e.message : String(e), [creds.password, turnSecret, tunnelSecret]);
        throw new InitError(
          `vps:${creds.host}`,
          `VPS ${creds.host} 初始化失败，已停止后续 VPS（重跑 p2p-net init 即可续跑：secrets 会重新生成并全量重推，VPS 幂等重开）。\n` +
            `请按下方清单复核该 VPS 的云厂商安全组/防火墙后重跑 p2p-net init：\n${securityChecklist()}\n（原因：${why}）`,
          e,
        );
      }
      if (!state.vpsDone.includes(creds.host)) state.vpsDone.push(creds.host);
      writeState(dir, state);
      saveConfig(dir, { supabaseUrl, publishableKey, tunnelSecret, relays: state.vpsDone.map((ip) => ({ ip })) });
    }

    // 6) 收尾输出：结果 + 安全组清单 + 下一步建议
    out('');
    out('p2p-net init 完成。');
    out(`Supabase: ${supabaseUrl}`);
    for (const ip of state.vpsDone) out(`PWA: https://${ip}`);
    out('');
    out('请确认每台 VPS 的云厂商安全组/防火墙已按清单放行：');
    out(securityChecklist());
    out('');
    out('下一步：先 p2p-net login 登录，再 p2p-net start 前台验证跑通；确认好用后 p2p-net service install 安装常驻服务（缺登录态的服务会启动即退、反复重启）。');
    log.info('vps', 'init 全部完成', { relays: state.vpsDone });
  } finally {
    rl?.close();
  }
}

/** 安全组清单：端口值与 node-init/init-node.sh 对齐；隧道 relay 端口取自 PORTS 契约（仅 loopback）。 */
function securityChecklist(): string {
  return [
    '  - 22/tcp            SSH（init 完成后建议收紧为你的办公 IP）',
    '  - 80/tcp            HTTP（证书签发 + 跳转 HTTPS）',
    `  - 443/tcp           HTTPS（PWA + 隧道；隧道 relay 仅监听 127.0.0.1:${PORTS.TUNNEL_RELAY_PORT}，无需放行）`,
    '  - 3478/tcp + udp    TURN/STUN',
    '  - 50000-50019/udp   TURN relay 端口段',
  ].join('\n');
}

function readState(dir: string): InitState {
  const p = join(dir, STATE_FILE);
  if (!existsSync(p)) return { supabaseDone: false, vpsDone: [] };
  try {
    const o = JSON.parse(readFileSync(p, 'utf8')) as Partial<InitState>;
    return {
      supabaseDone: o.supabaseDone === true,
      vpsDone: Array.isArray(o.vpsDone) ? o.vpsDone.filter((x): x is string => typeof x === 'string') : [],
      ...(typeof o.projectRef === 'string' && o.projectRef ? { projectRef: o.projectRef } : {}),
    };
  } catch {
    // 损坏的 state 按"全部未完成"处理：各阶段幂等，重做安全
    return { supabaseDone: false, vpsDone: [] };
  }
}

/** 0600 原子写（与 store.ts 同一模式；state 非公开接口，就近私有实现）。 */
function writeState(dir: string, state: InitState): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, STATE_FILE);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

/** 防御性脱敏：下游错误文本若万一含在册秘密，进 InitError 消息前抹掉。 */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('******');
  return out;
}
