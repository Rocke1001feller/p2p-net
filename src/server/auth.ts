/** auth 模块：Supabase GoTrue 纯 REST 登录与自动续期（Task 14 产出，Task 17/20 消费）。
 *  纯 REST：POST {supabaseUrl}/auth/v1/token?grant_type=password|refresh_token（header apikey），
 *  不引 supabase-js。续期语义参照 v2 仓 transport.js（devanywhere-server/desktop/lib/transport.js:74-116）：
 *  60s 临期余量、并发单飞、失败 60s 退避冷却（轮询节奏反复打令牌端点会触发限流，冷却比 401 便宜）。
 *  凭据纪律：password/accessToken/refreshToken 只进请求体与内存，绝不进日志/错误消息；
 *  持久化是调用方的事（store.saveAuth，0600 原子写），本模块不落盘。
 */

import type { AppConfig } from './store.js';

/** 登录态（auth.json 的内存形态；Task 17 start / Task 20 doctor 消费）。 */
export interface AuthState {
  accessToken: string;
  refreshToken: string;
  /** accessToken 过期时刻（epoch ms = 签发时刻 + expires_in*1000）。 */
  expiresAt: number;
  uid: string;
  email: string;
}

/** 认证失败的统一错误：message 必带可操作指引（p2p-net login），且绝不含 token/密码。 */
export class AuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthError';
  }
}

/** 可选尾参：测试注入 seam（与 init/supabase.ts 的 BootstrapDeps 同模式），生产全走默认值。 */
export interface AuthDeps {
  fetchImpl?: typeof fetch;
}

/** 临期余量：剩余有效期不足 60s 即续期（与 v2 transport.js 同值）。 */
const EXPIRY_MARGIN_MS = 60_000;
/** 失败退避：续期失败后 60s 冷却，冷却期内不再打令牌端点。 */
const REFRESH_COOLDOWN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const BODY_EXCERPT_LEN = 200;

/** 在途续期（单飞）与失败冷却，按 refreshToken 记账。模块级 = 进程内共享（CLI/daemon 单进程语义）。 */
const inflightRefresh = new Map<string, Promise<AuthState>>();
const refreshBlockedUntil = new Map<string, number>();

export async function loginWithPassword(cfg: AppConfig, email: string, password: string, deps: AuthDeps = {}): Promise<AuthState> {
  const r = await tokenRequest(cfg, deps, 'password', { email, password });
  if (!r.ok) {
    throw new AuthError(`登录失败：${errText(r)}。请确认邮箱与密码无误后重试 p2p-net login`);
  }
  return mapTokenResponse(r.json, { email });
}

export async function ensureFreshToken(cfg: AppConfig, a: AuthState, deps: AuthDeps = {}): Promise<AuthState> {
  if (a.expiresAt - Date.now() >= EXPIRY_MARGIN_MS) return a; // 新鲜：原样返回（同引用，零请求）
  const blockedUntil = refreshBlockedUntil.get(a.refreshToken) ?? 0;
  if (Date.now() < blockedUntil) {
    throw new AuthError('token 续期刚失败过（60s 冷却中，不再重复打令牌端点）：请重新运行 p2p-net login');
  }
  const inflight = inflightRefresh.get(a.refreshToken);
  if (inflight) return inflight; // 单飞：并发调用共享同一次续期
  const p = (async () => {
    try {
      return await doRefresh(cfg, a, deps);
    } finally {
      inflightRefresh.delete(a.refreshToken); // settle 前摘除，后续调用重新发起
    }
  })();
  inflightRefresh.set(a.refreshToken, p);
  return p;
}

async function doRefresh(cfg: AppConfig, a: AuthState, deps: AuthDeps): Promise<AuthState> {
  try {
    const r = await tokenRequest(cfg, deps, 'refresh_token', { refresh_token: a.refreshToken });
    if (!r.ok) {
      throw new AuthError(`token 续期失败：${errText(r)}。登录态已失效，请重新运行 p2p-net login`);
    }
    // refresh_token rotation 关闭时响应可缺 refresh_token/user，沿用旧值
    return mapTokenResponse(r.json, { email: a.email, uid: a.uid, refreshToken: a.refreshToken });
  } catch (e) {
    refreshBlockedUntil.set(a.refreshToken, Date.now() + REFRESH_COOLDOWN_MS);
    throw e;
  }
}

interface TokenReply {
  ok: boolean;
  status: number;
  json?: Record<string, unknown>;
}

/** 令牌端点最小请求助手：网络/超时/畸形 JSON 统一包装为 AuthError（响应体可能含 token，绝不入错误文案）。 */
async function tokenRequest(
  cfg: AppConfig,
  deps: AuthDeps,
  grantType: 'password' | 'refresh_token',
  body: Record<string, unknown>,
): Promise<TokenReply> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.supabaseUrl}/auth/v1/token?grant_type=${grantType}`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { apikey: cfg.publishableKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new AuthError(
      `无法连接 Supabase（${cfg.supabaseUrl}）：请检查网络后重试；若持续失败请重新运行 p2p-net login`,
      { cause: e },
    );
  }
  let json: Record<string, unknown> | undefined;
  try {
    const text = await res.text();
    json = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch (e) {
    throw new AuthError('Supabase 令牌响应不是合法 JSON：请运行 p2p-net doctor 排查，或重新运行 p2p-net login 重建登录态', { cause: e });
  }
  return { ok: res.ok, status: res.status, json };
}

/** GoTrue 令牌响应 → AuthState；缺关键字段抛 AuthError（绝不把响应体原文带进文案——成功体含 token）。 */
function mapTokenResponse(
  json: Record<string, unknown> | undefined,
  fallback: { email: string; uid?: string; refreshToken?: string },
): AuthState {
  const o = json ?? {};
  const user = (o.user ?? undefined) as { id?: unknown; email?: unknown } | undefined;
  const accessToken = typeof o.access_token === 'string' && o.access_token ? o.access_token : undefined;
  const expiresIn = typeof o.expires_in === 'number' && Number.isFinite(o.expires_in) && o.expires_in > 0 ? o.expires_in : undefined;
  const refreshToken = typeof o.refresh_token === 'string' && o.refresh_token ? o.refresh_token : fallback.refreshToken;
  const uid = typeof user?.id === 'string' && user.id ? user.id : fallback.uid;
  const email = typeof user?.email === 'string' && user.email ? user.email : fallback.email;
  if (!accessToken || expiresIn === undefined || !refreshToken || !uid) {
    const missing = [
      !accessToken && 'access_token',
      expiresIn === undefined && 'expires_in',
      !refreshToken && 'refresh_token',
      !uid && 'user.id',
    ].filter(Boolean).join('/');
    throw new AuthError(`Supabase 令牌响应缺字段（${missing}）：请重试；若持续出现请重新运行 p2p-net login 或重跑 p2p-net init 检查 supabaseUrl`);
  }
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000, uid, email };
}

/** 从错误响应提取人话摘要（GoTrue 的 msg/error_description），截断防刷屏。 */
function errText(r: TokenReply): string {
  const j = r.json;
  let s: string;
  if (j && typeof j === 'object') {
    s = String(j.msg ?? j.error_description ?? j.message ?? j.error ?? `HTTP ${r.status}`);
  } else {
    s = `HTTP ${r.status}`;
  }
  return s.slice(0, BODY_EXCERPT_LEN);
}
