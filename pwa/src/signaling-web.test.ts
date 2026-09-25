import test from 'node:test';
import assert from 'node:assert/strict';
import { autoAccess, handleChannelMessage, handleProxyMessage, offerAccess, WebRtcSession } from './signaling-web.js';
import { LS_ACCESS } from './constants.js';
import { encodeResChunkBin, encodeWsMsgBin } from 'p2p-net/browser';

test('proxy 通道任何合法帧都是活性证明（不独厚 pong）', () => {
  // 2026-09-23 真机实证：批量传输期间 ctrl 心跳被饿死/丢失，15s 无 pong 误判死亡拆连。
  // 数据帧在流本身就是活着的证据——res-chunk 也必须刷新心跳。
  let proofs = 0;
  const frames: unknown[] = [];
  const sinks = { onProof: () => { proofs += 1; }, onFrame: (m: unknown) => frames.push(m) };
  handleProxyMessage(JSON.stringify({ k: 'res-chunk', id: 1, dataB64: 'x' }), sinks);
  handleProxyMessage(JSON.stringify({ k: 'pong', t: 1 }), sinks);
  handleProxyMessage(JSON.stringify({ k: 'res-head', id: 2, status: 200, headers: {} }), sinks);
  assert.equal(proofs, 3, '三帧都应记活性证明');
  assert.equal(frames.length, 3, '所有帧（含 proxy 上的 pong）都上交路由层');
});

test('非法帧：不记活性、不上交', () => {
  let proofs = 0;
  const frames: unknown[] = [];
  handleProxyMessage('not-json{{{', { onProof: () => { proofs += 1; }, onFrame: (m: unknown) => frames.push(m) });
  assert.equal(proofs, 0);
  assert.equal(frames.length, 0);
});

test('二进制帧入站：res-chunk/ws-msg 记活性并上交，Uint8Array 体不丢字节', () => {
  let proofs = 0;
  const frames: any[] = [];
  const sinks = { onProof: () => { proofs += 1; }, onFrame: (m: unknown) => frames.push(m) };
  const payload = new Uint8Array([5, 6, 7, 251]);
  handleChannelMessage(encodeResChunkBin(9, payload, false).buffer as ArrayBuffer, sinks);
  handleChannelMessage(encodeWsMsgBin(3, payload).buffer as ArrayBuffer, sinks);
  assert.equal(proofs, 2);
  assert.equal(frames[0].k, 'res-chunk');
  assert.equal(frames[0].id, 9);
  assert.deepEqual(frames[0].data, payload);
  assert.equal(frames[1].k, 'ws-msg');
  assert.equal(frames[1].wid, 3);
  assert.deepEqual(frames[1].data, payload);
});

test('二进制垃圾帧：不记活性、不上交；JSON 文本路径不受影响', () => {
  let proofs = 0;
  const frames: any[] = [];
  const sinks = { onProof: () => { proofs += 1; }, onFrame: (m: unknown) => frames.push(m) };
  handleChannelMessage(new Uint8Array([1, 2]).buffer as ArrayBuffer, sinks);
  handleChannelMessage(JSON.stringify({ k: 'res-head', id: 1, status: 200, headers: {} }), sinks);
  assert.equal(proofs, 1, '仅 JSON 合法帧记活性');
  assert.equal(frames.length, 1);
});

// ---- Wave 2 W2-1：接入类型分桶——autoAccess 探测降级 + meta 随 offer 发出 ----

test('autoAccess：无 navigator.connection（iPhone Safari/Node 同形）→ unknown，不抛', () => {
  // Global Constraints：无 Network Information API 的平台必须降级手动标注/unknown，不得报错
  assert.equal(autoAccess(), 'unknown');
});

test('autoAccess：connection.type=cellular → cellular-other；非蜂窝 → unknown', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { connection: { type: 'cellular' } }, configurable: true });
    assert.equal(autoAccess(), 'cellular-other');
    Object.defineProperty(globalThis, 'navigator', { value: { connection: { type: 'wifi' } }, configurable: true });
    assert.equal(autoAccess(), 'unknown');
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    assert.equal(autoAccess(), 'unknown', 'connection 缺失（Safari）不得抛');
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
  }
});

type LsLike = { getItem(k: string): string | null };

async function withLocalStorage<T>(ls: LsLike | undefined, fn: () => T | Promise<T>): Promise<T> {
  const g = globalThis as { localStorage?: LsLike };
  const prev = g.localStorage;
  if (ls === undefined) delete g.localStorage;
  else g.localStorage = ls;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete g.localStorage;
    else g.localStorage = prev;
  }
}

test('offerAccess：手动标注（LS）优先；无 LS 且无可探测连接 → unknown', async () => {
  await withLocalStorage(undefined, () => {
    assert.equal(offerAccess(), 'unknown', '无 LS 且无 connection（Safari 同形）必须降级 unknown，不抛');
  });
  await withLocalStorage({ getItem: (k) => (k === LS_ACCESS ? 'wifi-office' : null) }, () => {
    assert.equal(offerAccess(), 'wifi-office', '手动标注优先于自动探测');
  });
  await withLocalStorage({ getItem: () => null }, () => {
    assert.equal(offerAccess(), 'unknown', 'LS 无值回落自动探测');
  });
});

test('offer 携带 meta.access 随信令发出（W2-1）：无标注 → unknown；手动标注 → 标注值', async () => {
  // 假 RTCPeerConnection：只实现 connect() 触达的面（datachannel/createOffer/setLocalDescription/close）
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
  class FakePc {
    onicecandidate: ((ev: { candidate: null }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    localDescription: { type: string; sdp: string } | null = null;
    createDataChannel(): FakeDc { return new FakeDc(); }
    async createOffer(): Promise<{ type: string; sdp: string }> { return { type: 'offer', sdp: 'v=0 fake' }; }
    async setLocalDescription(d: { type: string; sdp: string }): Promise<void> { this.localDescription = d; }
    close(): void {}
  }
  const g = globalThis as { RTCPeerConnection?: unknown };
  const prevPc = g.RTCPeerConnection;
  g.RTCPeerConnection = FakePc;
  const sent: Array<{ room: string; sender: string; msg: any }> = [];
  const signaling = {
    send: async (room: string, sender: string, msg: unknown) => { sent.push({ room, sender, msg }); },
    poll: async (_room: string, cursor: number) => ({ msgs: [] as unknown[], cursor }),
    purgeExpired: async () => {},
  };
  const session = new WebRtcSession({
    signaling: signaling as any,
    uid: 'uid-1', myDeviceId: 'phone-1', iceServers: [],
    onStatus: () => {}, onFrame: () => {},
  });
  try {
    await withLocalStorage(undefined, () => session.connect('desk-1'));
    const offers1 = sent.filter((m) => m.msg?.type === 'offer');
    assert.equal(offers1.length, 1, 'connect 必须发出一条 offer');
    assert.deepEqual(offers1[0]!.msg.meta, { access: 'unknown' }, '无标注无探测 → meta.access=unknown 随 offer 发出');

    await withLocalStorage({ getItem: (k) => (k === LS_ACCESS ? 'cellular-cu' : null) }, () => session.connect('desk-1'));
    const offers2 = sent.filter((m) => m.msg?.type === 'offer');
    assert.equal(offers2.length, 2, '重连应再发一条 offer');
    assert.deepEqual(offers2[1]!.msg.meta, { access: 'cellular-cu' }, '手动标注随 offer 的 meta 发出');
  } finally {
    session.teardown();
    if (prevPc === undefined) delete g.RTCPeerConnection;
    else g.RTCPeerConnection = prevPc;
  }
});
