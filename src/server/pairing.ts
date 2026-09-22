/** 配对出票与 start 运行时的 Supabase 数据面直连助手（Task 17 产出）。
 *  纯 REST 直连（apikey + 用户 JWT），不引 supabase-js（与 server/auth.ts 同一纪律）：
 *  - issuePairingTicket：POST /rest/v1/pairing_tickets（空 body，Prefer: return=representation）→ 票据 id；
 *  - getTicketStatus：GET /rest/v1/pairing_tickets?id=eq.<id>&select=status → pending|redeemed|expired；
 *  - bindDeviceAuth：POST /rest/v1/rpc/bind_device_auth {p_role:'desktop', p_hostname} → 设备 uuid
 *    （服务端按 (user, role, hostname) 幂等，重复绑定返回既有设备 id）；
 *  - fetchTurnCredentials：POST /functions/v1/turn-credentials → HostAgent 的 TurnCredentials；
 *  - startPairingLoop：出票 → 逐 relay 回调打印 URL+QR → 5s 轮询 → redeemed 打「手机已接入」回执 /
 *    expired 或 120s 到期自动换新票重打。环内任何失败只 warn 重试，绝不 crash 宿主进程。
 *
 *  秘密纪律：accessToken 只进 Authorization 头，绝不进日志/错误文案/stdout；
 *  打到终端的 URL 含 ticketId+deviceId 是产品设计（PWA 扫码载荷），票据 120s 即过期。
 */

import { hostname } from 'node:os';

import type { TurnCredentials } from '../host.js';
import type { Logger } from '../log/logger.js';
import type { AppConfig } from './store.js';

/** 配对/绑定/TURN 直连的统一错误：message 必为人话，且绝不含 token。 */
export class PairingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PairingError';
  }
}

export type TicketStatus = 'pending' | 'redeemed' | 'expired';

const REQUEST_TIMEOUT_MS = 10_000;
const BODY_EXCERPT_LEN = 200;

/** 默认轮询节奏 5s / 票据有效期 120s（与服务端 expires_at 默认值一致）。 */
export const PAIRING_POLL_INTERVAL_MS = 5_000;
export const PAIRING_TICKET_TTL_MS = 120_000;

/** PWA 扫码载荷形态：<relay>/connect?t=<ticketId>&d=<deskDeviceId>&u=<接入URL>（pwa/src/cloud.ts 解析）。
 *  u= 直指隧道公网入口 /tunnel/s/<deviceId>：PWA 把 u 原样存为 tunnelUrl 并拼 `${u}/s/<port>/…`，
 *  经 Caddy /tunnel/* 反代落 relay 的桌面隧道会话（缺此前缀则隧道流量 404，只剩 P2P 主路径）。 */
export function buildConnectUrl(ip: string, ticketId: string, deviceId: string): string {
  const u = encodeURIComponent(`https://${ip}/tunnel/s/${deviceId}`);
  return `https://${ip}/connect?t=${encodeURIComponent(ticketId)}&d=${encodeURIComponent(deviceId)}&u=${u}`;
}

/** 出票：POST /rest/v1/pairing_tickets（空 body，return=representation）→ { ticketId }。 */
export async function issuePairingTicket(
  cfg: AppConfig,
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ ticketId: string }> {
  const res = await postJson(cfg, accessToken, '/rest/v1/pairing_tickets', {}, fetchImpl, {
    Prefer: 'return=representation',
  });
  if (!res.ok) throw new PairingError(`配对出票失败（HTTP ${res.status}）：${errExcerpt(res.json)}，请重试；若持续失败请运行 p2p-net doctor 排查`);
  const id = Array.isArray(res.json) ? (res.json[0] as { id?: unknown } | undefined)?.id : undefined;
  if (typeof id !== 'string' || !id) {
    throw new PairingError('配对出票响应缺 id：Supabase 侧 pairing_tickets 表可能未建好，请重跑 p2p-net init 或运行 p2p-net doctor 排查');
  }
  return { ticketId: id };
}

/** 轮询票据状态：GET …/pairing_tickets?id=eq.<id>&select=status。 */
export async function getTicketStatus(
  cfg: AppConfig,
  accessToken: string,
  ticketId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TicketStatus> {
  let res: Response;
  try {
    res = await fetchImpl(
      `${cfg.supabaseUrl}/rest/v1/pairing_tickets?id=eq.${encodeURIComponent(ticketId)}&select=status`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: authHeaders(cfg, accessToken) },
    );
  } catch (e) {
    throw new PairingError(`无法连接 Supabase（${cfg.supabaseUrl}）：请检查网络后重试`, { cause: e });
  }
  const json = await readJson(res);
  if (!res.ok) throw new PairingError(`票据状态查询失败（HTTP ${res.status}）：${errExcerpt(json)}`);
  const status = Array.isArray(json) ? (json[0] as { status?: unknown } | undefined)?.status : undefined;
  if (status === 'pending' || status === 'redeemed' || status === 'expired') return status;
  throw new PairingError(`票据状态查询响应异常（票据可能已被清理）：ticketId=${ticketId}`);
}

/** 设备绑定：POST /rest/v1/rpc/bind_device_auth → 设备 uuid（幂等 per (user, role, hostname)）。 */
export async function bindDeviceAuth(
  cfg: AppConfig,
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const res = await postJson(cfg, accessToken, '/rest/v1/rpc/bind_device_auth', { p_role: 'desktop', p_hostname: hostname() }, fetchImpl);
  if (!res.ok) {
    throw new PairingError(`设备绑定失败（HTTP ${res.status}）：${errExcerpt(res.json)}，请重跑 p2p-net init 或运行 p2p-net doctor 排查`);
  }
  if (typeof res.json !== 'string' || !res.json) {
    throw new PairingError('设备绑定响应不是设备 id：bind_device_auth RPC 可能缺失，请重跑 p2p-net init');
  }
  return res.json;
}

/** TURN 凭据：POST /functions/v1/turn-credentials → { iceServers, ttlSeconds }（HostAgent turnFetcher）。 */
export async function fetchTurnCredentials(
  cfg: AppConfig,
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TurnCredentials> {
  const res = await postJson(cfg, accessToken, '/functions/v1/turn-credentials', {}, fetchImpl);
  if (!res.ok) throw new PairingError(`TURN 凭据获取失败（HTTP ${res.status}）：${errExcerpt(res.json)}`);
  const o = (res.json ?? {}) as { iceServers?: unknown; ttlSeconds?: unknown };
  if (!Array.isArray(o.iceServers)) throw new PairingError('TURN 凭据响应缺 iceServers：请重跑 p2p-net init 检查函数部署');
  return {
    iceServers: o.iceServers as TurnCredentials['iceServers'],
    ...(typeof o.ttlSeconds === 'number' && Number.isFinite(o.ttlSeconds) ? { ttlSeconds: o.ttlSeconds } : {}),
  };
}

export interface PairingLoopOptions {
  cfg: AppConfig;
  /** 每次请求现取（与 HostAgent accessToken 同一闭包），支持后续令牌刷新接线。 */
  accessToken: () => string | null;
  relays: { ip: string }[];
  deviceId: string;
  log: Logger;
  /** 每张票对每台 relay 回调一次（start 编排里打 URL + qrcode-terminal 图形）。 */
  printTicket?: (ip: string, url: string) => void;
  /** 手机接入回执；缺省打 log.info「手机已接入」+ event('phone_connected')。 */
  onRedeemed?: (ticketId: string) => void;
}

export interface PairingLoopDeps {
  fetchImpl?: typeof fetch;
  issueTicket?: (cfg: AppConfig, accessToken: string) => Promise<{ ticketId: string }>;
  pollStatus?: (cfg: AppConfig, accessToken: string, ticketId: string) => Promise<TicketStatus>;
  /** 测试注入：轮询间隔（默认 5000）与票据有效期（默认 120000）。 */
  pollIntervalMs?: number;
  ticketTtlMs?: number;
  now?: () => number;
}

export interface PairingHandle {
  stop(): void;
}

/** 配对环：出票 → 逐 relay 打 URL → 5s 轮询 → redeemed 回执并换新票 / expired 或本地到期换新票重打。
 *  长期伴随 start 进程运行：任何环节失败只 warn 并重试，绝不 throw、绝不 crash 宿主。 */
export function startPairingLoop(opts: PairingLoopOptions, deps: PairingLoopDeps = {}): PairingHandle {
  const { cfg, log } = opts;
  const issue = deps.issueTicket ?? ((c: AppConfig, token: string) => issuePairingTicket(c, token, deps.fetchImpl));
  const poll = deps.pollStatus ?? ((c: AppConfig, token: string, id: string) => getTicketStatus(c, token, id, deps.fetchImpl));
  const pollIntervalMs = deps.pollIntervalMs ?? PAIRING_POLL_INTERVAL_MS;
  const ticketTtlMs = deps.ticketTtlMs ?? PAIRING_TICKET_TTL_MS;
  const now = deps.now ?? (() => Date.now());
  const onRedeemed =
    opts.onRedeemed ??
    ((ticketId: string) => {
      log.info('pairing', '手机已接入', { ticketId });
      log.event('phone_connected', { ticketId });
    });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (fn: () => void, ms: number): void => {
    if (stopped) return;
    timer = setTimeout(fn, ms);
    timer.unref?.();
  };

  async function cycle(): Promise<void> {
    if (stopped) return;
    let ticketId: string;
    try {
      ({ ticketId } = await issue(cfg, opts.accessToken() ?? ''));
    } catch (e) {
      log.warn('pairing', `配对出票失败，${Math.round(pollIntervalMs / 1000)}s 后重试`, { err: errMsg(e) });
      schedule(() => void cycle(), pollIntervalMs);
      return;
    }
    if (stopped) return;
    log.info('pairing', '配对票已签发（120s 有效）', { ticketId, relays: opts.relays.length });
    for (const relay of opts.relays) {
      const url = buildConnectUrl(relay.ip, ticketId, opts.deviceId);
      try {
        opts.printTicket?.(relay.ip, url);
      } catch (e) {
        log.warn('pairing', 'QR 打印失败（不影响配对轮询）', { err: errMsg(e) });
      }
    }
    schedule(() => void pollOnce(ticketId, now() + ticketTtlMs), pollIntervalMs);
  }

  async function pollOnce(ticketId: string, deadline: number): Promise<void> {
    if (stopped) return;
    if (now() >= deadline) {
      log.info('pairing', '配对票到期未扫码，换新票重打 QR', { ticketId });
      schedule(() => void cycle(), 0);
      return;
    }
    try {
      const status = await poll(cfg, opts.accessToken() ?? '', ticketId);
      if (stopped) return;
      if (status === 'redeemed') {
        onRedeemed(ticketId);
        schedule(() => void cycle(), 0); // 换新票供下一台设备配对
        return;
      }
      if (status === 'expired') {
        log.info('pairing', '配对票已过期（服务端），换新票重打 QR', { ticketId });
        schedule(() => void cycle(), 0);
        return;
      }
    } catch (e) {
      log.warn('pairing', '票据状态轮询失败（下轮重试）', { err: errMsg(e) });
    }
    schedule(() => void pollOnce(ticketId, deadline), pollIntervalMs);
  }

  void cycle();
  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function authHeaders(cfg: AppConfig, accessToken: string): Record<string, string> {
  return { apikey: cfg.publishableKey, Authorization: `Bearer ${accessToken}` };
}

/** 小 POST JSON 助手：网络/超时/畸形 JSON 统一包装为 PairingError（响应体绝不进 cause 以外的文案……
 *  注意 PostgREST/函数错误体只含 message 等元数据，不含请求侧 token）。 */
async function postJson(
  cfg: AppConfig,
  accessToken: string,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  extraHeaders: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.supabaseUrl}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { ...authHeaders(cfg, accessToken), 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new PairingError(`无法连接 Supabase（${cfg.supabaseUrl}）：请检查网络后重试`, { cause: e });
  }
  return { ok: res.ok, status: res.status, json: await readJson(res) };
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 从 PostgREST/函数错误体提取人话摘要（截断防刷屏）；响应体在服务端，不含我们的 token。 */
function errExcerpt(json: unknown): string {
  const o = json as { message?: unknown; error?: unknown; msg?: unknown } | undefined;
  const s = String(o?.message ?? o?.error ?? o?.msg ?? '无服务端摘要');
  return s.slice(0, BODY_EXCERPT_LEN);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
