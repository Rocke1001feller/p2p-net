/**
 * shell.ts 的 Node 测试桩（仅 *.test.ts 使用，不进生产包）：
 * 在 `await import('./shell.js')` 之前 installShellHarness()，提供
 * DOM/浏览器全局桩（document/window/navigator/location/localStorage/MessageChannel）、
 *  fetch 路由桩（/config.json、signaling REST、/s/<port>/ 网关）与假 RTCPeerConnection。
 *
 * 设计要点：
 * - setInterval 包 unref：shell 模块级 3s/10s 看门狗与 WebRtcSession 的 800ms 轮询
 *   不得把测试进程钉死；一次性 setTimeout 保持原样（测试自身 sleep 依赖事件循环存活）。
 * - /s/<port>/api/* 一律 503：bootGateDecision 据此 defer 开窗，健康检查定时器链
 *   （5/12/25s）根本不会排程，测试进程可即时退出。
 */

export class FakeEl {
  id = '';
  className = '';
  value = '';
  type = '';
  src = '';
  title = '';
  disabled = false;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: unknown[] = [];
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  contentWindow: { postMessage: (...args: unknown[]) => void } | null = { postMessage: () => {} };
  /** 让 looksBooted 恒 false（健康检查链第一步即 defer 的场景用不到它）。 */
  contentDocument: unknown = undefined;
  private classSet = new Set<string>();
  classList = {
    add: (...cs: string[]) => { cs.forEach((c) => this.classSet.add(c)); },
    remove: (...cs: string[]) => { cs.forEach((c) => this.classSet.delete(c)); },
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !this.classSet.has(c);
      if (on) this.classSet.add(c); else this.classSet.delete(c);
      return on;
    },
    contains: (c: string) => this.classSet.has(c),
    replace: (a: string, b: string) => {
      if (!this.classSet.delete(a)) return false;
      this.classSet.add(b);
      return true;
    },
  };
  private html = '';
  set innerHTML(v: string) { this.html = v; if (v === '') this.children = []; }
  get innerHTML(): string { return this.html; }
  /** 文本观察缝（harness observeTextIds 用）：每次 textContent 写入都记录。 */
  textRecorder?: (v: string) => void;
  private _textContent = '';
  set textContent(v: string) { this._textContent = v; this.textRecorder?.(v); }
  get textContent(): string { return this._textContent; }
  append(...nodes: unknown[]): void { this.children.push(...nodes); }
  appendChild<T>(n: T): T { this.children.push(n); return n; }
  replaceWith(_n: unknown): void { /* 无父节点跟踪：桩内空转 */ }
  cloneNode(_deep?: boolean): FakeEl { return new FakeEl(); }
  querySelector(_sel: string): FakeEl { return new FakeEl(); }
  querySelectorAll(_sel: string): FakeEl[] { return []; }
  addEventListener(): void {}
  removeEventListener(): void {}
  setAttribute(): void {}
}

export interface CapturedSig { room: string; sender: string; msg: Record<string, unknown> }
export interface FetchCall { url: string; method: string }

export interface ShellHarness {
  el(id: string): FakeEl;
  window: Record<string, unknown>;
  localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  sentSig: CapturedSig[];
  fetchCalls: FetchCall[];
  /** observeTextIds 指定的元素 id → textContent 历次写入序列。 */
  textLog: Record<string, string[]>;
  /** 轮询条件成立（5ms 步进），超时抛错。 */
  waitFor(cond: () => boolean, timeoutMs?: number, what?: string): Promise<void>;
  /** 安装假 RTCPeerConnection。autoOpen=false → dc 永不开（升级失败路径用）。
   *  stats：'direct'|'relay' 时 getStats 返回对应候选对的展平行（旁路采纳门禁取证用）；缺省空表。 */
  installFakeRtc(opts?: { autoOpen?: boolean; stats?: 'direct' | 'relay' | 'none' }): void;
}

function def(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

export function installShellHarness(opts: { search: string; services?: unknown; observeTextIds?: string[] }): ShellHarness {
  const els = new Map<string, FakeEl>();
  const textLog: Record<string, string[]> = {};
  const el = (id: string): FakeEl => {
    let e = els.get(id);
    if (!e) {
      e = new FakeEl();
      e.id = id;
      if (opts.observeTextIds?.includes(id)) {
        const log: string[] = [];
        textLog[id] = log;
        e.textRecorder = (v) => log.push(v);
      }
      els.set(id, e);
    }
    return e;
  };

  const sentSig: CapturedSig[] = [];
  const fetchCalls: FetchCall[] = [];
  // relays 空表：p2p 段 iceServers 为空 → NAT facts 采集立即退化（不烧 3s 探针超时），offer 链路仍真实走通。
  const config = { supabaseUrl: 'https://supa.test', publishableKey: 'pk-test', relays: [] as { url: string }[] };
  const servicesPayload = opts.services ?? { services: [], console: '/s/3000/' };

  const jsonResponse = (status: number, payload: unknown): Response => {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { forEach: (cb: (v: string, k: string) => void) => cb('application/json', 'content-type') },
      json: async () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
      text: async () => text,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
      body: null,
    } as unknown as Response;
  };

  const fetchStub = async (input: unknown, init?: { method?: string; body?: string }): Promise<Response> => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    const method = init?.method ?? 'GET';
    fetchCalls.push({ url, method });
    if (url === '/config.json') return jsonResponse(200, config);
    if (url.includes('/rest/v1/signaling_messages')) {
      if (method === 'POST') {
        const body = JSON.parse(init?.body ?? '{}') as { room?: string; sender?: string; payload?: Record<string, unknown> };
        sentSig.push({ room: body.room ?? '', sender: body.sender ?? '', msg: body.payload ?? {} });
        return jsonResponse(201, {});
      }
      return jsonResponse(200, []); // poll：无消息
    }
    if (url.includes('/functions/v1/turn-credentials')) return jsonResponse(200, { iceServers: [] });
    if (/\/s\/\d+\/services/.test(url)) return jsonResponse(200, servicesPayload);
    if (/\/s\/\d+\/api\//.test(url)) return jsonResponse(503, { error: 'synthetic_down' }); // 探活判死 → 开窗 defer
    return jsonResponse(404, { error: 'not_found' });
  };
  def('fetch', fetchStub);

  // ---- 定时器：interval 包 unref（模块级看门狗/轮询不钉死进程），timeout 原样 ----
  const origSetInterval = globalThis.setInterval;
  def('setInterval', ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    (origSetInterval(fn, ms, ...args) as unknown as { unref(): void }).unref()) as typeof setInterval);

  // ---- 存储 ----
  const store = new Map<string, string>();
  const localStorageStub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  def('localStorage', localStorageStub);

  // ---- 位置/导航 ----
  def('location', { search: opts.search, origin: 'https://pwa.test', href: 'https://pwa.test/' });

  const swWorker = { postMessage: () => {}, state: 'activated' };
  def('navigator', {
    userAgent: 'Mozilla/5.0 (shell-test)',
    serviceWorker: {
      addEventListener: () => {},
      getRegistrations: async () => [],
      register: async () => ({ active: swWorker, installing: null, waiting: null, scope: 'https://pwa.test/' }),
    },
  });

  // ---- DOM ----
  def('document', {
    getElementById: (id: string) => el(id),
    querySelector: () => new FakeEl(),
    querySelectorAll: () => [],
    createElement: () => new FakeEl(),
    addEventListener: () => {},
    visibilityState: 'visible',
  });
  const windowStub: Record<string, unknown> = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  def('window', windowStub);
  def('MessageChannel', class {
    port1 = { onmessage: null, postMessage: () => {}, close: () => {} };
    port2 = { onmessage: null, postMessage: () => {}, close: () => {} };
  });
  // auth-js 见到 isBrowser（我们桩了 window/document）会 new BroadcastChannel 做多标签同步——
  // Node 的 BroadcastChannel 背后是 ref'd MessagePort，会把测试进程永久钉住；桩掉即跳过。
  def('BroadcastChannel', undefined);

  const harness: ShellHarness = {
    el,
    window: windowStub,
    localStorage: localStorageStub,
    sentSig,
    fetchCalls,
    textLog,
    waitFor: async (cond, timeoutMs = 5_000, what = '条件') => {
      const deadline = Date.now() + timeoutMs;
      while (!cond()) {
        if (Date.now() > deadline) throw new Error(`waitFor 超时：${what}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    installFakeRtc: (rtcOpts) => {
      // 采纳门禁（W-A）取证形态：direct=本地 srflx×远端 host（pairType 'p2p'）；
      // relay=本地 srflx×远端 relay（host 侧 TURN，pairType 'relay'）——与 status.ts 判据逐键对齐。
      const statsRows: Record<string, unknown>[] = !rtcOpts?.stats || rtcOpts.stats === 'none' ? [] : [
        { type: 'candidate-pair', id: 'pair1', state: 'succeeded', nominated: true, localCandidateId: 'L1', remoteCandidateId: 'R1' },
        { type: 'local-candidate', id: 'L1', candidateType: 'srflx', address: '203.0.113.10', port: 40000 },
        rtcOpts.stats === 'relay'
          ? { type: 'remote-candidate', id: 'R1', candidateType: 'relay', address: '49.233.155.13', port: 50001 }
          : { type: 'remote-candidate', id: 'R1', candidateType: 'host', address: '192.168.1.10', port: 51000 },
      ];
      class FakeDc {
        binaryType = 'arraybuffer';
        readyState = 'connecting';
        bufferedAmount = 0;
        onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        send(): void {}
        close(): void { this.readyState = 'closed'; } // 本地 teardown 不派生 onclose（同生产语义静默化，测试确定性）
      }
      class FakePc {
        onicecandidate: ((ev: { candidate: null }) => void) | null = null;
        onconnectionstatechange: (() => void) | null = null;
        connectionState = 'new';
        localDescription: { type: string; sdp: string } | null = null;
        createDataChannel(): FakeDc {
          const dc = new FakeDc();
          if (rtcOpts?.autoOpen !== false) {
            setTimeout(() => { dc.readyState = 'open'; dc.onopen?.(); }, 5);
          }
          return dc;
        }
        async createOffer(): Promise<{ type: string; sdp: string }> { return { type: 'offer', sdp: 'v=0 fake' }; }
        async setLocalDescription(d: { type: string; sdp: string }): Promise<void> { this.localDescription = d; }
        async setRemoteDescription(): Promise<void> {}
        async addIceCandidate(): Promise<void> {}
        setConfiguration(): void {}
        async getStats(): Promise<{ forEach: (cb: (v: unknown) => void) => void }> { return { forEach: (cb) => statsRows.forEach(cb) }; }
        close(): void {}
      }
      def('RTCPeerConnection', FakePc);
    },
  };
  return harness;
}
