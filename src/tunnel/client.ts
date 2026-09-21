/**
 * 桌面出站隧道客户端（Node only，`ws` 包）—— 兜底模式下桌面 → relay 的常驻连接。
 *
 * 语义（plan Task 11）：
 * - `connect(url)`：url 即完整地址（含 sid/token query，如
 *   `wss://<host>/tunnel/desktop?sid=<uuid>&token=<hmac hex>`；token 计算归调用方，本类不做鉴权）。
 * - 断线指数退避重连：1s→2s→4s→…→30s 封顶，抖动 ±20%（`backoffDelayMs` 纯函数，可注入 rand 单测）；
 *   初始连接失败（ECONNREFUSED 等）同样进入重连循环——relay-bj 重启后桌面自动恢复（验收口径 ≤30s）。
 * - 重连成功（曾断开过、重新 open）触发 `onReconnect` 回调：宿主在此时重接桥/重放状态。
 * - `onFrame(cb)`：relay 下发的帧（JSON 解码后）原样透传给宿主（主会话在桌面侧接进既有
 *   HttpBridge/WsBridge——本类只透传不路由）；`send(obj)` 把帧发往 relay（未连接时静默丢弃，
 *   在途请求由 relay 侧 504 兜底）。
 * - `close()`：干净退出（1000），停止重连。
 */
import { WebSocket } from 'ws';
import { decodeFrame } from '../frames.js';

export interface BackoffOptions {
  /** 首次重连延迟；默认 1000ms。 */
  baseMs?: number;
  /** 延迟封顶；默认 30000ms。 */
  maxMs?: number;
  /** 抖动比例（±）；默认 0.2。 */
  jitter?: number;
}

/** 第 attempt 次（1 起）重连前的等待：min(base·2^(attempt-1), max) × (1 ± jitter)。 */
export function backoffDelayMs(attempt: number, opts: Required<BackoffOptions>, rand: number): number {
  const raw = Math.min(opts.baseMs * 2 ** Math.max(0, attempt - 1), opts.maxMs);
  return Math.max(0, Math.round(raw * (1 + (rand * 2 - 1) * opts.jitter)));
}

export interface TunnelClientOptions {
  backoff?: BackoffOptions;
}

const DEFAULT_BACKOFF: Required<BackoffOptions> = { baseMs: 1000, maxMs: 30000, jitter: 0.2 };

export class TunnelClient {
  private backoff: Required<BackoffOptions>;
  private url?: string;
  private ws?: WebSocket;
  private timer?: NodeJS.Timeout;
  private attempt = 0;
  private closedByUser = false;
  private frameCb?: (frame: unknown) => void;
  private reconnectCb?: () => void;

  constructor(opts?: TunnelClientOptions) {
    this.backoff = { ...DEFAULT_BACKOFF, ...opts?.backoff };
  }

  /** 当前连接是否可用（OPEN）。 */
  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(url: string): void {
    this.url = url;
    this.closedByUser = false;
    this.open();
  }

  /** 帧入口：relay 下发的每一帧（已 JSON 解码）回调给宿主。重复注册后者覆盖前者。 */
  onFrame(cb: (frame: unknown) => void): void {
    this.frameCb = cb;
  }

  /** 断线后重新连上时回调（首次 connect 成功不触发）。重复注册后者覆盖前者。 */
  onReconnect(cb: () => void): void {
    this.reconnectCb = cb;
  }

  /** 发帧给 relay（JSON 序列化）。未连接时静默丢弃——隧道语义下在途请求由 relay 504 兜底。 */
  send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** 干净退出：停止重连循环并关闭当前连接。 */
  close(): void {
    this.closedByUser = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    try { this.ws?.close(1000); } catch { /* 已关闭 */ }
  }

  private open(): void {
    if (!this.url || this.closedByUser) return;
    const ws = this.ws = new WebSocket(this.url);
    ws.on('open', () => {
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      const wasRetry = this.attempt > 0;
      this.attempt = 0;
      if (wasRetry) this.reconnectCb?.();
    });
    ws.on('message', (data: Buffer) => {
      const frame = decodeFrame(data);
      if (frame !== null) this.frameCb?.(frame);
    });
    ws.on('close', () => this.scheduleReconnect());
    ws.on('error', () => { /* close 事件随后必到，重连统一在 close 处理 */ });
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || !this.url) return;
    this.attempt += 1;
    const delay = backoffDelayMs(this.attempt, this.backoff, Math.random());
    this.timer = setTimeout(() => this.open(), delay);
    this.timer.unref?.();
  }
}
