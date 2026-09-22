/** init VPS 编排 + 验证探针（spec §4.2，Task 12；verifyVps 由 Task 20 doctor 复用）。
 *
 *  编排顺序：connect → 上传 node-init 资产 → 带 env 执行 init-node.sh → 上传 PWA +
 *  写 /opt/p2p-net/pwa/config.json → 刷新 /opt/p2p-net/ 隧道入口 → systemctl restart
 *  p2p-net-tunnel caddy coturn → 四层验证（config.json 200+字段齐、/ 200、TLS 证书剩余
 *  天数 > 0、隧道无 token 探针 401=alive）。失败即停，错误带安全组 443/3478 放行提示。
 *
 *  凭据纪律（与 ssh.ts/supabase.ts 同一标准）：
 *  - TURN_SECRET/TUNNEL_SECRET/SSH 密码只允许出现在 exec 命令串（SSH 对端进程 env）里，
 *    绝不进日志行与错误消息；远端 stderr/stdout 摘要进 InitError 前一律先按三 secret 脱敏。
 *  - 日志只记 layer='vps' + 步骤名 + ip/路径/探针结果等安全 ctx。
 *
 *  隧道探针为什么不能用 fetch：fetch 规范禁发 Upgrade/Connection 头，plain GET
 *  /tunnel/desktop 落在 relay httpHandler 上只会 404；401 是 upgrade 鉴权门的回答，
 *  必须用 node:https 裸发 WS 握手才拿得到（实测：plain GET=404，upgrade=401）。
 */

import { randomBytes } from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import type { Logger } from '../../log/logger.js';
import { SshRunner, type VpsCreds } from './ssh.js';
import { InitError } from './supabase.js';

/** SshRunner 的最小结构面（测试注入 seam；生产默认 SshRunner.connect）。 */
export interface SshRunnerLike {
  exec(cmd: string): Promise<{ code: number; stdout: string; stderr: string }>;
  putDir(localDir: string, remoteDir: string): Promise<void>;
  end(): void;
}

export interface ProvisionVpsOpts {
  turnSecret: string;
  tunnelSecret: string;
  pwaDistDir: string;
  supabaseUrl: string;
  publishableKey: string;
}

/** 验证探针注入 seam（生产全部走真实网络实现）。 */
export interface VerifyDeps {
  fetchImpl?: typeof fetch;
  /** 测 <host>:443 对端证书剩余天数；失败由 verifyVps 收成 -1。默认 node:tls 实测。 */
  certDaysLeftProbe?: (host: string, timeoutMs: number) => Promise<number>;
  /** 对 https://<host>/tunnel/desktop?sid=probe 发无 token 的 WS upgrade 握手，返回 HTTP 状态。默认 node:https 实测。 */
  tunnelStatusProbe?: (host: string, timeoutMs: number) => Promise<number>;
}

export interface ProvisionDeps extends VerifyDeps {
  connectRunner?: (creds: VpsCreds) => Promise<SshRunnerLike>;
}

export interface VpsVerifyResult {
  httpsOk: boolean;
  certDaysLeft: number;
  tunnelAlive: boolean;
}

/** 包内 dist/cli/init → <pkg>/node-init，源码态 src/cli/init → 仓库 node-init（同 supabase.ts DDL_FILE 先例）。 */
const NODE_INIT_DIR_URL = new URL('../../../node-init/', import.meta.url);
const REMOTE_INIT_DIR = '/opt/p2p-net-init';
const REMOTE_APP_DIR = '/opt/p2p-net';
const REMOTE_PWA_DIR = '/opt/p2p-net/pwa';
const RESTART_CMD = 'systemctl restart p2p-net-tunnel caddy coturn';
const PROBE_TIMEOUT_MS = 10_000;
const ERR_EXCERPT_LEN = 200;
const SECURITY_HINT = '请确认云厂商安全组/防火墙已放行 443/tcp 与 3478（tcp+udp），然后重跑 init';

/** 写入 VPS /config.json 的渲染器（与 pwa/src/config.ts RuntimeConfig 逐字段对齐）。 */
export function renderConfigJson(cfg: { supabaseUrl: string; publishableKey: string; ip: string }): string {
  return JSON.stringify(
    { supabaseUrl: cfg.supabaseUrl, publishableKey: cfg.publishableKey, relays: [{ url: `https://${cfg.ip}` }] },
    null,
    2,
  ) + '\n';
}

export async function provisionVps(
  creds: VpsCreds,
  opts: ProvisionVpsOpts,
  log: Logger,
  deps: ProvisionDeps = {},
): Promise<{ ip: string; pwaUrl: string }> {
  const connectRunner = deps.connectRunner ?? ((c: VpsCreds) => SshRunner.connect(c));
  const ip = creds.host;
  const secrets = [creds.password, opts.turnSecret, opts.tunnelSecret];
  log.info('vps', '开始 VPS 初始化', { ip });

  const runner = await stepGuard('connect', '无法 SSH 连接 VPS', secrets, () => connectRunner(creds));
  try {
    // init-node.sh 需要 SCRIPT_DIR 下的 tunnel-relay-entry.mjs，故整目录上传到独立暂存目录
    // （不能直接放 /opt/p2p-net/：install 会撞同文件报错）
    await stepGuard('pushNodeInit', '上传初始化资产失败', secrets, async () => {
      log.info('vps', '上传 node-init 资产', { ip, remoteDir: REMOTE_INIT_DIR });
      await runner.putDir(fileURLToPath(NODE_INIT_DIR_URL), REMOTE_INIT_DIR);
    });

    await stepGuard(
      'initScript',
      `VPS 初始化脚本执行失败，可登录 VPS 手动执行 bash ${REMOTE_INIT_DIR}/init-node.sh 排查；若服务起不来或外网不可达，${SECURITY_HINT}`,
      secrets,
      async () => {
        log.info('vps', '执行 init-node.sh（coturn+caddy+隧道，env 注入密钥）', { ip });
        // secret 只进命令串（对端进程 env）；本模块与 ssh.ts 都不记录命令内容
        const cmd = `TURN_SECRET=${shq(opts.turnSecret)} TUNNEL_SECRET=${shq(opts.tunnelSecret)} bash ${REMOTE_INIT_DIR}/init-node.sh`;
        const r = await runner.exec(cmd);
        if (r.code !== 0) throw new Error(`退出码 ${r.code}：${scrub(r.stderr || r.stdout, secrets)}`);
      },
    );

    await stepGuard('uploadPwa', '上传 PWA 静态资产失败', secrets, async () => {
      log.info('vps', '上传 PWA 静态资产', { ip, remoteDir: REMOTE_PWA_DIR });
      await runner.putDir(opts.pwaDistDir, REMOTE_PWA_DIR);
    });

    await stepGuard('writeConfig', `写入 ${REMOTE_PWA_DIR}/config.json 失败`, secrets, async () => {
      log.info('vps', '写入 config.json（supabaseUrl/publishableKey/relays）', { ip });
      // base64 中转避免一切 shell 引号问题；config.json 只含公开字段，无 secret
      const b64 = Buffer.from(renderConfigJson({ supabaseUrl: opts.supabaseUrl, publishableKey: opts.publishableKey, ip }), 'utf8').toString('base64');
      const r = await runner.exec(`printf %s ${shq(b64)} | base64 -d > ${REMOTE_PWA_DIR}/config.json`);
      if (r.code !== 0) throw new Error(`退出码 ${r.code}：${scrub(r.stderr, secrets)}`);
    });

    // putDir 以目录为粒度：整目录上传即刷新隧道入口 tunnel-relay-entry.mjs（init-node.sh 附带，无害）
    await stepGuard('pushTunnelEntry', '上传隧道入口失败', secrets, async () => {
      log.info('vps', '刷新隧道入口 tunnel-relay-entry.mjs', { ip, remoteDir: REMOTE_APP_DIR });
      await runner.putDir(fileURLToPath(NODE_INIT_DIR_URL), REMOTE_APP_DIR);
    });

    await stepGuard(
      'restartServices',
      `重启服务失败，可登录 VPS 执行 journalctl -u p2p-net-tunnel -u caddy -u coturn 排查；若服务正常但外网不可达，${SECURITY_HINT}`,
      secrets,
      async () => {
        log.info('vps', '重启 p2p-net-tunnel/caddy/coturn', { ip });
        const r = await runner.exec(RESTART_CMD);
        if (r.code !== 0) throw new Error(`退出码 ${r.code}：${scrub(r.stderr || r.stdout, secrets)}`);
      },
    );
  } finally {
    runner.end();
  }

  log.info('vps', '运行四层验证探针', { ip });
  const v = await verifyVps(ip, deps);
  log.info('vps', '验证探针结果', { ip, httpsOk: v.httpsOk, certDaysLeft: v.certDaysLeft, tunnelAlive: v.tunnelAlive });
  if (!v.httpsOk || v.certDaysLeft <= 0 || !v.tunnelAlive) {
    throw new InitError(
      'verify',
      `VPS 验证未通过（httpsOk=${v.httpsOk} certDaysLeft=${v.certDaysLeft} tunnelAlive=${v.tunnelAlive}）：${SECURITY_HINT}`,
    );
  }

  const pwaUrl = `https://${ip}`;
  log.info('vps', 'VPS 初始化完成', { ip, pwaUrl });
  return { ip, pwaUrl };
}

/** 四层探针：config.json 200+字段齐、/ 200 → httpsOk；TLS 剩余天数（失败=-1）；隧道无 token 401=alive。
 *  单探针失败只体现在返回值，不抛错（doctor 要拿部分绿的结果出报告）。 */
export async function verifyVps(ip: string, deps: VerifyDeps = {}): Promise<VpsVerifyResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const certProbe = deps.certDaysLeftProbe ?? probeCertDaysLeft;
  const tunnelProbe = deps.tunnelStatusProbe ?? probeTunnelStatus;

  const configOk = await probeConfigJson(fetchImpl, ip).catch(() => false);
  const rootOk = await probeRoot(fetchImpl, ip).catch(() => false);
  const certDaysLeft = await certProbe(ip, PROBE_TIMEOUT_MS).catch(() => -1);
  const tunnelStatus = await tunnelProbe(ip, PROBE_TIMEOUT_MS).catch(() => 0);
  return { httpsOk: configOk && rootOk, certDaysLeft, tunnelAlive: tunnelStatus === 401 };
}

async function probeConfigJson(fetchImpl: typeof fetch, ip: string): Promise<boolean> {
  const res = await fetchImpl(`https://${ip}/config.json`, { cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!res.ok) return false;
  const j: unknown = await res.json();
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return false;
  const o = j as Record<string, unknown>;
  const relays = o.relays;
  return (
    typeof o.supabaseUrl === 'string' &&
    o.supabaseUrl !== '' &&
    typeof o.publishableKey === 'string' &&
    o.publishableKey !== '' &&
    Array.isArray(relays) &&
    relays.length > 0 &&
    relays.every((r) => typeof (r as { url?: unknown })?.url === 'string' && (r as { url: string }).url !== '')
  );
}

async function probeRoot(fetchImpl: typeof fetch, ip: string): Promise<boolean> {
  const res = await fetchImpl(`https://${ip}/`, { cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  await res.arrayBuffer(); // 排空 body，连接可复用
  return res.ok;
}

/** node:tls 直连 <host>:443 读对端证书有效期（LE shortlived IP 证书须公开可信，默认校验开启）。 */
function probeCertDaysLeft(host: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host }, () => {
      const validTo = socket.getPeerCertificate()?.valid_to;
      socket.end();
      if (typeof validTo !== 'string' || !validTo) {
        reject(new Error('对端未提供证书'));
        return;
      }
      resolve(Math.floor((Date.parse(validTo) - Date.now()) / 86_400_000));
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`TLS 探测 ${timeoutMs}ms 超时`)));
    socket.once('error', reject);
  });
}

/** 无 token WS 握手探针：401 = relay 鉴权门在应答 = 服务活着；101/404/超时均为不活。 */
function probeTunnelStatus(host: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        port: 443,
        path: '/tunnel/desktop?sid=probe',
        method: 'GET',
        headers: {
          connection: 'upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': randomBytes(16).toString('base64'),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('upgrade', () => resolve(101)); // 无 token 不会到这里；防御性兜底
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`隧道探测 ${timeoutMs}ms 超时`)));
    req.once('error', reject);
    req.end();
  });
}

/** 单步执行 + 统一包装：任何底层错误都收成带修复建议的 InitError；摘要进消息前先按 secret 脱敏。 */
async function stepGuard<T>(stepName: string, hint: string, secrets: string[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InitError) throw e;
    const why = scrub(e instanceof Error ? e.message : String(e), secrets).slice(0, ERR_EXCERPT_LEN);
    throw new InitError(stepName, `${hint}（原因：${why}）`, e);
  }
}

/** POSIX 单引号包裹（内嵌单引号转义）：secret 经 env 赋值进命令串时防注入。 */
function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** 与 ssh.ts 同款脱敏：secret 串一旦出现在摘要里，替换为 ******。 */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('******');
  return out;
}
