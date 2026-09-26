/**
 * 桌面出站隧道客户端（Node only，`ws` 包）—— 兜底模式下桌面 → relay 的常驻连接。
 *
 * 语义（plan Task 11）：
 * - `connect(url)`：url 即完整地址（含 sid/token query，如
 *   `wss://<host>/tunnel/desktop?sid=<uuid>&token=<hmac hex>`；token 计算归调用方，本类不做鉴权）。
 * - 断线指数退避重连：1s→2s→4s→…→30s 封顶，抖动 ±20%（`backoffDelayMs` 纯函数，可注入 rand 单测）；
 *   初始连接失败（ECONNREFUSED 等）同样进入重连循环——relay-bj 重启后桌面自动恢复（验收口径 ≤30s）。
 * - 应用层心跳看门狗（2026-09-26 僵尸腿根修）：open 后每 15s 发一次 ws `ping()`；连续 2 个周期
 *   无 pong（约 30-35s 无活性）即判死——`terminate()` 交由既有 close→退避重连接管。中间设备静默
 *   回收 TCP 会话时 close 事件可迟到数小时，只靠山洪重连 = status 假绿灯（隧道腿 1/1 在线而 relay
 *   已对 PWA 502）。判死一刻先闩 `legDead`（`isAlive` 立即如实报死）再回调 `onLegDead`（宿主记事件）。
 *   拍点状态推进为纯函数 `heartbeatAdvance`（仿 backoffDelayMs 风格），计时器经 `clock` 注入（假时钟单测）。
 * - 重连成功（曾断开过、重新 open）触发 `onReconnect` 回调：宿主在此时重接桥/重放状态；
 *   同时心跳状态复位（缺席计数清零、重新起表）。
 * - `onFrame(cb)`：relay 下发的帧（JSON 解码后）原样透传给宿主（主会话在桌面侧接进既有
 *   HttpBridge/WsBridge——本类只透传不路由）；`send(obj)` 把帧发往 relay（未连接时静默丢弃，
 *   在途请求由 relay 侧 504 兜底）。
 * - `close()`：干净退出（1000），停止重连与心跳一切计时器。
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

export interface HeartbeatOptions {
  /** ping 发送间隔；默认 15000ms。 */
  intervalMs?: number;
  /** 连续多少个周期无 pong 即判死（terminate 交退避重连接管）；默认 2。 */
  tolerateMisses?: number;
}

/** 心跳一拍的状态推进（纯函数，仿 backoffDelayMs 可单测）：pong 到 → 缺席归零；累计 ≥ 容忍 → 判死。 */
export function heartbeatAdvance(missed: number, gotPong: boolean, tolerateMisses: number): { missed: number; dead: boolean } {
  const next = gotPong ? 0 : missed + 1;
  return { missed: next, dead: next >= tolerateMisses };
}

/** 周期计时器（setInterval 语义）——心跳测试缝：生产为全局计时器（unref），单测注假时钟手动驱动拍点。 */
export interface IntervalClock {
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const SYS_CLOCK: IntervalClock = {
  setInterval: (cb, ms) => {
    const t = setInterval(cb, ms);
    t.unref?.();
    return t;
  },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export interface TunnelClientOptions {
  backoff?: BackoffOptions;
  heartbeat?: HeartbeatOptions;
  /** 心跳计时器注入（缺省全局 unref setInterval）。 */
  clock?: IntervalClock;
}

const DEFAULT_BACKOFF: Required<BackoffOptions> = { baseMs: 1000, maxMs: 30000, jitter: 0.2 };
const DEFAULT_HEARTBEAT: Required<HeartbeatOptions> = { intervalMs: 15_000, tolerateMisses: 2 };

export class TunnelClient {
  private backoff: Required<BackoffOptions>;
  private heartbeat: Required<HeartbeatOptions>;
  private clock: IntervalClock;
  private url?: string;
  private ws?: WebSocket;
  private timer?: NodeJS.Timeout;
  private attempt = 0;
  private closedByUser = false;
  private frameCb?: (frame: unknown) => void;
  private reconnectCb?: () => void;
  private legDeadCb?: () => void;
  /** 心跳表句柄（clock.clearInterval 配对）。 */
  private hbHandle?: unknown;
  /** 连续无 pong 周期数（heartbeatAdvance 推进）。 */
  private hbMissed = 0;
  /** 本周期是否已收 pong（每拍消费后清零）。 */
  private pongInPeriod = false;
  /** 判死闩锁：terminate 落地（close 事件）前 isAlive 即如实报死；重连 open 时复位。 */
  private legDead = false;

  constructor(opts?: TunnelClientOptions) {
    this.backoff = { ...DEFAULT_BACKOFF, ...opts?.backoff };
    this.heartbeat = { ...DEFAULT_HEARTBEAT, ...opts?.heartbeat };
    this.clock = opts?.clock ?? SYS_CLOCK;
  }

  /** 当前连接是否可用（OPEN）。 */
  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** 链路活性（心跳口径）：OPEN 且看门狗未判死——status 在线计数以此为准，不信 readyState 假绿灯。 */
  get isAlive(): boolean {
    return this.isOpen && !this.legDead;
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

  /** 心跳判死时回调（terminate 前一刻；宿主记 tunnel_leg_dead 事件）。重复注册后者覆盖前者。 */
  onLegDead(cb: () => void): void {
    this.legDeadCb = cb;
  }

  /** 发帧给 relay（JSON 序列化）。未连接时静默丢弃——隧道语义下在途请求由 relay 504 兜底。 */
  send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** 干净退出：停止重连循环与心跳，并关闭当前连接。 */
  close(): void {
    this.closedByUser = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.stopHeartbeat();
    try { this.ws?.close(1000); } catch { /* 已关闭 */ }
  }

  private open(): void {
    if (!this.url || this.closedByUser) return;
    const ws = this.ws = new WebSocket(this.url);
    ws.on('open', () => {
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      const wasRetry = this.attempt > 0;
      this.attempt = 0;
      this.startHeartbeat();
      if (wasRetry) this.reconnectCb?.();
    });
    ws.on('message', (data: Buffer) => {
      const frame = decodeFrame(data);
      if (frame !== null) this.frameCb?.(frame);
    });
    ws.on('pong', () => { this.pongInPeriod = true; });
    ws.on('close', () => {
      this.stopHeartbeat();
      this.scheduleReconnect();
    });
    ws.on('error', () => { /* close 事件随后必到，重连统一在 close 处理 */ });
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || !this.url) return;
    this.attempt += 1;
    const delay = backoffDelayMs(this.attempt, this.backoff, Math.random());
    this.timer = setTimeout(() => this.open(), delay);
    this.timer.unref?.();
  }

  /** open 时（重）起心跳表：状态全复位——重连成功后旧腿的缺席/判死不残留。 */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.hbMissed = 0;
    this.pongInPeriod = false;
    this.legDead = false;
    this.hbHandle = this.clock.setInterval(() => this.heartbeatTick(), this.heartbeat.intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.hbHandle !== undefined) {
      this.clock.clearInterval(this.hbHandle);
      this.hbHandle = undefined;
    }
  }

  /** 心跳一拍：清算上周期 pong → 判死（terminate 交退避重连接管）或发下一拍 ping。 */
  private heartbeatTick(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return; // 连接已不在：close 事件负责停表
    const r = heartbeatAdvance(this.hbMissed, this.pongInPeriod, this.heartbeat.tolerateMisses);
    this.hbMissed = r.missed;
    this.pongInPeriod = false;
    if (r.dead) {
      this.legDead = true;
      this.stopHeartbeat();
      this.legDeadCb?.();
      try { ws.terminate(); } catch { /* close 事件兜底重连 */ }
      return;
    }
    try { ws.ping(); } catch { /* 发送失败交由 close/error 路径 */ }
  }
}
