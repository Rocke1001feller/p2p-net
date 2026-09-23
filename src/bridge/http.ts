/**
 * HTTP 本地转发桥（Node only）：req 帧 → node:http.request(127.0.0.1:port) → res-head/res-chunk。
 *
 * 语义与老仓 POC host（poc/webrtc-pwa/host/index.html doFetch）逐字对齐：
 * - 请求头剥离清单：host/content-length/accept-encoding/connection/origin/referer；
 * - 响应头剥离清单：content-encoding/content-length/transfer-encoding/connection；
 * - location 头去掉本机 origin 前缀（http(s)://127.0.0.1:<port> / localhost:<port> → ''）；
 * - 16384B 分块 base64，done 帧收尾；101/204/205/304 无 body 特判（res-head 即收尾）；
 * - req-abort → AbortController 中止，服务器侧可见连接中止，对端静默（POC AbortError 同语义）；
 * - 老 POC 帧（无 port）→ 400 错误帧，不静默；本地连接失败 → 502 错误帧。
 * 背压：DataChannel bufferedAmount > 8MiB 时等待（POC dcSend 同语义）。
 * SW 侧 30s 超时语义不在 bridge（归 PWA SW）。
 */
import http from 'node:http';
import { chunkB64, isReq, isReqAbort, type ReqFrame, type TunnelFrame } from '../frames.js';

/** DataChannel 最小结构（werift RTCDataChannel / 测试 stub 均满足）。 */
export interface DcLike {
  send(data: string | Buffer): void;
  readonly bufferedAmount: number;
  readonly readyState?: string;
}

// 512KiB（2026-09-23 由 8MiB 下调）：有序通道里后发请求的 res-head 排在积压 chunk 之后，
// 阈值即「首帧延迟上界」。8MiB 在蜂窝中继（~1-3Mbps）意味着数十秒零回帧，把看门狗/超时全部引爆；
// 512KiB 把上界压到秒级，同时足够吃掉 localhost 与慢链路之间的速度差。
const BACKPRESSURE_BYTES = 512 * 1024;
const NO_BODY_STATUS = [101, 204, 205, 304];
const STRIP_REQ_HEADERS = new Set(['host', 'content-length', 'accept-encoding', 'connection', 'origin', 'referer']);
const STRIP_RES_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 帧出站（JSON 串）+ 背压：bufferedAmount 超阈值即等待，绝不挤爆 SCTP 缓冲。 */
export async function dcSend(dc: DcLike, frame: TunnelFrame): Promise<void> {
  if (dc.readyState !== undefined && dc.readyState !== 'open') return;
  while (dc.bufferedAmount > BACKPRESSURE_BYTES) await sleep(10);
  dc.send(JSON.stringify(frame));
  // 每帧让出 macrotask：werift 纯 JS DTLS/SCTP 与批量编码同进程，不让出会把 ctrl pong 与
  // 上游回调饿死（2026-09-23 真机实证：洪泛期 localhost 响应延迟 14-20s、对端误判拆连）。
  await new Promise<void>((r) => setImmediate(r));
}

function rewriteLocation(value: string, port: number): string {
  let v = value;
  for (const prefix of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `https://127.0.0.1:${port}`, `https://localhost:${port}`]) {
    v = v.split(prefix).join('');
  }
  return v;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export class HttpBridge {
  private ctrls = new Map<number, AbortController>();

  /** 帧入口：处理 req / req-abort；其余帧（ws 系列、ping）交还调用方路由。 */
  async handle(dc: DcLike, frame: unknown): Promise<void> {
    if (isReq(frame)) return this.doReq(dc, frame);
    if (isReqAbort(frame)) {
      const ctrl = this.ctrls.get(frame.id);
      if (ctrl) {
        ctrl.abort();
        this.ctrls.delete(frame.id);
      }
    }
  }

  private async doReq(dc: DcLike, frame: ReqFrame): Promise<void> {
    const { id, method, path, headers, bodyB64 } = frame;
    if (typeof frame.port !== 'number' || !Number.isInteger(frame.port) || frame.port <= 0 || frame.port > 65535) {
      // 老 POC 帧无 port：显式报错帧，不静默
      await dcSend(dc, { k: 'res-head', id, status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      await dcSend(dc, { k: 'res-chunk', id, dataB64: b64('bridge error: req.port missing (old POC frame not supported)'), done: true });
      return;
    }

    const h: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(headers ?? {})) {
      if (STRIP_REQ_HEADERS.has(k.toLowerCase())) continue;
      h[k] = v;
    }

    const ctrl = new AbortController();
    this.ctrls.set(id, ctrl);
    let headSent = false;
    const t0 = Date.now();
    if (process.env.P2P_NET_DEBUG) console.error('[p2p-net] req#%d %s :%d%s', id, method, frame.port, path);
    try {
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request({ host: 'localhost', port: frame.port, path, method, headers: h, signal: ctrl.signal }, (res) => {
        if (process.env.P2P_NET_DEBUG) console.error('[p2p-net] res#%d %s :%d%s → %d (+%dms)', id, frame.method, frame.port, frame.path, res.statusCode, Date.now() - t0);
        resolve(res);
      });
        req.on('error', reject);
        if (bodyB64) req.end(Buffer.from(bodyB64, 'base64'));
        else req.end();
      });

      const rh: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (STRIP_RES_HEADERS.has(k)) continue;
        let val = Array.isArray(v) ? v.join(', ') : (v ?? '');
        if (k === 'location') val = rewriteLocation(val, frame.port);
        rh[k] = val;
      }
      await dcSend(dc, { k: 'res-head', id, status: res.statusCode ?? 502, headers: rh });
      headSent = true;

      if (NO_BODY_STATUS.includes(res.statusCode ?? 0)) {
        this.ctrls.delete(id);
        res.resume();
        await dcSend(dc, { k: 'res-chunk', id, done: true });
        return;
      }

      let sentBytes = 0;
      for await (const chunk of res) {
        for (const piece of chunkB64(chunk as Buffer)) {
          sentBytes += piece.length;
          await dcSend(dc, { k: 'res-chunk', id, dataB64: piece });
        }
      }
      this.ctrls.delete(id);
      await dcSend(dc, { k: 'res-chunk', id, done: true });
      if (process.env.P2P_NET_DEBUG) console.error('[p2p-net] done#%d :%d%s %dB(b64) +%dms', id, frame.port, frame.path, sentBytes, Date.now() - t0);
    } catch (e) {
      this.ctrls.delete(id);
      const msg = e instanceof Error ? e.message : String(e);
      if (ctrl.signal.aborted) return; // 客户端取消：静默丢弃（POC AbortError 同语义）
      if (!headSent) {
        await dcSend(dc, { k: 'res-head', id, status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        await dcSend(dc, { k: 'res-chunk', id, dataB64: b64('host fetch error: ' + msg), done: true });
      } else {
        // 头已发出、中途断流：以 done 帧干净收尾（body 截断）
        await dcSend(dc, { k: 'res-chunk', id, done: true });
      }
    }
  }

  /** 全量中止在途请求（host 断开时调用）。 */
  abortAll(): void {
    for (const ctrl of this.ctrls.values()) ctrl.abort();
    this.ctrls.clear();
  }
}
