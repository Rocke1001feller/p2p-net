/**
 * 产品壳 UI 模块（原型 A「随行」）：屏幕路由、tab 栏、状态条、设备卡、连接中阶段、
 * 离线 sheet、toast、微信环境拦截。引擎（shell.ts）只经由本模块触碰 DOM。
 * 色值沿用全端口径：P2P 深绿 #0A8A5F / 中继浅绿 #7BC96F / 连接中琥珀 #B26A00 / 离线灰 / 故障红。
 */
import type { CascadeStatus } from './session.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface SavedDevice {
  id: string;        // 桌面 daemon deviceId（信令房间锚点）
  name?: string;     // 发现载荷 self.hostname（连上后回填）
  tunnelUrl?: string | null; // 二维码 u= 携带的接入网关（级联第 2 段；null = 该设备无隧道）
  /** 该设备上次成功的服务发现端口（19528 契约 / 19628 并行偏移）。
   *  持久化理由：二维码只在新配对时给一次 `?dsc=`，账号登录/设备列表重连拿不到——
   *  不记住就必然退回"猜 19528"，遇到偏移端口即白屏（2026-09-12 真机根因）。 */
  discoveryPort?: number;
  lastAt?: number;   // 最近一次连接发起时间
}

// ---- 屏幕与 tab ----
const FULL_SCREENS = ['screen-scan-intro', 'screen-camera', 'screen-login', 'screen-connecting'];
const TAB_SCREENS: Record<string, string> = { devices: 'screen-devices', workspace: 'screen-workspace', me: 'screen-me' };
let curTab = 'devices';

export function showScreen(id: string): void {
  for (const s of FULL_SCREENS) $(s).classList.toggle('show', s === id);
  document.getElementById('tabbar')!.style.display = id ? 'none' : 'flex';
}

export function showTab(name: string): void {
  curTab = TAB_SCREENS[name] ? name : 'devices';
  for (const s of Object.values(TAB_SCREENS)) $(s).classList.remove('show');
  $(TAB_SCREENS[curTab]).classList.add('show');
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabbar [data-tab]')) {
    b.classList.toggle('on', b.dataset.tab === curTab);
  }
}

export function currentTab(): string { return curTab; }

export function setWorkspaceEnabled(ok: boolean): void {
  ($('tabWorkspace') as HTMLButtonElement).disabled = !ok;
}

// ---- toast ----
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string): false {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  return false;
}

// ---- 调试日志（引擎挂载点，隐藏） ----
export function log(msg: string): void {
  const el = document.getElementById('log');
  if (el) el.textContent += `${new Date().toISOString().slice(11, 19)} ${msg}\n`;
  console.log(`[shell] ${msg}`);
}

// ---- 状态条（工作台 tab 顶部 44px 感知条，Q1） ----
const MODE_LABEL: Record<string, string> = { p2p: '直连', tunnel: '隧道', turn: '中继' };
const MODE_BADGE: Record<string, string> = { p2p: 'p2p', tunnel: 'relay', turn: 'relay' };
/** 心跳 pong 的状态帧不带 mode——记住最后一次真实落点，别把中继谎报成"直连"。 */
let lastMode: string | null = null;

export function setStatus(s: CascadeStatus, deviceName: string): void {
  const dot = $('connDot');
  const title = $('connTitle');
  const rtt = $('connRtt');
  if (s.state === 'connected') {
    if (s.mode) lastMode = s.mode;
    // 落点诚实的最高优先级是 getStats 的 pairType：p2p 段也可能选中对端 relay 候选
    // （桌面常备 TURN 候选），此时 stage 报 p2p 但流量实际在走中继（2026-09-22 蜂窝真机实锤）。
    const byPair = s.pairType === 'relay' ? 'turn' : s.pairType === 'p2p' ? 'p2p' : null;
    const mode = byPair ?? s.mode ?? lastMode ?? 'p2p';
    dot.style.background = mode === 'p2p' ? 'var(--p2p)' : 'var(--relay)';
    dot.className = 'dot breath';
    title.innerHTML = ''; // 用 DOM 组装，避免 innerHTML 注入面
    const b = document.createElement('span'); b.textContent = deviceName || '已连接';
    const badge = document.createElement('span'); badge.className = `badge ${MODE_BADGE[mode] ?? 'p2p'}`;
    badge.textContent = MODE_LABEL[mode] ?? '已连接';
    title.append(b, ' ', badge);
    rtt.textContent = s.rttMs !== undefined ? `${Math.round(s.rttMs)} ms` : '';
    $('btnDisconnect').classList.remove('hidden');
  } else if (s.state === 'connecting') {
    dot.style.background = 'var(--conn)';
    dot.className = 'dot breath';
    title.textContent = `${deviceName || '设备'} · 连接中…`;
    rtt.textContent = '';
    $('btnDisconnect').classList.add('hidden');
  } else {
    lastMode = null;
    dot.style.background = 'var(--off)';
    dot.className = 'dot';
    title.textContent = s.state === 'failed' ? '连接失败' : '未连接';
    rtt.textContent = '';
    $('btnDisconnect').classList.add('hidden');
  }
}

// ---- 连接中屏 ----
export function showConnecting(deviceName: string): void {
  $('connDevName').textContent = deviceName || '—';
  stagesReset();
  showScreen('screen-connecting');
}

function stagesReset(): void {
  document.querySelectorAll('#stages .stg').forEach((el) => {
    el.className = 'stg';
    const sd = el.querySelector('.sd') as HTMLElement;
    if (sd) sd.textContent = '';
  });
  $('connStageTxt').textContent = '正在建立直连…';
}

export function connectingStage(stage: 'p2p' | 'tunnel' | 'turn'): void {
  const order = ['p2p', 'tunnel', 'turn'];
  let passed = true;
  for (const name of order) {
    const el = document.querySelector(`#stages .stg[data-stg="${name}"]`) as HTMLElement;
    const sd = el.querySelector('.sd') as HTMLElement;
    if (name === stage) { el.className = 'stg doing'; sd.textContent = ''; passed = false; }
    else if (passed) { el.className = 'stg done'; sd.textContent = '✓'; }
    else el.className = 'stg';
  }
  $('connStageTxt').textContent =
    stage === 'p2p' ? '正在建立直连（NAT 穿越）…'
    : stage === 'tunnel' ? '直连不可用，尝试反向隧道…'
    : '隧道不可用，走 TURN 中继（加密）…';
}

export function hideConnecting(): void {
  $('screen-connecting').classList.remove('show');
  document.getElementById('tabbar')!.style.display = 'flex';
}

// ---- 设备列表 ----
export function renderDevices(devices: SavedDevice[], onConnect: (d: SavedDevice) => void): void {
  const list = $('devList');
  list.innerHTML = '';
  $('devEmpty').style.display = devices.length ? 'none' : 'block';
  for (const d of devices) {
    const card = document.createElement('div');
    card.className = 'dev-card';
    const top = document.createElement('div'); top.className = 'top';
    const ic = document.createElement('div'); ic.className = 'dev-ic';
    ic.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="5" width="16" height="10" rx="1.6"/><path d="M2 18h20"/></svg>';
    const nm = document.createElement('div'); nm.className = 'nm';
    const b = document.createElement('b'); b.textContent = d.name || `桌面 ${d.id.slice(0, 8)}…`;
    const span = document.createElement('span');
    span.textContent = d.lastAt ? `上次连接 ${new Date(d.lastAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : d.id;
    nm.append(b, span);
    top.append(ic, nm);
    card.appendChild(top);
    card.onclick = () => onConnect(d);
    list.appendChild(card);
  }
}

export function setMe(email: string | null, deviceCount: number, diag: string): void {
  $('meEmail').textContent = email || '未登录';
  $('meAvatar').textContent = (email || 'D').slice(0, 1).toUpperCase();
  $('meDevCount').textContent = `${deviceCount} 台（本机记忆）`;
  $('diagInfo').textContent = diag;
}

// ---- sheets ----
export function showOfflineSheet(deviceName: string, detail: string, onRetry: () => void): void {
  $('offlineTitle').textContent = `${deviceName || '设备'}连不上`;
  $('offlineLead').textContent = detail || '可能已休眠或未开机。会话都安全地存在那台电脑上，上线后即可继续。';
  const retry = $('btnRetryConn');
  const cloned = retry.cloneNode(true) as HTMLButtonElement;
  retry.replaceWith(cloned);
  cloned.onclick = () => { hideSheets(); onRetry(); };
  $('dim').classList.add('show');
  $('offlineSheet').classList.add('show');
}

export function showPasteSheet(onGo: (raw: string) => void): void {
  ($('inPastePair') as HTMLInputElement).value = '';
  const go = $('btnPasteGo');
  const cloned = go.cloneNode(true) as HTMLButtonElement;
  go.replaceWith(cloned);
  cloned.onclick = () => {
    const raw = ($('inPastePair') as HTMLInputElement).value.trim();
    if (!raw) return;
    hideSheets();
    onGo(raw);
  };
  $('dim').classList.add('show');
  $('pasteSheet').classList.add('show');
}

export function hideSheets(): void {
  $('dim').classList.remove('show');
  $('offlineSheet').classList.remove('show');
  $('pasteSheet').classList.remove('show');
}

// ---- 浏览器能力/环境拦截（Q15 用户裁决：提示用系统浏览器打开） ----
export function showBrowserHint(title: string, desc: string): void {
  const el = $('wechatHint');
  el.querySelector('h3')!.textContent = title;
  el.querySelector('.sub')!.textContent = desc;
  el.classList.add('show');
}

export function wechatGuard(): boolean {
  // 放宽匹配：部分 iOS 微信 webview UA 变体不含 MicroMessenger（真机实测漏拦）
  if (/MicroMessenger|WeChat|Weixin/i.test(navigator.userAgent)) {
    showBrowserHint('请在浏览器中打开', '微信内置浏览器不支持本页的安全能力。\n请点右上角「···」→ 选择「在浏览器打开」（Safari / Chrome）。');
    return true;
  }
  return false;
}

// 供引擎在服务列表渲染后回填设备名（发现载荷 self.hostname）
export function setConnTitle(name: string): void {
  ($('connTitle') as HTMLElement).dataset.name = name;
}
