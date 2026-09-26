import test from 'node:test';
import assert from 'node:assert/strict';
import { CascadeSession, type CascadeOptions, type CascadeStatus } from './session.js';
import type { WebRtcSession } from './signaling-web.js';
import type { SignalingClient } from 'p2p-net/browser';

/** 内存信令桩（本组用例不触达 WebRTC 段信令交互，只兜住类型面）。 */
function fakeSignaling(): SignalingClient {
  return {
    send: async () => {},
    poll: async (_room: string, cursor: number) => ({ msgs: [], cursor }),
    purgeExpired: async () => {},
  } as unknown as SignalingClient;
}

/** RTCPeerConnection 一律抛错：p2p/turn 段立即失败（靠 stage 时序断言段序，不真跑 ICE）。 */
function installThrowingRtc(): void {
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    value: class { constructor() { throw new Error('rtc_disabled'); } },
    configurable: true,
    writable: true,
  });
}

/** 假 RTC：dc 5ms 自开（turn 段能建成，任务D turn 拒绝臂用）。 */
function installFakeRtc(): void {
  class FakeDc {
    binaryType = 'arraybuffer';
    readyState = 'connecting';
    bufferedAmount = 0;
    onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send(): void {}
    close(): void { this.readyState = 'closed'; }
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    value: class {
      onicecandidate: ((ev: { candidate: null }) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      connectionState = 'new';
      localDescription: { type: string; sdp: string } | null = null;
      createDataChannel(): FakeDc {
        const dc = new FakeDc();
        setTimeout(() => { dc.readyState = 'open'; dc.onopen?.(); }, 5);
        return dc;
      }
      async createOffer(): Promise<{ type: string; sdp: string }> { return { type: 'offer', sdp: 'v=0 fake' }; }
      async setLocalDescription(d: { type: string; sdp: string }): Promise<void> { this.localDescription = d; }
      async setRemoteDescription(): Promise<void> {}
      async addIceCandidate(): Promise<void> {}
      setConfiguration(): void {}
      async getStats(): Promise<{ forEach: (cb: (v: unknown) => void) => void }> { return { forEach: () => {} }; }
      close(): void {}
    },
    configurable: true,
    writable: true,
  });
}

/** 可变 fetch 桩：probeTunnel 只触 res.ok / res.text()；config/turn-credentials 触 res.json()。 */
interface StubRes { ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }
function jsonRes(status: number, payload: unknown): StubRes {
  const text = JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => payload };
}
let fetchImpl: (url: string) => Promise<StubRes>;
Object.defineProperty(globalThis, 'fetch', {
  value: async (input: unknown) => fetchImpl(String(input)),
  configurable: true,
  writable: true,
});
function tunnelOk(): void {
  fetchImpl = async () => jsonRes(200, { services: [] });
}
function tunnelDown(): void {
  fetchImpl = async () => ({ ok: false, status: 502, text: async () => 'bad gateway', json: async () => { throw new Error('not json'); } });
}
/** turn 段建连链路：/config.json + turn-credentials 凭据（iceServers 空表，NAT 采集立即退化）。 */
function turnCredsOk(): void {
  fetchImpl = async (url) => {
    if (url === '/config.json') return jsonRes(200, { supabaseUrl: 'https://supa.test', publishableKey: 'pk-test', relays: [] });
    if (url.includes('/functions/v1/turn-credentials')) return jsonRes(200, { iceServers: [] });
    return jsonRes(200, { services: [] });
  };
}

const TUNNEL_URL = 'https://gw.example.com/tunnel/s/abc';

function makeCascade(over: Partial<CascadeOptions>, statuses: CascadeStatus[]): CascadeSession {
  return new CascadeSession({
    signaling: fakeSignaling(),
    uid: 'uid-1',
    myDeviceId: 'phone-1',
    getJwt: async () => null,
    onStatus: (s) => statuses.push(s),
    onFrame: () => {},
    stunServers: [],
    ...over,
  });
}

test('任务C：lastMode=tunnel 注入 planStageModes——隧道段先行（跳过 10s p2p 白等）', async () => {
  installThrowingRtc();
  tunnelOk();
  const statuses: CascadeStatus[] = [];
  const c = makeCascade({ lastMode: 'tunnel' }, statuses);
  await c.connect('desk-1', TUNNEL_URL);
  assert.equal(c.mode, 'tunnel');
  assert.equal(statuses[0]!.stage, 'tunnel', '首个 status 必须是 tunnel 段（隧道先行）');
  assert.ok(!statuses.some((s) => s.stage === 'p2p'), 'p2p 段不得被触达');
  assert.equal(statuses.at(-1)!.state, 'connected');
  c.stop();
});

test('任务C：无 lastMode（/p2p/turn 记忆）维持原序——p2p 段先赌，失败落隧道', async () => {
  installThrowingRtc();
  tunnelOk();
  for (const lastMode of [undefined, null, 'p2p', 'turn'] as const) {
    const statuses: CascadeStatus[] = [];
    const c = makeCascade(lastMode === undefined ? {} : { lastMode }, statuses);
    await c.connect('desk-1', TUNNEL_URL);
    assert.equal(c.mode, 'tunnel', `lastMode=${String(lastMode)} 最终仍落隧道`);
    assert.equal(statuses[0]!.stage, 'p2p', `lastMode=${String(lastMode)} 首段必须是 p2p（原序）`);
    c.stop();
  }
});

test('任务C：probeTunnelAlive 包装私有 probeTunnel——活 true / 死 false / 无网关 false', async () => {
  installThrowingRtc();
  tunnelOk();
  const statuses: CascadeStatus[] = [];
  const c = makeCascade({ lastMode: 'tunnel' }, statuses);
  await c.connect('desk-1', TUNNEL_URL);
  assert.equal(await c.probeTunnelAlive(), true, '网关 200 services → 活');
  tunnelDown();
  assert.equal(await c.probeTunnelAlive(), false, '网关 502 → 死（false 而非抛错）');
  tunnelOk();
  c.stop();

  const bare = makeCascade({}, []);
  assert.equal(await bare.probeTunnelAlive(), false, '无 tunnelUrl → false，不得抛错');
});

// ---- 任务D：adoptP2pUpgrade（tunnel→p2p 热切换的 session 侧）----

/** 旁路已建成的假 WebRtcSession：adopt 只触 send/teardown 两面。 */
function fakeBuiltWeb(log: { torn: number; sent: unknown[] }): WebRtcSession {
  return {
    isOpen: true,
    send: async (f: unknown) => { log.sent.push(f); },
    teardown: () => { log.torn += 1; },
  } as unknown as WebRtcSession;
}

test('任务D：隧道态 adoptP2pUpgrade——热切 p2p + 补发 connected(p2p) + send 改委托旁路', async () => {
  installThrowingRtc();
  tunnelOk();
  const statuses: CascadeStatus[] = [];
  const c = makeCascade({ lastMode: 'tunnel' }, statuses);
  await c.connect('desk-1', TUNNEL_URL);
  assert.equal(c.mode, 'tunnel');
  const log = { torn: 0, sent: [] as unknown[] };
  const web = fakeBuiltWeb(log);
  assert.equal(c.adoptP2pUpgrade(web), true, '隧道态必须接受旁路');
  assert.equal(c.mode, 'p2p', 'adopt 后落点即 p2p');
  const last = statuses.at(-1)!;
  assert.deepEqual(
    { state: last.state, pairType: last.pairType, mode: last.mode, stage: last.stage },
    { state: 'connected', pairType: 'p2p', mode: 'p2p', stage: 'done' },
    'adopt 必须补一条 connected(p2p) 状态（状态条/落盘链路据此刷新）',
  );
  await c.send({ k: 'ping' });
  assert.equal(log.sent.length, 1, 'send 必须委托给旁路会话');
  assert.equal(log.torn, 0, 'adopt 不得拆掉刚接入的旁路');
  c.stop();
  assert.equal(log.torn, 1, 'stop 才拆旁路');
});

test('任务D：非隧道态 adoptP2pUpgrade——拒绝且不动传入实例', async () => {
  installThrowingRtc();
  const c = makeCascade({}, []); // 未 connect：mode null
  const log = { torn: 0, sent: [] as unknown[] };
  const web = fakeBuiltWeb(log);
  assert.equal(c.adoptP2pUpgrade(web), false, '无隧道会话不得接受');
  assert.equal(log.torn, 0, '拒绝路径不得 teardown 传入实例（旁路归调用方处置）');
  await c.send({ k: 'ping' });
  assert.equal(log.sent.length, 0, '拒绝后 send 不得流向旁路');
});

test('任务D：turn 会话中 adoptP2pUpgrade 拒绝——relay 会话不得被旁路顶替', async () => {
  installFakeRtc();
  turnCredsOk();
  const statuses: CascadeStatus[] = [];
  const c = makeCascade({ forceTurn: true, getJwt: async () => 'jwt-test' }, statuses);
  await c.connect('desk-1', TUNNEL_URL);
  assert.equal(c.mode, 'turn', 'forceTurn + 假 RTC + 凭据桩 → 落 turn');
  const log = { torn: 0, sent: [] as unknown[] };
  const web = fakeBuiltWeb(log);
  assert.equal(c.adoptP2pUpgrade(web), false, 'turn 会话中不得接受旁路');
  assert.equal(c.mode, 'turn', '拒绝后落点不变');
  assert.equal(log.torn, 0, '拒绝路径不得 teardown 传入实例');
  await c.send({ k: 'ping' });
  assert.equal(log.sent.length, 0, 'send 仍走原 turn 会话，不得流向旁路');
  c.stop();
});
