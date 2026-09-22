/** init 总编排（Task 13）：parseVpsSpec 录入 VPS 列表 → 生成全部署统一密钥 → 收集 Supabase
 *  凭据 → bootstrapSupabase → 逐台 provisionVps（串行，失败即停）→ saveConfig → 打印安全组
 *  清单 + `p2p-net service install` 建议。
 *
 *  断点续跑：init-state.json 只记录完成阶段（{supabaseDone, vpsDone}），绝不含任何秘密。
 *  已完成阶段自动跳过；Supabase 阶段完成后 supabaseUrl/publishableKey 从 config.json 读回。
 *
 *  秘密纪律（与 supabase.ts/vps.ts/ssh.ts 同一标准）：
 *  - turnSecret/tunnelSecret 每次运行 randomBytes 现生成，只存内存，经编排器写入 VPS/Supabase，
 *    绝不落本地盘、不进日志/stdout/错误消息（续跑没有旧密钥可用，只能重新生成——见报告说明）；
 *  - Supabase Access Token / 管理员密码 / VPS 密码只进 prompt 答案与对应编排器入参；
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
import type { SupabaseMgmt } from './init/mgmt.js';
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

/** init-state.json 的形状：只记录完成阶段，绝无秘密。 */
interface InitState {
  supabaseDone: boolean;
  vpsDone: string[];
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

    // 2) 生成全部署统一密钥：只存内存，交编排器写入 VPS/Supabase，不落本地盘
    const turnSecret = randomBytes(32).toString('hex');
    const tunnelSecret = randomBytes(32).toString('hex');

    // 3)+4) Supabase 引导（已完成则跳过，从 config.json 读回公开字段）
    let supabaseUrl: string;
    let publishableKey: string;
    if (state.supabaseDone) {
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
      log.info('supabase', '断点续跑：跳过 Supabase 引导', { supabaseUrl });
    } else {
      const token = await ask('Supabase Access Token（supabase.com → Account → Access Tokens）: ', { secret: true });
      const projectRef = (await ask('Supabase projectRef（留空自动新建）: ')).trim() || undefined;
      const region = (await ask('新建 project 的 region（留空默认 ap-southeast-1）: ')).trim() || undefined;
      const adminEmail = (await ask('首个账号邮箱: ')).trim();
      const adminPassword = await ask('首个账号密码: ', { secret: true });
      const r = await bootstrapSupabase(
        { token, projectRef, region, adminEmail, adminPassword, turnSecret, turnHosts: ips, log },
        { mgmt: deps.mgmt, fetchImpl: deps.fetchImpl },
      );
      supabaseUrl = r.supabaseUrl;
      publishableKey = r.publishableKey;
      state.supabaseDone = true;
      writeState(dir, state);
      // 尽早落 config（relays 先记已完成的）：Supabase 成功后、VPS 失败也能凭 state+config 续跑
      saveConfig(dir, { supabaseUrl, publishableKey, relays: state.vpsDone.map((ip) => ({ ip })) });
    }

    // 5) 逐台 provisionVps（串行；失败即停并重包装带安全组清单）
    for (const creds of vpsList) {
      if (state.vpsDone.includes(creds.host)) {
        log.info('vps', '断点续跑：跳过已完成 VPS', { ip: creds.host });
        continue;
      }
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
          `VPS ${creds.host} 初始化失败，已停止后续 VPS（已完成的阶段重跑时会自动跳过）。\n` +
            `请按下方清单复核该 VPS 的云厂商安全组/防火墙后重跑 p2p-net init：\n${securityChecklist()}\n（原因：${why}）`,
          e,
        );
      }
      state.vpsDone.push(creds.host);
      writeState(dir, state);
      saveConfig(dir, { supabaseUrl, publishableKey, relays: state.vpsDone.map((ip) => ({ ip })) });
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
    out('下一步：运行 p2p-net service install 安装常驻服务，然后 p2p-net login 登录。');
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
