/**
 * Supabase PostgREST 轮询信令客户端（Node/浏览器同构，仅依赖 globalThis.fetch）。
 *
 * 表：public.signaling_messages（Task 2 migration：room/sender/kind/payload/expires_at）。
 * 调用方注入 Supabase URL、publishable key 与用户 access_token（每次请求现取，支持刷新）——库不持有凭据。
 */
import type { SigMessage } from './protocol.js';

export type FetchLike = typeof globalThis.fetch;

export interface SignalingClientOptions {
  supabaseUrl: string;
  /** 每次请求现取，支持 token 刷新；返回 null 时不带 authorization 头。 */
  accessToken: () => string | null;
  publishableKey: string;
  /** 轮询间隔提示值（默认 800ms）；本类不做定时，循环由调用方（host.ts / PWA shell）驱动。 */
  pollMs?: number;
}

export interface SigRow {
  id: number;
  sender: string;
  payload: SigMessage;
}

export interface PollResult {
  msgs: SigRow[];
  cursor: number;
}

export class SignalingClient {
  constructor(private opts: SignalingClientOptions) {}

  private headers(): Record<string, string> {
    const t = this.opts.accessToken();
    return {
      apikey: this.opts.publishableKey,
      'content-type': 'application/json',
      ...(t ? { authorization: `Bearer ${t}` } : {}),
    };
  }

  async send(room: string, sender: string, msg: SigMessage, kind: 'sig' | 'data' = 'sig', ttlSeconds = 120): Promise<void> {
    const r = await fetch(`${this.opts.supabaseUrl}/rest/v1/signaling_messages`, {
      signal: AbortSignal.timeout(10_000),
      method: 'POST',
      headers: { ...this.headers(), prefer: 'return=minimal' },
      body: JSON.stringify({
        room,
        sender,
        kind,
        payload: msg,
        expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      }),
    });
    if (!r.ok) throw new Error(`signaling send failed: ${r.status}`);
  }

  async poll(room: string, cursor: number): Promise<PollResult> {
    const q = new URLSearchParams({
      room: `eq.${room}`,
      id: `gt.${cursor}`,
      // TTL 过滤必须在读侧：agent 每次启动 cursor=0 会重放全房历史，不过滤就会回答僵尸会话
      expires_at: `gt.${new Date().toISOString()}`,
      order: 'id.asc',
      select: 'id,sender,payload',
    });
    const r = await fetch(`${this.opts.supabaseUrl}/rest/v1/signaling_messages?${q}`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`signaling poll failed: ${r.status}`);
    const rows = (await r.json()) as SigRow[];
    return { msgs: rows, cursor: rows.length ? rows[rows.length - 1].id : cursor };
  }

  /** 清理本房间已过期行（RLS 只允许删自己房间的过期行）；失败静默——清理是尽力而为。 */
  async purgeExpired(room: string): Promise<void> {
    await fetch(
      `${this.opts.supabaseUrl}/rest/v1/signaling_messages?room=eq.${encodeURIComponent(room)}&expires_at=lt.${new Date().toISOString()}`,
      { method: 'DELETE', headers: this.headers() },
    ).catch(() => {});
  }
}
