/**
 * 信令协议：房间名构造与消息类型（纯函数，Node/浏览器同构）。
 *
 * 房间名约定（Supabase signaling_messages 表 RLS 依赖此前缀）：
 *   `sig:<auth.uid>:<deviceId>` —— 同账号多设备互写对方房间即信令通路。
 */

export type SigMessageType = 'offer' | 'answer' | 'ice' | 'hello' | 'bye' | 'tunnel' | 'upgrade';

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
  /** offer 专用元数据（Wave 2）：PWA 接入类型标注（W2-1 access）与 NAT facts 紧凑串
   *  （W2-2 nat，如 `m:ep-ind,servers:2`，只带聚合语义绝不带 ip）随 offer 上报；其余消息不带。
   *  可选且不进 isSigMessage 类型守卫——旧版 PWA 无 meta 的 offer 必须原样兼容。 */
  meta?: { access?: string; nat?: string };
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

/** 'upgrade' = host→PWA 请求发起 ICE restart（W2-6）；复用 sid/from，无其他字段。 */
const TYPES = new Set<SigMessageType>(['offer', 'answer', 'ice', 'hello', 'bye', 'tunnel', 'upgrade']);

export function isSigMessage(x: unknown): x is SigMessage {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.type === 'string' && TYPES.has(o.type as SigMessageType) && typeof o.sid === 'string';
}
