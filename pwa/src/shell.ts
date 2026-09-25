/**
 * shell 主页面逻辑（产品壳 v2，2026-09-08）：
 * 登录（相机扫码 / 粘贴 p2pnet2|… 或 URL / 账号密码）→ 设备列表 → 级联连接
 * （P2P 直连 → 反向隧道 → TURN，裁决顺序）→ 工作台 tab 直载桌面控制台（不重建移动端工作台）。
 *
 * 帧路由（proxy DataChannel ↔ SW/iframe）—— 沿用 M1 Task 8 语义：
 *  - SW req（/s/<port>/ scope 解析出的 port）→ 全局 id 重映射 → dc；res 帧 → 按原 id 回 SW；
 *  - iframe ws-* 帧（__p2pnet 标记）→ wid = port*1e6 + n 重映射 → dc；回程反解进对应 iframe；
 *  - 隧道模式（cascade.mode==='tunnel'）：SW req 分流到网关 HTTP（tunnelProxy 流式回帧），
 *    ws-open 分流到网关原生 WebSocket 透传。
 * MessageChannel 每 10s 重注 + SW 激活即重注（POC 平移，防 SW 休眠丢 port）。
 *
 * 防 Offline 全套：嵌套 SW 冻结（shim）+ 状态条感知 +
 * 断线自动重连（指数退避 1/2/4/8/15s）+ 失败离线 sheet。
 *
 * 后端配置（supabase / relays）一律来自 loadRuntimeConfig()（同源 /config.json，p2p-net init 写入）；
 * /config.json 缺失或损坏时渲染可操作错误页，绝不白屏（spec §3）。
 *
 * dev 直连冒烟钩子（保持 driver 兼容）：?dev=1&jwt=&rt=&uid=&device=&desk=[&sigUrl=&ice=&transport=relay&dsc=]，
 * window.__p2pNetConnect(deskId?) / __p2pNetOpenService(port) / __p2pNetDebug()。
 */
import jsQR from 'jsqr';
import { SignalingClient } from 'p2p-net/browser';
import {
  fetchTurnCredentials, loginByPassword, loginByTicket, parseScan, bindPhone, supabase,
  type ScanPayload,
} from './cloud.js';
import { loadRuntimeConfig, type RuntimeConfig } from './config.js';
import {
  DISCOVERY_PORT, LS_ACCESS, LS_DESK_ID, LS_DEVICE_ID, LS_DEVICES, LS_UID, stunServersFromRelays,
} from './constants.js';
import { discoveryCandidates, pickDiscoveryPort } from './discovery.js';
import {
  HEALTH_CHECK_DELAYS_MS, bootGateDecision, dataPlaneAlive, healthDecision, looksBooted,
} from './workbenchRecovery.js';
import { CascadeSession, type LinkMode } from './session.js';
import { FrameLedger, type HungEntry } from './frameLedger.js';
import { DataPlaneLiveness } from './dataPlaneLiveness.js';
import { livenessFromQuery } from './livenessConfig.js';
import {
  hideConnecting, hideSheets, log, renderDevices, setMe, setStatus, showConnecting,
  showOfflineSheet, showPasteSheet, showScreen, showTab, setWorkspaceEnabled, toast,
  connectingStage, wechatGuard, showBrowserHint, setStall,
  type SavedDevice,
} from './ui.js';
import { stallSuspect } from './stall.js';
import { onConnectFailure, onConnectStopped } from './reconnectPolicy.js';
import { bootConnectTarget } from './bootPolicy.js';

const Q = new URLSearchParams(location.search);
const DEV_MODE = Q.get('dev') === '1';
const WID_BASE = 1_000_000;

interface TabEntry {
  port: number;
  iframe: HTMLIFrameElement;
  /** 数字 wid → shim 原始 wid（shim 的 wid 形如 'w1' 字符串，回传 iframe 必须保形）。 */
  wids: Map<number, unknown>;
  /** 首屏自愈状态（2026-09-12）：重载次数 / 是否已确认 boot 起来。 */
  reloads?: number;
  booted?: boolean;
  healthTimer?: ReturnType<typeof setTimeout>;
}

const swPorts = new Map<number, MessagePort>();
const tabs = new Map<number, TabEntry>();
const pendingSw = new Map<number, { swPort: MessagePort; origId: number; timer: ReturnType<typeof setTimeout> }>();
/**
 * 数据面"挂起"看门狗（2026-09-12 真机实证修复）。
 *
 * 现象：网络高频切换后，pc 自报 connected、ctrl 心跳正常（RTT 在跳）、daemon 也报 connected/p2p，
 * 但 SW 请求发出去后**永远收不到回帧**（CDP 实证：有 req 事件、无 res 事件），只能等超时；
 * 整页重载立刻恢复 —— 即"链路对象活着、proxy 数据通道已黑"。
 *
 * 因此不看自报状态，改看**事实**：请求发出后长期没有回帧就判定数据面已死，主动拆连重连
 * （重连会新建 pc/dc，等同重载的效果，但自动完成、不做用户可见的中断）。
 */
const inflightSw = new Map<number, number>();
/**
 * 黑洞判定口径（2026-09-23 中继洪泛事故整改）：看门狗检测的是**全局零字节流动**，
 * 不是单请求首帧慢。旧口径「单请求 9s 无首帧且 ≥2 条」在有序通道洪泛下必然误杀——
 * host 125ms 灌入 6MB，后发请求的 res-head 排在大文件 chunk 之后，慢链路下 >9s 零回帧
 * 是正常排队现象，拆连反而制造「重灌→再超时」死循环。
 * 现在：任何回帧（res-head/res-chunk/ws-*）都刷新活性证明；有在途请求且全局静默
 * 超 WEDGE_MS 才判死拆连。慢由 SW 超时与桥侧 512KiB 背压上限去兜。
 */
const LIVE = livenessFromQuery(Q); // N4 真机标定旋钮（?ping=&liveness=&wedge=）
const liveness = new DataPlaneLiveness(LIVE.wedgeMs);
const SW_HANG_MS = 9_000;   // 仅诊断日志口径：单请求无回帧超此值打 [frame] 日志（不再作为拆连依据）
const pendingFetch = new Map<number, { resolve: (r: { status: number; body: Uint8Array }) => void; chunks: Uint8Array[]; status: number; timer: ReturnType<typeof setTimeout> }>();
let dcSeq = 0;

/**
 * 帧账本（2026-09-12 白屏第 3 次复发后加）：现场只靠"白屏"根本分不清
 * 「请求没发出去 / 发出去了没回帧 / 回来了但 iframe 已被打死」。
 * 这里记录 ①发出 ②回帧 ③超过 9s 仍无回帧（含 path），并随 __p2pNetDebug() 暴露，
 * 于是这类问题下次**不需要 SSH、不需要 CDP**：手机上看一眼就知道死在哪一环。
 */
const frameLedger = new FrameLedger();
/** 帧账本（语义同 2026-09-12 内联版；字节计量为 Wave 1 增量，spec D5/D8）。 */
function trackReq(gid: number, port: number | undefined, path: string, outFrame?: unknown): void {
  frameLedger.trackReq(gid, port, path, outFrame);
}
function settleReq(gid: number, inFrame?: unknown): void {
  frameLedger.settleReq(gid, inFrame);
}
/** 把"挂了多久还没回帧"的请求摘出来（watchdog 与诊断共用） */
function harvestHung(): HungEntry[] {
  return frameLedger.harvestHung(Date.now(), SW_HANG_MS, log);
}
let cascade: CascadeSession | null = null;
/** 会话代号：重连后旧实例的 onStatus/onFrame 迟到事件一律作废（2026-09-12 假直连根因修复）。 */
let cascadeGen = 0;
let currentServices: { name: string; port: number; url?: string }[] = [];
let deskName = '';
let cachedToken: string | null = null;
/** 运行时配置（boot 时加载；/config.json 缺失/损坏已在 boot 拦截成错误页，此处防御性非空断言）。 */
let runtimeCfg: RuntimeConfig | null = null;
/** p2p 段 STUN 服务器（boot 时由 runtimeCfg.relays 推导）。 */
let p2pStunServers: RTCIceServer[] = [];
function cfg(): RuntimeConfig {
  if (!runtimeCfg) throw new Error('unreachable: boot 未加载运行时配置');
  return runtimeCfg;
}

/** 当前目标桌面（连接中/已连接态的锚点）。 */
const desk: { id: string; tunnelUrl: string | null; ticket: string | null; discoveryPort: number | null } = {
  id: '', tunnelUrl: null, ticket: null, discoveryPort: null,
};
/** 本次会话选定的服务发现端口（URL dsc → 设备记忆 → 契约，见 discovery.ts）。 */
let activeDiscoveryPort: number | null = null;
let manualStop = false;
let wasConnected = false;
/** 是否成功连上过（用于区分"首次连上"与"重连"：重连必须重建工作台首屏）。 */
let everConnected = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// ---- 设备表（v1 本机记忆；服务器侧心跳表为后续增强） ----
function loadDevices(): SavedDevice[] {
  try { return JSON.parse(localStorage.getItem(LS_DEVICES) || '[]') as SavedDevice[]; } catch { return []; }
}
function saveDevices(list: SavedDevice[]): void {
  localStorage.setItem(LS_DEVICES, JSON.stringify(list.slice(0, 12)));
}
function upsertDevice(d: SavedDevice): SavedDevice[] {
  const list = loadDevices().filter((x) => x.id !== d.id);
  list.unshift({ ...d, lastAt: Date.now(), tunnelUrl: d.tunnelUrl ?? undefined });
  saveDevices(list);
  return list;
}
function refreshDevicesUI(): void {
  renderDevices(loadDevices(), (d) => void startConnect(d));
}

// ---- dev 直连冒烟钩子（driver 兼容面）----
interface DevIdentity { jwt: string | null; rt: string | null; uid: string; deviceId: string; deskId: string }
function devIdentity(): DevIdentity | null {
  if (!DEV_MODE) return null;
  return {
    jwt: Q.get('jwt'),
    rt: Q.get('rt'),
    uid: Q.get('uid') || 'smoke',
    deviceId: Q.get('device') || (() => { const k = 'p2p-net.dev.phoneId'; let v = localStorage.getItem(k); if (!v) { v = 'phone-' + Math.random().toString(36).slice(2, 9); localStorage.setItem(k, v); } return v; })(),
    deskId: Q.get('desk') || localStorage.getItem(LS_DESK_ID) || 'desk-smoke',
  };
}
function currentUid(): string {
  return devIdentity()?.uid || localStorage.getItem(LS_UID) || '';
}
function currentDeviceId(): string {
  return devIdentity()?.deviceId || localStorage.getItem(LS_DEVICE_ID) || '';
}

// ---- 信令 ----
function makeSignaling(): SignalingClient {
  return new SignalingClient({
    supabaseUrl: Q.get('sigUrl') || cfg().supabaseUrl,
    publishableKey: cfg().publishableKey,
    accessToken: () => cachedToken,
  });
}
function watchAuthToken(): void {
  void supabase().then((s) => s.auth.getSession()).then(({ data }) => { cachedToken = data.session?.access_token ?? null; }).catch(() => {});
  void supabase().then((s) => s.auth.onAuthStateChange((event, sess) => {
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
      cachedToken = sess?.access_token ?? cachedToken;
    }
  })).catch(() => {});
}
async function getJwt(): Promise<string | null> {
  const s = await (await supabase()).auth.getSession().then(({ data }) => data.session?.access_token ?? null).catch(() => null);
  return s || devIdentity()?.jwt || null;
}

// ---- SW 管理（单根 scope 模型，M1 Task 8 根修平移） ----
let swReg: ServiceWorkerRegistration | null = null;
async function ensureSW(): Promise<void> {
  if (swReg?.active) { injectPort(); return; }
  const regs = await navigator.serviceWorker.getRegistrations().catch(() => [] as ServiceWorkerRegistration[]);
  for (const r of regs) {
    if (/\/s\/\d+\//.test(r.scope)) { await r.unregister().catch(() => {}); }
  }
  swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  if (!swReg.active) {
    const w = swReg.installing || swReg.waiting;
    if (w) await new Promise<void>((res) => {
      const on = () => { if (w.state === 'activated') { w.removeEventListener('statechange', on); res(); } };
      w.addEventListener('statechange', on);
    });
  }
  injectPort();
}
function injectPort(): void {
  const w = swReg?.active;
  if (!w) return;
  const ch = new MessageChannel();
  swPorts.set(0, ch.port1);
  ch.port1.onmessage = (ev) => {
    const m = ev.data;
    if (m?.k === 'req') void onSwReq(m);
    else if (m?.k === 'req-abort') onSwAbort(m);
  };
  w.postMessage({ k: 'init-port' }, [ch.port2]);
}
setInterval(() => injectPort(), 10_000);
navigator.serviceWorker.addEventListener('message', (ev) => {
  if ((ev.data as { k?: string } | null)?.k === 'sw-active') injectPort();
});

// ---- 帧路由：SW ↔ 级联（dc / 网关） ↔ iframe ----
async function onSwReq(m: { id: number; port?: number; method: string; path: string; headers: Record<string, string>; bodyB64?: string | null }): Promise<void> {
  const swPort = swPorts.get(0);
  if (!swPort) return;
  if (!cascade?.isOpen || !cascade.mode) {
    // 快速失败（不占用 30s/12s 超时窗）：链路不可用时立刻回 503，工作台能立即重试/降级。
    // 响应体用 JSON——纯文本体曾让工作台 JSON.parse 出语法错误，掩盖真实原因。
    swPort.postMessage({ k: 'res-head', id: m.id, status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } });
    swPort.postMessage({ k: 'res-chunk', id: m.id, dataB64: b64(JSON.stringify({ error: 'link_down', message: '数据面未连接', retryable: true })), done: true });
    return;
  }
  const gid = ++dcSeq;
  // 慢链路大文件传输可超 31s；90s 兜底 GC。F9：两图同清——只清 pendingSw 会把在途计数
  // 永远留在 inflightSw（dc 回帧销账 :306 走不到无 pendingSw 的条目），泄漏计数会喂给看门狗。
  const timer = setTimeout(() => { pendingSw.delete(gid); inflightSw.delete(gid); }, 90_000);
  pendingSw.set(gid, { swPort, origId: m.id, timer });
  inflightSw.set(gid, Date.now()); // 看门狗计时（回帧时清）
  if (cascade.mode === 'tunnel') {
    // 隧道模式：SW req 分流到网关 HTTP（流式回帧后清理）——隧道段走网关 HTTP，不进 dc 账本；
    // 但 spec D9 路径归类：响应帧计 wire 桶且 pathType 记 'tunnel'（隧道段无 ICE 对，getStats 判不到）。
    // F9：finish 必须与 dc 腿同口径清理（pendingSw/inflightSw/timer）——tunnelProxy 成功与失败
    // 都以 done:true 的 res-chunk 收尾，此处是隧道腿唯一可靠的成对清理点。
    const finish = (frame: any): void => {
      swPort.postMessage({ ...frame, id: m.id });
      if (frame.k === 'res-chunk' && frame.done) { clearTimeout(timer); pendingSw.delete(gid); inflightSw.delete(gid); }
    };
    await cascade.tunnelProxy({ ...m, port: m.port ?? 0 }, (frame) => { frameLedger.noteTunnelFrame(frame); finish({ ...frame, id: gid }); });
    return;
  }
  const frame = { k: 'req' as const, id: gid, port: m.port, method: m.method, path: m.path, headers: m.headers, bodyB64: m.bodyB64 ?? null };
  trackReq(gid, m.port, m.path, frame);   // 帧账本：发出记一笔（含线字节），回帧销账
  await cascade.send(frame);
}

function onSwAbort(m: { id: number }): void {
  if (!cascade?.isOpen) return;
  const lp = swPorts.get(0);
  for (const [gid, e] of pendingSw) {
    if (e.swPort === lp && e.origId === m.id) {
      clearTimeout(e.timer);
      pendingSw.delete(gid);
      inflightSw.delete(gid); // F9：中止也要清在途计数（dc 回帧销账走不到已删的 pendingSw 条目）
      if (cascade.mode !== 'tunnel') void cascade.send({ k: 'req-abort', id: gid });
      return;
    }
  }
}

function b64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

/** shell 自身请求（服务发现 / 控制台免登）：按模式分流。 */
async function fetchVia(port: number, path: string, timeoutMs = 30_000): Promise<{ status: number; body: Uint8Array }> {
  if (cascade?.mode === 'tunnel' && cascade.tunnelUrl) {
    frameLedger.noteTunnelFrame(); // 路径归类（spec D9）：本分支为裸 fetch 无帧，只记 pathType
    const gw = cascade.tunnelUrl.replace(/\/+$/, '');
    const res = await fetch(`${gw}/s/${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
  }
  if (!cascade?.isOpen) throw new Error('tunnel not connected');
  const gid = ++dcSeq;
  const p = new Promise<{ status: number; body: Uint8Array }>((resolve) => {
    const entry = { resolve, chunks: [] as Uint8Array[], status: 200, timer: setTimeout(() => { pendingFetch.delete(gid); resolve({ status: 504, body: new Uint8Array() }); }, timeoutMs) };
    pendingFetch.set(gid, entry);
  });
  const frame = { k: 'req' as const, id: gid, port, method: 'GET', path, headers: { accept: 'application/json' }, bodyB64: null };
  trackReq(gid, port, path, frame);
  await cascade.send(frame);
  return p;
}

function onDcFrame(m: any): void {
  liveness.noteFrame(); // 任何数据面回帧都是活性证明（含 ws-* / pong）
  if (m.k === 'res-head' || m.k === 'res-chunk') {
    settleReq(m.id, m); // 帧账本：回帧销账（无论是 SW 请求还是 shell 自身请求；含线字节）
    const sw = pendingSw.get(m.id);
    if (sw) {
      if (m.k === 'res-chunk' && m.done) { clearTimeout(sw.timer); pendingSw.delete(m.id); }
      sw.swPort.postMessage({ ...m, id: sw.origId });
      inflightSw.delete(m.id); // 数据面活着：清看门狗
      return;
    }
    const pf = pendingFetch.get(m.id);
    if (pf) {
      if (m.k === 'res-head') { pf.status = m.status; return; }
      // 帧协议 v2 双形态：二进制帧 m.data 直传；旧 JSON 帧走 dataB64
      if (m.data instanceof Uint8Array) pf.chunks.push(m.data);
      else if (m.dataB64) pf.chunks.push(u8FromB64(m.dataB64));
      if (m.done) {
        clearTimeout(pf.timer);
        pendingFetch.delete(m.id);
        const total = pf.chunks.reduce((n, c) => n + c.length, 0);
        const body = new Uint8Array(total);
        let off = 0;
        for (const c of pf.chunks) { body.set(c, off); off += c.length; }
        pf.resolve({ status: pf.status, body });
      }
    }
    return;
  }
  if (m.k === 'pong') return;
  if (typeof m.k === 'string' && m.k.startsWith('ws-')) {
    const port = Math.floor(m.wid / WID_BASE);
    const n = m.wid % WID_BASE;
    const tab = tabs.get(port);
    const orig = tab?.wids.get(n);
    if (!tab || orig === undefined) return;
    // 帧协议 v2 边界转换：二进制 ws 体（m.data）→ dataB64 喂 iframe（shim 协议不动；线税已在 dc 段省掉）
    const out = m.data instanceof Uint8Array ? { ...m, data: undefined, dataB64: b64FromU8(m.data) } : m;
    tab.iframe.contentWindow?.postMessage({ __p2pnet: true, ...out, wid: orig }, location.origin);
  }
}

/** 数据面是否已黑：有在途请求且全局静默超阈（任何回帧都在刷新活性）。
 *  F9：判死口径下沉 liveness.wedged 的 link 参数——未打开（连接进行中/已停止）与隧道
 *  链路不判；连接进行中没有数据面可黑，陈旧在途计数不得误杀进行中的健康重试。 */
function dataPlaneWedged(): boolean {
  if (!cascade) return false;
  return liveness.wedged(inflightSw.size, Date.now(), { isOpen: cascade.isOpen, mode: cascade.mode });
}

/** stall 示警（spec D5）：tunnel 段 ctrlAlive 恒 false——隧道无 dc 静默概念，SW 超时兜底。 */
function checkStall(): boolean {
  return stallSuspect({
    ctrlAlive: cascade?.mode !== 'tunnel' && (cascade?.isOpen ?? false),
    inFlight: inflightSw.size,
    silentMs: liveness.silentFor(),
  });
}

setInterval(() => {
  setStall(checkStall());
  if (cascade && cascade.mode !== 'tunnel' && inflightSw.size > 0) {
    log(`[pulse] 在途 ${inflightSw.size} 条；累计回帧 ${frameLedger.res}；静默 ${Math.round(liveness.silentFor() / 1000)}s`);
  }
  if (!dataPlaneWedged()) return;
  const hung = harvestHung();
  log(`[watchdog] 数据面全局静默 >${LIVE.wedgeMs / 1000}s（在途 ${inflightSw.size} 条无一回帧）→ 拆连重连`
    + (hung.length ? `（例：:${hung[0].port ?? '?'}${hung[0].path}）` : ''));
  inflightSw.clear();
  cascade?.stop(); // emit off → onCascadeStatus 会走指数退避重连（新建 pc，等同重载效果）
}, 3_000);

function u8FromB64(b: string): Uint8Array {
  const bin = atob(b);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function b64FromU8(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

// iframe → 引擎的 ws 帧：按来源 tab 重映射 wid（隧道模式分流到网关 WS）
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || m.__p2pnet !== true) return;
  for (const [port, tab] of tabs) {
    if (tab.iframe.contentWindow === ev.source) {
      if (!cascade?.isOpen) return;
      const n = Number(String(m.wid).replace(/^w/, ''));
      if (!Number.isFinite(n)) return;
      tab.wids.set(n, m.wid);
      const remapped = port * WID_BASE + n;
      if (cascade.mode === 'tunnel') {
        if (m.k === 'ws-open') cascade.tunnelWsOpen(remapped, port, String(m.path || '/'), (f) => onDcFrame({ ...f, wid: remapped }));
        else if (m.k === 'ws-msg') cascade.tunnelWsSend(remapped, m);
        else if (m.k === 'ws-close') cascade.tunnelWsClose(remapped, m.code);
        return;
      }
      void cascade.send({ ...m, wid: remapped, ...(m.k === 'ws-open' ? { port } : {}) });
      return;
    }
  }
});

// ---- 连接级联 ----
async function startConnect(d: SavedDevice, isRetry = false): Promise<void> {
  manualStop = false;
  hideSheets(); // 失败残留的 offline/paste 遮罩不得挡住重连成功后的工作台（2026-09-09 实锤）
  const uid = currentUid();
  const myDeviceId = currentDeviceId();
  if (!uid || !myDeviceId) { showScreen('screen-login'); return; }
  desk.id = d.id;
  desk.tunnelUrl = d.tunnelUrl ?? desk.tunnelUrl;
  // 发现端口三级来源：URL dsc（配对二维码刚给的新鲜事实）→ 设备记忆 → 契约端口
  activeDiscoveryPort = pickDiscoveryPort(Q.get('dsc'), d.discoveryPort ?? null);
  desk.discoveryPort = activeDiscoveryPort;
  deskName = d.name || d.id.slice(0, 8) + '…';
  localStorage.setItem(LS_DESK_ID, d.id);

  // 2026-09-24 F3 修复：手动重试不得杀死自动重连循环——!isRetry 分支随即清零这些状态，
  // 先捕获上下文，失败时据此恢复 scheduleReconnect（reconnectPolicy.ts 裁决）。
  const autoCtx = { isRetry, wasConnected, reconnectAttempt, timerPending: reconnectTimer !== null };

  if (!isRetry) {
    wasConnected = false;
    reconnectAttempt = 0;
    showConnecting(d.name || `桌面 ${d.id.slice(0, 8)}…`);
  }
  setStatus({ state: 'connecting', pairType: null, stage: 'p2p' }, deskName);

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // 2026-09-12 根因修复：重连必须先停旧实例。旧行为直接覆盖变量 → 旧 WebRTC 会话继续轮询信令、
  // 继续 5s 一次上报 connected/p2p，把新会话的"隧道"状态盖成"直连"（真机实证 mode=tunnel 而标签=直连），
  // 同时旧 pc/定时器长期泄漏。先 ++gen 使旧实例的一切回调失效，再 stop 释放它。
  cascadeGen += 1;
  const gen = cascadeGen;
  cascade?.stop();
  cascade = new CascadeSession({
    signaling: makeSignaling(),
    uid,
    myDeviceId,
    getJwt,
    stunServers: p2pStunServers,
    servicesPort: activeDiscoveryPort,
    onStatus: (s) => { if (gen === cascadeGen) onCascadeStatus(s); },
    onFrame: (m) => { if (gen === cascadeGen) onDcFrame(m); },
    onStatsRows: (rows) => { if (gen === cascadeGen) frameLedger.sampleWireStats(rows); }, // wire 采样（spec D9；僵尸会话作废）
    onTunnelUrl: (u) => { desk.tunnelUrl = u; },
    liveness: LIVE,
  });
  // dev 覆盖：?ice= 注入两段 WebRTC 的 iceServers；?transport=relay 只跑 TURN 段
  const iceOverride = Q.get('ice');
  const devOpts: { p2pIceServers?: RTCIceServer[]; forceTurn?: boolean; p2pFullIce?: boolean; forceTunnel?: boolean } = {};
  if (iceOverride) { try { devOpts.p2pIceServers = JSON.parse(iceOverride) as RTCIceServer[]; } catch { /* 忽略 */ } }
  if (Q.get('transport') === 'relay') {
    devOpts.forceTurn = true;
    log('[exp] 强制 TURN 中继模式（只跑 TURN 段）');
    toast('exp: 强制 TURN 中继');
  }
  if (Q.get('tunnel') === '1' || Q.get('notunnel') === '1') {
    devOpts.forceTunnel = true;
    log('[exp] 强制隧道模式（跳过 WebRTC）');
    toast('exp: 强制隧道');
  }
  const p2pIce = Q.get('p2pice');
  if (p2pIce === 'full' || p2pIce === 'stun') {
    devOpts.p2pFullIce = p2pIce === 'full';
    log(`[exp] p2pice=${p2pIce}${p2pIce === 'full' ? '（full ICE via turn-credentials）' : '（STUN-only 现状）'}`);
  }
  cascade.setDevOverrides(devOpts);

  try {
    await cascade.connect(d.id, d.tunnelUrl ?? desk.tunnelUrl);
    liveness.noteOpen(); // 新连接给完整静默宽限窗口
    wasConnected = true;
    reconnectAttempt = 0;
    hideConnecting();
    await afterConnected();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'stopped') {
      // F9：实例被停（看门狗/手动断开/排障 flap/被新实例取代）。旧代码无条件静默 return——
      // 看门狗 stop 落在自动重试中途时，onCascadeStatus 的 'off' 分支又因 wasConnected 已清零
      // 不排重连 → 两侧都不排、无待触发定时器 → 自动重连循环永久死亡（页面谎称「正在重连…」，
      // 桌面端恢复也救不回来）。裁决下沉 reconnectPolicy.onConnectStopped（单测覆盖）。
      const stoppedAct = onConnectStopped({ superseded: gen !== cascadeGen, manualStop, ...autoCtx });
      if (!stoppedAct.reconnect && !stoppedAct.sheet) return; // 被取代/手动断开：保持静默
      log(`[conn] 连接被中断（stopped）→ ${stoppedAct.reconnect ? '自动重连循环续命' : '交代用户'}`);
      hideConnecting();
      setStatus({ state: 'failed', pairType: null }, deskName);
      if (stoppedAct.reconnect) scheduleReconnect();
      if (stoppedAct.sheet) showOfflineSheet(d.name || `桌面 ${d.id.slice(0, 8)}…`, '连接被数据面看门狗中断。请重试。', () => void startConnect(d));
      return;
    }
    log(`[conn] 级联失败：${msg}`);
    hideConnecting();
    setStatus({ state: 'failed', pairType: null }, deskName);
    const act = onConnectFailure(autoCtx);
    if (act.reconnect) scheduleReconnect(); // F3：带自动重连上下文的手动失败必须恢复循环
    if (act.sheet) showOfflineSheet(d.name || `桌面 ${d.id.slice(0, 8)}…`, `三种通道均不可达：${msg}`, () => void startConnect(d));
  }
}

function onCascadeStatus(s: Parameters<typeof setStatus>[0]): void {
  setStatus(s, deskName);
  if (s.state === 'connecting' && s.stage && s.stage !== 'done') connectingStage(s.stage);
  // 断线自愈（Q16）：曾连接、非手动断开 → 指数退避重连
  if (s.state === 'off' && wasConnected && !manualStop && desk.id) {
    toast('连接断开，正在重连…');
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  // 2026-09-12 恢复速度优化：首跳 500ms（原 1s），之后 1→2→4→8→15s 封顶。
  // 真机实证：三轮断网切换后网络其实已恢复，但重连仍卡在退避窗口里，恢复被拖到十几秒。
  const delay = reconnectAttempt === 0 ? 500 : Math.min(1000 * 2 ** (reconnectAttempt - 1), 15_000);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startConnect({ id: desk.id, tunnelUrl: desk.tunnelUrl, name: deskName }, true);
  }, delay);
}

/**
 * 网络恢复即刻重连（2026-09-12 稳定性/速度加固）。
 *
 * 浏览器把"底层网络恢复"以 `online` 事件告诉我们——这比我们自己的退避轮询更早知道。
 * 此前不监听该事件：网络回来了，重连却还在 1→2→4→8→15s 的退避窗口里干等，
 * 实测恢复被拖到十几秒（0/24 全快速失败期间）。
 * 现在：恢复瞬间清零退避并立即重连；链路仍开着则什么都不做。
 */
window.addEventListener('online', () => {
  if (manualStop || !desk.id) return;
  reconnectAttempt = 0; // 网络刚回来：退避阶梯重置
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (!cascade?.isOpen) {
    log('[net] 网络已恢复 → 立即重连（跳过退避）');
    void startConnect({ id: desk.id, tunnelUrl: desk.tunnelUrl, name: deskName }, true);
  }
});

function stopSession(): void {
  manualStop = true;
  wasConnected = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  cascade?.stop();
  setStatus({ state: 'off', pairType: null }, deskName);
  setWorkspaceEnabled(false);
  toast('已断开');
}

// ---- 服务发现 + 工作台直载（不重建移动端工作台） ----
let servicesFetched = false;
let fetchRetries = 0;
let consolePort: number | null = null;

async function afterConnected(): Promise<void> {
  showTab('workspace');
  setWorkspaceEnabled(true);
  // 本轮之前连过 → 说明这是**重连**（黑洞拆连/换网/断网恢复）。此时：
  //   ① 服务清单与免登票据要重新取（票据可能已过期、console 端口可能变了）；
  //   ② 工作台 iframe 很可能在黑洞窗口里被打死（资源 504）——必须**强制重载**，
  //      否则就是用户看到的"永远白屏"（2026-09-12 真机 CDP 取证）。
  const isReconnect = everConnected;
  if (isReconnect) { servicesFetched = false; fetchRetries = 0; }
  await fetchServices();
  if (isReconnect && consolePort) {
    const tab = tabs.get(consolePort);
    if (tab) {
      tab.booted = false;
      tab.reloads = 0;
      log('[workbench] 数据面已重连 → 重建工作台（清首屏残骸）');
      await openService(consolePort);
    }
  }
  everConnected = true;
}

async function fetchServices(): Promise<void> {
  if (servicesFetched) return;
  // 候选端口逐个试（URL/记忆优先，其后契约 → 偏移）。全部失败才算"发现不可用"——
  // 旧实现只打 19528，遇到并行偏移端口就必然失败（2026-09-12 白屏根因）。
  const candidates = discoveryCandidates(activeDiscoveryPort ?? Q.get('dsc'));
  let lastErr: unknown = new Error('discovery_unreachable');
  for (const dscPort of candidates) {
    try {
      const res = await fetchVia(dscPort, '/services');
      const text = new TextDecoder().decode(res.body);
      const list = JSON.parse(text) as {
        self?: { hostname?: string; deviceId?: string };
        console?: string | { url?: string }[];
        consoleTicket?: string;
        services?: { name: string; url?: string; port?: number }[];
      };
      // 免登票据以 discovery 下发的 consoleTicket 为准；配对票据是 Supabase UUID，
      // 不能当控制台 auto 票据用（2026-09-09 实锤：直连 200 / 经 PWA 403）。
      if (typeof list.consoleTicket === 'string' && list.consoleTicket) desk.ticket = list.consoleTicket;
      currentServices = (list.services ?? []).map((s) => ({
        ...s,
        port: Number.isFinite(s.port) ? Number(s.port) : Number((s.url || '').match(/^\/s\/(\d+)\//)?.[1]),
      })).filter((s) => Number.isFinite(s.port) && s.port > 0);
      // 成功端口落进设备记忆：下次（含账号登录/设备列表重连、换网重连）直接用，
      // 不必再靠 URL 里的 ?dsc= ——这正是"二维码能连、重连必白屏"的根治点。
      const changed = desk.discoveryPort !== dscPort;
      activeDiscoveryPort = dscPort;
      desk.discoveryPort = dscPort;
      if (list.self?.hostname) deskName = list.self.hostname;
      upsertDevice({
        id: desk.id,
        name: deskName,
        tunnelUrl: desk.tunnelUrl ?? undefined,
        discoveryPort: dscPort,
      });
      if (changed) log(`[services] 发现端口 ${dscPort}（契约 ${DISCOVERY_PORT}）；已记忆到设备`);
      servicesFetched = true;
      log(`[services] ${currentServices.length} 个；console=${list.console ?? '（载荷未带）'}`);
      await openWorkbench(list);
      return;
    } catch (e) {
      lastErr = e;
      log(`[services] 端口 ${dscPort} 拉取失败：${(e as Error).message}`);
    }
  }
  // 全部候选都失败：**不再**打开 0.9.x 老端口 3002（那等于把用户丢进白屏）。
  // 明确告知 + 可重试，是这里唯一正确的兜底。
  log(`[services] 候选全失败：${(lastErr as Error).message}`);
  if (fetchRetries < 3) {
    fetchRetries += 1;
    setTimeout(() => { void fetchServices(); }, 2000);
    return;
  }
  showOfflineSheet(deskName, '服务发现不可用（已尝试端口 ' + candidates.join(' / ') + '）。请确认桌面端已连接，然后重试。', () => {
    servicesFetched = false;
    fetchRetries = 0;
    void fetchServices();
  });
}

/** 工作台直载：控制台端口**只能**来自桌面自述（载荷 console / 服务清单）。
 *  console 字段形态：字符串 '/s/<port>/'（旧）或数组占位（p2p-net 一期为 []，字段保留）。 */
async function openWorkbench(list?: { console?: string | { url?: string }[] }): Promise<void> {
  const consoleField = list?.console;
  const consolePath = typeof consoleField === 'string' ? consoleField
    : Array.isArray(consoleField) ? (consoleField[0]?.url ?? '') : '';
  const cport = Number(consolePath.match(/^\/s\/(\d+)\//)?.[1])
    || currentServices.find((s) => s.name === 'p2p-net')?.port
    || Number(currentServices.find((s) => (s.url || '').includes('/s/'))?.port);
  if (!Number.isInteger(cport) || cport <= 0) {
    showOfflineSheet(deskName, '桌面未自述工作台端口，无法打开。请更新桌面端后重试。', () => {
      servicesFetched = false;
      fetchRetries = 0;
      void fetchServices();
    });
    return;
  }
  // 验收/排障钩子：?svc=<port> 直开指定服务（绕过 console 自述选择），供 bench/回归定向打击。
  const svcQ = Number(Q.get('svc'));
  if (Number.isInteger(svcQ) && svcQ > 0) {
    consolePort = svcQ;
    await openService(svcQ);
    return;
  }
  consolePort = cport;
  await openService(cport);
}

async function openService(port: number): Promise<void> {
  let tab = tabs.get(port);
  if (!tab) {
    await ensureSW();
    const iframe = document.createElement('iframe');
    iframe.id = `svc-${port}`;
    iframe.title = String(port);
    iframe.className = 'app';
    document.getElementById('appHost')!.appendChild(iframe);
    tab = { port, iframe, wids: new Map(), reloads: 0, booted: false };
    tabs.set(port, tab);
    iframe.src = 'about:blank';
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const t of tabs.values()) t.iframe.style.display = 'none';
  tab.iframe.style.display = 'block';
  setConnTitleSafe();
  void markActive(port);
  void bootWorkbench(port, tab);
}

// ---- 工作台首屏自愈（2026-09-12 白屏真根因；决策逻辑见 workbenchRecovery.ts）----
// 数据面短时黑洞会让控制台首屏资源 504，而失败的 <script>/<link> 永不自动重试 →
// iframe 永久白屏。所以开窗前先探活，开窗后体检，不健康就重载。
const bootDefer = new Map<number, number>();
const BOOT_PROBE_TIMEOUT_MS = 4_000;

/** 数据面探活：拿到上游真实应答（含 404）即证明回帧路径活着（此刻才值得烧首屏资源）。 */
async function dataPlaneReady(port: number, timeoutMs = BOOT_PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetchVia(port, '/api/auth/status', timeoutMs);
    return dataPlaneAlive(res.status);
  } catch {
    return false;
  }
}

async function bootWorkbench(port: number, tab: TabEntry): Promise<void> {
  if (tab.booted) return;
  const deferCount = bootDefer.get(port) ?? 0;
  const ready = await dataPlaneReady(port);
  const gate = bootGateDecision({ dataPlaneReady: ready, deferCount });
  if (gate === 'defer') {
    bootDefer.set(port, deferCount + 1);
    log(`[workbench] 数据面未就绪，暂缓开窗（第 ${deferCount + 1} 次）；等重连后再试`);
    return; // 重连成功会再次走到这里（afterConnected → openService）
  }
  if (gate === 'giveup') {
    log('[workbench] 多次探活失败，交给用户手动重试');
    showOfflineSheet(deskName, '数据面暂时不可用，无法打开工作台。请重试。', () => {
      bootDefer.delete(port);
      void bootWorkbench(port, tab);
    });
    return;
  }
  bootDefer.delete(port);
  tab.iframe.src = await workbenchEntryUrl(port);
  scheduleHealthChecks(port, tab);
}

/** 开窗后按节奏体检：没 boot 起来就重载（上限 3 次），避免"永久白屏"。
 *  同一时刻只挂一个探针（重载前先清掉上一个），避免多拍并发重载。 */
function scheduleHealthChecks(port: number, tab: TabEntry, step = 0): void {
  if (tab.healthTimer) clearTimeout(tab.healthTimer);
  const delay = HEALTH_CHECK_DELAYS_MS[Math.min(step, HEALTH_CHECK_DELAYS_MS.length - 1)];
  tab.healthTimer = setTimeout(() => {
    if (port !== consolePort) return;
    if (looksBooted(tab.iframe.contentDocument)) {
      if (!tab.booted) log('[workbench] 首屏已就绪');
      tab.booted = true;
      return;
    }
    if (step < HEALTH_CHECK_DELAYS_MS.length - 1) { scheduleHealthChecks(port, tab, step + 1); return; }
    const verdict = healthDecision({ booted: false, reloadCount: tab.reloads ?? 0 });
    if (verdict === 'reload') {
      tab.reloads = (tab.reloads ?? 0) + 1;
      log(`[workbench] 首屏未起来（第 ${tab.reloads} 次）→ 重载`);
      void openService(port).then(() => scheduleHealthChecks(port, tab));
      return;
    }
    log('[workbench] 重载多次仍未起来 → 交给用户手动重试');
    showOfflineSheet(deskName, '工作台没能加载出来。请重试。', () => {
      tab.reloads = 0;
      void openService(port).then(() => scheduleHealthChecks(port, tab));
    });
  }, delay);
}

/** 工作台入口：有免登票据 → 先经数据面兑换（拿 auth-token 写入同源 localStorage，再进根路径）。
 *  控制台的免登 HTML 会 location.replace('/')，直接导航会跳出 /s/<port>/ 作用域——所以由
 *  shell 代取 HTML、解析 JWT、落 localStorage，iframe 直接进工作台根。 */
async function workbenchEntryUrl(port: number): Promise<string> {
  const ticket = desk.ticket;
  desk.ticket = null;
  if (ticket) {
    try {
      const res = await fetchVia(port, `/api/auth/auto?ticket=${encodeURIComponent(ticket)}`, 15_000);
      const text = new TextDecoder().decode(res.body);
      const m = text.match(/localStorage\.setItem\("auth-token","([^"]+)"\)/);
      if (m && res.status === 200) {
        localStorage.setItem('auth-token', m[1]);
        log('[workbench] 免登票据已兑换（auth-token 已写入）');
        return `/s/${port}/`;
      }
      log(`[workbench] 票据兑换未通过（HTTP ${res.status}），进入手输登录页`);
    } catch (e) {
      log(`[workbench] 票据兑换失败：${(e as Error).message}，进入手输登录页`);
    }
  }
  return `/s/${port}/`;
}

function markActive(port: number): void { void port; }
function setConnTitleSafe(): void {
  const el = document.getElementById('connTitle');
  if (el && !el.textContent?.includes(deskName)) {
    const badge = el.querySelector('.badge');
    el.textContent = '';
    const b = document.createElement('span'); b.textContent = deskName;
    el.append(b);
    if (badge) el.append(' ', badge);
  }
}

// ---- 登录（扫码免密 + 账号密码，Q3 双真） ----
async function ensureBindPhone(): Promise<void> {
  if (localStorage.getItem(LS_DEVICE_ID)) return;
  const bound = await bindPhone('p2p-net-pwa');
  localStorage.setItem(LS_DEVICE_ID, bound.deviceId);
  log(`[auth] 已绑定 phone 设备 ${bound.deviceId.slice(0, 8)}…`);
}

/** 扫码/粘贴结果处理：票 → 兑换登录 → 绑定 → 记住设备 → 连接。 */
async function handlePair(raw: string): Promise<void> {
  let pair: ScanPayload;
  try { pair = parseScan(raw); } catch (e) { toast((e as Error).message); return; }
  if (!pair.ticket) { toast('二维码内容无效'); return; }
  const statusEl = document.getElementById('loginStatus');
  try {
    const { data } = await (await supabase()).auth.getSession();
    if (!data.session) {
      if (statusEl) statusEl.textContent = '扫码登录中…';
      await loginByTicket(pair.ticket, 'p2p-net-pwa');
    }
    await ensureBindPhone();
    const sess = await (await supabase()).auth.getSession();
    if (sess.data.session) localStorage.setItem(LS_UID, sess.data.session.user.id);
    if (pair.deskDeviceId) {
      // 二维码自述的发现端口必须一路带下去：
      // 设备记忆（下次重连不用再猜）+ 本次连接（立刻用对端口）。
      // 2026-09-12 真机白屏根因：这两个对象都不带 dsc，等于把二维码里唯一的新鲜事实扔掉。
      const list = upsertDevice({
        id: pair.deskDeviceId,
        tunnelUrl: pair.tunnelUrl ?? undefined,
        discoveryPort: pair.discoveryPort ?? undefined,
      });
      refreshDevicesUI();
      void startConnect({
        id: pair.deskDeviceId,
        tunnelUrl: pair.tunnelUrl,
        name: undefined,
        discoveryPort: pair.discoveryPort ?? undefined,
      });
    } else {
      refreshDevicesUI();
      showTab('devices');
      toast('登录成功，请选择要连接的设备');
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = `❌ ${(e as Error).message}`;
    toast((e as Error).message);
  }
}

async function passwordLogin(): Promise<void> {
  const email = (document.getElementById('inEmail') as HTMLInputElement).value.trim();
  const pw = (document.getElementById('inPassword') as HTMLInputElement).value;
  const statusEl = document.getElementById('loginStatus')!;
  if (!email || !pw) { statusEl.textContent = '请输入邮箱与密码'; return; }
  statusEl.textContent = '登录中…';
  try {
    await loginByPassword(email, pw);
    await ensureBindPhone();
    localStorage.setItem(LS_UID, (await (await supabase()).auth.getSession()).data.session!.user.id);
    cachedToken = (await (await supabase()).auth.getSession()).data.session!.access_token;
    statusEl.textContent = '✅ 登录成功';
    afterAuthUI();
    // 连接路由回来的人：密码登录后继续连接
    if (desk.id) void startConnect({ id: desk.id, tunnelUrl: desk.tunnelUrl });
    else showTab('devices');
  } catch (e) {
    statusEl.textContent = `❌ ${(e as Error).message}`;
  }
}

function afterAuthUI(): void {
  void getJwt().then(() => { /* 预热 token */ });
  refreshDevicesUI();
  void supabase().then((s) => s.auth.getSession()).then(({ data }) => {
    setMe(data.session?.user.email ?? null, loadDevices().length, `模式=${cascade?.mode ?? '—'}`);
  });
  setWorkspaceEnabled(!!cascade?.isOpen);
  showTab('devices');
}

// ---- 相机扫码（jsQR，T12 兑现） ----
let camStream: MediaStream | null = null;
let camRaf = 0;
async function startScan(): Promise<void> {
  showScreen('screen-camera');
  $id('camStatus').textContent = '正在启动相机…';
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
    const v = document.getElementById('camVideo') as HTMLVideoElement;
    v.srcObject = camStream;
    await v.play();
    $id('camStatus').textContent = '对准电脑主面板上的登录二维码';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    let flip = false;
    const tick = (): void => {
      if (!camStream) return;
      flip = !flip;
      if (flip && v.videoWidth) {
        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code?.data) {
          stopScan();
          void handlePair(code.data);
          return;
        }
      }
      camRaf = requestAnimationFrame(tick);
    };
    camRaf = requestAnimationFrame(tick);
  } catch (e) {
    $id('camStatus').textContent = `相机不可用：${(e as Error).message}（可返回用「粘贴二维码内容」）`;
  }
}
function stopScan(): void {
  cancelAnimationFrame(camRaf);
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
}

// ---- 工具 ----
const $id = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---- 启动 ----
async function boot(): Promise<void> {
  if (wechatGuard()) return;   // Q15：微信内置浏览器直接拦截
  // ?debug=1 诊断浮层：真机无 DevTools 时把隐藏 #log 翻成可见浮层（越早越好，boot 失败也可见）
  if (Q.has('debug')) document.getElementById('log')?.classList.replace('hidden', 'debug');
  log(`[boot] p2p-net 随行${DEV_MODE ? '（dev 直连钩子）' : ''}`);
  // 运行时配置是全端唯一配置来源：缺失/损坏必须渲染可操作错误页而非白屏（spec §3）。
  try {
    runtimeCfg = await loadRuntimeConfig();
  } catch (e) {
    log(`[boot] ${(e as Error).message}`);
    showBrowserHint('部署配置缺失', (e as Error).message);
    return;
  }
  p2pStunServers = stunServersFromRelays(runtimeCfg.relays);
  if (!('serviceWorker' in navigator)) {
    showBrowserHint('此浏览器不支持', '本页依赖 Service Worker。\n请用 Safari（iPhone）或 Chrome（Android）打开。');
    return;
  }
  try { await ensureSW(); } catch (e) {
    // SW 注册失败（iOS 微信/隐私模式等）：整条隧道不可用，明确提示而不是白屏
    log(`[boot] SW 注册失败：${(e as Error).message}`);
    showBrowserHint('此浏览器能力不足', `Service Worker 注册失败（${(e as Error).message}）。\n请用 Safari（iPhone）或 Chrome（Android）打开。`);
    return;
  }
  refreshDevicesUI();
  setWorkspaceEnabled(false);

  // /connect?t=&d=&u= 路由（桌面二维码 URL 形态，Q9）
  const urlTicket = Q.get('t') || Q.get('ticket');
  if (urlTicket) {
    desk.ticket = urlTicket;
    desk.id = Q.get('d') || '';
    desk.tunnelUrl = Q.get('u');
  }

  const dev = devIdentity();
  if (dev) {
    if (dev.rt) {
      const { error } = await (await supabase()).auth.setSession({ access_token: dev.jwt ?? '', refresh_token: dev.rt });
      if (error) log(`[dev] ⚠️ setSession 失败（rt 无效？）: ${error.message}`);
      cachedToken = (await (await supabase()).auth.getSession()).data.session?.access_token ?? dev.jwt;
      log(`[dev] 会话已激活（rt 模式）`);
    } else {
      cachedToken = dev.jwt;
    }
    desk.id = dev.deskId;
    desk.ticket = Q.get('t') || null;   // 烟测：真控制台免登票据（&t=）
    localStorage.setItem(LS_DESK_ID, dev.deskId);
    upsertDevice({ id: dev.deskId, tunnelUrl: undefined });
    refreshDevicesUI();
    setMe((await (await supabase()).auth.getSession()).data.session?.user.email ?? dev.uid, loadDevices().length, 'dev 钩子');
    showTab('devices');
    setWorkspaceEnabled(true);
    // driver 兼容：不自动连（由 __p2pNetConnect 驱动）；?auto=1 供真机级烟测直进连接
    if (Q.get('auto') === '1') void (window as any).__p2pNetConnect(dev.deskId);
    return;
  }

  watchAuthToken();
  const { data } = await (await supabase()).auth.getSession();
  if (data.session) {
    localStorage.setItem(LS_UID, data.session.user.id);
    try { await ensureBindPhone(); } catch (e) { log(`[auth] 设备绑定失败：${(e as Error).message}`); }
    afterAuthUI();
    // 自动连接目标（bootPolicy）：票据直达优先；无票重进自动重连最近桌面（F6）。
    // URL 里的 dsc 一并带上（否则又退回"猜契约端口"）。
    const bootTarget = bootConnectTarget({ loggedIn: true, ticketDeskId: desk.id, lastDeskId: localStorage.getItem(LS_DESK_ID) });
    if (bootTarget) {
      const saved = loadDevices().find((d) => d.id === bootTarget);
      void startConnect({
        id: bootTarget,
        tunnelUrl: desk.tunnelUrl ?? saved?.tunnelUrl,
        discoveryPort: Number(Q.get('dsc')) || saved?.discoveryPort,
      });
    }
  } else {
    setMe(null, loadDevices().length, '—');
    showScreen('screen-scan-intro');
    // /connect?t=&d= 直达（桌面二维码 URL 形态）：未登录也必须自动走票据兑换，
    // 不能卡在引导页。
    // 重投时必须**原样带上 dsc**：此前重建的载荷把它丢了 → 扫码登录成功但工作台白屏。
    // 合成 URL 必须含 '/connect?'（parseScan 只认该形态）；源仓此处的合成串缺 '/connect'
    // 路径导致永远落到格式错误分支——迁入时一并修复。
    if (urlTicket) {
      const dscParam = Q.get('dsc') ? `&dsc=${encodeURIComponent(Q.get('dsc') as string)}` : '';
      void handlePair(
        `https://p2p-net.invalid/connect?t=${encodeURIComponent(urlTicket)}&d=${encodeURIComponent(desk.id || '')}${dscParam}`,
      );
    }
    return;
  }
}

// ---- DOM 事件接线 ----
for (const b of document.querySelectorAll<HTMLButtonElement>('#tabbar [data-tab]')) {
  b.addEventListener('click', () => {
    const name = b.dataset.tab!;
    if (name === 'workspace' && !cascade?.isOpen) { toast('先连接一台电脑，才能进入工作台'); showTab('devices'); return; }
    showTab(name);
  });
}
$id('btnGoScan').onclick = () => showScreen('screen-scan-intro');
$id('btnOpenCamera').onclick = () => void startScan();
$id('btnCamClose').onclick = () => { stopScan(); showScreen('screen-scan-intro'); };
$id('btnGotoLogin').onclick = () => showScreen('screen-login');
$id('bkLogin').onclick = () => showScreen('screen-scan-intro');
$id('btnEye').onclick = () => {
  const p = $id<HTMLInputElement>('inPassword');
  p.type = p.type === 'password' ? 'text' : 'password';
};
$id('btnPasswordLogin').onclick = () => void passwordLogin();
$id('lnkClaim').onclick = () => toast('账号由初始化（p2p-net init）时创建，请在电脑端查看');
$id('btnDisconnect').onclick = () => stopSession();
$id('btnLogout').onclick = () => {
  void supabase().then((s) => s.auth.signOut()).then(() => {
    localStorage.removeItem(LS_UID);
    localStorage.removeItem(LS_DEVICE_ID);
    location.href = '/';
  });
};
$id('rowDevices').onclick = () => showTab('devices');
$id('rowDiag').onclick = () => {
  setMe(null, loadDevices().length,
    `模式=${cascade?.mode ?? '—'} · 通道=${cascade?.isOpen ? '开' : '关'} · 网关=${desk.tunnelUrl ? '有' : '无'}`);
  toast(`模式=${cascade?.mode ?? '—'} 通道=${cascade?.isOpen ? '开' : '关'}`);
};
// 接入类型标注（Wave 2 W2-1）：写 LS_ACCESS，下一次 offer 起随 meta.access 上报；
// 选「自动探测」则清除手动标注，回落 navigator.connection 探测（Safari 无 → unknown）。
const selAccess = $id<HTMLSelectElement>('selAccess');
selAccess.value = localStorage.getItem(LS_ACCESS) ?? '';
selAccess.onchange = () => {
  if (selAccess.value) localStorage.setItem(LS_ACCESS, selAccess.value);
  else localStorage.removeItem(LS_ACCESS);
};
const openPaste = (): void => showPasteSheet((raw) => void handlePair(raw));
$id('btnPastePair').onclick = openPaste;
$id('btnPastePair2').onclick = openPaste;

// ---- 引擎导出（smoke driver / 排障） ----
(window as any).__p2pNetOpenService = (port: number) => void openService(port);
/**
 * 排障/回归钩子：模拟"数据面黑洞"（拆掉当前会话，让请求 >9s 无回帧）。
 * 用途：白屏自愈回归——把黑洞打在控制台首屏加载的瞬间，断言工作台能自愈（无需人工刷新）。
 * 与 __p2pNetConnect/__p2pNetOpenService 同属"引擎导出（smoke driver / 排障）"面，不做任何写操作。
 */
(window as any).__p2pNetFlap = (reason = 'manual') => {
  log(`[exp] 模拟数据面黑洞（${reason}）→ 拆连，交给既有重连与首屏自愈`);
  inflightSw.clear();
  cascade?.stop();
};
(window as any).__p2pNetConnect = (deskId?: string) => {
  const id = deskId || desk.id || localStorage.getItem(LS_DESK_ID) || '';
  if (!id) return Promise.reject(new Error('no desk id'));
  return startConnect({ id, tunnelUrl: desk.tunnelUrl });
};
(window as any).__p2pNetDebug = () => ({
  connected: cascade?.isOpen ?? false,
  mode: cascade?.mode ?? null,
  services: currentServices,
  consolePort,
  desk: { ...desk },
  // 排障用（2026-09-12）：gen 用于识别僵尸会话，inflight 用于识别数据面黑洞
  gen: cascadeGen,
  inflightSw: inflightSw.size,
  stall: checkStall(),
  // 帧账本：sent/res 差距大 = 回程丢帧；lastHung 直接给出是哪些路径没回来
  frames: {
    sent: frameLedger.sent,
    res: frameLedger.res,
    hung: frameLedger.hung,
    bytesSent: frameLedger.bytesSent,
    bytesRecv: frameLedger.bytesRecv,
    pathType: frameLedger.pathType,
    wireBytesSent: frameLedger.wireBytesSent,
    wireBytesRecv: frameLedger.wireBytesRecv,
    lastHung: frameLedger.lastHung,
  },
});

void boot();
