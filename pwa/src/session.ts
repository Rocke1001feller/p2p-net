/**
 * 级联连接控制器（2026-09-08 用户裁决顺序）：P2P 直连 → 反向隧道 → TURN 中继。
 * relay 服务器仅兜底控成本——TURN 是最后一段，且必须用 turn-credentials 临时凭据（防白嫖）。
 *
 * - p2p 段：WebRtcSession + 仅 STUN（自建 coturn @3478）——不含 TURN 候选，直连失败不会
 *   悄悄滑进 TURN，顺序由本类显式控制。
 *   2026-09-09 蜂窝 A/B 实证（Android/联通 LTE）：full ICE 合并方案 0/3 失败，显式分段 3/3 可用——
 *   本分段结构为产品定案，勿合并回 single-PC full ICE。
 * - tunnel 段：不建 WebRTC，直接 HTTP 打桌面公布的接入网关（二维码 u= 携带 / 信令公告学习），
 *   探活 = GET <gw>/s/<SERVICES_PORT>/services；代理语义（SW req / WS）由 shell 按 mode 分流。
 * - turn 段：WebRtcSession + turn-credentials 下发的 iceServers + policy 'relay'
 *   （直连已失败，强制中继不做无谓打洞）。
 *
 * 会话语义：connect() 可重复调用 = 重连（规则②平移）；stop() 为用户主动断开（不触发自动重连）。
 */
import { SignalingClient } from 'p2p-net/browser';
import { CASCADE_TIMEOUT_MS, DISCOVERY_PORT } from './constants.js';
import { fetchTurnCredentials } from './cloud.js';
import { WebRtcSession, type LightStatus } from './signaling-web.js';

export type LinkMode = 'p2p' | 'tunnel' | 'turn';
export type Stage = 'p2p' | 'tunnel' | 'turn' | 'done';

export interface CascadeStatus extends LightStatus {
  mode?: LinkMode;
  stage?: Stage;
}

export interface CascadeOptions {
  signaling: SignalingClient;
  uid: string;
  myDeviceId: string;
  getJwt: () => Promise<string | null>;
  onStatus: (s: CascadeStatus) => void;
  /** 仅 WebRTC 段产生隧道帧（tunnel 段的 HTTP/WS 由 shell 直接走网关）。 */
  onFrame: (frame: any) => void;
  /** 从信令学到的隧道网关公告（host Task 11；现在主要靠二维码 u= 携带）。 */
  onTunnelUrl?: (u: string) => void;
  /** p2p 段 STUN 服务器（由运行时配置 relays 推导，shell 在 boot 时注入）。 */
  stunServers: RTCIceServer[];
  /** dev 覆盖：?ice= 注入的 p2p 段 iceServers（默认 stunServers）。 */
  p2pIceServers?: RTCIceServer[];
  /** dev 覆盖：?transport=relay 时只跑 TURN 段（smoke TURN 变体）。 */
  forceTurn?: boolean;
  /** 实验（P0-1）：p2p 段改用 turn-credentials 完整 ICE（policy all），URL ?p2pice=full 注入 */
  p2pFullIce?: boolean;
  /** dev/验收覆盖：?tunnel=1 或 ?notunnel=1 时只跑反向隧道段（Task 11 强制隧道模式）。 */
  forceTunnel?: boolean;
  /** 验收覆盖：daemon discovery 端口（?dsc=；默认 DISCOVERY_PORT 19728）。 */
  servicesPort?: number;
}

const isOk = (s: LightStatus) => s.state === 'connected';

export class CascadeSession {
  mode: LinkMode | null = null;
  tunnelUrl: string | null = null;
  private web: WebRtcSession | null = null;
  private stopped = false;
  private tunnelDown = false;
  private readonly wsMap = new Map<number, WebSocket>();

  constructor(private readonly opts: CascadeOptions) {}

  /** dev 钩子实验覆盖：构造后注入（?ice= / ?transport=relay / ?p2pice= / ?tunnel=1 由 shell 统一解析）。 */
  setDevOverrides(o: Partial<Pick<CascadeOptions, 'forceTurn' | 'forceTunnel' | 'p2pIceServers' | 'p2pFullIce'>>): void {
    Object.assign(this.opts, o);
  }

  get isOpen(): boolean {
    if (this.stopped) return false;
    if (this.mode === 'tunnel') return !this.tunnelDown;
    return this.web?.isOpen ?? false;
  }

  /** 建连级联。knownTunnelUrl：二维码 u= / 上次成功记忆；可重复调用 = 重连。 */
  async connect(deskDeviceId: string, knownTunnelUrl: string | null): Promise<void> {
    this.stopped = false;
    this.tunnelDown = false;
    if (knownTunnelUrl) this.tunnelUrl = knownTunnelUrl;
    this.teardownWeb();

    const stages: { mode: LinkMode; run: () => Promise<void> }[] = [];
    if (this.opts.forceTunnel) {
      stages.push({
        mode: 'tunnel',
        run: async () => {
          if (!this.tunnelUrl) throw new Error('no_tunnel_url');
          this.emit({ state: 'connecting', pairType: null, mode: 'tunnel', stage: 'tunnel' });
          await this.probeTunnel(CASCADE_TIMEOUT_MS.tunnel);
        },
      });
    } else {
      if (!this.opts.forceTurn) {
        stages.push({
          mode: 'p2p',
          run: () => {
            if (!this.opts.p2pFullIce) {
              return this.tryWebRtc(deskDeviceId, this.opts.p2pIceServers ?? this.opts.stunServers, 'all', CASCADE_TIMEOUT_MS.p2p);
            }
            return (async () => {
              const jwt = await this.opts.getJwt();
              if (!jwt) throw new Error('no_jwt_for_full_ice');
              const creds = await fetchTurnCredentials(jwt);
              await this.tryWebRtc(deskDeviceId, creds.iceServers, 'all', CASCADE_TIMEOUT_MS.p2pFull);
            })();
          },
        });
      }
      stages.push({
        mode: 'tunnel',
        run: async () => {
          if (!this.tunnelUrl) throw new Error('no_tunnel_url');
          this.emit({ state: 'connecting', pairType: null, mode: 'tunnel', stage: 'tunnel' });
          await this.probeTunnel(CASCADE_TIMEOUT_MS.tunnel);
        },
      });
      stages.push({
        mode: 'turn',
        run: async () => {
          const jwt = await this.opts.getJwt();
          if (!jwt) throw new Error('no_jwt_for_turn');
          const creds = await fetchTurnCredentials(jwt);
          await this.tryWebRtc(deskDeviceId, creds.iceServers, 'relay', CASCADE_TIMEOUT_MS.turn);
        },
      });
    }

    for (const st of stages) {
      if (this.stopped) throw new Error('stopped');
      try {
        await st.run();
        this.mode = st.mode;
        this.emit({ state: 'connected', pairType: st.mode === 'p2p' ? 'p2p' : 'relay', mode: st.mode, stage: 'done' });
        return;
      } catch (e) {
        if (this.stopped) throw new Error('stopped');
        this.teardownWeb();
        this.emit({ state: 'connecting', pairType: null, stage: st.mode });
        console.log(`[cascade] ${st.mode} 段失败：${e instanceof Error ? e.message : e}`);
      }
    }
    this.mode = null;
    this.emit({ state: 'failed', pairType: null });
    throw new Error('所有通道均不可达（桌面不在线或网络受限）');
  }

  /** 用户主动断开：置 stopped，onStatus off；后续 connect() 复位。 */
  stop(): void {
    this.stopped = true;
    this.teardownWeb();
    this.mode = null;
    this.emit({ state: 'off', pairType: null });
  }

  /** proxy 通道出站（仅 WebRTC 段；tunnel 段由 shell 走网关 fetch）。 */
  async send(frame: unknown): Promise<void> {
    await this.web?.send(frame);
  }

  // ---- WebRTC 段（p2p / turn 共用，仅 iceServers/policy 不同） ----
  private async tryWebRtc(deskDeviceId: string, iceServers: RTCIceServer[], policy: RTCIceTransportPolicy, timeoutMs: number): Promise<void> {
    this.teardownWeb();
    const stage: Stage = policy === 'relay' ? 'turn' : 'p2p';
    this.emit({ state: 'connecting', pairType: null, stage, mode: undefined });
    const web = this.web = new WebRtcSession({
      signaling: this.opts.signaling,
      uid: this.opts.uid,
      myDeviceId: this.opts.myDeviceId,
      iceServers,
      iceTransportPolicy: policy,
      onStatus: (s) => {
        if (web !== this.web) return; // 旧 web 会话的迟到事件作废（重连后不得污染当前状态）
        if (s.state === 'off') {
          // 2026-09-12 根因修复：此前 'off' 被这里吞掉——链路已死却没人通知上层，
          // 界面停在"直连"、不重连，请求只能干等 30s 超时。必须往上报，让 shell 重连/降级。
          this.tunnelDown = false;
          this.emit({ state: 'off', pairType: null });
          return;
        }
        this.emit({ ...s, mode: undefined });
      },
      onFrame: this.opts.onFrame,
    });
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`webrc_timeout_${timeoutMs}`)), timeoutMs);
      const check = setInterval(() => {
        if (this.stopped) { clearInterval(check); clearTimeout(timer); reject(new Error('stopped')); return; }
        if (web.isOpen) { clearInterval(check); clearTimeout(timer); resolve(); }
      }, 150);
    });
    await web.connect(deskDeviceId);
    await done;
  }

  private pendingStage(iceServers: RTCIceServer[], policy: RTCIceTransportPolicy): Stage {
    void iceServers;
    return policy === 'relay' ? 'turn' : 'p2p';
  }

  // ---- tunnel 段：网关 HTTP 探活（发现端点；失败再试工作台 /health 形态的根路径） ----
  private async probeTunnel(timeoutMs: number): Promise<void> {
    const gw = this.tunnelUrl!.replace(/\/+$/, '');
    const probes = [`${gw}/s/${this.opts.servicesPort ?? DISCOVERY_PORT}/services`];
    let lastErr: unknown = new Error('tunnel_unreachable');
    for (const url of probes) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) { lastErr = new Error(`tunnel_probe_${res.status}`); continue; }
        // 内容校验：Caddy try_files 会把 /s/* 回退成 SPA index.html（200 假阳性）——
        // 必须确认是 daemon 发现载荷（JSON 且含 services 数组）才算隧道活着
        const text = await res.text();
        const j = JSON.parse(text) as { services?: unknown };
        if (Array.isArray(j.services)) { this.tunnelDown = false; return; }
        lastErr = new Error('tunnel_probe_not_services_json');
      } catch (e) { lastErr = e; }
    }
    throw lastErr instanceof Error ? lastErr : new Error('tunnel_unreachable');
  }

  /** tunnel 段代理（shell 的 SW req 分流用）：网关 HTTP → 流式回调 res 帧。 */
  async tunnelProxy(
    m: { id: number; port: number; method: string; path: string; headers: Record<string, string>; bodyB64?: string | null },
    post: (frame: any) => void,
  ): Promise<void> {
    const gw = this.tunnelUrl!.replace(/\/+$/, '');
    const headers = { ...m.headers };
    delete headers.host; delete headers['content-length']; delete headers.connection;
    const init: RequestInit = {
      method: m.method,
      headers,
      signal: AbortSignal.timeout(30_000),
    };
    if (m.bodyB64) {
      const bin = atob(m.bodyB64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      init.body = u8;
    }
    try {
      const res = await fetch(`${gw}/s/${m.port}${m.path}`, init);
      const h: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) h[k] = v; });
      post({ k: 'res-head', id: m.id, status: res.status, headers: h });
      if (!res.body) { post({ k: 'res-chunk', id: m.id, done: true }); return; }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let s = '';
        for (let i = 0; i < value.length; i++) s += String.fromCharCode(value[i]);
        post({ k: 'res-chunk', id: m.id, dataB64: btoa(s) });
      }
      post({ k: 'res-chunk', id: m.id, done: true });
    } catch (e) {
      post({ k: 'res-head', id: m.id, status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      post({ k: 'res-chunk', id: m.id, dataB64: btoa(`tunnel gateway error: ${e instanceof Error ? e.message : e}`), done: true });
    }
  }

  /** tunnel 段 WS：网关原生 WebSocket 透传（网关不支持 upgrade 时 open 超时 → ws-open-err）。 */
  tunnelWsOpen(
    wid: number, port: number, path: string,
    post: (frame: any) => void,
  ): WebSocket {
    const gw = this.tunnelUrl!.replace(/^http/, 'ws').replace(/\/+$/, '');
    const ws = new WebSocket(`${gw}/s/${port}${path}`);
    const timer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) { try { ws.close(); } catch { /* 忽略 */ } post({ k: 'ws-open-err', wid }); }
    }, 8_000);
    ws.onopen = () => { clearTimeout(timer); post({ k: 'ws-open-ok', wid }); };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') post({ k: 'ws-msg', wid, text: ev.data });
      else {
        const blob = ev.data as Blob;
        void blob.arrayBuffer().then((b) => {
          const u8 = new Uint8Array(b);
          let s = '';
          for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
          post({ k: 'ws-msg', wid, dataB64: btoa(s) });
        });
      }
    };
    ws.onclose = (ev) => { clearTimeout(timer); post({ k: 'ws-close', wid, code: ev.code, reason: ev.reason }); };
    ws.onerror = () => { clearTimeout(timer); post({ k: 'ws-open-err', wid }); };
    this.wsMap.set(wid, ws);
    return ws;
  }

  tunnelWsSend(wid: number, frame: any): void {
    const ws = this.wsMap.get(wid);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (frame.text !== undefined) ws.send(frame.text);
    else if (frame.dataB64) {
      const bin = atob(frame.dataB64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      ws.send(u8);
    }
  }

  tunnelWsClose(wid: number, code?: number): void {
    const ws = this.wsMap.get(wid);
    if (ws) { try { ws.close(code ?? 1000); } catch { /* 忽略 */ } this.wsMap.delete(wid); }
  }

  private teardownWeb(): void {
    this.web?.teardown();
    this.web = null;
    for (const ws of this.wsMap.values()) { try { ws.close(); } catch { /* 忽略 */ } }
    this.wsMap.clear();
  }

  private emit(s: CascadeStatus): void {
    this.opts.onStatus({ ...s, mode: s.mode ?? (this.mode ?? undefined) });
  }

  /** 信令公告学习入口（shell 轮询回调转发）：host Task 11 的 tunnel 公告。 */
  learnTunnelUrl(u: string): void {
    if (u && u !== this.tunnelUrl) {
      this.tunnelUrl = u;
      this.opts.onTunnelUrl?.(u);
    }
  }
}
