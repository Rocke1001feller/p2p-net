import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { HttpBridge, dcSend, type DcLike } from '../bridge/http.js';
import { WsBridge } from '../bridge/ws.js';
import { decodeFrame, encodeFrame } from '../frames.js';

// ---- FakeDc：收集出站帧 ----

class FakeDc implements DcLike {
  frames: any[] = [];
  timestamps: number[] = [];
  bufferedAmount = 0;
  readyState = 'open';
  send(data: string | Buffer): void {
    this.frames.push(JSON.parse(String(data)));
    this.timestamps.push(Date.now());
  }
  frame(pred: (f: any) => boolean): any | undefined {
    return this.frames.find(pred);
  }
  async waitFor(pred: (f: any) => boolean, timeoutMs = 3000, desc = ''): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const f = this.frame(pred);
      if (f) return f;
      if (Date.now() > deadline) throw new Error(`waitFor timeout: ${desc}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

// ---- 本地 http 测试服务器（127.0.0.1 随机端口）----

interface ServerHooks {
  onAbort?: () => void;
  path?: string;
  method?: string;
}

function startHttpServer(hooks: ServerHooks = {}): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (hooks.path && req.url !== hooks.path) { res.writeHead(404); res.end(); return; }
      if (req.url === '/echo') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(Buffer.concat(chunks));
        });
        return;
      }
      if (req.url === '/hang-until-abort') {
        req.on('aborted', () => hooks.onAbort?.());
        req.on('close', () => { if (!req.complete) hooks.onAbort?.(); });
        return; // 永不响应，等客户端断开
      }
      if (req.url === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => res.write('data: two\n\n'), 120);
        setTimeout(() => { res.write('data: three\n\n'); res.end(); }, 260);
        return;
      }
      if (req.url === '/no-body-204') { res.writeHead(204); res.end(); return; }
      if (req.url === '/no-body-304') { res.writeHead(304); res.end(); return; }
      if (req.url === '/redirect') {
        const selfPort = (server.address() as AddressInfo).port;
        res.writeHead(302, { location: `http://127.0.0.1:${selfPort}/landing` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('hello bridge');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

/** 关闭服务器并强制断开 keep-alive 连接（否则进程退出被拖慢 5s+）。 */
function closeServer(server: http.Server): void {
  server.close();
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
}

// ---- HTTP 桥 ----

test('HttpBridge：GET 200 文本（res-head + res-chunk + done）', async () => {
  const { server, port } = await startHttpServer();
  const dc = new FakeDc();
  const bridge = new HttpBridge();
  await bridge.handle(dc, { k: 'req', id: 1, port, method: 'GET', path: '/', headers: {} });
  const head = await dc.waitFor((f) => f.k === 'res-head', 3000, 'res-head');
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-type'], 'text/plain; charset=utf-8');
  const chunk = await dc.waitFor((f) => f.k === 'res-chunk' && f.dataB64, 3000, 'chunk');
  assert.equal(Buffer.from(chunk.dataB64, 'base64').toString(), 'hello bridge');
  const done = await dc.waitFor((f) => f.k === 'res-chunk' && f.done, 3000, 'done');
  assert.equal(done.id, 1);
  closeServer(server);
});

test('HttpBridge：POST body 往返 + 剥离头不透传、业务头保留', async () => {
  let seenHeaders: http.IncomingHttpHeaders = {};
  let seenBody = Buffer.alloc(0);
  const server = http.createServer((req, res) => {
    seenHeaders = req.headers;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(seenBody);
    });
  });
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
  const body = Buffer.from('股票数据 ping 汉字 0123');
  const dc = new FakeDc();
  const bridge = new HttpBridge();
  await bridge.handle(dc, {
    k: 'req', id: 2, port, method: 'POST', path: '/x',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example', referer: 'https://evil.example/p', 'accept-encoding': 'br', 'x-keep': 'yes' },
    bodyB64: body.toString('base64'),
  });
  const chunk = await dc.waitFor((f) => f.k === 'res-chunk' && f.dataB64, 3000, 'echo chunk');
  assert.deepEqual(Buffer.from(chunk.dataB64, 'base64'), body); // body 往返
  assert.equal(dc.frame((f) => f.k === 'res-chunk' && f.done).done, true);
  assert.equal(seenHeaders['x-keep'], 'yes'); // 业务头透传
  assert.equal(seenHeaders.origin, undefined); // 剥离清单不透传
  assert.equal(seenHeaders.referer, undefined);
  assert.equal(seenHeaders['accept-encoding'], undefined);
  closeServer(server);
});

test('HttpBridge：204/304 无 body 特判（res-head 即收尾）', async () => {
  const { server, port } = await startHttpServer();
  for (const [p, status] of [['/no-body-204', 204], ['/no-body-304', 304]] as const) {
    const dc = new FakeDc();
    const bridge = new HttpBridge();
    await bridge.handle(dc, { k: 'req', id: 10, port, method: 'GET', path: p, headers: {} });
    const head = await dc.waitFor((f) => f.k === 'res-head', 3000, `res-head ${status}`);
    assert.equal(head.status, status);
    const done = await dc.waitFor((f) => f.k === 'res-chunk' && f.done, 3000, `done ${status}`);
    assert.equal(done.dataB64, undefined); // 无载荷
  }
  closeServer(server);
});

test('HttpBridge：302 location 头重写为本机相对路径', async () => {
  const { server, port } = await startHttpServer();
  const dc = new FakeDc();
  const bridge = new HttpBridge();
  await bridge.handle(dc, { k: 'req', id: 20, port, method: 'GET', path: '/redirect', headers: {} });
  const head = await dc.waitFor((f) => f.k === 'res-head', 3000, '302');
  assert.equal(head.status, 302);
  assert.equal(head.headers['location'], '/landing');
  closeServer(server);
});

test('HttpBridge：SSE 三帧按序流式到达（不整段缓冲）', async () => {
  const { server, port } = await startHttpServer();
  const dc = new FakeDc();
  const bridge = new HttpBridge();
  await bridge.handle(dc, { k: 'req', id: 30, port, method: 'GET', path: '/sse', headers: {} });
  await dc.waitFor((f) => f.k === 'res-chunk' && f.done, 3000, 'sse done');
  const chunks = dc.frames.filter((f) => f.k === 'res-chunk' && f.dataB64);
  assert.equal(chunks.length, 3);
  const texts = chunks.map((f) => Buffer.from(f.dataB64, 'base64').toString());
  assert.deepEqual(texts, ['data: one\n\n', 'data: two\n\n', 'data: three\n\n']);
  // 第 1 帧与第 3 帧间隔 ≥ 120ms → 逐帧转发，非结束后一次性吐出
  const t0 = dc.timestamps[dc.frames.indexOf(chunks[0])];
  const t2 = dc.timestamps[dc.frames.indexOf(chunks[2])];
  assert.ok(t2 - t0 >= 120, `流式间隔应 ≥120ms，实际 ${t2 - t0}ms`);
  closeServer(server);
});

test('HttpBridge：req-abort 后服务器收到中止（request aborted）', async () => {
  let aborted = false;
  const { server, port } = await startHttpServer({ onAbort: () => { aborted = true; } });
  const dc = new FakeDc();
  const bridge = new HttpBridge();
  const handling = bridge.handle(dc, { k: 'req', id: 40, port, method: 'GET', path: '/hang-until-abort', headers: {} });
  await new Promise((r) => setTimeout(r, 100)); // 让请求挂进服务器
  await bridge.handle(dc, { k: 'req-abort', id: 40 });
  const deadline = Date.now() + 2000;
  while (!aborted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(aborted, true);
  await handling;
  closeServer(server);
});

test('HttpBridge：缺 port（老 POC 帧）→ 400 错误帧，不静默', async () => {
  const dc = new FakeDc();
  const bridge = new HttpBridge();
  await bridge.handle(dc, { k: 'req', id: 50, method: 'GET', path: '/', headers: {} });
  const head = await dc.waitFor((f) => f.k === 'res-head', 3000, '400 head');
  assert.equal(head.status, 400);
  const chunk = await dc.waitFor((f) => f.k === 'res-chunk' && f.done, 3000, '400 done');
  assert.match(Buffer.from(chunk.dataB64, 'base64').toString(), /port/i);
});

test('HttpBridge：目标端口拒绝连接 → 502 错误帧', async () => {
  const dc = new FakeDc();
  const bridge = new HttpBridge();
  await bridge.handle(dc, { k: 'req', id: 60, port: 1, method: 'GET', path: '/', headers: {} }); // 1 端口必拒
  const head = await dc.waitFor((f) => f.k === 'res-head', 3000, '502 head');
  assert.equal(head.status, 502);
  await dc.waitFor((f) => f.k === 'res-chunk' && f.done, 3000, '502 done');
});

test('HttpBridge：非 req 帧（ping）不归 http 桥处理', async () => {
  const dc = new FakeDc();
  const bridge = new HttpBridge();
  await bridge.handle(dc, { k: 'ping', t: 1 });
  assert.equal(dc.frames.length, 0);
});

// ---- 背压（8MiB）----

test('dcSend 背压：bufferedAmount > 8MiB 时挂起，降下来才发', async () => {
  const dc = new FakeDc();
  dc.bufferedAmount = 9 * 1024 * 1024;
  const sending = dcSend(dc, { k: 'res-chunk', id: 1, done: true });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(dc.frames.length, 0); // 背压挂起中
  dc.bufferedAmount = 0;
  await sending;
  assert.equal(dc.frames.length, 1);
});

// ---- WS 桥 ----

function startWsServer(): Promise<{ wss: WebSocketServer; port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) ws.send(Buffer.concat([data as Buffer, Buffer.from('!')]));
        else ws.send(`echo:${data.toString()}`);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ wss, server, port: (server.address() as AddressInfo).port }));
  });
}

test('WsBridge：ws-open → open-ok；text 双向', async () => {
  const { server, port } = await startWsServer();
  const dc = new FakeDc();
  const bridge = new WsBridge({ port });
  await bridge.handle(dc, { k: 'ws-open', wid: 1, path: '/ws' });
  await dc.waitFor((f) => f.k === 'ws-open-ok' && f.wid === 1, 3000, 'open-ok');

  await bridge.handle(dc, { k: 'ws-msg', wid: 1, text: 'hello' });
  const back = await dc.waitFor((f) => f.k === 'ws-msg' && f.text === 'echo:hello', 3000, 'text echo');
  assert.equal(back.wid, 1);
  bridge.closeAll();
  closeServer(server);
});

test('WsBridge：binary 双向（base64 通道）', async () => {
  const { server, port } = await startWsServer();
  const dc = new FakeDc();
  const bridge = new WsBridge({ port });
  await bridge.handle(dc, { k: 'ws-open', wid: 2, path: '/ws' });
  await dc.waitFor((f) => f.k === 'ws-open-ok' && f.wid === 2, 3000, 'open-ok');

  const payload = Buffer.from([0, 1, 2, 250, 251, 252]);
  await bridge.handle(dc, { k: 'ws-msg', wid: 2, dataB64: payload.toString('base64') });
  const back = await dc.waitFor((f) => f.k === 'ws-msg' && f.dataB64, 3000, 'binary echo');
  assert.deepEqual(Buffer.from(back.dataB64, 'base64'), Buffer.concat([payload, Buffer.from('!')]));
  bridge.closeAll();
  closeServer(server);
});

test('WsBridge：服务器 close 码透传（code/reason）', async () => {
  // 专用服务器：连接即以 4321 关闭
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (ws: WebSocket) => ws.close(4321, 'server-bye'));
  const clientPort = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as AddressInfo).port)));

  const dc = new FakeDc();
  const bridge = new WsBridge({ port: clientPort });
  await bridge.handle(dc, { k: 'ws-open', wid: 3, path: '/ws' });
  const closed = await dc.waitFor((f) => f.k === 'ws-close' && f.wid === 3, 3000, 'ws-close');
  assert.equal(closed.code, 4321);
  assert.equal(closed.reason, 'server-bye');
  closeServer(srv);
});

test('WsBridge：连接失败 → ws-open-err', async () => {
  const dc = new FakeDc();
  const bridge = new WsBridge({ port: 1 }); // 1 端口必拒
  await bridge.handle(dc, { k: 'ws-open', wid: 4, path: '/ws' });
  const err = await dc.waitFor((f) => f.k === 'ws-open-err' && f.wid === 4, 3000, 'open-err');
  assert.equal(err.wid, 4);
  bridge.closeAll();
});

test('WsBridge：ws-close 帧关闭本地 socket', async () => {
  let serverSawClose = false;
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (ws: WebSocket) => ws.on('close', () => { serverSawClose = true; }));
  const port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as AddressInfo).port)));

  const dc = new FakeDc();
  const bridge = new WsBridge({ port });
  await bridge.handle(dc, { k: 'ws-open', wid: 5, path: '/ws' });
  await dc.waitFor((f) => f.k === 'ws-open-ok' && f.wid === 5, 3000, 'open-ok');
  await bridge.handle(dc, { k: 'ws-close', wid: 5, code: 1000, reason: 'client-bye' });
  const deadline = Date.now() + 2000;
  while (!serverSawClose && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(serverSawClose, true);
  closeServer(srv);
});

test('WsBridge：ws-open 自带 port 覆盖构造端口（多服务语义）', async () => {
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (ws: WebSocket) => ws.send('from-override'));
  const port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as AddressInfo).port)));

  const dc = new FakeDc();
  const bridge = new WsBridge({ port: 1 }); // 构造端口必拒——帧自带 port 应生效
  await bridge.handle(dc, { k: 'ws-open', wid: 6, path: '/ws', port });
  await dc.waitFor((f) => f.k === 'ws-open-ok' && f.wid === 6, 3000, 'open-ok(port override)');
  const msg = await dc.waitFor((f) => f.k === 'ws-msg' && f.wid === 6, 3000, 'msg');
  assert.equal((msg as { text: string }).text, 'from-override');
  bridge.closeAll();
  closeServer(srv);
});

test('WsBridge：ws-open 无 port 且构造无 port → ws-open-err（不静默）', async () => {
  const dc = new FakeDc();
  const bridge = new WsBridge({});
  await bridge.handle(dc, { k: 'ws-open', wid: 7, path: '/ws' });
  const err = await dc.waitFor((f) => f.k === 'ws-open-err' && f.wid === 7, 3000, 'open-err(no port)');
  assert.equal(err.wid, 7);
  bridge.closeAll();
});

test('HttpBridge：仅监听 ::1 的服务也可达（IPv6 回环回退）', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('v6-only'); });
  await new Promise<void>((r) => srv.listen(0, '::1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  const dc = new FakeDc();
  const bridge = new HttpBridge({});
  await bridge.handle(dc, { k: 'req', id: 9, port, method: 'GET', path: '/', headers: {}, bodyB64: null });
  const head = await dc.waitFor((f) => f.k === 'res-head' && f.id === 9, 3000, 'res-head(v6)');
  assert.equal(head.status, 200);
  const chunk = await dc.waitFor((f) => f.k === 'res-chunk' && f.id === 9, 3000, 'res-chunk(v6)');
  assert.equal(Buffer.from((chunk as { dataB64: string }).dataB64, 'base64').toString(), 'v6-only');
  closeServer(srv);
});
