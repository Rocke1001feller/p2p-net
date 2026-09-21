/**
 * §5.3 白名单强制（WebRTC 路径补洞）：req / ws-open 帧在分发进 HttpBridge/WsBridge 之前
 * 先过 isPortAllowed——白名单外端口必须收到错误帧（res-head 403 / ws-close 4403）、
 * 零出站连接，且拒绝事件留痕（console.error），不静默。
 *
 * stub dc / MemSignaling / onSignal 注入模式照 src/tests/host.integration.test.ts。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { HostAgent, PeerSession } from './host.js';
import type { SigMessage } from './signaling/protocol.js';
import type { PollResult } from './signaling/client.js';

// ---- 内存信令 stub（照 host.integration.test.ts 模式）----

class MemSignaling {
  private nextId = 1;
  private boxes = new Map<string, Array<{ id: number; sender: string; payload: SigMessage }>>();

  async send(room: string, sender: string, msg: SigMessage): Promise<void> {
    const rows = this.boxes.get(room) ?? [];
    rows.push({ id: this.nextId++, sender, payload: msg });
    this.boxes.set(room, rows);
  }

  async poll(room: string, cursor: number): Promise<PollResult> {
    const rows = (this.boxes.get(room) ?? []).filter((r) => r.id > cursor);
    return { msgs: rows, cursor: rows.length ? rows[rows.length - 1].id : cursor };
  }

  async purgeExpired(): Promise<void> {}
}

// ---- 测试工具（照 host.integration.test.ts 模式）----

async function until(fn: () => boolean, ms = 5000, what = ''): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 关闭服务器并强制断开 keep-alive 连接（否则进程退出被拖慢 5s+）。 */
function closeServer(server: http.Server): void {
  server.close();
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
}

/** stub DataChannel（DcLike）：send 捕获出站帧到 sent。 */
function mkDc(sent: any[]): any {
  return {
    label: 'proxy',
    bufferedAmount: 0,
    readyState: 'open',
    send: (data: string) => sent.push(JSON.parse(data)),
    onmessage: null as null | ((ev: { data: string }) => void),
  };
}

function mkAgent(isPortAllowed: (port: number) => boolean, extra: { wsPort?: number } = {}): HostAgent {
  return new HostAgent({
    supabaseUrl: 'http://unused.invalid',
    publishableKey: 'pk',
    accessToken: () => null,
    deviceId: 'd',
    uid: 'u',
    turnFetcher: async () => ({ iceServers: [] }),
    signaling: new MemSignaling(),
    pollMs: 50,
    isPortAllowed,
    ...extra,
  });
}

/**
 * 经 HostAgent.onSignal（bogus sdp offer）拿到登进路由表的 PeerSession——
 * 验证 HostAgent options.isPortAllowed 真实流入帧分发路径，而非只测 PeerSession 单件。
 */
async function sessionViaOffer(agent: HostAgent): Promise<PeerSession> {
  await (agent as unknown as { onSignal: (m: unknown) => Promise<void> })
    .onSignal({ type: 'offer', sid: 's1', from: 'phone-1', sdp: { type: 'offer', sdp: 'v=0 bogus' } })
    .catch(() => {}); // bogus sdp：acceptOffer 必失败，但会话已先入路由表（同 host.integration.test.ts 模式）
  const sessions = (agent as unknown as { sessions: Map<string, PeerSession> }).sessions;
  const s = sessions.get('phone-1');
  assert.ok(s, 'offer 后应登记会话');
  return s;
}

async function listenCountingHttp(onHit: () => void): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    onHit();
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('allowed-ok');
  });
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
  return { server, port };
}

async function listenCountingWs(onConn: () => void): Promise<{ server: http.Server; wss: WebSocketServer; port: number }> {
  const server = http.createServer();
  server.on('connection', onConn); // TCP 级计数：即使握手未发生也能抓到出站连接
  const wss = new WebSocketServer({ server });
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
  return { server, wss, port };
}

test('req 帧命中白名单外端口：res-head 403 + done 收尾 + 零出站请求（HostAgent options 装配贯通）', async () => {
  let hits = 0;
  const { server, port } = await listenCountingHttp(() => { hits += 1; });

  const agent = mkAgent(() => false); // 全拒：任何端口都不在白名单
  const session = await sessionViaOffer(agent);

  const sent: any[] = [];
  const dc = mkDc(sent);
  session.wireChannel(dc, 'proxy');

  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  try {
    dc.onmessage!({ data: JSON.stringify({ k: 'req', id: 1, port, method: 'GET', path: '/', headers: {} }) });
    await until(() => sent.some((f) => f.k === 'res-head'), 3000, 'res-head');
    await new Promise((r) => setTimeout(r, 60)); // 反证窗口：若守卫失效，出站请求必在此间触达

    const head = sent.find((f) => f.k === 'res-head');
    assert.equal(head.id, 1);
    assert.equal(head.status, 403, '白名单外 req 必须回 403');
    assert.ok(
      sent.some((f) => f.k === 'res-chunk' && f.id === 1 && f.done),
      '403 后必须以 done 帧收尾（客户端 SW 等 done，否则挂到 30s 超时）',
    );
    assert.equal(hits, 0, '白名单外端口不得触达 localhost');
    assert.ok(errs.some((l) => l.includes(String(port))), '拒绝必须 console.error 留痕（不静默）');
  } finally {
    console.error = origErr;
    session.dispose();
    closeServer(server);
  }
});

test('req 帧命中白名单内端口：正常代理触达 localhost（白名单不误伤）', async () => {
  let hits = 0;
  const { server, port } = await listenCountingHttp(() => { hits += 1; });

  const session = new PeerSession(undefined, (p) => p === port);
  const sent: any[] = [];
  const dc = mkDc(sent);
  session.wireChannel(dc, 'proxy');
  try {
    dc.onmessage!({ data: JSON.stringify({ k: 'req', id: 2, port, method: 'GET', path: '/', headers: {} }) });
    await until(() => sent.some((f) => f.k === 'res-chunk' && f.done), 3000, 'res done');
    const head = sent.find((f) => f.k === 'res-head');
    assert.equal(head.status, 200);
    assert.equal(hits, 1, '白名单内端口必须正常代理');
    const chunk = sent.find((f) => f.k === 'res-chunk' && f.dataB64);
    assert.equal(Buffer.from(chunk.dataB64, 'base64').toString(), 'allowed-ok');
  } finally {
    session.dispose();
    closeServer(server);
  }
});

test('ws-open 命中白名单外端口：ws-close 4403 + 零出站连接', async () => {
  let conns = 0;
  const { server, wss, port } = await listenCountingWs(() => { conns += 1; });

  const session = new PeerSession(undefined, () => false);
  const sent: any[] = [];
  const dc = mkDc(sent);
  session.wireChannel(dc, 'proxy');
  try {
    dc.onmessage!({ data: JSON.stringify({ k: 'ws-open', wid: 7, path: '/ws', port }) });
    await until(() => sent.some((f) => f.k === 'ws-close'), 3000, 'ws-close');
    await new Promise((r) => setTimeout(r, 60)); // 反证窗口

    const close = sent.find((f) => f.k === 'ws-close');
    assert.equal(close.wid, 7);
    assert.equal(close.code, 4403, '白名单外 ws-open 必须回 ws-close 4403');
    assert.equal(conns, 0, '白名单外端口不得发起本地 ws 连接');
  } finally {
    session.dispose();
    wss.close();
    closeServer(server);
  }
});

test('ws-open 缺省 wsPort 同样受白名单约束（帧无 port 时校验解析后的缺省端口）', async () => {
  let conns = 0;
  const { server, wss, port } = await listenCountingWs(() => { conns += 1; });

  const session = new PeerSession(port, (p) => p !== port); // wsPort 不在白名单
  const sent: any[] = [];
  const dc = mkDc(sent);
  session.wireChannel(dc, 'proxy');
  try {
    dc.onmessage!({ data: JSON.stringify({ k: 'ws-open', wid: 8, path: '/ws' }) }); // 帧不带 port → 落到 wsPort
    await until(() => sent.some((f) => f.k === 'ws-close'), 3000, 'ws-close');
    const close = sent.find((f) => f.k === 'ws-close');
    assert.equal(close.wid, 8);
    assert.equal(close.code, 4403);
    assert.equal(conns, 0);
  } finally {
    session.dispose();
    wss.close();
    closeServer(server);
  }
});

test('ws-open 命中白名单内端口：正常触达本地 ws 服务（ws-open-ok）', async () => {
  let conns = 0;
  const { server, wss, port } = await listenCountingWs(() => { conns += 1; });
  wss.on('connection', (ws) => ws.on('message', () => ws.send('pong')));

  const session = new PeerSession(undefined, (p) => p === port);
  const sent: any[] = [];
  const dc = mkDc(sent);
  session.wireChannel(dc, 'proxy');
  try {
    dc.onmessage!({ data: JSON.stringify({ k: 'ws-open', wid: 9, path: '/ws', port }) });
    await until(() => sent.some((f) => f.k === 'ws-open-ok'), 3000, 'ws-open-ok');
    assert.equal(conns, 1, '白名单内端口必须正常连接');
    assert.ok(!sent.some((f) => f.k === 'ws-close' && f.code === 4403), '不得误发 4403');
  } finally {
    session.dispose();
    wss.close();
    closeServer(server);
  }
});
