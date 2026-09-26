/**
 * werift RTCPeerConnection 生命周期包装（Node host 侧）。
 *
 * 从 POC（poc/webrtc-pwa host/index.html）平移的三条重连健壮性规则：
 *  1. ICE 竞态缓冲：远端描述未设置前到达的候选先入队，setRemoteDescription 后按序排空；
 *  2. 最新 offer 优先：新 sid 到来即 close 旧 pc 换绑新会话；
 *  3. sid 守卫：同 sid 的重复 offer 不重建连接。
 *
 * 状态灯：getStats candidate-pair → 'p2p'|'relay'（见 status.ts；判定字段以 gate4 取证为准）。
 */
import { RTCPeerConnection, type RTCDataChannel, type RTCIceServer } from 'werift';
import { pairTypeFromStats, relayAddrFromStats, rttFromStats, type StatsRow } from './status.js';
import { attachConsentWatchdog, type ConsentWatchdogEvent, type IceTransportsOwner } from './consent-watchdog.js';
import type { IceCandidateLike, SdpLike } from './signaling/protocol.js';

export interface LinkStatus {
  /**
   * 'disconnected' = ICE 的**可自愈瞬时态**（RFC 8445：等 STUN 保活/重传即可能回到 connected）。
   * 2026-09-12 根因修复：此前把 disconnected 并入 'failed'，导致被控端在蜂窝抖动时把会话当死会话
   * 摘除——在途请求与 ICE 路由一起丢失，客户端又因 dc.readyState 仍是 open 显示"假直连"，
   * 于是所有请求只能等 SW 30s 超时（真机实证：Android 直连下 Files/Source Control 全 504）。
   * 只有 pc 自报 'failed' 才是真失败。
   */
  state: 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
  pairType: 'p2p' | 'relay' | null;
  relayAddr?: string;
  rttMs?: number;
}

export interface PeerHandlers {
  onChannel: (dc: RTCDataChannel, label: string) => void;
  onIce: (cand: IceCandidateLike) => void;
  onStatus: (s: LinkStatus) => void;
}

/** Peer 依赖的最小 pc 结构（单测注入 stub 用；werift RTCPeerConnection 满足此结构）。 */
export interface PcLike {
  connectionState: 'closed' | 'disconnected' | 'new' | 'connected' | 'failed' | 'connecting';
  localDescription: SdpLike | null;
  ondatachannel: ((ev: { channel: RTCDataChannel }) => void) | null;
  onicecandidate: ((ev: { candidate?: { toJSON(): IceCandidateLike } }) => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  onconnectionstatechange: (() => void) | null;
  setRemoteDescription(desc: SdpLike): Promise<void>;
  setLocalDescription(desc?: SdpLike): Promise<unknown>;
  createOffer(): Promise<SdpLike>;
  createAnswer(): Promise<SdpLike>;
  addIceCandidate(cand: IceCandidateLike): Promise<void>;
  createDataChannel(label: string, opts?: { ordered?: boolean; maxRetransmits?: number }): RTCDataChannel;
  getStats(): Promise<Map<string, StatsRow>>;
  close(): void | Promise<void>;
}

export interface IceQueue {
  add(c: IceCandidateLike): void;
  drain(): IceCandidateLike[];
  reset(): void;
  readonly size: number;
}

export function makeIceQueue(): IceQueue {
  let items: IceCandidateLike[] = [];
  return {
    add(c) { items.push(c); },
    drain() { const out = items; items = []; return out; },
    reset() { items = []; },
    get size() { return items.length; },
  };
}

const STATS_INTERVAL_MS = 5000;

export class Peer {
  pc?: PcLike;
  curSid?: string;
  private remoteSet = false;
  private iceQueue: IceQueue = makeIceQueue();
  /** 最近一次 addIce 主路径失败原因（兜底成功后仍保留，供排障/状态上报） */
  private lastIceError: string | null = null;
  /** 靠"去 ufrag 兜底"才加进去的候选数：>0 即证明主路径在丢**本可用**的候选 */
  private iceTolerantAdds = 0;
  private statusCb?: (s: LinkStatus) => void;
  private statsTimer?: ReturnType<typeof setInterval>;
  private lastStats: { pairType: 'p2p' | 'relay' | null; rttMs?: number; relayAddr?: string } = { pairType: null };
  private detachConsent?: () => void;

  constructor(
    private iceServers: RTCIceServer[] = [],
    private opts: { transport?: 'all' | 'relay'; pcFactory?: () => PcLike; consent?: { intervalMs?: number; maxRevives?: number; healthyResetMs?: number } } = {},
  ) {}

  private newPc(): PcLike {
    if (this.opts.pcFactory) return this.opts.pcFactory();
    // werift 结构满足 PcLike；仅个别描述类型更严，此处收窄安全（集成测全程走真实对象）
    return new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: this.opts.transport ?? 'all',
    }) as unknown as PcLike;
  }

  private dispose(): void {
    if (this.detachConsent) { this.detachConsent(); this.detachConsent = undefined; }
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = undefined; }
    if (this.pc) { try { void this.pc.close(); } catch { /* 已关闭 */ } }
  }

  /** ICE consent 看门狗（spec D3）：pc 建好即挂；stub pc 无 iceTransports → 看门狗内部零副作用。 */
  private armConsentWatchdog(pc: PcLike): void {
    this.detachConsent?.();
    this.detachConsent = attachConsentWatchdog(pc as unknown as IceTransportsOwner, {
      intervalMs: this.opts.consent?.intervalMs,
      maxRevives: this.opts.consent?.maxRevives,
      healthyResetMs: this.opts.consent?.healthyResetMs,
      onEvent: (e) => this.onConsentEvent(e),
    });
  }

  private onConsentEvent(e: ConsentWatchdogEvent): void {
    if (e.kind === 'revive') {
      // 复活是可观测的异常事件（正常链路永不触发），进 stderr 留证据
      console.error(`[p2p-net] ICE consent 复活第 ${e.revives} 次（iceState=${e.iceState} consentFresh=${e.consentFresh}）——werift #69 兜底生效`);
      return;
    }
    // give-up：复活上限已到，链路真的死了——走既有失败链路（宽限→expireSession→session_end）
    console.error(`[p2p-net] ICE consent 复活 ${e.revives} 次仍死——上报 failed`);
    this.statusCb?.({ state: 'failed', ...this.lastStats });
  }

  /** 规则3 sid 归属守卫的前半 + 规则2 最新 offer 优先换绑 */
  async acceptOffer(sid: string, sdp: SdpLike, handlers: PeerHandlers): Promise<void> {
    if (sid === this.curSid) return;
    this.dispose();
    this.curSid = sid;
    this.remoteSet = false;
    this.iceQueue = makeIceQueue();
    this.lastStats = { pairType: null };
    this.statusCb = handlers.onStatus;
    const pc = this.pc = this.newPc();
    this.armConsentWatchdog(pc);
    pc.ondatachannel = (ev) => handlers.onChannel(ev.channel, ev.channel.label);
    pc.onicecandidate = (ev) => {
      const c = ev.candidate as ( undefined | { toJSON?: () => IceCandidateLike });
      if (!c) return;
      handlers.onIce(typeof c.toJSON === 'function' ? c.toJSON() : (c as unknown as IceCandidateLike));
    };
    pc.onconnectionstatechange = () => {
      void this.refreshStats().then(() => this.emitStatus());
      this.scheduleStats();
    };
    await pc.setRemoteDescription(sdp);
    this.remoteSet = true;
    for (const c of this.iceQueue.drain()) {
      // 陈旧会话的候选（跨 offer 重放）会 ufrag 不匹配——单条隔离，不拖垮 acceptOffer。
      // 但"同会话 ufrag 对不上"的候选必须救回来：见 addIceTolerant 注释。
      await this.addIceTolerant(pc, c, 'addIce(queued) skipped');
    } // 规则1 ICE 竞态缓冲排空
    await pc.setLocalDescription(await pc.createAnswer());
  }

  /** 升级轮重协商（W2-6，spike §1.4-1：host 只作受控应答方）：同一 PC 原位应答 ICE restart offer。
   *  不 dispose、不换 PC、不重挂 handlers（ondatachannel/onicecandidate/onconnectionstatechange/statusCb 全部存续），
   *  不动 iceQueue/remoteSet——werift setRemoteDescription 见新 ufrag 自动对称 restart（spike §1.1），
   *  新 ufrag 候选经 addIce→addIceTolerant 常态链路被吸收。sid 守卫：只认当前会话。 */
  async acceptRestartOffer(sid: string, sdp: SdpLike): Promise<boolean> {
    if (sid !== this.curSid || !this.pc) return false;
    await this.pc.setRemoteDescription(sdp);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    return true;
  }

  async addIce(cand: IceCandidateLike): Promise<void> {
    if (!this.remoteSet) { this.iceQueue.add(cand); return; }
    if (!this.pc) return;
    await this.addIceTolerant(this.pc, cand, 'addIce skipped');
  }

  /**
   * 加入远端 ICE 候选（带"去 ufrag"兜底）。
   *
   * 为什么需要兜底（2026-09-12 真机取证）：数据面 PC 只有一个 media section（application），
   * 而 werift 在候选**带 usernameFragment** 时会去 remote SDP 里找同一个 ufrag 的 media section，
   * 找不到就整个候选都不加。于是有两类候选被丢掉：
   *   ① 跨会话重放的陈旧候选 —— 丢掉是对的；
   *   ② **同一会话但因重协商/浏览器实现差异导致 ufrag 对不上** —— 丢掉是灾难：
   *      ICE 候选集残缺 → 连接"看似成功"（DC open、控制帧正常）但数据面时通时断。
   *      真机实证：桌面日志连刷 24 行 `No media section matched the ICE usernameFragment`，
   *      桌面对端 `pairType=relay` 而手机侧显示"直连"，控制台首屏资源间歇 504。
   * ufrag 只是提示，mid/index 足以定位 media section，所以去掉它再试一次是安全的。
   */
  private async addIceTolerant(pc: PcLike, cand: IceCandidateLike, tag: string): Promise<void> {
    try { await pc.addIceCandidate(cand); return; } catch (e) {
      this.lastIceError = e instanceof Error ? e.message : String(e);
    }
    const { usernameFragment: _ufrag, ...withoutUfrag } = cand;
    try {
      await pc.addIceCandidate(withoutUfrag);
      this.iceTolerantAdds += 1;
      // 只报前几次：>0 就说明主路径确实在丢**可用**候选（真机排障的关键指标）
      if (this.iceTolerantAdds <= 3) {
        console.error(`[p2p-net] addIce 兜底成功（去 ufrag）第 ${this.iceTolerantAdds} 次 —— 主路径丢失了可用候选`);
      }
      return;
    } catch (e2) {
      console.error(`[p2p-net] ${tag}:`, e2 instanceof Error ? e2.message : e2,
        `（首次失败：${this.lastIceError ?? 'n/a'}）`);
    }
  }

  /** 换用新 ICE 服务器配置（turnFetcher 刷新后调用；下一次 acceptOffer/connectAsClient 生效）。 */
  setIceServers(list: RTCIceServer[]): void {
    this.iceServers = list;
  }

  /** answerer→offerer 方向（集成测假客户端用）：设置远端 answer 并排空窗口期候选。 */
  async acceptAnswer(sid: string, sdp: SdpLike): Promise<void> {
    if (sid !== this.curSid || !this.pc) return;
    await this.pc.setRemoteDescription(sdp);
    this.remoteSet = true;
    for (const c of this.iceQueue.drain()) await this.pc.addIceCandidate(c);
  }

  get pendingIce(): number {
    return this.iceQueue.size;
  }

  get localDescription(): SdpLike | null {
    return this.pc?.localDescription ?? null;
  }

  /** ctrl 通道：unordered+maxRetransmits 0，ping/pong RTT（POC 踩坑：绝不用 ordered 通道测 RTT） */
  createCtrl(): RTCDataChannel {
    if (!this.pc) throw new Error('Peer: no peer connection (acceptOffer/connectAsClient first)');
    return this.pc.createDataChannel('ctrl', { ordered: false, maxRetransmits: 0 });
  }

  private emitStatus(): void {
    this.statusCb?.(this.snapshot());
  }

  snapshot(): LinkStatus {
    const st = this.pc?.connectionState ?? 'closed';
    const state: LinkStatus['state'] =
      st === 'connected' ? 'connected'
      : st === 'connecting' || st === 'new' ? 'connecting'
      : st === 'disconnected' ? 'disconnected'
      : st === 'failed' ? 'failed'
      : 'closed';
    return { state, ...this.lastStats };
  }

  async refreshStats(): Promise<void> {
    if (!this.pc) return;
    try {
      const rows = [...(await this.pc.getStats()).values()];
      this.lastStats = {
        pairType: pairTypeFromStats(rows),
        rttMs: rttFromStats(rows),
        relayAddr: relayAddrFromStats(rows),
      };
    } catch { /* stats 失败不致命，保留下次刷新 */ }
  }

  private scheduleStats(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => { void this.refreshStats().then(() => this.emitStatus()); }, STATS_INTERVAL_MS);
    this.statsTimer.unref?.();
  }

  /** offerer 侧（集成测的假客户端用；生产浏览器侧用原生 RTCPeerConnection，不走这里） */
  async connectAsClient(handlers: PeerHandlers, opts: { poolSize?: number } = {}): Promise<{
    sid: string;
    sdp: SdpLike;
    channels: { proxy: RTCDataChannel; pool: RTCDataChannel[]; ctrl: RTCDataChannel };
  }> {
    const sid = Math.random().toString(36).slice(2, 10);
    this.dispose();
    this.curSid = sid;
    this.remoteSet = false;
    this.iceQueue = makeIceQueue();
    this.lastStats = { pairType: null };
    this.statusCb = handlers.onStatus;
    const pc = this.pc = this.newPc();
    this.armConsentWatchdog(pc);
    // proxy 通道池（spec D2）：label 与 PWA 对齐——首条恒 'proxy'（0.1.0 兼容），其后 'proxy1..N-1'
    const n = Math.max(1, Math.min(16, opts.poolSize ?? 1));
    const pool: RTCDataChannel[] = [];
    for (let i = 0; i < n; i++) pool.push(pc.createDataChannel(i === 0 ? 'proxy' : `proxy${i}`));
    const ctrl = this.createCtrl();
    pc.ondatachannel = (ev) => handlers.onChannel(ev.channel, ev.channel.label);
    pc.onicecandidate = (ev) => {
      const c = ev.candidate as ( undefined | { toJSON?: () => IceCandidateLike });
      if (!c) return;
      handlers.onIce(typeof c.toJSON === 'function' ? c.toJSON() : (c as unknown as IceCandidateLike));
    };
    pc.onconnectionstatechange = () => { void this.refreshStats().then(() => this.emitStatus()); this.scheduleStats(); };
    await pc.setLocalDescription(await pc.createOffer());
    this.remoteSet = true; // offerer：此后到达的远端候选由 werift 内部缓冲
    return { sid, sdp: pc.localDescription!, channels: { proxy: pool[0]!, pool, ctrl } };
  }

  /** 主动关闭当前会话（host agent stop 时调用）。 */
  close(): void {
    this.dispose();
  }
}
