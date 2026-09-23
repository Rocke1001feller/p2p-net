/**
 * 浏览器侧 WebRTC 会话（offerer）—— POC poc/webrtc-pwa/pwa/local/index.html:75-184 的产品化平移。
 * 三条健壮性规则原样平移：① ICE 竞态缓冲（远端描述未设前入队，设后按序排空）；
 * ② 最新会话优先（新 connect 即拆旧 pc）；③ sid 守卫（answer/ice 只认当前 sid）。
 *
 * 信令：p2p 库 SignalingClient（PostgREST 表 signaling_messages，RLS owner-only）。
 * 房间语义：本端轮询自己房间 roomFor(uid, myDeviceId) 等 answer/ice；offer/ice 发往桌面房间
 * roomFor(uid, deskDeviceId)，from = 本端 deviceId（host 侧按 from 回写应答房间）。
 * ctrl 通道：unordered+maxRetransmits 0（POC 踩坑：绝不用 ordered 通道测 RTT）。
 * 状态灯：原生 getStats → p2p 库 pairTypeFromStats/rttFromStats（werift 无 selected、浏览器有——
 * 库内两判据都写，此处直接复用）。
 */
import { pairTypeFromStats, roomFor, rttFromStats, relayAddrFromStats, SignalingClient, decodeBinFrame, encodeWsMsgBin, PROXY_POOL_SIZE } from 'p2p-net/browser';
import { PoolRouter } from './poolRouter.js';

export interface LightStatus {
  state: 'off' | 'connecting' | 'connected' | 'failed';
  pairType: 'p2p' | 'relay' | null;
  rttMs?: number;
  relayAddr?: string;
}

export interface SessionOptions {
  signaling: SignalingClient;
  uid: string;
  myDeviceId: string;
  iceServers: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  onStatus: (s: LightStatus) => void;
  /** proxy 通道上的隧道帧（req 响应帧由 shell 消费；ws-* 转发进对应 tab iframe）。 */
  onFrame: (frame: any) => void;
}

const POLL_MS = 800;          // plan Task 4：800ms 增量轮询
const PURGE_MS = 60_000;
const STATS_MS = 5_000;
const PING_MS = 5_000;
/**
 * 去活判定窗口（2026-09-12 根因修复；2026-09-23 蜂窝浸泡放宽 15s→45s）：ctrl 通道心跳
 * 连续收不到 pong 超此窗口即判链路已死。15s 的代价：蜂窝 4G 的 RRC 切换/信号波动造成
 * 6-15s 丢包簇是常态（ctrl 为测真 RTT 用 unordered+零重传，丢包不重发），真机实测
 * 6630ms 尖峰频繁出现，15s 窗口把「蜂窝打嗝」误判成「P2P 黑洞」，每次误判都触发
 * 整页全量重下。45s ≈ 9 个心跳周期，真黑洞检测延迟仍在 SW 单请求超时（45s）量级内。
 * 真机实证背景（15s 版）：P2P 黑洞时 dc.readyState 仍是 'open'，isOpen 因此撒谎 →
 * 界面显示"直连"、不重连，请求只能干等 SW 超时（Android 直连下 Files/Source Control 全 504）。
 */
const LIVENESS_MS = 45_000;

/**
 * proxy 通道入站帧处理（抽成纯函数便于单测，2026-09-23 心跳误判整改）。
 * 任何合法帧都先记活性证明再上交路由：批量传输期间 ctrl 心跳（unordered 不重传）
 * 会被饿死/丢失，但数据在流本身就是活着的证据，绝不能在传输中误判死亡拆连。
 */
export function handleProxyMessage(data: string, sinks: { onProof: () => void; onFrame: (m: unknown) => void }): void {
  try {
    const m = JSON.parse(data);
    sinks.onProof();
    sinks.onFrame(m);
  } catch { /* 非法帧丢弃 */ }
}

/** 通道入站统一解码（帧协议 v2）：字符串走 JSON；ArrayBuffer 走二进制帧。
 *  任何合法帧都先记活性证明——批量传输期数据在流本身就是活着的证据。 */
export function handleChannelMessage(data: string | ArrayBuffer, sinks: { onProof: () => void; onFrame: (m: unknown) => void }): void {
  if (typeof data === 'string') return handleProxyMessage(data, sinks);
  const bf = decodeBinFrame(new Uint8Array(data));
  if (!bf) return;
  sinks.onProof();
  sinks.onFrame(bf);
}

function b64ToU8(b: string): Uint8Array {
  const bin = atob(b);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export class WebRtcSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;   // = dcs[0] 别名：isOpen / 心跳回退 / teardown 兼容锚点
  private dcs: RTCDataChannel[] = [];
  private router: PoolRouter | null = null;
  private ctrlDc: RTCDataChannel | null = null;
  private sid: string | null = null;
  private deskDeviceId: string | null = null;
  private remoteSet = false;
  private readonly iceQueue: RTCIceCandidateInit[] = [];
  private cursor = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;

  constructor(private readonly opts: SessionOptions) {}

  get isOpen(): boolean {
    // 诚实版 isOpen：通道 open **且** 心跳新鲜。否则就是"假直连"，必须让上层走重连/降级。
    return this.dc?.readyState === 'open' && Date.now() - this.lastPongAt < LIVENESS_MS;
  }

  /** 建连（可重复调用 = 重连，规则②：拆旧换新）。 */
  async connect(deskDeviceId: string): Promise<void> {
    this.teardown();
    this.deskDeviceId = deskDeviceId;
    this.sid = Math.random().toString(36).slice(2, 10);
    this.cursor = 0;
    this.remoteSet = false;
    this.iceQueue.length = 0;
    this.opts.onStatus({ state: 'connecting', pairType: null });

    const pc = this.pc = new RTCPeerConnection({
      iceServers: this.opts.iceServers,
      iceTransportPolicy: this.opts.iceTransportPolicy ?? 'all',
    });
    pc.onicecandidate = (e) => {
      if (e.candidate && this.sid && this.deskDeviceId) {
        void this.opts.signaling.send(
          roomFor(this.opts.uid, this.deskDeviceId),
          this.opts.myDeviceId,
          { type: 'ice', sid: this.sid, cand: e.candidate.toJSON(), from: this.opts.myDeviceId },
        ).catch((e) => { console.log(`[sig] 发送失败（后续候选/重连补偿）: ${e instanceof Error ? e.message : e}`); });
      }
    };
    pc.onconnectionstatechange = () => void this.emitPcStatus();

    // proxy 通道池（spec D2）：req 恒走 proxy0；res/ws 由 host 按 id/wid 粘滞选最闲。
    // 每条通道都是活性证明来源——任何通道回帧都刷 lastPongAt（handleChannelMessage 语义不变：
    // 字符串走 JSON、ArrayBuffer 走帧协议 v2 二进制解码，Task 3 双端同批）。
    const dcs: RTCDataChannel[] = [];
    for (let i = 0; i < PROXY_POOL_SIZE; i++) {
      const ch = pc.createDataChannel(i === 0 ? 'proxy' : `proxy${i}`);
      // 二进制帧必须同步解码：浏览器默认 blob 形态无法同步读，先切 arraybuffer 再挂 onmessage。
      ch.binaryType = 'arraybuffer';
      ch.onmessage = (ev) => {
        handleChannelMessage(ev.data, {
          onProof: () => { this.lastPongAt = Date.now(); },
          onFrame: (m) => this.opts.onFrame(m),
        });
      };
      dcs.push(ch);
    }
    const dc = this.dc = dcs[0]!;
    this.dcs = dcs;
    this.router = new PoolRouter(() => this.dcs);
    dc.onopen = () => {
      this.lastPongAt = Date.now();
      this.opts.onStatus({ state: 'connected', pairType: null });
      void this.refreshStats();
    };
    dc.onclose = () => this.opts.onStatus({ state: 'off', pairType: null });

    // 带外控制通道（unordered + 不重传）：ping/pong 不与批量数据同队排队，RTT 才反映真实链路
    const ctrl = this.ctrlDc = pc.createDataChannel('ctrl', { ordered: false, maxRetransmits: 0 });
    ctrl.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.k === 'pong') {
          this.lastPongAt = Date.now(); // 心跳新鲜度（去活判定唯一依据）
          this.opts.onStatus({ state: 'connected', pairType: this.lastPairType, rttMs: Date.now() - m.t });
        }
      } catch { /* 忽略 */ }
    };

    await pc.setLocalDescription(await pc.createOffer());
    await this.opts.signaling.send(
      roomFor(this.opts.uid, deskDeviceId),
      this.opts.myDeviceId,
      { type: 'offer', sid: this.sid, sdp: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp }, from: this.opts.myDeviceId },
    );

    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    this.purgeTimer = setInterval(() => {
      void this.opts.signaling.purgeExpired(roomFor(this.opts.uid, this.opts.myDeviceId)).catch(() => {});
    }, PURGE_MS);
    this.statsTimer = setInterval(() => { if (this.isOpen) void this.refreshStats(); }, STATS_MS);
    this.pingTimer = setInterval(() => {
      // 优先 ctrl；对端无 ctrl 时回退 proxy（POC 兼容语义）
      const ch = (this.ctrlDc && this.ctrlDc.readyState === 'open') ? this.ctrlDc
        : (this.dc && this.dc.readyState === 'open' ? this.dc : null);
      if (ch) { try { ch.send(JSON.stringify({ k: 'ping', t: Date.now() })); } catch { /* 忽略 */ } }
    }, PING_MS);
    // 看门狗：心跳断供即判死 → 通知上层（CascadeSession 会转发 off，shell 走重连/降级）
    this.watchdogTimer = setInterval(() => {
      if (this.dc?.readyState !== 'open') return;
      if (Date.now() - this.lastPongAt < LIVENESS_MS) return;
      this.opts.onStatus({ state: 'off', pairType: null });
      this.teardown();
    }, 2_000);
  }

  private lastPairType: 'p2p' | 'relay' | null = null;
  private lastRelayAddr?: string;

  private async emitPcStatus(): Promise<void> {
    const st = this.pc?.connectionState;
    if (st === 'connected') {
      await this.refreshStats();
    } else if (st === 'failed') {
      this.opts.onStatus({ state: 'failed', pairType: null });
    } else if (st === 'connecting' || st === 'new' || st === 'disconnected') {
      // disconnected 是瞬时态：显式回落到"连接中"语义，别让界面继续假装已连接
      this.opts.onStatus({ state: 'connecting', pairType: this.lastPairType });
    }
  }

  private statsToRows(report: RTCStatsReport): Record<string, any>[] {
    const rows: Record<string, any>[] = [];
    report.forEach((v: any) => rows.push(v));   // 兼容 forEach-only 形态（POC 同款）
    return rows;
  }

  private async refreshStats(): Promise<void> {
    if (!this.pc) return;
    try {
      const rows = this.statsToRows(await this.pc.getStats());
      this.lastPairType = pairTypeFromStats(rows);
      const rtt = rttFromStats(rows);
      const relayAddr = relayAddrFromStats(rows);
      if (relayAddr) this.lastRelayAddr = relayAddr;
      this.opts.onStatus({
        state: this.isOpen ? 'connected' : 'connecting',
        pairType: this.lastPairType,
        ...(rtt !== undefined ? { rttMs: rtt } : {}),
        ...(this.lastRelayAddr ? { relayAddr: this.lastRelayAddr } : {}),
      });
    } catch { /* stats 失败不影响链路 */ }
  }

  /** proxy 池出站（背压 8MiB，POC dcSend 同语义）：req→proxy0；ws-open/msg/close 按 PoolRouter 粘滞。 */
  async send(frame: unknown): Promise<void> {
    const idx = this.router?.channelFor(frame) ?? 0;
    const dc = this.dcs[idx] ?? this.dc;
    if (!dc || dc.readyState !== 'open') return;
    // ws 上行二进制体：直接上二进制帧（省 33% 线税 + 双端编解码 CPU）
    const f = frame as { k?: string; wid?: number; dataB64?: string };
    if (f.k === 'ws-msg' && typeof f.dataB64 === 'string') {
      if (!(await this.waitSendSlot(dc))) return;
      // encodeWsMsgBin 产出为新分配整体帧（byteOffset=0），.buffer 即完整字节——库 d.ts 的
      // Uint8Array<ArrayBufferLike> 与 TS 5.7+ 的 ArrayBufferView<ArrayBuffer> 重载不兼容，
      // 走 ArrayBuffer 重载发送（线上字节与直接 send(Uint8Array) 完全相同）。
      dc.send(encodeWsMsgBin(f.wid!, b64ToU8(f.dataB64)).buffer as ArrayBuffer);
      return;
    }
    const s = JSON.stringify(frame);
    if (!(await this.waitSendSlot(dc))) return;
    dc.send(s);
  }

  /** 背压等待（8MiB，5s 封顶）：黑洞通道只涨不落，超时即认通道已死（2026-09-12 语义不变）。 */
  private async waitSendSlot(dc: RTCDataChannel): Promise<boolean> {
    const deadline = Date.now() + 5_000;
    while (dc.bufferedAmount > 8 * 1024 * 1024) {
      if (Date.now() > deadline) {
        this.opts.onStatus({ state: 'off', pairType: null });
        this.teardown();
        return false;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return true;
  }

  private async poll(): Promise<void> {
    try {
      const { msgs, cursor } = await this.opts.signaling.poll(roomFor(this.opts.uid, this.opts.myDeviceId), this.cursor);
      this.cursor = cursor;
      for (const row of msgs) {
        const m = row.payload;
        if (!this.sid || m.sid !== this.sid) continue;   // 规则③ sid 守卫
        if (m.type === 'answer' && m.sdp && this.pc && !this.remoteSet) {
          await this.pc.setRemoteDescription(m.sdp as RTCSessionDescriptionInit);
          await this.flushIce();
        } else if (m.type === 'ice' && m.cand) {
          await this.addIce(m.cand);
        }
      }
    } catch (e) { console.log(`[sig] 轮询失败（下一 tick 重试）: ${e instanceof Error ? e.message : e}`); }
  }

  /** 规则① ICE 竞态缓冲。 */
  private async addIce(cand: RTCIceCandidateInit): Promise<void> {
    if (!this.pc) return;
    if (this.remoteSet) { try { await this.pc.addIceCandidate(cand); } catch { /* 单个候选失败可忽略 */ } }
    else this.iceQueue.push(cand);
  }

  private async flushIce(): Promise<void> {
    this.remoteSet = true;
    while (this.iceQueue.length) {
      try { await this.pc?.addIceCandidate(this.iceQueue.shift()!); } catch { /* 单个候选失败可忽略 */ }
    }
  }

  teardown(): void {
    for (const t of [this.pollTimer, this.purgeTimer, this.statsTimer, this.pingTimer, this.watchdogTimer]) {
      if (t) clearInterval(t);
    }
    this.pollTimer = this.purgeTimer = this.statsTimer = this.pingTimer = this.watchdogTimer = null;
    if (this.ctrlDc) { try { this.ctrlDc.close(); } catch { /* 忽略 */ } this.ctrlDc = null; }
    for (const ch of this.dcs) { try { ch.close(); } catch { /* 忽略 */ } }
    this.dcs = [];
    this.dc = null;
    this.router = null;
    if (this.pc) { try { this.pc.close(); } catch { /* 忽略 */ } this.pc = null; }
    this.sid = null;
    this.remoteSet = false;
    this.iceQueue.length = 0;
    this.lastPairType = null;
    this.lastRelayAddr = undefined;
  }
}
