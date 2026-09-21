/**
 * host agent 装配（Node，被控端常驻）：信令轮询自己房间 → 收 offer → 按客户端设备建立
 * 独立会话（Peer + 独立 HttpBridge/WsBridge）→ 状态灯事件。
 *
 * 多会话模型（2026-09-06 复盘，根因修复）：
 * - 旧实现单 peer + 全局桥：`connStatechange`/`pc.remoteDescription` 只有一份，任何
 *   客户端新 offer 都会「最新 offer 优先换绑」挤掉旧客户端；又被双端各 ~10s 重发 offer
 *   强化成互踢战争（iPhone Chrome/Safari 各开一次即互相白屏/登录失败）。
 * - 新模型：key = 客户端 deviceId（SigMessage.from）。同设备新 offer 替换旧会话（换绑语义
 *   保留在单设备内，POC 重连语义不丢）；跨设备并存。每会话独立桥实例 —— 桥的键空间
 *   （req id / ws wid）全局共享会串响应，多客户端必须分桥。
 *
 * 轮询语义（plan Task 7 Step 2）：默认 800ms 增量轮询；每 60s 清理本房间过期行；
 * turnFetcher 结果缓存 ttl-60s 过期重取；断开后继续轮询等新 offer（桌面常驻等连接）。
 */
import type { RTCDataChannel, RTCIceServer } from 'werift';
import { Peer, type LinkStatus } from './peer.js';
import { HttpBridge, type DcLike } from './bridge/http.js';
import { WsBridge } from './bridge/ws.js';
import { decodeFrame, isPing, isReq, isReqAbort, isWsClose, isWsMsg, isWsOpen, type TunnelFrame } from './frames.js';
import { SignalingClient, type PollResult } from './signaling/client.js';
import { isSigMessage, roomFor, type SigMessage } from './signaling/protocol.js';

export interface TurnCredentials {
  iceServers: RTCIceServer[];
  /** 凭据有效期（秒）；缓存 ttl-60s 过期重取。默认 3600。 */
  ttlSeconds?: number;
}

export interface SignalingClientLike {
  send(room: string, sender: string, msg: SigMessage, kind?: 'sig' | 'data', ttlSeconds?: number): Promise<void>;
  poll(room: string, cursor: number): Promise<PollResult>;
  purgeExpired(room: string): Promise<void>;
}

export type HostStatus = LinkStatus & { deviceId: string };

export interface HostAgentOptions {
  supabaseUrl: string;
  publishableKey: string;
  /** 每次请求现取，支持 token 刷新。 */
  accessToken: () => string | null;
  deviceId: string;
  uid: string;
  turnFetcher: () => Promise<TurnCredentials>;
  onStatus?: (s: HostStatus) => void;
  /** 未被内建桥处理的帧（其他 label 的通道、proxy 上的未知帧）回调给宿主（daemon 服务发现等）。 */
  onServiceFrame?: (dc: RTCDataChannel, frame: unknown) => void;
  /** 注入信令实现（默认 PostgREST SignalingClient；集成测用内存 stub）。 */
  signaling?: SignalingClientLike;
  pollMs?: number;
  /** ws-open 帧缺省目标本地端口（帧可自带 port 覆盖；两处皆无时 ws-open 回 open-err）。 */
  wsPort?: number;
}

// 调试日志（P2P_NET_DEBUG=1 启用）；错误类日志不受开关限制（轮询/onSignal 失败必须留痕）
const dbg = (...a: unknown[]) => { if (process.env.P2P_NET_DEBUG) console.error('[p2p-net]', new Date().toISOString(), ...a); };

const DEFAULT_POLL_MS = 800;
const PURGE_INTERVAL_MS = 60_000;
const ICE_CACHE_MARGIN_MS = 60_000;
const DEFAULT_TURN_TTL_MS = 3600_000;
/** 会话宽限期：非 connected 且非 closed 的状态先在路由表里保留这么久（等自愈/等新 offer）。 */
export const SESSION_GRACE_MS = 20_000;

/**
 * 会话摘除策略（纯函数，便于单测）——2026-09-12 根因修复。
 *
 * 旧行为：`state === 'closed' || 'failed'` 立即从 sessions 摘除。但 'disconnected' 曾被映射成
 * 'failed'，且 ICE 真失败也常在一次抖动内出现；一摘就丢 ICE 路由与在途请求（会话对象还留在
 * 事件回调里，pc 也没 dispose），客户端却因为 dc.readyState 仍是 open 而显示"假直连"。
 * 现行为：只有客户端明确关闭才立即摘；其余非连接态先给宽限期（期间新 offer 仍可 replace）。
 */
export function sessionDisposition(state: LinkStatus['state']): 'keep' | 'grace' | 'drop' {
  if (state === 'connected') return 'keep';
  if (state === 'closed') return 'drop';
  return 'grace'; // connecting | disconnected | failed
}

/**
 * 单客户端会话：一个 Peer + 独立 HttpBridge/WsBridge（桥键空间按会话隔离，不串响应）。
 * 同 deviceId 新 offer → replace()（POC「最新 offer 换绑」保留在单设备内）；dispose() 释放。
 */
export class PeerSession {
  readonly peer = new Peer([], { transport: 'all' });
  readonly httpBridge = new HttpBridge();
  readonly wsBridge: WsBridge;
  /** 本会话最近一次成功状态（换绑/断开时重置）。 */
  lastStatus: LinkStatus = { state: 'closed', pairType: null };
  private disposed = false;
  private graceTimer?: ReturnType<typeof setTimeout>;

  constructor(wsPort?: number) {
    this.wsBridge = new WsBridge({ port: wsPort });
  }

  wireChannel(dc: RTCDataChannel, label: string, onServiceFrame?: (dc: RTCDataChannel, frame: unknown) => void): void {
    if (label === 'ctrl') {
      dc.onmessage = (ev) => {
        const m = decodeFrame(ev.data);
        if (isPing(m)) dc.send(JSON.stringify({ k: 'pong', t: m.t } satisfies TunnelFrame));
      };
      return;
    }
    if (label.startsWith('proxy')) {
      dc.onmessage = (ev) => {
        const m = decodeFrame(ev.data);
        if (!m) return;
        if (isReq(m) || isReqAbort(m)) { dbg('req', (m as { method?: string }).method, 'port=' + (m as { port?: number }).port, (m as { path?: string }).path); void this.httpBridge.handle(dc, m); return; }
        if (isWsOpen(m) || isWsMsg(m) || isWsClose(m)) { void this.wsBridge.handle(dc, m); return; }
        onServiceFrame?.(dc, m);
      };
      return;
    }
    dc.onmessage = (ev) => {
      const m = decodeFrame(ev.data);
      if (m) onServiceFrame?.(dc, m);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearGrace();
    try { this.peer.close(); } catch { /* 已关闭 */ }
    this.httpBridge.abortAll();
    this.wsBridge.closeAll();
  }

  /** 宽限窗口：到期仍非 connected 则回调（宿主据此 dispose 真会话）。 */
  startGrace(ms: number, onExpire: () => void): void {
    if (this.graceTimer) return; // 已在宽限中：不重复计时（避免抖动反复重置）
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined;
      if (!this.disposed) onExpire();
    }, ms);
    this.graceTimer.unref?.();
  }

  clearGrace(): void {
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = undefined; }
  }
}

export class HostAgent {
  private opts: HostAgentOptions;
  private signaling: SignalingClientLike;
  /** 客户端会话表：key = 客户端 deviceId（SigMessage.from）。同设备换绑；跨设备并存。 */
  private sessions = new Map<string, PeerSession>();
  private cursor = 0;
  private running = false;
  private polling = false;
  private pollTimer?: ReturnType<typeof setInterval>;
  private purgeTimer?: ReturnType<typeof setInterval>;
  private iceCache?: { creds: TurnCredentials; fetchedAt: number };

  constructor(opts: HostAgentOptions) {
    this.opts = opts;
    this.signaling = opts.signaling ?? new SignalingClient({
      supabaseUrl: opts.supabaseUrl,
      accessToken: opts.accessToken,
      publishableKey: opts.publishableKey,
      pollMs: opts.pollMs,
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  private room(): string {
    return roomFor(this.opts.uid, this.opts.deviceId);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.cursor = 0;
    const pollMs = this.opts.pollMs ?? DEFAULT_POLL_MS;
    this.pollTimer = setInterval(() => void this.pollOnce(), pollMs);
    this.pollTimer.unref?.();
    this.purgeTimer = setInterval(() => { void this.signaling.purgeExpired(this.room()).catch(() => {}); }, PURGE_INTERVAL_MS);
    this.purgeTimer.unref?.();
    void this.pollOnce();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    if (this.purgeTimer) { clearInterval(this.purgeTimer); this.purgeTimer = undefined; }
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }

  private async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const { msgs, cursor } = await this.signaling.poll(this.room(), this.cursor);
      this.cursor = cursor;
      for (const row of msgs) {
        dbg('signal', row.payload?.type, 'sid=' + (row.payload as { sid?: string })?.sid, 'from=' + (row.payload as { from?: string })?.from);
        try {
          await this.onSignal(row.payload);
        } catch (e) {
          // 逐条隔离：一条坏消息不得拖垮轮询环，但绝不静默（2026-09-06 iPhone 排查教训）
          console.error('[p2p-net] onSignal failed:', e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      // 轮询失败要留痕（401/网络/表结构），吞掉等于失明
      // 2026-09-12：补打 e.cause —— undici 只把 network 级失败包成 "fetch failed"，
      // 真正原因（ECONNRESET/ETIMEDOUT/EAI_AGAIN/EMFILE…）在 cause 里，旧日志把线索丢掉了。
      const cause = (e as { cause?: { code?: string; name?: string; message?: string } })?.cause;
      const detail = cause ? ` (cause=${cause.code ?? cause.name ?? ''}${cause.message ? ':' + cause.message : ''})` : '';
      console.error('[p2p-net] poll failed:', (e instanceof Error ? e.message : String(e)) + detail);
    } finally {
      this.polling = false;
    }
  }

  private async onSignal(msg: unknown): Promise<void> {
    if (!isSigMessage(msg)) return;
    if (msg.type === 'offer' && msg.sdp) {
      const clientKey = msg.from;
      if (!clientKey) { console.error('[p2p-net] offer 缺 from，无法路由应答（客户端必须带身份）'); return; }
      const ice = await this.getIceServers();
      const existing = this.sessions.get(clientKey);
      const session = existing ?? new PeerSession(this.opts.wsPort);
      // 同设备换绑：先关旧 peer，再点新连接（POC「最新 offer 优先」语义限定在单设备内）
      if (existing) { dbg('session replace', clientKey); session.dispose(); this.sessions.delete(clientKey); }
      this.sessions.set(clientKey, session);
      dbg('offer accepted', 'from=' + clientKey);
      await session.peer.setIceServers(ice);
      await session.peer.acceptOffer(msg.sid, msg.sdp, {
        onChannel: (dc, label) => session.wireChannel(dc, label, this.opts.onServiceFrame),
        onIce: (cand) => this.reply(clientKey, msg.sid, { type: 'ice', sid: msg.sid, cand, from: this.opts.deviceId }),
        onStatus: (s) => {
          session.lastStatus = s;
          // 2026-09-12 根因修复：只有 closed 立即摘；connecting/disconnected/failed 走宽限期，
          // 抖动期保留 ICE 路由与在途请求（旧行为把 disconnected 当 failed 秒摘 → 请求全挂）。
          const verdict = sessionDisposition(s.state);
          if (verdict === 'keep') session.clearGrace();
          else if (verdict === 'drop') this.dropSession(clientKey, session);
          else session.startGrace(SESSION_GRACE_MS, () => this.dropSession(clientKey, session));
          this.opts.onStatus?.({ ...s, deviceId: this.opts.deviceId });
        },
      });
      const local = session.peer.localDescription;
      if (local) { this.reply(clientKey, msg.sid, { type: 'answer', sid: msg.sid, sdp: local, from: this.opts.deviceId }); dbg('answer sent to room', roomFor(this.opts.uid, clientKey)); }
      else console.error('[p2p-net] acceptOffer 后无 localDescription');
      return;
    }
    if (msg.type === 'ice' && msg.cand) {
      // ICE 按 from 路由到对应会话（其余会话的 ice 轮不到）
      const session = this.sessions.get(msg.from ?? '');
      if (!session) { dbg('ice dropped 无会话', 'from=' + msg.from); return; }
      await session.peer.addIce(msg.cand);
    }
  }

  /** 应答路由：写回 offer 来源设备的房间（SigMessage.from = 客户端 deviceId）。 */
  private reply(from: string, sid: string, msg: SigMessage): void {
    if (!from) return;
    void this.signaling
      .send(roomFor(this.opts.uid, from), this.opts.deviceId, msg)
      .catch(() => {});
  }

  /** 摘除并释放一个客户端会话（幂等；宽限到期或客户端明确关闭时调用）。 */
  private dropSession(key: string, session: PeerSession): void {
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    session.dispose();
    dbg('session dropped', key, 'last=' + session.lastStatus.state);
  }

  /** 单测/排障用：当前会话数。 */
  get sessionCount(): number {
    return this.sessions.size;
  }

  private async getIceServers(): Promise<RTCIceServer[]> {
    const cached = this.iceCache;
    if (cached) {
      const ttlMs = (cached.creds.ttlSeconds ?? DEFAULT_TURN_TTL_MS / 1000) * 1000;
      if (Date.now() - cached.fetchedAt < ttlMs - ICE_CACHE_MARGIN_MS) return cached.creds.iceServers;
    }
    const creds = await this.opts.turnFetcher().catch((e) => {
      console.error('[p2p-net] turnFetcher failed:', e instanceof Error ? e.message : e);
      throw e;
    });
    this.iceCache = { creds, fetchedAt: Date.now() };
    dbg('iceServers ready,', creds.iceServers.length, '条');
    return creds.iceServers;
  }
}

/** 供类型完备：DcLike 由 bridge/http 导出，此处 re-export 便于宿主引用。 */
export type { DcLike };
