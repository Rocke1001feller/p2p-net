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
import { dcSend, HttpBridge, type DcLike } from './bridge/http.js';
import { pickLeastBufferedIdx, proxyLabelIdx } from './pool.js';
import { WsBridge } from './bridge/ws.js';
import { assertPortAllowed, PortNotAllowedError } from './bridge/guard.js';
import { decodeFrame, decodeBinFrame, isPing, isReq, isReqAbort, isWsClose, isWsMsg, isWsOpen, type TunnelFrame } from './frames.js';
import { SignalingClient, type PollResult } from './signaling/client.js';
import { isSigMessage, roomFor, type SigMessage } from './signaling/protocol.js';
import { selectedPairStats, type PathType } from './pathType.js';

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

export type HostStatus = LinkStatus & {
  deviceId: string;
  /** 会话归属的客户端 deviceId（SigMessage.from）——事件流 sid 的事实来源（Task 19 ruling #1）。 */
  clientKey: string;
  /** 会话帧账本快照（Wave 1，spec D5/D8）：终态事件带最终字节量。 */
  ledger?: SessionLedger;
  /** 终结原因细分（Task 5 修复轮）：'replaced' = 同设备新 offer 换绑合成的终态，
   *  与正常 closed / 宽限到期 failed 区分（start.ts 记为 session_end 的 reason）。 */
  endReason?: string;
};

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
  /**
   * 端口白名单（spec §5.3 安全洞补洞）：req/ws-open 帧分发进桥之前强制校验目标端口。
   * 缺省放行（库层向后兼容）；CLI/daemon 装配必须传入（Task 17），否则 WebRTC 路径
   * 可被 PWA 驱使打任意 localhost 端口。
   */
  isPortAllowed?: (port: number) => boolean;
  /** 测试缝：覆盖会话宽限期（默认 SESSION_GRACE_MS=20s；测试注入小值驱动宽限到期路径）。 */
  sessionGraceMs?: number;
  /**
   * 信令看门狗阈值（连续 poll 失败次数）。2026-09-24 真机门禁 F4：轮询黑洞 9min/20+min
   * 两次不自愈、/status 假正常。三段楼梯：recoverAfter 起标记 recovering（日志+状态面可见）；
   * recreateAfter 重建自有信令客户端一次（注入实现不重建）；exitAfter 调 onSignalingBlackHole。
   */
  signalingWatchdog?: { recoverAfter?: number; recreateAfter?: number; exitAfter?: number };
  /** 持续黑洞的收尾动作（默认 process.exit(1)：常驻服务 launchd KeepAlive / systemd
   *  Restart=always 崩溃自愈，与人工重启同效；测试注入替代）。每段黑洞 episode 只触发一次。 */
  onSignalingBlackHole?: () => void;
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

/** 数据面 DC 适配：标记二进制能力（桥据此走帧协议 v2），背压读数透传。 */
export function asDataPlaneDc(dc: RTCDataChannel): DcLike {
  return {
    binaryOk: true,
    get bufferedAmount() { return dc.bufferedAmount; },
    get readyState() { return dc.readyState; },
    send(data) { dc.send(typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)); },
  };
}

/**
 * 单客户端会话：一个 Peer + 独立 HttpBridge/WsBridge（桥键空间按会话隔离，不串响应）。
 * 同 deviceId 新 offer → replace()（POC「最新 offer 换绑」保留在单设备内）；dispose() 释放。
 */

/** 会话帧账本（spec D5/D8，成本一等指标）：req 计数 / 完成计数 / 双向线字节。
 *  Wave 1 增补（spec D9）：pathType（getStats 选定对推导）+ wire 字节（选定对累计增量，
 *  字节因子 = wire 增量 ÷ 应用字节增量的分子）。 */
export interface SessionLedger {
  req: number;
  resDone: number;
  bytesSent: number;
  bytesRecv: number;
  /** 传输路径：direct/relay 来自 getStats 采样；tunnel 会话不经 PeerSession，host 账本不会出现 tunnel（tunnel 口径在 PWA 侧 noteTunnelFrame）；未判定 = unknown。 */
  pathType: PathType;
  wireBytesSent: number;
  wireBytesRecv: number;
}

export function makeLedger(): SessionLedger {
  return { req: 0, resDone: 0, bytesSent: 0, bytesRecv: 0, pathType: 'unknown', wireBytesSent: 0, wireBytesRecv: 0 };
}

export class PeerSession {
  readonly peer = new Peer([], { transport: 'all' });
  readonly httpBridge = new HttpBridge();
  readonly wsBridge: WsBridge;
  /** 本会话最近一次成功状态（换绑/断开时重置）。 */
  lastStatus: LinkStatus = { state: 'closed', pairType: null };
  private disposed = false;
  private graceTimer?: ReturnType<typeof setTimeout>;
  private readonly wsPort?: number;
  private readonly isPortAllowed?: (port: number) => boolean;
  /**
   * proxy 通道池（spec D2）：按 label 下标注册（'proxy'→0、'proxyN'→N）。
   * req/req-abort 入站恒在 proxy0（PWA 侧路由保证）；res/ws-* 出站按 id/wid 粘滞选最闲——
   * 同一响应/同一条 WS 的帧永不跨通道（保序），不同请求可并发占满池。
   */
  private readonly pool: DcLike[] = [];
  private readonly reqDc = new Map<number, DcLike>();
  private readonly widDc = new Map<number, DcLike>();
  readonly ledger = makeLedger();
  private wireTimer?: ReturnType<typeof setInterval>;

  constructor(wsPort?: number, isPortAllowed?: (port: number) => boolean) {
    this.wsPort = wsPort;
    this.isPortAllowed = isPortAllowed;
    this.wsBridge = new WsBridge({ port: wsPort });
    this.httpBridge.onSettled = (id) => {
      // 注意（Task 4 评审留存）：settle 早于最终 done 帧发送（http.ts 三路殊途同归），
      // 但 done 帧走 doReq 闭包捕获的 dc 参数（即 meterDc 包装），字节计量不依赖 reqDc 回查，不丢。
      this.reqDc.delete(id);
      this.ledger.resDone += 1;
    };
  }

  /** §5.3 白名单校验：true=放行；仅 PortNotAllowedError 折成 false（拒绝），其余异常上抛。 */
  private portAllowed(port: number): boolean {
    try {
      assertPortAllowed(this.isPortAllowed, port);
      return true;
    } catch (e) {
      if (e instanceof PortNotAllowedError) return false;
      throw e;
    }
  }

  /** 池化选路：open 通道中 bufferedAmount 最小者；池空/全灭 → 回落到达通道。 */
  private pickDc(fallback: DcLike): DcLike {
    const idx = pickLeastBufferedIdx(this.pool);
    return (idx >= 0 ? this.pool[idx] : undefined) ?? fallback;
  }

  /** 出站计量包装：asDataPlaneDc 之上叠 bytesSent 累计（每会话独立账本；DcLike.binaryOk 透传）。
   *  注意：不得用 {...base} 展开——spread 会把 bufferedAmount/readyState 的活 getter 固化成
   *  包装瞬间的值，背压/选路读数随即失真（pool-host.test.ts 实锤）。 */
  private meterDc(dc: RTCDataChannel): DcLike {
    const base = asDataPlaneDc(dc);
    const ledger = this.ledger;
    return {
      binaryOk: base.binaryOk,
      get bufferedAmount() { return base.bufferedAmount; },
      get readyState() { return base.readyState; },
      send: (data) => {
        ledger.bytesSent += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
        base.send(data);
      },
    };
  }

  wireChannel(dc: RTCDataChannel, label: string, onServiceFrame?: (dc: RTCDataChannel, frame: unknown) => void): void {
    if (label === 'ctrl') {
      dc.onmessage = (ev) => {
        const m = decodeFrame(ev.data);
        if (isPing(m)) dc.send(JSON.stringify({ k: 'pong', t: m.t } satisfies TunnelFrame));
      };
      return;
    }
    const poolIdx = proxyLabelIdx(label);
    if (poolIdx >= 0) {
      const bdc = this.meterDc(dc);
      this.pool[poolIdx] = bdc;
      this.startWireSampler(); // 会话建池后启动 wire 采样（spec D9；幂等）
      dc.onmessage = (ev) => {
        const raw = ev.data;
        this.ledger.bytesRecv += typeof raw === 'string' ? Buffer.byteLength(raw) : (raw as Buffer).byteLength;
        if (raw instanceof Buffer || raw instanceof Uint8Array) {
          // Task 2 二进制入站：PWA ws 上行（encodeWsMsgBin）——跟随 wid 粘滞通道。
          const bf = decodeBinFrame(raw instanceof Uint8Array && !Buffer.isBuffer(raw) ? Buffer.from(raw) : raw as Buffer);
          // bf 形态为 {k,wid,data}，不满足 isWsMsg（要求 text/dataB64/dataBin）——按 k 判定并折成
          // dataBin 形态进桥（Task 2 语义原样，仅出站通道由到达通道改为 wid 粘滞）。
          if (bf?.k === 'ws-msg') void this.wsBridge.handle(this.widDc.get(bf.wid) ?? bdc, { k: 'ws-msg', wid: bf.wid, dataBin: bf.data });
          return;
        }
        const m = decodeFrame(raw as string);
        if (!m) return;
        if (isReq(m)) {
          // §5.3 白名单强制：先校验再触达 localhost——PWA 不得借 host 打任意端口。
          // 403 后补 done 帧收尾（与 http.ts 400/502 错误路径同约定），否则客户端 SW 挂到 30s 超时。
          if (!this.portAllowed(m.port)) {
            console.error(`[p2p-net] req 拒绝：端口 ${m.port} 不在白名单（id=${m.id} ${m.method} ${m.path}）`);
            void dcSend(bdc, { k: 'res-head', id: m.id, status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
            void dcSend(bdc, { k: 'res-chunk', id: m.id, dataB64: Buffer.from(`bridge error: port ${m.port} not in allowlist`, 'utf8').toString('base64'), done: true });
            return;
          }
          dbg('req', m.method, 'port=' + m.port, m.path);
          this.ledger.req += 1;
          const out = this.pickDc(bdc);
          this.reqDc.set(m.id, out);
          void this.httpBridge.handle(out, m);
          return;
        }
        if (isReqAbort(m)) { dbg('req-abort', m.id); void this.httpBridge.handle(bdc, m); return; }
        if (isWsOpen(m)) {
          // 校验解析后的目标端口（帧可自带 port 覆盖，缺省回落 wsPort；两处皆无交桥回 open-err）
          const port = m.port ?? this.wsPort;
          if (typeof port === 'number' && !this.portAllowed(port)) {
            console.error(`[p2p-net] ws-open 拒绝：端口 ${port} 不在白名单（wid=${m.wid} ${m.path}）`);
            void dcSend(bdc, { k: 'ws-close', wid: m.wid, code: 4403, reason: `port ${port} not in allowlist` });
            return;
          }
          const out = this.pickDc(bdc);
          this.widDc.set(m.wid, out);
          void this.wsBridge.handle(out, m);
          return;
        }
        if (isWsMsg(m) || isWsClose(m)) {
          const out = this.widDc.get(m.wid) ?? bdc;
          if (isWsClose(m)) this.widDc.delete(m.wid);
          void this.wsBridge.handle(out, m);
          return;
        }
        onServiceFrame?.(dc, m);
      };
      return;
    }
    dc.onmessage = (ev) => {
      const m = decodeFrame(ev.data);
      if (m) onServiceFrame?.(dc, m);
    };
  }

  /** wire 采样（spec D9，默认 5s 节拍）：getStats 选定对累计值→增量累进账本。
   *  纪律：只写内存账本，采样失败零副作用；/status 快照与 events.jsonl 走既有路径，不新增 I/O。
   *  intervalMs 为测试缝（生产恒默认）。 */
  startWireSampler(intervalMs = 5_000): void {
    if (this.wireTimer) return;
    let prevWire: { wireSent: number; wireRecv: number } | undefined;
    this.wireTimer = setInterval(() => {
      void (async () => {
        const pc = this.peer.pc;
        if (!pc) return;
        try {
          const stats = await pc.getStats();
          const cur = selectedPairStats([...stats.values()]);
          if (prevWire) {
            this.ledger.wireBytesSent += Math.max(0, cur.wireSent - prevWire.wireSent);
            this.ledger.wireBytesRecv += Math.max(0, cur.wireRecv - prevWire.wireRecv);
          }
          if (cur.pathType !== 'unknown') this.ledger.pathType = cur.pathType;
          prevWire = { wireSent: cur.wireSent, wireRecv: cur.wireRecv };
        } catch { /* 采样失败零副作用，下拍再来 */ }
      })();
    }, intervalMs);
    this.wireTimer.unref?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearGrace();
    if (this.wireTimer) { clearInterval(this.wireTimer); this.wireTimer = undefined; }
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
  // 信令看门狗状态（F4 黑洞治理）：连续失败计数/首败时间/末次错误/恢复态/已重建/黑洞已触发
  private sigConsecFail = 0;
  private sigFirstFailAt?: number;
  private sigLastError?: string;
  private sigOk = 0;
  private sigFail = 0;
  /** 最近一次 poll 耗时（2026-09-25 自检探针：信令 RTT 是黑洞归因的第一变量）。 */
  private sigLastPollMs?: number;
  private sigRecovering = false;
  private sigRecreated = false;
  private sigBlackHoleFired = false;

  constructor(opts: HostAgentOptions) {
    this.opts = opts;
    this.signaling = opts.signaling ?? this.makeDefaultSignaling();
  }

  /** 自有信令客户端的工厂（看门狗 recreateAfter 重建同参新实例；注入实现不重建）。 */
  private makeDefaultSignaling(): SignalingClientLike {
    return new SignalingClient({
      supabaseUrl: this.opts.supabaseUrl,
      accessToken: this.opts.accessToken,
      publishableKey: this.opts.publishableKey,
      pollMs: this.opts.pollMs,
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
      const t0 = Date.now();
      const { msgs, cursor } = await this.signaling.poll(this.room(), this.cursor);
      this.sigLastPollMs = Date.now() - t0;
      this.notePollOk();
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
      const msg = (e instanceof Error ? e.message : String(e)) + detail;
      console.error('[p2p-net] poll failed:', msg);
      this.notePollFail(msg);
    } finally {
      this.polling = false;
    }
  }

  /** poll 成功：看门狗计数清零；若刚走出一段失败 episode，留恢复痕（带历时与连败数）。 */
  private notePollOk(): void {
    this.sigOk++;
    if (this.sigConsecFail > 0) {
      const secs = this.sigFirstFailAt ? Math.round((Date.now() - this.sigFirstFailAt) / 1000) : 0;
      console.error(`[p2p-net] 信令恢复：连续 ${this.sigConsecFail} 次失败、历时 ${secs}s 后重连成功`);
    }
    this.sigConsecFail = 0;
    this.sigFirstFailAt = undefined;
    this.sigLastError = undefined;
    this.sigRecovering = false;
    this.sigRecreated = false;
    this.sigBlackHoleFired = false;
  }

  /** poll 失败：看门狗三段楼梯（F4 黑洞治理，阈值可用 opts.signalingWatchdog 覆盖）。 */
  private notePollFail(msg: string): void {
    this.sigFail++;
    this.sigConsecFail++;
    this.sigFirstFailAt ??= Date.now();
    this.sigLastError = msg;
    const n = this.sigConsecFail;
    const wd = { recoverAfter: 3, recreateAfter: 15, exitAfter: 45, ...this.opts.signalingWatchdog };
    const elapsed = Math.round((Date.now() - this.sigFirstFailAt) / 1000);
    if (n >= wd.recoverAfter && !this.sigRecovering) {
      this.sigRecovering = true;
      console.error(`[p2p-net] 信令看门狗：连续 ${n} 次 poll 失败（已 ${elapsed}s），进入恢复观察态——信令面疑似黑洞中`);
    }
    if (n >= wd.recreateAfter && !this.sigRecreated && !this.opts.signaling) {
      this.signaling = this.makeDefaultSignaling();
      this.sigRecreated = true;
      console.error(`[p2p-net] 信令看门狗：连续 ${n} 次失败，已重建信令客户端`);
    }
    if (n >= wd.exitAfter && !this.sigBlackHoleFired) {
      this.sigBlackHoleFired = true;
      console.error(`[p2p-net] 信令看门狗：连续 ${n} 次失败（已 ${elapsed}s）判定信令黑洞，交由常驻监管重启进程`);
      (this.opts.onSignalingBlackHole ?? (() => process.exit(1)))();
    }
  }

  /** 信令面健康快照（F4：黑洞期 /status 假正常的治理——此表进 getStatus，p2p-net status 渲染）。 */
  signalingHealth(): {
    consecutiveFailures: number;
    firstFailureAt?: number;
    lastError?: string;
    recovering: boolean;
    recreated: boolean;
    pollsOk: number;
    pollsFailed: number;
    lastPollMs?: number;
  } {
    return {
      consecutiveFailures: this.sigConsecFail,
      ...(this.sigFirstFailAt !== undefined ? { firstFailureAt: this.sigFirstFailAt } : {}),
      ...(this.sigLastError !== undefined ? { lastError: this.sigLastError } : {}),
      recovering: this.sigRecovering,
      recreated: this.sigRecreated,
      pollsOk: this.sigOk,
      pollsFailed: this.sigFail,
      ...(this.sigLastPollMs !== undefined ? { lastPollMs: this.sigLastPollMs } : {}),
    };
  }

  private async onSignal(msg: unknown): Promise<void> {
    if (!isSigMessage(msg)) return;
    if (msg.type === 'offer' && msg.sdp) {
      const clientKey = msg.from;
      if (!clientKey) { console.error('[p2p-net] offer 缺 from，无法路由应答（客户端必须带身份）'); return; }
      const ice = await this.getIceServers();
      const existing = this.sessions.get(clientKey);
      // 同设备换绑：dispose 旧会话并新建 PeerSession（POC「最新 offer 优先」语义限定在单设备内）。
      // dispose 不可逆（disposed 永久置位），复用旧对象会挡死宽限回调并让后续 dispose 早退。
      if (existing) {
        dbg('session replace', clientKey);
        // 换绑终结帧（Task 5 修复轮）：旧语义是静默 dispose，被换会话的累计字节永远到不了
        // session_end/events.jsonl——手机重连是主导生命周期，每换一次绑丢一整段成本数据。
        // 必须先在表内发终结帧（带账本快照，endReason='replaced' 与正常 closed 区分），
        // 再摘除释放；此后旧会话的残余回声由 onSessionStatus 出表守卫拦截，终态只发一次。
        this.opts.onStatus?.({
          ...existing.lastStatus, state: 'closed', endReason: 'replaced',
          deviceId: this.opts.deviceId, clientKey, ledger: { ...existing.ledger },
        });
        existing.dispose();
        this.sessions.delete(clientKey);
      }
      const session = new PeerSession(this.opts.wsPort, this.opts.isPortAllowed);
      this.sessions.set(clientKey, session);
      dbg('offer accepted', 'from=' + clientKey);
      await session.peer.setIceServers(ice);
      await session.peer.acceptOffer(msg.sid, msg.sdp, {
        onChannel: (dc, label) => session.wireChannel(dc, label, this.opts.onServiceFrame),
        onIce: (cand) => this.reply(clientKey, msg.sid, { type: 'ice', sid: msg.sid, cand, from: this.opts.deviceId }),
        onStatus: (s) => this.onSessionStatus(clientKey, session, s),
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

  /**
   * 会话状态归一口：维护 lastStatus + 摘除策略 + 事件转发。
   * 出表守卫：会话被摘除/换绑后，其 Peer 的残余状态回声（如 dispose → pc.close() 的
   * 异步 closed）不再进入事件流——终态（closed / 宽限到期合成的 failed）只发一次。
   */
  private onSessionStatus(clientKey: string, session: PeerSession, s: LinkStatus): void {
    if (this.sessions.get(clientKey) !== session) return;
    session.lastStatus = s;
    // 2026-09-12 根因修复：只有 closed 立即摘；connecting/disconnected/failed 走宽限期，
    // 抖动期保留 ICE 路由与在途请求（旧行为把 disconnected 当 failed 秒摘 → 请求全挂）。
    const verdict = sessionDisposition(s.state);
    if (verdict === 'keep') session.clearGrace();
    else if (verdict === 'drop') this.dropSession(clientKey, session);
    else session.startGrace(this.opts.sessionGraceMs ?? SESSION_GRACE_MS, () => this.expireSession(clientKey, session));
    this.opts.onStatus?.({ ...s, deviceId: this.opts.deviceId, clientKey, ledger: { ...session.ledger } });
  }

  /**
   * 宽限到期（I1 会话会计修复）：先合成一次终态 onStatus（state:'failed'——客户端未显式
   * 关闭，用 'closed' 会谎称正常关闭），再摘除会话。否则手机走出覆盖后 /status 长期谎报
   * 活跃会话（静默 drop 无终态事件，环形缓冲里的 session_start 永远配不了对）。
   */
  private expireSession(clientKey: string, session: PeerSession): void {
    this.opts.onStatus?.({ ...session.lastStatus, state: 'failed', deviceId: this.opts.deviceId, clientKey, ledger: { ...session.ledger } });
    this.dropSession(clientKey, session);
  }

  /** 单测/排障用：当前会话数。 */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** 数据面计量快照（/status 与成本观测，spec D5/D8 + D9）：全部活跃会话账本求和 + 会话级路径分布。
   *  totals.pathType 无求和语义（恒 'unknown'），逐会话路径占比看 byPath。 */
  dataPlaneSnapshot(): { totals: SessionLedger; sessions: number; byPath: Record<PathType, number> } {
    const totals = makeLedger();
    const byPath: Record<PathType, number> = { direct: 0, relay: 0, tunnel: 0, unknown: 0 };
    for (const s of this.sessions.values()) {
      totals.req += s.ledger.req;
      totals.resDone += s.ledger.resDone;
      totals.bytesSent += s.ledger.bytesSent;
      totals.bytesRecv += s.ledger.bytesRecv;
      totals.wireBytesSent += s.ledger.wireBytesSent;
      totals.wireBytesRecv += s.ledger.wireBytesRecv;
      byPath[s.ledger.pathType] += 1;
    }
    return { totals, sessions: this.sessions.size, byPath };
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
