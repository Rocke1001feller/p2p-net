/** 隧道帧协议编解码 —— 字段与语义逐字对齐老仓 POC（poc/webrtc-pwa/pwa/sw.js + host/index.html），
 *  唯一增量字段：req.port（M1 多服务寻址；PWA SW 从 scope 前缀解析注入）。
 */

export interface ReqFrame {
  k: 'req';
  id: number;
  /** 目标本地端口（127.0.0.1）。老 POC 无此字段 → bridge 回 400 帧错误，不静默。 */
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyB64?: string | null;
  /** M1 兜底隧道增量（Task 11）：relay 发出的 req 帧标记 via:'tunnel'（port 恒为 0，桌面按 path 前缀路由）。 */
  via?: 'tunnel';
}

export interface ReqAbortFrame { k: 'req-abort'; id: number }

export interface ResHeadFrame {
  k: 'res-head';
  id: number;
  status: number;
  headers: Record<string, string>;
}

export interface ResChunkFrame {
  k: 'res-chunk';
  id: number;
  dataB64?: string;
  done?: boolean;
}

export interface WsOpenFrame { k: 'ws-open'; wid: number; path: string; port?: number }
export interface WsOpenOkFrame { k: 'ws-open-ok'; wid: number }
export interface WsOpenErrFrame { k: 'ws-open-err'; wid: number }
export interface WsMsgFrame { k: 'ws-msg'; wid: number; text?: string; dataB64?: string }
export interface WsCloseFrame { k: 'ws-close'; wid: number; code?: number; reason?: string }
export interface PingFrame { k: 'ping'; t: number }
export interface PongFrame { k: 'pong'; t: number }

export type TunnelFrame =
  | ReqFrame | ReqAbortFrame
  | ResHeadFrame | ResChunkFrame
  | WsOpenFrame | WsOpenOkFrame | WsOpenErrFrame | WsMsgFrame | WsCloseFrame
  | PingFrame | PongFrame;

/** SW 侧 30s 超时→504、16384 分块、8MiB 背压等语义归 PWA SW / bridge，不在本文件。 */
export const CHUNK_SIZE = 16384;

export function encodeFrame(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

export function decodeFrame(buf: Buffer | string): unknown {
  try {
    return JSON.parse(typeof buf === 'string' ? buf : buf.toString('utf8'));
  } catch {
    return null;
  }
}

/** 大 buffer → ≤16384B 的 base64 分片（顺序拼接可还原）。 */
export function chunkB64(buf: Buffer): string[] {
  const out: string[] = [];
  for (let i = 0; i < buf.length; i += CHUNK_SIZE) out.push(buf.subarray(i, i + CHUNK_SIZE).toString('base64'));
  return out;
}

const hasStr = (o: Record<string, unknown>, k: string) => typeof o[k] === 'string';
const hasNum = (o: Record<string, unknown>, k: string) => typeof o[k] === 'number';

function shape(x: unknown, k: string): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && (x as Record<string, unknown>).k === k;
}

export function isReq(x: unknown): x is ReqFrame {
  return shape(x, 'req') && hasNum(x, 'id') && hasStr(x, 'method') && hasStr(x, 'path');
}
export function isReqAbort(x: unknown): x is ReqAbortFrame {
  return shape(x, 'req-abort') && hasNum(x, 'id');
}
export function isResHead(x: unknown): x is ResHeadFrame {
  return shape(x, 'res-head') && hasNum(x, 'id') && hasNum(x, 'status');
}
export function isResChunk(x: unknown): x is ResChunkFrame {
  return shape(x, 'res-chunk') && hasNum(x, 'id');
}
export function isWsOpen(x: unknown): x is WsOpenFrame {
  return shape(x, 'ws-open') && hasNum(x, 'wid') && hasStr(x, 'path') &&
    ((x as { port?: unknown }).port === undefined || hasNum(x, 'port'));
}
export function isWsOpenOk(x: unknown): x is WsOpenOkFrame {
  return shape(x, 'ws-open-ok') && hasNum(x, 'wid');
}
export function isWsOpenErr(x: unknown): x is WsOpenErrFrame {
  return shape(x, 'ws-open-err') && hasNum(x, 'wid');
}
export function isWsMsg(x: unknown): x is WsMsgFrame {
  return shape(x, 'ws-msg') && hasNum(x, 'wid') && (hasStr(x, 'text') || hasStr(x, 'dataB64'));
}
export function isWsClose(x: unknown): x is WsCloseFrame {
  return shape(x, 'ws-close') && hasNum(x, 'wid');
}
export function isPing(x: unknown): x is PingFrame {
  return shape(x, 'ping') && hasNum(x, 't');
}
export function isPong(x: unknown): x is PongFrame {
  return shape(x, 'pong') && hasNum(x, 't');
}
