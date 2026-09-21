/**
 * 信令协议：房间名构造与消息类型（纯函数，Node/浏览器同构）。
 *
 * 房间名约定（Supabase signaling_messages 表 RLS 依赖此前缀）：
 *   `sig:<auth.uid>:<deviceId>` —— 同账号多设备互写对方房间即信令通路。
 */

export type SigMessageType = 'offer' | 'answer' | 'ice' | 'hello' | 'bye' | 'tunnel';

/** 会话描述线格式（浏览器 RTCSessionDescription / werift 同形）。 */
export interface SdpLike {
  type: string;
  sdp: string;
}

/** ICE 候选线格式（candidate 属性平铺字典，浏览器 addIceCandidate 可直接接受）。 */
export interface IceCandidateLike {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface SigMessage {
  type: SigMessageType;
  sid: string;
  sdp?: SdpLike;
  cand?: IceCandidateLike;
  from?: string;
  /** type='tunnel'（Task 11 兜底公告）时携带的公网 URL。 */
  tunnelUrl?: string;
}

const ROOM_RE = /^sig:([^:]+):(.+)$/;

export function roomFor(uid: string, deviceId: string): string {
  return `sig:${uid}:${deviceId}`;
}

export function parseRoom(room: string): { uid: string; deviceId: string } | null {
  const m = ROOM_RE.exec(room);
  if (!m) return null;
  return { uid: m[1], deviceId: m[2] };
}

const TYPES = new Set<SigMessageType>(['offer', 'answer', 'ice', 'hello', 'bye', 'tunnel']);

export function isSigMessage(x: unknown): x is SigMessage {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.type === 'string' && TYPES.has(o.type as SigMessageType) && typeof o.sid === 'string';
}
