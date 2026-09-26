import test from 'node:test';
import assert from 'node:assert/strict';
import { Peer, makeIceQueue, type PcLike, type LinkStatus } from '../peer.js';
import type { IceCandidateLike, SdpLike } from '../signaling/protocol.js';

// ---- stub pc（werift 真实 pc 不进单测，进 Task 7 集成测）----

interface StubCalls {
  closeCount: number;
  addedIce: IceCandidateLike[];
  remoteDescriptions: SdpLike[];
  dataChannels: Array<{ label: string; opts?: Record<string, unknown> }>;
}

function makeStubPc(statsRows: Array<Record<string, unknown>> = []): { pc: PcLike; calls: StubCalls } {
  const calls: StubCalls = { closeCount: 0, addedIce: [], remoteDescriptions: [], dataChannels: [] };
  const pc: PcLike = {
    connectionState: 'new',
    localDescription: { type: 'answer', sdp: 'v=0 stub' },
    ondatachannel: null,
    onicecandidate: null,
    oniceconnectionstatechange: null,
    onconnectionstatechange: null,
    async setRemoteDescription(d) { calls.remoteDescriptions.push(d); },
    async setLocalDescription() { return undefined; },
    async createOffer() { return { type: 'offer', sdp: 'v=0 stub-offer' }; },
    async createAnswer() { return { type: 'answer', sdp: 'v=0 stub-answer' }; },
    async addIceCandidate(c) { calls.addedIce.push(c); },
    createDataChannel(label, opts) {
      calls.dataChannels.push({ label, opts });
      return { label } as any;
    },
    async getStats() {
      const m = new Map<string, Record<string, unknown>>();
      for (const r of statsRows) m.set(String(r.id ?? r.type), r);
      return m as any;
    },
    close() { calls.closeCount++; },
  };
  return { pc, calls };
}

function stubFactoryQueue(stubs: Array<{ pc: PcLike; calls: StubCalls }>): () => PcLike {
  let i = 0;
  return () => stubs[i++]!.pc;
}

const noopHandlers = () => ({
  onChannel: () => {},
  onIce: () => {},
  onStatus: () => {},
});

const OFFER: SdpLike = { type: 'offer', sdp: 'v=0 offer' };
const CAND = (v: string): IceCandidateLike => ({ candidate: v, sdpMid: '0', sdpMLineIndex: 0 });

// ---- makeIceQueue 纯函数 ----

test('makeIceQueue：入队/排空/重置', () => {
  const q = makeIceQueue();
  q.add(CAND('a'));
  q.add(CAND('b'));
  assert.equal(q.size, 2);
  assert.deepEqual(q.drain().map((c) => c.candidate), ['a', 'b']);
  assert.equal(q.drain().length, 0);
  q.add(CAND('c'));
  q.reset();
  assert.equal(q.size, 0);
});

// ---- ICE 竞态缓冲（规则1：会话窗口期入队、setRemoteDescription 后排空；旧会话残留随换绑丢弃）----

test('addIce 竞态：setRemoteDescription 窗口期入队，就绪后按序排空', async () => {
  const stubs = [makeStubPc()];
  const peer = new Peer([], { pcFactory: stubFactoryQueue(stubs) });
  const pcAny = stubs[0].pc as any;
  const orig = pcAny.setRemoteDescription.bind(stubs[0].pc);
  pcAny.setRemoteDescription = async (d: SdpLike) => { await new Promise((r) => setTimeout(r, 15)); await orig(d); };

  const accepting = peer.acceptOffer('sid-1', OFFER, noopHandlers());
  await peer.addIce(CAND('during-1')); // remoteSet 仍为 false → 入队
  assert.equal(stubs[0].calls.addedIce.length, 0);
  await accepting;
  assert.deepEqual(stubs[0].calls.addedIce.map((c) => c.candidate), ['during-1']);
  assert.equal(stubs[0].calls.remoteDescriptions.length, 1); // 排空发生在 setRemoteDescription 之后

  await peer.addIce(CAND('late-2'));
  assert.equal(stubs[0].calls.addedIce.length, 2); // 就绪后直加
  assert.deepEqual(stubs[0].calls.addedIce[1].candidate, 'late-2');
});

// ---- sid 守卫（规则3）----

test('同 sid 二次 offer 不重建 pc', async () => {
  const stubs = [makeStubPc(), makeStubPc()];
  const peer = new Peer([], { pcFactory: stubFactoryQueue(stubs) });
  await peer.acceptOffer('sid-1', OFFER, noopHandlers());
  await peer.acceptOffer('sid-1', OFFER, noopHandlers());
  assert.equal(stubs[1].calls.closeCount + 0, 0);
  assert.equal(stubs[0].calls.remoteDescriptions.length, 1); // 只处理了一次
});

// ---- 最新 offer 优先（规则2）----

test('新 sid offer 触发旧 pc close 换绑', async () => {
  const stubs = [makeStubPc(), makeStubPc()];
  const peer = new Peer([], { pcFactory: stubFactoryQueue(stubs) });
  await peer.acceptOffer('sid-1', OFFER, noopHandlers());
  await peer.acceptOffer('sid-2', OFFER, noopHandlers());
  assert.equal(stubs[0].calls.closeCount, 1);
  assert.equal(stubs[1].calls.remoteDescriptions.length, 1);
});

test('旧会话的候选缓冲不污染新会话', async () => {
  const stubs = [makeStubPc(), makeStubPc()];
  const peer = new Peer([], { pcFactory: stubFactoryQueue(stubs) });
  await peer.addIce(CAND('stale'));
  await peer.acceptOffer('sid-1', OFFER, noopHandlers());
  await peer.acceptOffer('sid-2', OFFER, noopHandlers());
  assert.equal(stubs[0].calls.addedIce.length, 0); // 无主/stale 候选随会话重置丢弃
  assert.equal(stubs[1].calls.addedIce.length, 0);
});

// ---- 升级轮重协商原位应答（W2-6：同 sid 不拆 PC，异 sid/无 PC 拒绝）----

test('acceptRestartOffer：同 sid 同一 pc 原位再应答（不 close/不新建/不动 handlers）；异 sid 与无 PC 拒绝', async () => {
  const stubs = [makeStubPc(), makeStubPc()];
  const peer = new Peer([], { pcFactory: stubFactoryQueue(stubs) });
  await peer.acceptOffer('sid-1', OFFER, noopHandlers());
  assert.equal(stubs[0].calls.remoteDescriptions.length, 1);
  let answers = 0;
  const origAnswer = stubs[0].pc.createAnswer.bind(stubs[0].pc);
  stubs[0].pc.createAnswer = async () => { answers += 1; return origAnswer(); };

  const ok = await peer.acceptRestartOffer('sid-1', { type: 'offer', sdp: 'v=0 restart' });
  assert.equal(ok, true, '同 sid 必须受理');
  assert.equal(stubs[0].calls.remoteDescriptions.length, 2, '同一 pc 原位再咽一次 restart SDP');
  assert.equal(answers, 1, 'createAnswer 在同一 pc 上被调（新 answer）');
  assert.equal(stubs[0].calls.closeCount, 0, '原位应答不得拆 PC（数据面存续）');
  assert.equal(stubs[1].calls.remoteDescriptions.length, 0, '不得新建 pc');

  const reject = await peer.acceptRestartOffer('sid-2', { type: 'offer', sdp: 'v=0 restart-2' });
  assert.equal(reject, false, '异 sid 必须拒绝（sid 守卫只认当前会话）');
  assert.equal(stubs[0].calls.remoteDescriptions.length, 2, '异 sid 零 pc 交互');
  assert.equal(answers, 1);
  assert.equal(stubs[0].calls.closeCount, 0, '拒绝路径同样不拆 PC');

  const idle = new Peer([], { pcFactory: stubFactoryQueue([makeStubPc()]) });
  assert.equal(await idle.acceptRestartOffer('sid-x', OFFER), false, '无会话无 PC 必须拒绝');
});

// ---- 数据通道/候选回调接线 ----

test('ondatachannel/onicecandidate 接线（候选以平铺字典下发）', async () => {
  const stubs = [makeStubPc()];
  const peer = new Peer([], { pcFactory: stubFactoryQueue(stubs) });
  const seen: Array<{ label: string; dc: unknown }> = [];
  const ices: IceCandidateLike[] = [];
  await peer.acceptOffer('sid-1', OFFER, {
    onChannel: (dc, label) => seen.push({ label, dc }),
    onIce: (c) => ices.push(c),
    onStatus: () => {},
  });
  const fakeDc = { label: 'proxy' } as any;
  stubs[0].pc.ondatachannel?.({ channel: fakeDc });
  assert.deepEqual(seen, [{ label: 'proxy', dc: fakeDc }]);

  stubs[0].pc.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp …', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'u' } as any });
  stubs[0].pc.onicecandidate?.({ candidate: undefined });
  assert.deepEqual(ices, [{ candidate: 'candidate:1 1 udp …', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'u' }]);
});

// ---- ctrl 通道 ----

test('createCtrl 用 unordered+maxRetransmits:0（绝不 ordered 测 RTT）', async () => {
  const stubs = [makeStubPc()];
  const peer = new Peer([], { pcFactory: stubFactoryQueue(stubs) });
  await peer.acceptOffer('sid-1', OFFER, noopHandlers());
  peer.createCtrl();
  assert.deepEqual(stubs[0].calls.dataChannels, [{ label: 'ctrl', opts: { ordered: false, maxRetransmits: 0 } }]);
});

// ---- connectAsClient（集成测假客户端用）----

test('connectAsClient 建 proxy+ctrl 两条通道并返回 offer', async () => {
  const stubs = [makeStubPc()];
  const peer = new Peer([], { pcFactory: stubFactoryQueue(stubs) });
  const { sid, sdp } = await peer.connectAsClient(noopHandlers());
  assert.ok(sid.length >= 6);
  assert.equal(sdp.type, 'answer'); // stub localDescription
  assert.deepEqual(
    stubs[0].calls.dataChannels.map((d) => d.label),
    ['proxy', 'ctrl'],
  );
  const ctrl = stubs[0].calls.dataChannels[1];
  assert.deepEqual(ctrl.opts, { ordered: false, maxRetransmits: 0 });
});

// ---- snapshot / refreshStats ----

test('snapshot：connectionState 映射 + lastStats 合并', async () => {
  const statsRows = [
    { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.05 },
    { id: 'L', type: 'local-candidate', candidateType: 'relay', address: '39.106.59.183', port: 50010 },
    { id: 'R', type: 'remote-candidate', candidateType: 'relay', address: '39.106.59.183', port: 50018 },
  ];
  const stubs = [makeStubPc(statsRows)];
  const peer = new Peer([], { pcFactory: stubFactoryQueue(stubs) });

  assert.deepEqual(peer.snapshot(), { state: 'closed', pairType: null }); // 尚无会话
  await peer.acceptOffer('sid-1', OFFER, noopHandlers());
  await peer.refreshStats();
  assert.deepEqual(peer.snapshot(), {
    state: 'connecting',
    pairType: 'relay',
    relayAddr: '39.106.59.183:50010',
    rttMs: 50,
  });

  (stubs[0].pc as any).connectionState = 'connected';
  assert.equal((peer.snapshot() as LinkStatus).state, 'connected');
  // 2026-09-12 根因修复：disconnected 是 ICE 可自愈瞬时态，绝不能报成 failed——
  // 曾被宿主当作真失败摘除会话，导致蜂窝抖动下在途请求全挂（Android 直连 Files 504 实证）。
  (stubs[0].pc as any).connectionState = 'disconnected';
  assert.equal((peer.snapshot() as LinkStatus).state, 'disconnected');
  (stubs[0].pc as any).connectionState = 'failed';
  assert.equal((peer.snapshot() as LinkStatus).state, 'failed');
  (stubs[0].pc as any).connectionState = 'closed';
  assert.equal((peer.snapshot() as LinkStatus).state, 'closed');
});

test('onconnectionstatechange 触发 onStatus 事件', async () => {
  const statsRows = [
    { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.02 },
    { id: 'L', type: 'local-candidate', candidateType: 'host', address: '192.168.1.2', port: 50000 },
    { id: 'R', type: 'remote-candidate', candidateType: 'host', address: '192.168.1.3', port: 50001 },
  ];
  const stubs = [makeStubPc(statsRows)];
  const peer = new Peer([], { pcFactory: stubFactoryQueue(stubs) });
  const statuses: LinkStatus[] = [];
  await peer.acceptOffer('sid-1', OFFER, { ...noopHandlers(), onStatus: (s) => statuses.push(s) });
  (stubs[0].pc as any).connectionState = 'connected';
  stubs[0].pc.onconnectionstatechange?.();
  await new Promise((r) => setTimeout(r, 10)); // refreshStats 是异步链
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].state, 'connected');
  assert.equal(statuses[0].pairType, 'p2p');
});
