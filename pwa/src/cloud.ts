/**
 * 云端链路：扫码登录（ticket 兑换）→ verifyOtp 建会话 → bind_device_auth 绑 phone 设备 →
 * turn-credentials 取 TURN 临时凭据。契约逐字对齐老仓 mobile/src/cloud.ts；
 * bind 响应只取设备 id（network_name/virtual_ip/relays 等 v1 字段一律忽略），
 * 形态归一见 parseBindResponse。
 *
 * Supabase 地址与 publishable key 不再硬编码：一律取 loadRuntimeConfig()（同源 /config.json，
 * 由 p2p-net init 写入 VPS）。模块内 memo 一份以免每个 RPC 都重拉；拉取失败清缓存以便重试。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadRuntimeConfig, type RuntimeConfig } from './config.js';

let cfgPromise: Promise<RuntimeConfig> | null = null;
function getCfg(): Promise<RuntimeConfig> {
  if (!cfgPromise) {
    cfgPromise = loadRuntimeConfig();
    cfgPromise.catch(() => { cfgPromise = null; }); // 失败不钉死：下次调用重新拉
  }
  return cfgPromise;
}

let client: SupabaseClient | null = null;
let clientUrl = '';
export async function supabase(): Promise<SupabaseClient> {
  const cfg = await getCfg();
  if (!client || clientUrl !== cfg.supabaseUrl) {
    client = createClient(cfg.supabaseUrl, cfg.publishableKey);
    clientUrl = cfg.supabaseUrl;
  }
  return client;
}

/**
 * 扫码载荷解析。形态：<relay>/connect?t=<ticket>&d=<deskDeviceId>&u=<网关>&dsc=<discovery端口>
 * （p2p-net start 每台 relay 打一张 https://<ip>/connect?… 二维码）。
 *
 * ⚠️ `dsc` 必须解析出来（2026-09-12 白屏真根因之一，历史教训平移）：桌面自述的
 * 发现端口若在二维码里带着却被 parseScan 丢弃 → 手机侧只能猜契约端口 → 服务发现必然失败
 * → 白屏。丢一个字段，症状是全链路白屏。
 */
export interface ScanPayload {
  ticket: string;
  deskDeviceId: string | null;
  tunnelUrl: string | null;
  /** 桌面自述的服务发现端口；缺席 = 客户端按契约端口探测。 */
  discoveryPort: number | null;
}

export function parseScan(text: string): ScanPayload {
  // URL 形态：桌面二维码 = <relay>/connect?t=<ticketId>&d=<deskDeviceId>&u=<接入URL>。
  // 原生相机/微信扫码直接拉起 PWA；u= 是反向隧道兜底网关（级联第 2 段用，可省略）。
  if (text.includes('/connect?')) {
    try {
      const q = new URL(text).searchParams;
      const ticket = (q.get('t') || '').trim();
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ticket)) throw new Error('bad ticket');
      const dsc = Number((q.get('dsc') || '').trim());
      return {
        ticket,
        deskDeviceId: (q.get('d') || '').trim() || null,
        tunnelUrl: (q.get('u') || '').trim() || null,
        discoveryPort: Number.isInteger(dsc) && dsc > 0 && dsc < 65536 ? dsc : null,
      };
    } catch { /* 落到 p2pnet2 分支的报错 */ }
  }
  if (text.startsWith('p2pnet2|')) {
    const parts = text.slice(8).split('|');
    const ticket = (parts[0] ?? '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ticket)) throw new Error('登录二维码格式无效');
    const deskDeviceId = (parts[1] ?? '').trim() || null;
    return { ticket, deskDeviceId, tunnelUrl: (parts[2] ?? '').trim() || null, discoveryPort: null };
  }
  throw new Error('请扫电脑端 p2p-net start 打印的「登录二维码」，或粘贴二维码内容');
}

/** 扫码登录：ticket → Edge Function 兑换 → verifyOtp 建会话。全程无需账号密码。 */
export async function loginByTicket(ticket: string, deviceLabel: string): Promise<void> {
  const cfg = await getCfg();
  let res: Response;
  try {
    res = await fetch(`${cfg.supabaseUrl}/functions/v1/redeem-pairing-ticket`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: cfg.publishableKey,
        authorization: `Bearer ${cfg.publishableKey}`,
      },
      body: JSON.stringify({ ticket, device_label: deviceLabel }),
    });
  } catch {
    throw new Error('无法连接云端，请检查网络');
  }
  if (res.status === 410) throw new Error('二维码已过期，请扫电脑屏幕上最新的');
  const body = await res.json().catch(() => ({}) as { token_hash?: string });
  if (!res.ok || !body.token_hash) throw new Error(`登录兑换失败（HTTP ${res.status}）`);
  const { error } = await (await supabase()).auth.verifyOtp({ token_hash: body.token_hash, type: 'magiclink' });
  if (error) throw new Error('登录失败，请重新扫码');
}

export interface BindResult { deviceId: string }

/** 账号密码登录（不在电脑旁场景）：Supabase Auth 现成链路，登录后与扫码用户同域。 */
export async function loginByPassword(email: string, password: string): Promise<void> {
  const { error } = await (await supabase()).auth.signInWithPassword({ email, password });
  if (error) {
    if (error.message.includes('Invalid login')) throw new Error('账号或密码不正确');
    throw new Error(error.message);
  }
}

/** 绑定本机为账号下 phone 设备：响应只消费设备 id（D-M1-3；network_name/virtual_ip/relays 等 v1 字段一律忽略）。 */
export async function bindPhone(hostname: string): Promise<BindResult> {
  const { data, error } = await (await supabase()).rpc('bind_device_auth', {
    p_hostname: hostname,
    p_role: 'phone',
  });
  if (error?.message.includes('invite_required')) throw new Error('invite_required');
  if (error) throw new Error(`设备绑定失败：${error.message}`);
  const id = parseBindResponse(data);
  if (!id) throw new Error('设备绑定响应缺少 device_id');
  return { deviceId: id };
}

/** bind_device_auth 响应归一：DDL 为 returns uuid（PostgREST 直返裸字符串）；
 *  jsonb {device_id} 是 D-M1-3 历史形态，保留兜底。
 *  2026-09-22 真机实锤：旧代码只认对象形态 → 裸 uuid 被判缺 device_id → 绑定即抛错、
 *  LS_DEVICE_ID 永不落盘 → startConnect 静默 bail，手机端永远连不上。 */
export function parseBindResponse(data: unknown): string | null {
  if (typeof data === 'string' && data) return data;
  if (data && typeof data === 'object') {
    const id = (data as { device_id?: unknown }).device_id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

export interface TurnCredentialsResponse {
  iceServers: RTCIceServer[];
  ttlSeconds?: number;
}

/** TURN REST 临时凭据：需登录态 JWT；失败抛错由调用方降级（host 直连或重试）。 */
export async function fetchTurnCredentials(accessToken: string): Promise<TurnCredentialsResponse> {
  const cfg = await getCfg();
  const res = await fetch(`${cfg.supabaseUrl}/functions/v1/turn-credentials`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: cfg.publishableKey,
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) throw new Error(`turn-credentials HTTP ${res.status}`);
  const body = (await res.json()) as TurnCredentialsResponse;
  if (!Array.isArray(body.iceServers)) throw new Error('turn-credentials 响应缺 iceServers');
  return body;
}
