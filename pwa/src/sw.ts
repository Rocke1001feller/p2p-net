/**
 * 代理层 Service Worker（M1 产品版）—— 自老仓 poc/webrtc-pwa/pwa/sw.js 逐段 TS 化移植。
 *
 * 与 POC 的差异（plan Task 8 关键设计）：
 *  - 多服务寻址：同一份 sw.js 按 scope `/s/<port>/` 注册多次；port 从被拦请求路径解析注入 req 帧
 *   （不依赖 SW 实例内状态，实例被浏览器回收重启也不丢端口语义）。
 *  - 白名单调整：放行 `/sw.js`、`/api/auth`、`/__p2pnet__/`；`/sig`、`/ice-config.js` 退役
 *   （信令走 SignalingClient PostgREST、TURN 凭据走 turn-credentials 函数，不再有控制面端点同源反代）。
 *  - shim 注入点 = `/s/<port>/` scope 下，注入 window.__p2pnetBase 供 shim 的 BASE 包装使用。
 *
 * 帧协议与 POC 一字不改：req{id,port,method,path,headers,bodyB64} / req-abort{id} /
 * res-head{id,status,headers} / res-chunk{id,dataB64?,done?}；30s 超时 → 504；101/204/205/304 无 body。
 * port 字段来源 = scope 解析（本文件），桥侧老 POC 帧（无 port）由 p2p HttpBridge 回 400 错误帧。
 */
/// <reference lib="webworker" />
import shimSource from './shim.js?raw';
import { ASSET_CACHE_NAME, shouldCacheResponse } from './assetCache.js';

const swSelf = self as unknown as ServiceWorkerGlobalScope;

let port: MessagePort | null = null;      // shell 页面注入的 MessagePort
let seq = 1;                              // 本实例 req id 序列（响应经 shell 按全局 id 关联后回带原 id）
interface PendingEntry {
  resolve: (r: Response) => void;
  ctrl?: ReadableStreamDefaultController<Uint8Array>;
  /** gzip 解码支路（spec D6）：res-head.enc==='gzip' 且本地支持 DecompressionStream 时建立。 */
  gz?: WritableStreamDefaultWriter<Uint8Array>;
  timer?: ReturnType<typeof setTimeout>;
}
const pending = new Map<number, PendingEntry>();
let shimCache: string | null = null;
/**
 * 帧往返超时（2026-09-23 由 12s 上调 45s：中继洪泛事故整改）。
 * 12s 的代价：中继慢链路下 host 瞬时灌入数 MB chunk，大文件的首帧在有序通道里排队
 * 十几秒是正常态（桥侧背压上限 512KiB 已给排队上界）；12s 超时把「慢」误判成「死」，
 * 工作台拿到 504 照样白屏。45s 覆盖 512KiB 排队 + 大 body 慢速流的极端窗口；
 * 真黑洞由 shell 看门狗按全局静默（60s）判死拆连，不靠单请求超时兜。
 */
const TUNNEL_TIMEOUT_MS = 45_000;

swSelf.addEventListener('install', () => swSelf.skipWaiting());
swSelf.addEventListener('activate', (e) => {
  e.waitUntil(
    swSelf.clients.claim().then(async () => {
      // SW 重启（休眠回收）后主动通知所有页面立即重注 port，把无 port 窗口缩到毫秒级
      const cs = await swSelf.clients.matchAll({ type: 'window' });
      cs.forEach((c) => c.postMessage({ k: 'sw-active' }));
    }),
  );
});

swSelf.addEventListener('message', (e) => {
  if (e.data && e.data.k === 'init-port') {
    port = e.ports[0];
    port.onmessage = (ev) => onPortMsg(ev.data);
  }
});

function b64u8(b: string): Uint8Array {
  const bin = atob(b);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function u8b64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

/** scope 前缀解析：/s/<port>/<rest> → { port, path }；非本 SW scope 形态返回 null（不拦）。 */
function parseScope(pathname: string): { port: number; path: string } | null {
  const m = pathname.match(/^\/s\/(\d+)(?=\/|$)/);
  if (!m) return null;
  const rest = pathname.slice(m[0].length) || '/';
  return { port: Number(m[1]), path: rest };
}

function onPortMsg(m: any): void {
  const p = pending.get(m.id);
  if (!p) return;
  if (m.k === 'res-head') {
    if (p.timer) clearTimeout(p.timer);
    const noBody = [101, 204, 205, 304].includes(m.status);
    if (noBody) { pending.delete(m.id); p.resolve(new Response(null, { status: m.status, headers: m.headers })); return; }
    if (m.enc === 'gzip' && typeof DecompressionStream !== 'undefined') {
      // gzip 流式解码（spec D6）：压缩字节写 ds.writable；解码后字节经 reader 逐段 enqueue
      const ds = new DecompressionStream('gzip');
      const stream = new ReadableStream<Uint8Array>({
        start(c) { p.ctrl = c; },
        cancel() { try { port && port.postMessage({ k: 'req-abort', id: m.id }); } catch { /* port 已死 */ } },
      });
      p.gz = ds.writable.getWriter();
      p.resolve(new Response(stream, { status: m.status, headers: m.headers }));
      const reader = ds.readable.getReader();
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length) p.ctrl?.enqueue(value);
          }
          p.ctrl?.close();
          pending.delete(m.id);
        } catch {
          try { p.ctrl?.error(new Error('gzip decode failed')); } catch { /* 已终结 */ }
          pending.delete(m.id);
        }
      })();
      return;
    }
    const stream = new ReadableStream<Uint8Array>({
      start(c) { p.ctrl = c; },
      cancel() { try { port && port.postMessage({ k: 'req-abort', id: m.id }); } catch { /* port 已死 */ } },
    });
    p.resolve(new Response(stream, { status: m.status, headers: m.headers }));
  } else if (m.k === 'res-chunk' && (p.ctrl || p.gz)) {
    // 帧协议 v2 双形态 + gzip 支路（spec D6）：u8 统一解出后按支路分发
    const u8 = m.data ? (m.data instanceof Uint8Array ? m.data : new Uint8Array(m.data))
      : m.dataB64 ? b64u8(m.dataB64) : null;
    if (p.gz) {
      // writer 内部排队保序：write/close 顺序到达，无需 await
      if (u8) void p.gz.write(u8);
      if (m.done) void p.gz.close().catch(() => { /* 解码器自清理 */ });
    } else if (p.ctrl) {
      if (u8) p.ctrl.enqueue(u8);
      if (m.done) { p.ctrl.close(); pending.delete(m.id); }
    }
  }
}

swSelf.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;                 // 跨源不拦（CDN、第三方登录等）
  if (parseScope(u.pathname)) { e.respondWith(proxy(e.request, u)); return; }
  // 其余路径不在本 SW 的 scope 形态内：按白名单语义放行。实际能到达这里的只有 scope 前缀
  // 形态之外的同源请求（多 scope 注册下浏览器只把 scope 内请求派给对应实例），此分支是
  // 防御性兜底——尤其未来若注册根 scope 时，白名单保证 shell 自身资产/控制面不被劫进隧道。
  return;
});

function getShim(): Promise<string> {
  if (shimCache) return Promise.resolve(shimCache);
  return Promise.resolve(shimSource);   // ?raw 构建期内联：SW 不需要运行时回源取 shim
}

function injectShim(html: string, shim: string, base: string): string {
  const tag = `\n<script>/*p2pnet-shim*/window.__p2pnetBase=${JSON.stringify(base)};\n${shim}\n</script>\n`;
  if (/<head[^>]*>/i.test(html)) return rewriteRootUrls(html.replace(/<head[^>]*>/i, (m) => m + tag), base);
  if (/<html[^>]*>/i.test(html)) return rewriteRootUrls(html.replace(/<html[^>]*>/i, (m) => m + tag), base);
  return rewriteRootUrls(tag + html, base);
}

// 根绝对路径改写：<script src="/assets/x.js"> 这类引用落在 /s/<port>/ SW 作用域之外，
// 不改写就会打到站点根 404（vite 产物全中——2026-09-06 iPhone 实测白屏根因）。
// 只动 src/href 属性里以单个 / 开头的值；// 协议相对、已完成前缀的 /s/ 不碰。
function rewriteRootUrls(html: string, base: string): string {
  return html.replace(/\b(src|href|poster)="\/(?!\/)(?!s\/)/gi, (_m, attr) => `${attr}="${base}/`);
}

function waitingHtml(): string {
  return '<meta charset="utf-8"><meta http-equiv="refresh" content="3"><body style="font-family:-apple-system,sans-serif;padding:2em;background:#0d1117;color:#c9d1d9">'
    + '<h3>⏳ 隧道尚未建立</h3><p>正在等待 shell 连接……本页每 3 秒自动重试。请确认桌面端在线、shell 页面已连接。</p></body>';
}

async function proxy(req: Request, u: URL): Promise<Response> {
  const scope = parseScope(u.pathname);
  if (!scope) return new Response('p2p-net: not a tunnel scope', { status: 404 });
  // 白名单（plan 关键设计 4）：scope 外资产与控制面放行。多 scope 注册下 scope 外请求
  // 理论上不会派发到本 SW；此判定同时覆盖「根 scope 注册」的未来形态。
  if (u.pathname === '/sw.js') return fetch(req);
  if (u.pathname.startsWith('/__p2pnet__/')) return fetch(req);   // shell 自身资产（shim、调试页）
  if (u.pathname === '/api/auth' || u.pathname.startsWith('/api/auth/')) return fetch(req); // Supabase 直连不拦
  // （/sig 与 /ice-config.js 已退役：不再放行，若有历史页面误触将进隧道对目标 404——语义正确）
  // 隧道资产缓存（2026-09-23 蜂窝浸泡整改）：长命资产（immutable / max-age≥1d）命中即回，
  // 全程不碰数据面——会话重建后的恢复从「全量重下 5.5MB」变「缓存秒开」，打断
  // 「重连→洪泛→链路更差→再重连」的死亡螺旋。隧道断着也能出缓存。
  if (req.method === 'GET') {
    try {
      const hit = await (await caches.open(ASSET_CACHE_NAME)).match(req.url);
      if (hit) return hit;
    } catch { /* CacheStorage 不可用时穿透隧道 */ }
  }
  if (!port) return new Response(waitingHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

  const id = seq++;
  const path = scope.path + u.search;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  if (typeof DecompressionStream !== 'undefined') headers['x-p2p-gzip'] = '1'; // spec D6 双端协商声明
  let bodyB64: string | null = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try { bodyB64 = u8b64(new Uint8Array(await req.arrayBuffer())); } catch { /* body 读取失败按空 body 发送 */ }
  }
  const resPromise = new Promise<Response>((resolve) => {
    const p: PendingEntry = { resolve };
    p.timer = setTimeout(() => {
      pending.delete(id);
      resolve(new Response(
        JSON.stringify({ error: 'tunnel_timeout', message: `数据面 ${TUNNEL_TIMEOUT_MS / 1000}s 内无响应`, retryable: true }),
        { status: 504, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
      ));
    }, TUNNEL_TIMEOUT_MS);
    pending.set(id, p);
  });
  // 客户端取消（导航离开/双击/AbortController）→ 通知 host 中止并立即清理，不再悬挂 30s
  req.signal.addEventListener('abort', () => {
    const p = pending.get(id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    pending.delete(id);
    try { port && port.postMessage({ k: 'req-abort', id }); } catch { /* port 已死 */ }
  });
  port.postMessage({ k: 'req', id, port: scope.port, method: req.method, path, headers, bodyB64 });
  const res = await resPromise;
  // 长命资产：tee 一份流给 CacheStorage（后台异步存），一份照常流给页面——
  // 不牺牲首载的流式体验，换后续每次会话重建的秒开。判定严格按上游 Cache-Control。
  if (req.method === 'GET' && res.ok && res.body && shouldCacheResponse(res.headers.get('cache-control'))) {
    const [pageBranch, cacheBranch] = res.body.tee();
    void caches.open(ASSET_CACHE_NAME)
      .then((c) => c.put(req.url, new Response(cacheBranch, { status: res.status, headers: res.headers })))
      .catch(() => { /* 缓存失败不影响本次响应 */ });
    return new Response(pageBranch, { status: res.status, headers: res.headers });
  }
  // HTML 响应：整段缓冲注入 shim（禁目标应用自带 SW 注册 + WebSocket 隧道 + BASE 前缀包装）
  if ((res.headers.get('content-type') || '').includes('text/html')) {
    const text = await res.text();
    const shim = await getShim();
    const headers2: Record<string, string> = {};
    res.headers.forEach((v, k) => { if (k.toLowerCase() !== 'content-length') headers2[k] = v; });
    return new Response(injectShim(text, shim, `/s/${scope.port}`), { status: res.status, headers: headers2 });
  }
  return res;
}
