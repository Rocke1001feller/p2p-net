import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createTunnelRelay, type TunnelRelay } from '../tunnel/relay.js';
import { TunnelClient, backoffDelayMs } from '../tunnel/client.js';
import { decodeFrame } from '../frames.js';

// ---- 工具 ----

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hmacToken = (secret: string, sid: string) => crypto.createHmac('sha256', secret).update(sid).digest('hex');

async function waitFor(pred: () => boolean, timeoutMs = 3000, desc = ''): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${desc}`);
    await sleep(5);
  }
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => { ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })); });
}

/** 等连接失败（升级被拒 / socket 被 destroy / 非法握手），返回失败原因描述。 */
function wsFailure(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('wsFailure timeout: 连接既未失败也未成功')), 2000);
    ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); resolve(`http ${res.statusCode}`); });
    ws.on('error', (e) => { clearTimeout(timer); resolve(String((e as Error).message)); });
    ws.on('close', () => { clearTimeout(timer); resolve('closed'); });
  });
}

function closeServer(server: http.Server): void {
  server.close();
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
}

async function listen(server: http.Server, port = 0): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      });
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(50); // 同端口重绑偶发 EADDRINUSE，退避重试
    }
  }
}

// ---- relay 测试服务器 ----

interface RelayFixture {
  relay: TunnelRelay;
  server: http.Server;
  port: number;
  close: () => void;
}

function startRelayServer(secret: string, requestTimeoutMs?: number): Promise<RelayFixture> {
  let relay!: TunnelRelay;
  const server = http.createServer((req, res) => relay.httpHandler(req, res));
  relay = createTunnelRelay({ secret, server, requestTimeoutMs });
  return listen(server).then((port) => ({
    relay,
    server,
    port,
    close: () => { relay.close(); closeServer(server); },
  }));
}

// ---- 假桌面（桌面侧 bridge 等价物：收帧、按测试自定义回帧）----

class FakeDesktop {
  ws!: WebSocket;
  frames: any[] = [];
  onFrame?: (f: any, d: FakeDesktop) => void;

  async connect(port: number, secret: string, sid: string, token = hmacToken(secret, sid)): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel/desktop?sid=${encodeURIComponent(sid)}&token=${token}`);
    this.ws.on('message', (data: Buffer) => {
      const f = decodeFrame(data);
      if (f === null) return;
      this.frames.push(f);
      this.onFrame?.(f, this);
    });
    await waitOpen(this.ws);
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  async waitFor(pred: (f: any) => boolean, timeoutMs = 3000, desc = ''): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const f = this.frames.find(pred);
      if (f) return f;
      if (Date.now() > deadline) throw new Error(`FakeDesktop waitFor timeout: ${desc}`);
      await sleep(5);
    }
  }

  async close(): Promise<void> {
    const p = waitClose(this.ws);
    this.ws.close();
    await p;
  }

  terminate(): void {
    this.ws.terminate();
  }
}

/** 默认假桌面：req → 200 文本回帧；ws-open → open-ok；ws-msg → echo。 */
function echoDesktop(): FakeDesktop {
  const d = new FakeDesktop();
  d.onFrame = (f, d) => {
    if (f.k === 'req') {
      d.send({ k: 'res-head', id: f.id, status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-tunnel': 'yes' } });
      d.send({ k: 'res-chunk', id: f.id, dataB64: Buffer.from('hello tunnel').toString('base64') });
      d.send({ k: 'res-chunk', id: f.id, done: true });
      return;
    }
    if (f.k === 'ws-open') { d.send({ k: 'ws-open-ok', wid: f.wid }); return; }
    if (f.k === 'ws-msg') {
      if (f.text !== undefined) d.send({ k: 'ws-msg', wid: f.wid, text: 'echo:' + f.text });
      else if (f.dataB64 !== undefined) {
        const payload = Buffer.concat([Buffer.from(f.dataB64, 'base64'), Buffer.from('!')]);
        d.send({ k: 'ws-msg', wid: f.wid, dataB64: payload.toString('base64') });
      }
    }
  };
  return d;
}

const SECRET = 'test-secret';

// ---- 桌面登记 / 鉴权 ----

test('relay：token 校验通过 → desktops 登记；重复 sid 顶旧（旧连接关闭、新连接接管）', async () => {
  const fx = await startRelayServer(SECRET);
  const a = echoDesktop();
  const b = echoDesktop();
  await a.connect(fx.port, SECRET, 'sid-dup');
  assert.equal(fx.relay.desktops.has('sid-dup'), true);
  const aClosed = waitClose(a.ws); // 顶旧即断：先挂 close 监听再连第二个
  await b.connect(fx.port, SECRET, 'sid-dup');
  assert.equal(fx.relay.desktops.size, 1);
  const closed = await aClosed;
  assert.equal(closed.code, 1006); // 顶旧 = 服务端 terminate，非握手关闭
  // 顶旧后，请求由新桌面接管（relay 内部存的是服务端 socket，故按行为断言）
  const res = await fetch(`http://127.0.0.1:${fx.port}/tunnel/s/sid-dup/takeover`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'hello tunnel');
  assert.equal(b.frames.some((f) => f.k === 'req' && f.path === '/takeover'), true);
  assert.equal(a.frames.some((f) => f.k === 'req'), false);
  b.terminate();
  fx.close();
});

test('relay：token 错 → upgrade 拒绝（401），不登记', async () => {
  const fx = await startRelayServer(SECRET);
  const ws = new WebSocket(`ws://127.0.0.1:${fx.port}/tunnel/desktop?sid=sid-bad&token=${'0'.repeat(64)}`);
  const failure = await wsFailure(ws);
  assert.match(failure, /401/);
  assert.equal(fx.relay.desktops.has('sid-bad'), false);
  fx.close();
});

// ---- HTTP 经隧道 ----

test('relay：GET 经隧道 → req 帧形状（port:0/via/path 带 search/头透传）+ 200/headers/body 回写', async () => {
  const fx = await startRelayServer(SECRET);
  const desk = echoDesktop();
  await desk.connect(fx.port, SECRET, 'sid-get');

  const res = await fetch(`http://127.0.0.1:${fx.port}/tunnel/s/sid-get/x?a=1`, { headers: { 'x-probe': 'p1' } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'hello tunnel');
  assert.equal(res.headers.get('x-tunnel'), 'yes');

  const frame = await desk.waitFor((f) => f.k === 'req', 3000, 'req frame');
  assert.equal(frame.port, 0);
  assert.equal(frame.via, 'tunnel');
  assert.equal(frame.method, 'GET');
  assert.equal(frame.path, '/x?a=1');
  assert.equal(frame.headers['x-probe'], 'p1');
  assert.equal(frame.headers.host, `127.0.0.1:${fx.port}`);
  assert.equal(typeof frame.id, 'number');
  fx.close();
});

test('relay：POST body 经隧道往返', async () => {
  const fx = await startRelayServer(SECRET);
  const desk = new FakeDesktop();
  desk.onFrame = (f, d) => {
    if (f.k === 'req') {
      d.send({ k: 'res-head', id: f.id, status: 200, headers: { 'content-type': f.headers['content-type'] ?? 'application/octet-stream' } });
      d.send({ k: 'res-chunk', id: f.id, dataB64: f.bodyB64 ?? '', done: true });
    }
  };
  await desk.connect(fx.port, SECRET, 'sid-post');

  const body = '中文 body 0123';
  const res = await fetch(`http://127.0.0.1:${fx.port}/tunnel/s/sid-post/submit`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body,
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), body);
  const frame = await desk.waitFor((f) => f.k === 'req', 3000, 'req frame');
  assert.equal(Buffer.from(frame.bodyB64, 'base64').toString(), body);
  fx.close();
});

test('relay：桌面未上线 → 502；未知路径 → 404', async () => {
  const fx = await startRelayServer(SECRET);
  const offline = await fetch(`http://127.0.0.1:${fx.port}/tunnel/s/nobody/x`);
  assert.equal(offline.status, 502);
  const notFound = await fetch(`http://127.0.0.1:${fx.port}/other`);
  assert.equal(notFound.status, 404);
  fx.close();
});

test('relay：桌面在途断开 → 在途请求 502', async () => {
  const fx = await startRelayServer(SECRET);
  const desk = new FakeDesktop();
  desk.onFrame = () => { /* 收到 req 不回帧，保持挂起 */ };
  await desk.connect(fx.port, SECRET, 'sid-hang');

  const pending = fetch(`http://127.0.0.1:${fx.port}/tunnel/s/sid-hang/slow`);
  await desk.waitFor((f) => f.k === 'req', 3000, 'req dispatched');
  await desk.close();

  const res = await pending;
  assert.equal(res.status, 502);
  assert.equal(await res.text(), 'desktop offline');
  fx.close();
});

test('relay：超时无响应 → 504（注入 requestTimeoutMs）', async () => {
  const fx = await startRelayServer(SECRET, 200);
  const desk = new FakeDesktop();
  desk.onFrame = () => { /* 不回帧 */ };
  await desk.connect(fx.port, SECRET, 'sid-timeout');

  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${fx.port}/tunnel/s/sid-timeout/x`);
  assert.equal(res.status, 504);
  assert.equal(await res.text(), 'tunnel timeout');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 180 && elapsed < 3000, `应在 ~200ms 超时，实际 ${elapsed}ms`);
  fx.close();
});

test('relay：桌面断开重连（同 sid）→ 后续请求自动恢复', async () => {
  const fx = await startRelayServer(SECRET);
  const desk1 = echoDesktop();
  await desk1.connect(fx.port, SECRET, 'sid-re');
  const ok1 = await fetch(`http://127.0.0.1:${fx.port}/tunnel/s/sid-re/one`);
  assert.equal(await ok1.text(), 'hello tunnel');

  await desk1.close();
  await waitFor(() => fx.relay.desktops.size === 0, 3000, 'desktop unregistered');
  const offline = await fetch(`http://127.0.0.1:${fx.port}/tunnel/s/sid-re/two`);
  assert.equal(offline.status, 502);

  const desk2 = echoDesktop();
  await desk2.connect(fx.port, SECRET, 'sid-re');
  const ok2 = await fetch(`http://127.0.0.1:${fx.port}/tunnel/s/sid-re/three`);
  assert.equal(ok2.status, 200);
  assert.equal(await ok2.text(), 'hello tunnel');
  desk2.terminate();
  fx.close();
});

// ---- PWA 侧 WS 经隧道 ----

test('relay：PWA WS 经 relay 到桌面 echo（text/binary）；ws-open path 含 search；close 码透传', async () => {
  const fx = await startRelayServer(SECRET);
  const desk = echoDesktop();
  await desk.connect(fx.port, SECRET, 'sid-ws');

  const pwa = new WebSocket(`ws://127.0.0.1:${fx.port}/tunnel/s/sid-ws/ws?room=shell`);
  await waitOpen(pwa);

  // text echo
  const textBack = new Promise<string>((resolve) => pwa.once('message', (d) => resolve(d.toString())));
  pwa.send('hi');
  assert.equal(await textBack, 'echo:hi');

  // binary echo
  const binBack = new Promise<Buffer>((resolve) => pwa.once('message', (d) => resolve(d as Buffer)));
  pwa.send(Buffer.from([0, 1, 250]));
  assert.deepEqual(await binBack, Buffer.from([0, 1, 250, 33]));

  // 桌面收到的 ws-open：wid 为 relay 内部分配的数字，path 保留 search
  const opened = await desk.waitFor((f) => f.k === 'ws-open', 3000, 'ws-open');
  assert.equal(typeof opened.wid, 'number');
  assert.equal(opened.path, '/ws?room=shell');

  // PWA 主动关 → 桌面收到 ws-close（code/reason 透传）
  const desktopClose = desk.waitFor((f) => f.k === 'ws-close', 3000, 'ws-close');
  pwa.close(1000, 'bye');
  const cf = await desktopClose;
  assert.equal(cf.code, 1000);
  assert.equal(cf.reason, 'bye');
  desk.terminate();
  fx.close();
});

test('relay：桌面 ws-open-err → PWA WS 关闭（1011）', async () => {
  const fx = await startRelayServer(SECRET);
  const desk = new FakeDesktop();
  desk.onFrame = (f, d) => { if (f.k === 'ws-open') d.send({ k: 'ws-open-err', wid: f.wid }); };
  await desk.connect(fx.port, SECRET, 'sid-wserr');

  const pwa = new WebSocket(`ws://127.0.0.1:${fx.port}/tunnel/s/sid-wserr/ws`);
  await waitOpen(pwa);
  const closed = await waitClose(pwa);
  assert.equal(closed.code, 1011);
  assert.equal(closed.reason, 'tunnel: desktop ws-open-err');
  desk.terminate();
  fx.close();
});

test('relay：桌面断开 → PWA 代理 WS 全关；未上线 sid 的 WS upgrade 被拒', async () => {
  const fx = await startRelayServer(SECRET);
  const desk = echoDesktop();
  await desk.connect(fx.port, SECRET, 'sid-dc');
  const pwa = new WebSocket(`ws://127.0.0.1:${fx.port}/tunnel/s/sid-dc/ws`);
  await waitOpen(pwa);
  const pwaClosed = waitClose(pwa);
  await desk.terminate();
  const closed = await pwaClosed;
  assert.equal(closed.code, 1011);
  assert.equal(closed.reason, 'tunnel: desktop offline');

  // 未上线 sid：upgrade 直接 destroy（连接失败，而非 101）——wsFailure 超时即失败
  const dead = new WebSocket(`ws://127.0.0.1:${fx.port}/tunnel/s/nobody/ws`);
  await wsFailure(dead);
  fx.close();
});

// ---- TunnelClient ----

test('backoffDelayMs：1s→2s→…→30s 封顶，抖动 ±20%', () => {
  const opts = { baseMs: 1000, maxMs: 30000, jitter: 0.2 };
  // rand=1 → +20%
  assert.equal(backoffDelayMs(1, opts, 1), 1200);
  assert.equal(backoffDelayMs(2, opts, 1), 2400);
  assert.equal(backoffDelayMs(3, opts, 1), 4800);
  assert.equal(backoffDelayMs(6, opts, 1), 36000); // 30000 封顶 ×1.2
  // rand=0 → -20%
  assert.equal(backoffDelayMs(1, opts, 0), 800);
  assert.equal(backoffDelayMs(2, opts, 0), 1600);
  assert.equal(backoffDelayMs(6, opts, 0), 24000);
  // rand=0.5 → 无抖动；封顶不随 attempt 无限增长
  assert.equal(backoffDelayMs(1, opts, 0.5), 1000);
  assert.equal(backoffDelayMs(99, opts, 0.5), 30000);
});

test('TunnelClient：初始连接失败持续重试，服务器就绪后连上', async () => {
  // 先占一个端口再释放，得到“确定可用的死端口”
  const probe = http.createServer();
  const port = await listen(probe);
  closeServer(probe);
  await sleep(50);

  const client = new TunnelClient({ backoff: { baseMs: 60, maxMs: 300, jitter: 0.2 } });
  const conns: WebSocket[] = [];
  let reconnects = 0;
  client.onReconnect(() => { reconnects += 1; });
  client.connect(`ws://127.0.0.1:${port}/tunnel/desktop?sid=x&token=y`);
  assert.equal(client.isOpen, false);

  await sleep(150); // 期间至少一次 ECONNREFUSED
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => conns.push(ws));
  await listen(server, port);

  await waitFor(() => client.isOpen && reconnects === 1, 3000, 'connected after retry + onReconnect');
  assert.equal(client.isOpen, true);
  assert.equal(reconnects, 1); // 非首次成功 → onReconnect
  assert.ok(conns.length >= 1);
  client.close();
  closeServer(server);
});

test('TunnelClient：断线退避后重连成功；onReconnect 触发；onFrame 恢复', async () => {
  let server = http.createServer();
  let conns: WebSocket[] = [];
  let wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => conns.push(ws));
  const port = await listen(server);

  const got: any[] = [];
  const client = new TunnelClient({ backoff: { baseMs: 60, maxMs: 300, jitter: 0.2 } });
  client.onFrame((f) => got.push(f));
  let reconnects = 0;
  client.onReconnect(() => { reconnects += 1; });
  client.connect(`ws://127.0.0.1:${port}/tunnel/desktop?sid=x&token=y`);
  await waitFor(() => conns.length === 1, 3000, 'first connection');

  conns[0].send(JSON.stringify({ k: 'ping', t: 1 }));
  await waitFor(() => got.some((f) => f.t === 1), 3000, 'frame before drop');

  // 停服断线
  const dropAt = Date.now();
  conns[0].terminate();
  closeServer(server);
  await sleep(30);

  // 同端口重启服务器
  server = http.createServer();
  conns = [];
  wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => conns.push(ws));
  await listen(server, port);

  await waitFor(() => conns.length >= 1, 3000, 'reconnected');
  await waitFor(() => reconnects === 1, 2000, 'onReconnect fired'); // 服务端 connection 与客户端 open 同进程不同句柄，需分别等
  const gap = Date.now() - dropAt;
  assert.ok(gap >= 35, `重连应经历退避等待（≥35ms，base=60ms ±20%），实际 ${gap}ms`);
  assert.equal(reconnects, 1);
  conns[0].send(JSON.stringify({ k: 'ping', t: 2 }));
  await waitFor(() => got.some((f) => f.t === 2), 3000, 'frame after reconnect');
  assert.equal(got.length, 2);

  client.close();
  closeServer(server);
});

test('TunnelClient：close() 停止重连', async () => {
  const server = http.createServer();
  const conns: WebSocket[] = [];
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => conns.push(ws));
  const port = await listen(server);

  const client = new TunnelClient({ backoff: { baseMs: 50, maxMs: 150, jitter: 0.2 } });
  client.connect(`ws://127.0.0.1:${port}/tunnel/desktop?sid=x&token=y`);
  await waitFor(() => conns.length === 1, 3000, 'first connection');

  conns[0].terminate(); // 断线（重连计时器将启动）
  client.close();       // 立即退出 → 计时器取消
  await sleep(300);

  // 期间允许重连也无妨——断言核心：close 后不再有新连接
  const countAtClose = conns.length;
  await sleep(250);
  assert.equal(conns.length, countAtClose);
  assert.equal(client.isOpen, false);
  closeServer(server);
});
