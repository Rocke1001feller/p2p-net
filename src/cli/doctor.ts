/** p2p-net doctor（Task 20）：七层归因探针，顺序与连接级联同序：
 *  auth → supabase → signaling → ice(TURN) → vps（每 relay）→ scanner → service。
 *
 *  裁决语义（Controller rulings）：
 *  - 只诊断不修复：全部探针只读，唯一例外是 signaling 自发自收——写自己房间
 *    sig:<uid>:doctor（30s TTL 自行过期 + purgeExpired 尽力清场）；
 *  - 首败不阻断：每层独立归因，失败后继续跑完剩余层收集完整报告；CLI 退出码=失败数；
 *  - 依赖标注：auth 层不过时，依赖 cfg/auth 的层标 ok=false + detail『依赖 auth 层通过』，
 *    不层层刷 401 红鲱鱼；vps 探针无鉴权只依赖 cfg——auth 挂、配置在时仍实跑；
 *  - 续期一次性：doctor 每次运行都是新进程，refresh 失败即归因（AuthError 文案已含
 *    p2p-net login），绝不循环重试；refresh rotation 成功时持久化新凭据（同 start.ts）；
 *  - 凭据纪律：detail/fix 绝不含 accessToken/refreshToken/tunnelSecret（uid/email/ip 可以）；
 *  - 全注入可测：loadConfig/loadAuth/saveAuth/ensureFreshToken/fetch/signalingFactory/
 *    verifyVps/tcpConnect/scannerFactory/serviceStatus 全经 deps，测试零真实网络/OS。
 */

import { existsSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { PORTS } from '../contracts.js';
import type { Layer, Logger } from '../log/logger.js';
import { ensureFreshToken, type AuthState } from '../server/auth.js';
import { createScanner, SCANNER_ENUM_FAILED_CODE, type Scanner } from '../server/scanner.js';
import { loadAuth, loadConfig, saveAuth, type AppConfig } from '../server/store.js';
import { SignalingClient, type PollResult, type SignalingClientOptions } from '../signaling/client.js';
import { roomFor, type SigMessage } from '../signaling/protocol.js';
import { verifyVps, type VpsVerifyResult } from './init/vps.js';
import { ServiceError, serviceStatus, type ServiceStatus } from './service.js';

// ---------- 产出契约 ----------

export interface DoctorCheck {
  layer: Layer;
  ok: boolean;
  detail: string;
  fix?: string;
}

// ---------- 注入面 ----------

/** SignalingClient 的最小结构面（测试注入 seam）。 */
export interface SignalingLike {
  send(room: string, sender: string, msg: SigMessage, kind?: 'sig' | 'data', ttlSeconds?: number): Promise<void>;
  poll(room: string, cursor: number): Promise<PollResult>;
  purgeExpired(room: string): Promise<void>;
}

export interface DoctorDeps {
  /** fetch 也可经 opts.fetchImpl 传入（brief 钉死）；两处都给时 opts 优先。 */
  fetchImpl?: typeof fetch;
  loadConfigFn?: typeof loadConfig;
  loadAuthFn?: typeof loadAuth;
  saveAuthFn?: typeof saveAuth;
  ensureFreshTokenFn?: typeof ensureFreshToken;
  signalingFactory?: (opts: SignalingClientOptions) => SignalingLike;
  /** 默认包一层 verifyVps（带 fetchImpl 与证书/隧道探针透传）。 */
  verifyVpsFn?: (ip: string) => Promise<VpsVerifyResult>;
  certDaysLeftProbe?: (host: string, timeoutMs: number) => Promise<number>;
  tunnelStatusProbe?: (host: string, timeoutMs: number) => Promise<number>;
  /** TURN 3478 TCP 探活（默认 node:net 实测，成功即 destroy 不留句柄）。 */
  tcpConnect?: (host: string, port: number, timeoutMs: number) => Promise<void>;
  scannerFactory?: (opts: { log: Logger }) => Scanner;
  serviceStatusFn?: (opts: { configDir: string }) => Promise<ServiceStatus>;
  /** 探针节奏（测试注入小值；生产默认见各常量）。 */
  requestTimeoutMs?: number;
  signalPollMs?: number;
  signalTimeoutMs?: number;
  scannerWaitMs?: number;
  tcpTimeoutMs?: number;
}

export interface RunDoctorOpts {
  /** 配置目录（config.json/auth.json 所在），CLI 默认 ~/.p2p-net。 */
  dir: string;
  fetchImpl?: typeof fetch;
}

// ---------- 常量 ----------

const TURN_PORT = 3478;
const DOCTOR_DEVICE_ID = 'doctor';
const SIGNAL_TTL_SECONDS = 30;
const REQUEST_TIMEOUT_MS = 10_000;
const SIGNAL_POLL_MS = 800;
const SIGNAL_TIMEOUT_MS = 5_000;
const SCANNER_WAIT_MS = 12_000; // 盖过首轮最坏耗时：枚举工具超时 8s（ENUM_TIMEOUT_MS）+ 探测批次（并发 8、单探 1.2s）
const TCP_TIMEOUT_MS = 3_000;

const RLS_FIX =
  '信令表读写异常：多半是 signaling_messages 的 RLS 策略或表结构问题——重跑 p2p-net init 可幂等重建（含 RLS 策略），或到 Supabase 控制台检查该表策略';
const TURN_FIX =
  'TURN 凭据签发失败：多半是 Edge Function secrets 未生效——到 Supabase 控制台确认 TURN_STATIC_AUTH_SECRET 与 TURN_HOSTS 已配置（或重跑 p2p-net init 幂等重推）';

/** 与 init.ts securityChecklist 逐字同措辞（那里是规范来源；relay 端口取自 PORTS 契约）。 */
function securityChecklist(): string {
  return [
    '  - 22/tcp            SSH（init 完成后建议收紧为你的办公 IP）',
    '  - 80/tcp            HTTP（证书签发 + 跳转 HTTPS）',
    `  - 443/tcp           HTTPS（PWA + 隧道；隧道 relay 仅监听 127.0.0.1:${PORTS.TUNNEL_RELAY_PORT}，无需放行）`,
    '  - 3478/tcp + udp    TURN/STUN',
    '  - 50000-50019/udp   TURN relay 端口段',
  ].join('\n');
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** loadAuth 返回 unknown：校验 AuthState 形态，畸形按未登录处理（同 start.ts asAuthState）。 */
function asAuthState(raw: unknown): AuthState | null {
  const o = raw as Partial<AuthState> | null;
  if (typeof o !== 'object' || o === null) return null;
  if (typeof o.accessToken !== 'string' || !o.accessToken) return null;
  if (typeof o.refreshToken !== 'string' || !o.refreshToken) return null;
  if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) return null;
  if (typeof o.uid !== 'string' || !o.uid) return null;
  if (typeof o.email !== 'string' || !o.email) return null;
  return o as AuthState;
}

/** auth 层不过时依赖层的统一标注（detail 钉死『依赖 auth 层通过』）。 */
function gated(layer: Layer, needs: string): DoctorCheck {
  return {
    layer,
    ok: false,
    detail: `依赖 auth 层通过（${needs}不可用，本层无法独立验证）`,
    fix: '先按 auth 层的修复建议处理，再重跑 p2p-net doctor',
  };
}

// ---------- 各层探针 ----------

interface AuthOutcome {
  check: DoctorCheck;
  cfg?: AppConfig;
  auth?: AuthState;
}

async function checkAuth(dir: string, fetchImpl: typeof fetch, deps: DoctorDeps): Promise<AuthOutcome> {
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const loadAuthFn = deps.loadAuthFn ?? loadAuth;
  const ensureFreshTokenFn = deps.ensureFreshTokenFn ?? ensureFreshToken;

  let cfg: AppConfig;
  try {
    cfg = loadConfigFn(dir);
  } catch (e) {
    // ConfigError message 已是人话（含 p2p-net init 指引），直接作 fix
    return { check: { layer: 'auth', ok: false, detail: '本地配置缺失或损坏', fix: errMsg(e) } };
  }
  let raw: unknown;
  try {
    raw = loadAuthFn(dir);
  } catch (e) {
    // 凭据 JSON 损坏：ConfigError message 已含 p2p-net login 指引
    return { check: { layer: 'auth', ok: false, detail: '登录凭据损坏', fix: errMsg(e) }, cfg };
  }
  const auth0 = asAuthState(raw);
  if (!auth0) {
    return {
      check: { layer: 'auth', ok: false, detail: '未登录（auth.json 缺失或登录态不完整）', fix: '请先运行 p2p-net login 登录' },
      cfg,
    };
  }
  try {
    const auth = await ensureFreshTokenFn(cfg, auth0, { fetchImpl });
    if (auth !== auth0) (deps.saveAuthFn ?? saveAuth)(dir, auth); // refresh rotation：持久化新凭据（同 start.ts）
    return { check: { layer: 'auth', ok: true, detail: `已登录：${auth.email}（uid ${auth.uid}）` }, cfg, auth };
  } catch (e) {
    // AuthError message 已含 p2p-net login 指引；一次性归因，不重试
    return { check: { layer: 'auth', ok: false, detail: '登录态刷新失败', fix: errMsg(e) }, cfg };
  }
}

async function checkSupabase(cfg: AppConfig, auth: AuthState, fetchImpl: typeof fetch, timeoutMs: number): Promise<DoctorCheck> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.supabaseUrl}/rest/v1/devices?limit=0`, {
      headers: { apikey: cfg.publishableKey, authorization: `Bearer ${auth.accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {
      layer: 'supabase',
      ok: false,
      detail: `无法连接 Supabase（${cfg.supabaseUrl}）`,
      fix: '请检查本机网络/DNS 后重跑 p2p-net doctor；若持续失败，确认 config.json 的 supabaseUrl 正确（必要时重跑 p2p-net init）',
    };
  }
  await res.arrayBuffer().catch(() => {}); // 排空 body，连接可复用
  if (!res.ok) {
    return {
      layer: 'supabase',
      ok: false,
      detail: `Supabase REST 返回 HTTP ${res.status}`,
      fix: '请到 supabase.com 控制台确认 project 未暂停/删除，且 config.json 的 supabaseUrl 与 publishableKey 属于同一 project（不一致则重跑 p2p-net init）',
    };
  }
  return { layer: 'supabase', ok: true, detail: 'Supabase REST 可达，数据面鉴权有效' };
}

async function checkSignaling(cfg: AppConfig, auth: AuthState, deps: DoctorDeps): Promise<DoctorCheck> {
  const factory = deps.signalingFactory ?? ((o: SignalingClientOptions) => new SignalingClient(o));
  const client = factory({
    supabaseUrl: cfg.supabaseUrl,
    publishableKey: cfg.publishableKey,
    accessToken: () => auth.accessToken,
  });
  const room = roomFor(auth.uid, DOCTOR_DEVICE_ID);
  const sid = `doctor-${Date.now()}`;
  const pollMs = deps.signalPollMs ?? SIGNAL_POLL_MS;
  const timeoutMs = deps.signalTimeoutMs ?? SIGNAL_TIMEOUT_MS;
  const startedAt = Date.now();
  try {
    await client.send(room, DOCTOR_DEVICE_ID, { type: 'hello', sid }, 'sig', SIGNAL_TTL_SECONDS);
  } catch {
    return { layer: 'signaling', ok: false, detail: `信令写入失败（房间 ${room}）`, fix: RLS_FIX };
  }
  try {
    const deadline = Date.now() + timeoutMs;
    let cursor = 0;
    for (;;) {
      const { msgs, cursor: next } = await client.poll(room, cursor);
      cursor = next;
      if (msgs.some((m) => m.payload?.sid === sid)) {
        return { layer: 'signaling', ok: true, detail: `信令自发自收回环正常（往返 ${Date.now() - startedAt}ms，探针消息 ${SIGNAL_TTL_SECONDS}s TTL 自行过期）` };
      }
      if (Date.now() >= deadline) {
        return { layer: 'signaling', ok: false, detail: `信令写入成功但 ${Math.round(timeoutMs / 1000)}s 内未读回（房间 ${room}）`, fix: RLS_FIX };
      }
      await sleep(pollMs);
    }
  } catch {
    return { layer: 'signaling', ok: false, detail: `信令读回失败（房间 ${room}）`, fix: RLS_FIX };
  } finally {
    await client.purgeExpired(room).catch(() => {}); // 尽力清场；30s TTL 兜底自洁
  }
}

async function checkTurn(cfg: AppConfig, auth: AuthState, fetchImpl: typeof fetch, deps: DoctorDeps): Promise<DoctorCheck> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.supabaseUrl}/functions/v1/turn-credentials`, {
      method: 'POST',
      headers: { apikey: cfg.publishableKey, authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    return {
      layer: 'ice',
      ok: false,
      detail: '无法调用 turn-credentials（网络不通）',
      fix: '请检查本机网络后重跑 p2p-net doctor；若持续失败请确认 Supabase project 在线',
    };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) return { layer: 'ice', ok: false, detail: `turn-credentials 返回 HTTP ${res.status}`, fix: TURN_FIX };
  let iceServers: unknown;
  try {
    iceServers = (JSON.parse(text) as { iceServers?: unknown }).iceServers;
  } catch {
    iceServers = undefined;
  }
  if (!Array.isArray(iceServers) || iceServers.length === 0) {
    return { layer: 'ice', ok: false, detail: 'turn-credentials 响应缺 iceServers 或为空', fix: TURN_FIX };
  }
  if (cfg.relays.length === 0) {
    return { layer: 'ice', ok: true, detail: `TURN 凭据签发正常（iceServers ${iceServers.length} 条）；无 relays 可探` };
  }
  // edge fn 正常 → 逐 relay TCP 3478 探活；部分失败 = ok:false + per-relay 明细
  const tcp = deps.tcpConnect ?? defaultTcpConnect;
  const failed: string[] = [];
  for (const relay of cfg.relays) {
    try {
      await tcp(relay.ip, TURN_PORT, deps.tcpTimeoutMs ?? TCP_TIMEOUT_MS);
    } catch {
      failed.push(relay.ip);
    }
  }
  if (failed.length > 0) {
    return {
      layer: 'ice',
      ok: false,
      detail: `TURN 凭据签发正常（iceServers ${iceServers.length} 条），但 3478/tcp 不可达：${failed.join('、')}`,
      fix: `请登录 ${failed.join('、')} 确认 coturn 在运行（systemctl status coturn），并确认云厂商安全组放行 3478 tcp+udp 与 50000-50019/udp`,
    };
  }
  return { layer: 'ice', ok: true, detail: `TURN 凭据签发正常（iceServers ${iceServers.length} 条），3478/tcp 全部 relay 可达` };
}

/** verifyVps 生产实现从不抛错（部分失败体现在返回值）；注入实现抛错由外层 guard 归因。 */
async function checkVpsOne(ip: string, verifyVpsFn: (ip: string) => Promise<VpsVerifyResult>): Promise<DoctorCheck> {
  const v = await verifyVpsFn(ip);
  const parts = [
    v.httpsOk ? 'HTTPS 通' : 'HTTPS 不通',
    v.certDaysLeft >= 0 ? `证书剩余 ${v.certDaysLeft} 天` : '证书有效期探测失败',
    v.tunnelAlive ? '隧道存活' : '隧道不活',
  ];
  if (!v.httpsOk || !v.tunnelAlive) {
    return {
      layer: 'vps',
      ok: false,
      detail: `${ip}：${parts.join('，')}`,
      fix:
        `请确认该 VPS 云厂商安全组/防火墙已按清单放行，并重跑 p2p-net doctor：\n${securityChecklist()}\n` +
        '若安全组无误，登录该 VPS 查 systemctl status caddy p2p-net-tunnel coturn',
    };
  }
  const warnings: string[] = [];
  if (v.certDaysLeft >= 0 && v.certDaysLeft < 1) {
    warnings.push('⚠ 证书即将到期（剩余不足 1 天；caddy 通常自动续期，请确认 80/443 持续可达）');
  } else if (v.certDaysLeft === -1) {
    warnings.push('⚠ 证书有效期探测失败（可能是瞬时网络问题，HTTPS 本身正常，可重跑 doctor 复测）');
  }
  return { layer: 'vps', ok: true, detail: `${ip}：${parts.join('，')}${warnings.length ? `（${warnings.join('；')}）` : ''}` };
}

function scannerEnumFix(cmd: string | null): string {
  const tool = cmd ?? (process.platform === 'linux' ? 'ss' : 'lsof');
  return `本机监听端口枚举依赖 ${tool}（macOS 自带 lsof；Linux 由 iproute2 提供 ss）：请确认 ${tool} 可用（which ${tool}）后重跑 p2p-net doctor`;
}

async function checkScanner(deps: DoctorDeps): Promise<DoctorCheck> {
  const factory = deps.scannerFactory ?? createScanner;
  // 捕获扫描器告警日志（枚举失败只进 warn 不抛错——scanner 周期兜底语义），用于失败归因
  const records: { level: string; msg: string; ctx?: Record<string, unknown> }[] = [];
  const capture = (level: string) => (_layer: Layer, msg: string, ctx?: Record<string, unknown>) => {
    records.push({ level, msg, ...(ctx ? { ctx } : {}) });
  };
  const sinkLog: Logger = { debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error'), event: () => {}, flush: () => {} };

  let scanner: Scanner;
  try {
    scanner = factory({ log: sinkLog });
  } catch (e) {
    return { layer: 'scanner', ok: false, detail: `扫描器创建失败：${errMsg(e)}`, fix: scannerEnumFix(null) };
  }
  try {
    // start() 立即跑首轮 reconcile（scanner.ts）：等 scanner.ready() 落定（首轮完成的精确信号），
    // 封顶 scannerWaitMs 兜底。旧实现轮询 list() 且关窗 3s < 枚举超时 8s——枚举慢/失败时
    // 会在首轮落地前误判「未发现本地服务」。
    scanner.start();
    await Promise.race([scanner.ready(), sleep(deps.scannerWaitMs ?? SCANNER_WAIT_MS)]);
    const services = scanner.list();
    // 结构化归因（M1）：枚举失败读 warn 的 ctx.code，不抄文案（文案改动不再破坏 doctor 检测）
    const enumFail = records.find((r) => r.level === 'warn' && r.ctx?.code === SCANNER_ENUM_FAILED_CODE);
    if (enumFail) {
      const cmd = typeof enumFail.ctx?.cmd === 'string' ? enumFail.ctx.cmd : null;
      return { layer: 'scanner', ok: false, detail: '无法枚举本机监听端口', fix: scannerEnumFix(cmd) };
    }
    if (services.length === 0) {
      return { layer: 'scanner', ok: true, detail: '未发现本地服务（这是正常的，如果你没在跑 dev server）' };
    }
    const names = services.slice(0, 5).map((s) => `${s.port} ${s.name}`).join('，');
    return { layer: 'scanner', ok: true, detail: `发现 ${services.length} 个本地服务：${names}${services.length > 5 ? '…' : ''}` };
  } catch (e) {
    return { layer: 'scanner', ok: false, detail: `扫描失败：${errMsg(e)}`, fix: scannerEnumFix(null) };
  } finally {
    try {
      scanner.stop(); // 清 10s reconcile 定时器，不留悬挂 handle
    } catch {
      // best-effort
    }
  }
}

async function checkService(dir: string, deps: DoctorDeps): Promise<DoctorCheck> {
  const statusFn = deps.serviceStatusFn ?? ((o: { configDir: string }) => serviceStatus(o));
  let s: ServiceStatus;
  try {
    s = await statusFn({ configDir: dir });
  } catch (e) {
    if (e instanceof ServiceError) {
      // 不支持的平台（win32 等）：Phase 2 规划，不算失败
      return { layer: 'service', ok: true, detail: '该平台暂不支持服务化（Phase 2 规划），跳过' };
    }
    throw e; // 意外错误交给外层 guard 归因
  }
  if (!s.installed) {
    return {
      layer: 'service',
      ok: false,
      detail: '常驻服务未安装',
      fix: 'p2p-net service install 可安装常驻服务（崩溃自愈 + 开机自启）；或先 p2p-net start 前台运行',
    };
  }
  if (!existsSync(s.nodePath)) {
    return {
      layer: 'service',
      ok: false,
      detail: `常驻服务已安装但 node 路径失效：${s.nodePath}（版本管理器切换了默认版本？）`,
      fix: '请重跑 p2p-net service install 重建常驻单元',
    };
  }
  if (!s.running) {
    // lastCrashTail 内容不进 detail（日志原文不属于 doctor 输出契约），只提示存在
    return {
      layer: 'service',
      ok: false,
      detail: `常驻服务已安装但未运行${s.lastCrashTail ? '（日志尾部有记录）' : ''}`,
      fix: 'p2p-net service logs 查看日志定位原因；必要时 p2p-net service uninstall 后重跑 p2p-net service install',
    };
  }
  return { layer: 'service', ok: true, detail: '常驻服务运行中' };
}

/** 默认 TCP 探活：连接成功即 destroy（纯活性探测，不留句柄）；超时/拒连 reject。 */
function defaultTcpConnect(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => {
      socket.destroy();
      resolve();
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`TCP ${host}:${port} ${timeoutMs}ms 超时`)));
    socket.once('error', (e) => {
      socket.destroy();
      reject(e);
    });
  });
}

// ---------- 编排 ----------

export async function runDoctor(opts: RunDoctorOpts, deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const fetchImpl = opts.fetchImpl ?? deps.fetchImpl ?? globalThis.fetch;
  const checks: DoctorCheck[] = [];
  /** 每层独立 guard：探针自身抛错也归因到该层，绝不中断后续层。 */
  const guard = async (layer: Layer, fn: () => Promise<DoctorCheck | DoctorCheck[]>): Promise<void> => {
    try {
      const r = await fn();
      checks.push(...(Array.isArray(r) ? r : [r]));
    } catch (e) {
      checks.push({ layer, ok: false, detail: `探针自身异常（doctor bug）：${errMsg(e)}`, fix: '请携带本输出到项目仓库提 issue' });
    }
  };

  let cfg: AppConfig | undefined;
  let auth: AuthState | undefined;
  await guard('auth', async () => {
    const r = await checkAuth(opts.dir, fetchImpl, deps);
    cfg = r.cfg;
    auth = r.auth;
    return r.check;
  });

  await guard('supabase', async () =>
    cfg && auth ? checkSupabase(cfg, auth, fetchImpl, deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS) : gated('supabase', 'Supabase 地址或用户令牌'),
  );
  await guard('signaling', async () => (cfg && auth ? checkSignaling(cfg, auth, deps) : gated('signaling', '用户令牌')));
  await guard('ice', async () => (cfg && auth ? checkTurn(cfg, auth, fetchImpl, deps) : gated('ice', '用户令牌')));
  await guard('vps', async () => {
    if (!cfg) return gated('vps', 'relays 配置');
    const verifyVpsFn =
      deps.verifyVpsFn ??
      ((ip: string) =>
        verifyVps(ip, {
          fetchImpl,
          ...(deps.certDaysLeftProbe ? { certDaysLeftProbe: deps.certDaysLeftProbe } : {}),
          ...(deps.tunnelStatusProbe ? { tunnelStatusProbe: deps.tunnelStatusProbe } : {}),
        }));
    const out: DoctorCheck[] = [];
    for (const relay of cfg.relays) {
      try {
        out.push(await checkVpsOne(relay.ip, verifyVpsFn));
      } catch (e) {
        // 每 relay 独立归因：一台探针异常不拖垮其余 relay
        out.push({
          layer: 'vps',
          ok: false,
          detail: `${relay.ip}：探针异常（${errMsg(e)}）`,
          fix: `请确认该 VPS 云厂商安全组/防火墙已按清单放行，并重跑 p2p-net doctor：\n${securityChecklist()}`,
        });
      }
    }
    if (out.length === 0) out.push({ layer: 'vps', ok: true, detail: 'config.json 无 relays（尚未 init 任何 VPS？），跳过' });
    return out;
  });
  await guard('scanner', () => checkScanner(deps));
  await guard('service', () => checkService(opts.dir, deps));
  return checks;
}

// ---------- CLI ----------

export interface RunDoctorCliDeps extends DoctorDeps {
  out?: (line: string) => void;
}

/** p2p-net doctor [--json] [--dir <path>]：human 逐层 ✓/✗ + 修复建议 + 汇总；退出码 = 失败数。 */
export async function runDoctorCli(argv: string[], deps: RunDoctorCliDeps = {}): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: 'boolean', default: false },
      dir: { type: 'string' },
    },
  });
  const dir = typeof values.dir === 'string' && values.dir !== '' ? values.dir : join(homedir(), '.p2p-net');
  const out = deps.out ?? ((line: string) => console.log(line));

  const checks = await runDoctor({ dir }, deps);
  const failed = checks.filter((c) => !c.ok);

  if (values.json === true) {
    out(JSON.stringify(checks, null, 2));
    return failed.length;
  }
  for (const c of checks) {
    out(`${c.ok ? '✓' : '✗'} ${c.layer} — ${c.detail}`);
    if (c.fix) {
      const lines = c.fix.split('\n');
      out(`  修复：${lines[0]}`);
      for (const rest of lines.slice(1)) out(`  ${rest}`);
    }
  }
  out(
    failed.length === 0
      ? `OK：全部 ${checks.length} 项检查通过`
      : `未通过 ${failed.length}/${checks.length} 项——doctor 只诊断不自动修复，请按上方「修复」建议逐项处理后重跑 p2p-net doctor`,
  );
  return failed.length;
}
