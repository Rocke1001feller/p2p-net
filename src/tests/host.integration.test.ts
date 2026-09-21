import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HostAgent, PeerSession, type HostStatus } from '../host.js';
import { Peer } from '../peer.js';
import { roomFor, type SigMessage } from '../signaling/protocol.js';
import type { PollResult } from '../signaling/client.js';
import type { IceCandidateLike } from '../signaling/protocol.js';

// ---- 内存信令 stub（SignalingClientLike）----

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

async function until(fn: () => boolean, ms = 15000, what = ''): Promise<void> {
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

test('HostAgent 集成：werift↔werift offer→DC→req→res→ctrl ping/pong→status 事件', async () => {
  // 本机 http 测试服务器（127.0.0.1 随机端口，禁外网依赖）
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('hello from host-bridge test');
  });
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));

  const UID = 'uid-itest';
  const HOST_DEV = 'desk-1';
  const PHONE_DEV = 'phone-1';
  const hostRoom = roomFor(UID, HOST_DEV);
  const phoneRoom = roomFor(UID, PHONE_DEV);

  const sig = new MemSignaling();
  const statuses: HostStatus[] = [];
  const agent = new HostAgent({
    supabaseUrl: 'http://unused.invalid',
    publishableKey: 'pk-itest',
    accessToken: () => null,
    deviceId: HOST_DEV,
    uid: UID,
    turnFetcher: async () => ({ iceServers: [] }), // 本机直连：无 STUN/TURN（真实 TURN 不进单测）
    onStatus: (s) => statuses.push(s),
    signaling: sig,
    pollMs: 25,
  });
  assert.equal(agent.isRunning, false);
  agent.start();
  assert.equal(agent.isRunning, true);

  // 假客户端（offerer）——Task 7 plan：werift↔werift 互通验装配
  const client = new Peer([], {});
  const proxyMsgs: any[] = [];
  const ctrlMsgs: any[] = [];
  let clientSid = '';
  const pendingClientIce: IceCandidateLike[] = [];
  const offer = await client.connectAsClient({
    onChannel: () => {},
    onIce: (cand) => {
      if (!clientSid) return;
      void sig.send(hostRoom, PHONE_DEV, { type: 'ice', sid: clientSid, cand, from: PHONE_DEV });
    },
    onStatus: () => {},
  });
  clientSid = offer.sid;
  await sig.send(hostRoom, PHONE_DEV, {
    type: 'offer',
    sid: offer.sid,
    sdp: { type: offer.sdp.type, sdp: offer.sdp.sdp },
    from: PHONE_DEV,
  });

  // 客户端侧 pump：收 answer/ice
  let clientCursor = 0;
  let answerSeen = false;
  const pump = setInterval(() => {
    void (async () => {
      const { msgs, cursor } = await sig.poll(phoneRoom, clientCursor);
      clientCursor = cursor;
      for (const row of msgs) {
        const m = row.payload;
        if (m.type === 'answer' && m.sdp) {
          await client.acceptAnswer(m.sid, m.sdp);
          answerSeen = true;
          for (const c of pendingClientIce.splice(0)) await client.addIce(c);
        } else if (m.type === 'ice' && m.cand) {
          if (answerSeen) await client.addIce(m.cand);
          else pendingClientIce.push(m.cand);
        }
      }
    })();
  }, 20);
  pump.unref?.();

  const { proxy, ctrl } = offer.channels;
  proxy.onmessage = (ev) => { proxyMsgs.push(JSON.parse(String(ev.data))); };
  ctrl.onmessage = (ev) => { ctrlMsgs.push(JSON.parse(String(ev.data))); };

  try {
    // DataChannel 建立
    await until(() => proxy.readyState === 'open', 20000, 'proxy dc open');
    await until(() => ctrl.readyState === 'open', 20000, 'ctrl dc open');

    // req 帧经 bridge → 本地 http → res 帧回达
    proxy.send(JSON.stringify({ k: 'req', id: 1, port, method: 'GET', path: '/', headers: {} }));
    await until(() => proxyMsgs.some((f) => f.k === 'res-chunk' && f.done), 20000, 'res done');
    const head = proxyMsgs.find((f) => f.k === 'res-head');
    assert.equal(head.status, 200);
    assert.equal(head.id, 1);
    const chunk = proxyMsgs.find((f) => f.k === 'res-chunk' && f.dataB64);
    assert.equal(Buffer.from(chunk.dataB64, 'base64').toString(), 'hello from host-bridge test');

    // ctrl ping/pong RTT 有值
    const t0 = Date.now();
    ctrl.send(JSON.stringify({ k: 'ping', t: t0 }));
    await until(() => ctrlMsgs.some((f) => f.k === 'pong'), 20000, 'pong');
    const pong = ctrlMsgs.find((f) => f.k === 'pong');
    assert.equal(pong.t, t0);
    const rtt = Date.now() - t0;
    assert.ok(Number.isFinite(rtt) && rtt >= 0);

    // status 事件至少一次 connected（含 deviceId）
    await until(() => statuses.some((s) => s.state === 'connected'), 20000, 'status connected');
    const st = statuses.find((s) => s.state === 'connected')!;
    assert.equal(st.deviceId, HOST_DEV);
  } finally {
    pump.unref && clearInterval(pump);
    agent.stop();
    client.close();
    closeServer(server);
  }
  assert.equal(agent.isRunning, false);
});

test('HostAgent：同设备重绑必须换新会话——替换后 disconnected 仍能 grace-drop（回归护栏）', async () => {
  // 回归：旧代码 `session = existing ?? new PeerSession(...)` 后 `session.dispose()` 再 set 回路由表，
  // 复用了同一个已 dispose 的对象。dispose 不可逆（disposed 永久置位）：
  // (a) startGrace 回调被 `if (!this.disposed)` 永久挡死——被替换的会话再也无法 grace-drop；
  // (b) 后续 dropSession/stop 的 dispose 早退，pc 与 bridges 永不关闭。
  const agent = new HostAgent({
    supabaseUrl: 'http://unused.invalid', publishableKey: 'pk', accessToken: () => null,
    deviceId: 'd', uid: 'u', turnFetcher: async () => ({ iceServers: [] }),
    signaling: new MemSignaling(), pollMs: 30,
  });
  const onSignal = (agent as unknown as { onSignal: (m: unknown) => Promise<void> }).onSignal.bind(agent);
  const sessions = (agent as unknown as { sessions: Map<string, PeerSession> }).sessions;
  // bogus sdp：acceptOffer 会失败，但会话已先入路由表——正是本测试要触达的状态
  const bogusSdp = { type: 'offer', sdp: 'v=0 bogus' };
  await onSignal({ type: 'offer', sid: 's1', from: 'phone-1', sdp: bogusSdp }).catch(() => {});
  const first = sessions.get('phone-1');
  assert.ok(first, '首个 offer 后应登记会话');
  await onSignal({ type: 'offer', sid: 's2', from: 'phone-1', sdp: bogusSdp }).catch(() => {});
  const second = sessions.get('phone-1');
  assert.ok(second);
  assert.notEqual(second, first, '重绑必须是新 PeerSession（dispose 不可逆，复用=宽限回调永久挡死）');
  assert.equal(agent.sessionCount, 1, '同设备重绑后仍只有一个会话');
  // 旧会话已 dispose：grace 回调不得再触发
  let oldFired = 0;
  first.startGrace(5, () => { oldFired += 1; });
  // 关键断言：替换后的会话 disconnected → 宽限到期必须能回调（dropSession 路径）
  let dropped = 0;
  second.startGrace(5, () => { dropped += 1; });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(oldFired, 0, '旧会话 dispose 后不得再回调');
  assert.equal(dropped, 1, '替换后的会话必须仍能 grace-drop');
  agent.stop();
});

test('HostAgent：ws-open 在未配置 wsPort 时回 open-err（不静默）', async () => {
  const agent = new HostAgent({
    supabaseUrl: 'http://unused.invalid',
    publishableKey: 'pk',
    accessToken: () => null,
    deviceId: 'd',
    uid: 'u',
    turnFetcher: async () => ({ iceServers: [] }),
    signaling: new MemSignaling(),
    pollMs: 50,
  });
  // 直测 wireChannel 语义：经由 proxy 通道帧路由——用 stub dc
  const sent: any[] = [];
  const stubDc: any = {
    label: 'proxy',
    bufferedAmount: 0,
    readyState: 'open',
    send: (data: string) => sent.push(JSON.parse(data)),
    onmessage: null,
  };
  const session = new PeerSession(undefined);  // 无 wsPort：ws-open 无 port 缺省 → open-err
  session.wireChannel(stubDc, 'proxy');
  stubDc.onmessage({ data: JSON.stringify({ k: 'ws-open', wid: 9, path: '/ws' }) });
  const err = sent.find((f) => f.k === 'ws-open-err');
  assert.equal(err?.wid, 9);
  session.dispose();
});

test('HostAgent：turnFetcher 单次失败不杀轮询环，后续 offer 照常应答', async () => {
  let failFirst = true;
  const agent = new HostAgent({
    supabaseUrl: 'http://unused.invalid',
    publishableKey: 'pk',
    accessToken: () => null,
    deviceId: 'd',
    uid: 'u',
    turnFetcher: async () => {
      if (failFirst) { failFirst = false; throw new Error('transient turn failure'); }
      return { iceServers: [] };
    },
    signaling: new MemSignaling(),
    pollMs: 30,
  });
  const sent: any[] = [];
  const mkDc = (): any => ({
    label: 'proxy', bufferedAmount: 0, readyState: 'open',
    send: (data: string) => sent.push(JSON.parse(data)),
    onmessage: null,
  });
  const ps = new PeerSession(undefined);
  ps.wireChannel(mkDc(), 'proxy');
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  // 第一条 offer：turnFetcher 抛错 → onSignal 失败但必须留痕且不影响后续
  (agent as unknown as { onSignal: (m: unknown) => Promise<void> }).onSignal({
    type: 'offer', sid: 'bad', from: 'phone-1', sdp: { type: 'offer', sdp: 'v=0 bogus' },
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  console.error = origErr;
  assert.ok(errs.some((l) => l.includes('transient turn failure')), 'turnFetcher 失败必须留痕');
  void agent; void sent;
});

test('HostAgent：两个客户端（不同 deviceId）同时在线，host 必须同时应答两者——单 viewer 是缺陷', async () => {
  // 本机 http 测试服务器：两个客户端各自发 req，必须各自收到自己的响应（桥键空间隔离）
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok-' + req.url);
  });
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));

  const UID = 'uid-multi';
  const HOST_DEV = 'desk-multi';
  const sig = new MemSignaling();
  const agent = new HostAgent({
    supabaseUrl: 'http://unused.invalid', publishableKey: 'pk', accessToken: () => null,
    deviceId: HOST_DEV, uid: UID, turnFetcher: async () => ({ iceServers: [] }), signaling: sig, pollMs: 25,
  });
  agent.start();

  const mkClient = async (dev: string) => {
    const client = new Peer([], {});
    const proxyMsgs: any[] = [];
    let sid = '';
    const pendingIce: IceCandidateLike[] = [];
    const offer = await client.connectAsClient({
      onChannel: () => {},
      onIce: (cand) => { if (sid) void sig.send(roomFor(UID, HOST_DEV), dev, { type: 'ice', sid, cand, from: dev }); },
      onStatus: () => {},
    });
    sid = offer.sid;
    await sig.send(roomFor(UID, HOST_DEV), dev, { type: 'offer', sid, sdp: { type: offer.sdp.type, sdp: offer.sdp.sdp }, from: dev });
    let cursor = 0, answerSeen = false;
    const pump = setInterval(() => {
      void (async () => {
        const { msgs, cursor: c } = await sig.poll(roomFor(UID, dev), cursor);
        cursor = c;
        for (const row of msgs) {
          const m = row.payload;
          if (m.type === 'answer' && m.sdp) { await client.acceptAnswer(m.sid, m.sdp); answerSeen = true; for (const cc of pendingIce.splice(0)) await client.addIce(cc); }
          else if (m.type === 'ice' && m.cand) { answerSeen ? await client.addIce(m.cand) : pendingIce.push(m.cand); }
        }
      })();
    }, 20);
    pump.unref?.();
    const { proxy } = offer.channels;
    proxy.onmessage = (ev) => { proxyMsgs.push(JSON.parse(String(ev.data))); };
    await until(() => proxy.readyState === 'open', 20000, `${dev} dc open`);
    return { client, proxy, proxyMsgs, dev };
  };

  const A = await mkClient('phone-A');   // 先连者
  await new Promise((r) => setTimeout(r, 300));
  const B = await mkClient('phone-B');   // 后连者：若 host 是单 viewer，B 会强绑 A 的通道

  try {
    // 关键断言：A 的通道必须仍是 open（单 viewer 会把它换绑/杀掉）
    await until(() => A.proxy.readyState === 'open', 3000, 'A 仍连接');
    // 双方 req 各自得到应答（桥键空间隔离）
    A.proxy.send(JSON.stringify({ k: 'req', id: 101, port, method: 'GET', path: '/a', headers: {} }));
    B.proxy.send(JSON.stringify({ k: 'req', id: 102, port, method: 'GET', path: '/b', headers: {} }));
    await until(() => A.proxyMsgs.some((f) => f.k === 'res-chunk' && f.done), 15000, 'A res');
    await until(() => B.proxyMsgs.some((f) => f.k === 'res-chunk' && f.done), 15000, 'B res');
    const aHead = A.proxyMsgs.find((f) => f.k === 'res-head' && f.id === 101);
    const bHead = B.proxyMsgs.find((f) => f.k === 'res-head' && f.id === 102);
    assert.equal(aHead.status, 200);
    assert.equal(bHead.status, 200);
    const aChunk = A.proxyMsgs.find((f) => f.k === 'res-chunk' && f.id === 101 && f.dataB64);
    const bChunk = B.proxyMsgs.find((f) => f.k === 'res-chunk' && f.id === 102 && f.dataB64);
    assert.equal(Buffer.from(aChunk.dataB64, 'base64').toString(), 'ok-/a');
    assert.equal(Buffer.from(bChunk.dataB64, 'base64').toString(), 'ok-/b');
  } finally {
    agent.stop(); A.client.close(); B.client.close(); closeServer(server);
  }
});
