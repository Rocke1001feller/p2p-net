/**
 * WebSocket 本地转发桥（Node only，`ws` 包客户端）：ws-* 帧 ↔ ws://127.0.0.1:<port><path>。
 *
 * 与老仓 POC host（poc/webrtc-pwa/host/index.html ws 段）逐字对齐：
 * - ws-open{wid,path} → 连接本地 → ws-open-ok / ws-open-err；
 * - 服务器→客户端：text 帧 → ws-msg{wid,text}，binary 帧 → 帧协议 v2 二进制帧（binaryOk）或 ws-msg{wid,dataB64}（legacy）；
 * - 关闭透传：ws-close{wid,code,reason}；
 * - 客户端→服务器：ws-msg{text|dataB64} → ws.send；ws-close{wid,code?,reason?} → ws.close。
 *
 * 帧协议增量字段之二：ws-open 可携带 `port`（多服务场景；M1 复审补充）。缺省时回退
 * bridge 构造参数 port；两处皆无 → ws-open-err，不静默。
 */
import WebSocket from 'ws';
import { encodeWsMsgBin, isWsClose, isWsMsg, isWsOpen, type TunnelFrame, type WsOpenFrame } from '../frames.js';
import { dcSend, dcSendBin, type DcLike } from './http.js';

/**
 * ws 只接受 **1000 或 3000–4999** 作为可发送的关闭码；其余一律非法。
 *
 * 2026-09-12 生产事故（daemon 崩溃重启根因，真机 + 堆栈实证）：
 *   手机侧 WS 异常关闭会上报 code=1006（"异常关闭"，属**接收端**语义，规范禁止回送）——
 *   该帧经反向隧道到 daemon：`WsBridge.handle` → `ws.close(1006)` →
 *   `TypeError: First argument must be a valid error code number` → 未被捕获 → **daemon 进程 exit 1**，
 *   launchd 反复拉起（`runs=3 / last exit code=1 / immediate reason=inefficient`），
 *   表现即"工作台白屏 + 后台服务反复重启"。
 *
 * 因此：**任何来自对端的关闭码都必须先净化**，不允许直接进 `ws.close`。
 */
export function sanitizeCloseCode(code?: unknown): number {
  const n = typeof code === 'number' ? code : Number(code);
  if (!Number.isInteger(n)) return 1000;
  if (n === 1000) return 1000;
  if (n >= 3000 && n <= 4999) return n;
  return 1000; // 1006/1005/1001… 等对端语义码统一回落为正常关闭
}

export class WsBridge {
  private sockets = new Map<number, WebSocket>();

  constructor(private opts: { port?: number }) {}

  /** 帧入口：处理 ws-open/ws-msg/ws-close；其余帧交还调用方路由。 */
  async handle(dc: DcLike, frame: unknown): Promise<void> {
    if (isWsOpen(frame)) return this.open(dc, frame);
    if (isWsMsg(frame)) {
      const ws = this.sockets.get(frame.wid);
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (frame.text !== undefined) ws.send(frame.text);
        else if (frame.dataB64 !== undefined) ws.send(Buffer.from(frame.dataB64, 'base64'));
        else if (frame.dataBin !== undefined) ws.send(Buffer.from(frame.dataBin.buffer, frame.dataBin.byteOffset, frame.dataBin.byteLength));
      }
      return;
    }
    if (isWsClose(frame)) {
      const ws = this.sockets.get(frame.wid);
      if (ws) {
        this.sockets.delete(frame.wid);
        // 净化关闭码 + 兜底：一个坏帧绝不能把被控端进程带走（防御纵深）
        try {
          ws.close(sanitizeCloseCode(frame.code), frame.reason);
        } catch {
          try { ws.terminate(); } catch { /* 已断开 */ }
        }
      }
    }
  }

  private async open(dc: DcLike, frame: WsOpenFrame): Promise<void> {
    const port = frame.port ?? this.opts.port;
    // 端口校验与 HttpBridge（http.ts doReq）对齐：缺省/非法端口 → open-err，不静默。
    // 必须前置校验——构造器对非法 port 同步抛错，open() 是 async，
    // host 侧 void 调用会让其成为 unhandled rejection（Node≥20 默认 crash）。
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
      void dcSend(dc, { k: 'ws-open-err', wid: frame.wid });
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://localhost:${port}${frame.path}`);
    } catch {
      // 防御纵深：一个坏帧（如非法 path）绝不能把被控端进程带走
      void dcSend(dc, { k: 'ws-open-err', wid: frame.wid });
      return;
    }
    this.sockets.set(frame.wid, ws);
    ws.on('open', () => { void dcSend(dc, { k: 'ws-open-ok', wid: frame.wid }); });
    ws.on('error', () => { void dcSend(dc, { k: 'ws-open-err', wid: frame.wid }); });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) void dcSend(dc, { k: 'ws-msg', wid: frame.wid, text: data.toString('utf8') });
      else if (dc.binaryOk) void dcSendBin(dc, encodeWsMsgBin(frame.wid, data));
      else void dcSend(dc, { k: 'ws-msg', wid: frame.wid, dataB64: data.toString('base64') });
    });
    ws.on('close', (code: number, reason: Buffer) => {
      void dcSend(dc, { k: 'ws-close', wid: frame.wid, code, reason: reason.toString('utf8') });
      this.sockets.delete(frame.wid);
    });
  }

  /** 全量关闭本地 socket（host 断开时调用）。 */
  closeAll(): void {
    for (const ws of this.sockets.values()) {
      try { ws.close(); } catch { /* 已关闭 */ }
    }
    this.sockets.clear();
  }
}
