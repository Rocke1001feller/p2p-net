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
    natProbe: async () => undefined, // W2-2：本测试不关 NAT 采集，注入缝保持 hermetic
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

// ---- Wave 2 W2-2：NAT facts——meta.nat 随 offer 发出，采集失败静默降级 ----

type SentMsg = { room: string; sender: string; msg: any };

/** 假 PC/DC + 内存信令：跑 connect 抓 offer（natProbe 经注入缝控制采集结果）。 */
async function captureOffer(natProbe: (() => Promise<string | undefined>) | undefined): Promise<{ offers: SentMsg[]; session: WebRtcSession }> {
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
  const sent: SentMsg[] = [];
  const signaling = {
    send: async (room: string, sender: string, msg: unknown) => { sent.push({ room, sender, msg }); },
    poll: async (_room: string, cursor: number) => ({ msgs: [] as unknown[], cursor }),
    purgeExpired: async () => {},
  };
  const session = new WebRtcSession({
    signaling: signaling as any,
    uid: 'uid-1', myDeviceId: 'phone-1', iceServers: [],
    onStatus: () => {}, onFrame: () => {},
    ...(natProbe ? { natProbe } : {}),
  });
  const restore = (): void => {
    if (prevPc === undefined) delete g.RTCPeerConnection;
    else g.RTCPeerConnection = prevPc;
  };
  try {
    await withLocalStorage(undefined, () => session.connect('desk-1'));
  } finally {
    restore();
  }
  return { offers: sent.filter((m) => m.msg?.type === 'offer'), session };
}

test('offer meta.nat 随 offer 发出：采集成功 → 紧凑串进 meta', async () => {
  const { offers, session } = await captureOffer(async () => 'm:ep-ind,servers:2');
  try {
    assert.equal(offers.length, 1, 'connect 必须发出一条 offer');
    assert.deepEqual(offers[0]!.msg.meta, { access: 'unknown', nat: 'm:ep-ind,servers:2' }, 'nat 紧凑串随 offer 的 meta 发出');
  } finally {
    session.teardown();
  }
});

test('offer meta.nat 采集失败（探针抛错/返回 undefined）→ 静默降级不阻断连接，meta 无 nat 键', async () => {
  const throwing = await captureOffer(async () => {
    throw new Error('probe boom');
  });
  try {
    assert.equal(throwing.offers.length, 1, '采集抛错不得阻断 offer 发送');
    assert.deepEqual(throwing.offers[0]!.msg.meta, { access: 'unknown' }, '失败降级：meta 不带 nat 键');
  } finally {
    throwing.session.teardown();
  }

  const undef = await captureOffer(async () => undefined);
  try {
    assert.equal(undef.offers.length, 1);
    assert.deepEqual(undef.offers[0]!.msg.meta, { access: 'unknown' }, '无采集结果：meta 不带 nat 键');
  } finally {
    undef.session.teardown();
  }
});

// ---- Wave 2 W2-6：升级执行手——upgrade 帧 → setConfiguration 翻转 + iceRestart 重协商 ----

interface UpgradeCaptures {
  setConfigurationCalls: RTCConfiguration[];
  createOfferOpts: Array<{ iceRestart?: boolean } | undefined>;
  setRemoteCount: number;
}

/** 假 PC/DC + 可编排行内存信令：connect 后经私有缝驱动 poll()
 *  （私有触达照 host.integration.test.ts:182 同款 as-unknown-as 先例）。 */
async function connectForUpgrade(extra: { iceServers: RTCIceServer[]; upgradeIceServers?: RTCIceServer[] }): Promise<{
  session: WebRtcSession; sent: SentMsg[]; caps: UpgradeCaptures; sid: string;
  pollRows: (rows: Array<{ payload: unknown }>) => void;
  drivePoll: () => Promise<void>;
  restore: () => void;
}> {
  const caps: UpgradeCaptures = { setConfigurationCalls: [], createOfferOpts: [], setRemoteCount: 0 };
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
    setConfiguration(cfg: RTCConfiguration): void { caps.setConfigurationCalls.push(cfg); }
    async createOffer(opts?: { iceRestart?: boolean }): Promise<{ type: string; sdp: string }> {
      caps.createOfferOpts.push(opts);
      return { type: 'offer', sdp: 'v=0 fake' };
    }
    async setLocalDescription(d: { type: string; sdp: string }): Promise<void> { this.localDescription = d; }
    async setRemoteDescription(_d: unknown): Promise<void> { caps.setRemoteCount += 1; }
    async addIceCandidate(): Promise<void> {}
    close(): void {}
  }
  const g = globalThis as { RTCPeerConnection?: unknown };
  const prevPc = g.RTCPeerConnection;
  g.RTCPeerConnection = FakePc;
  const sent: SentMsg[] = [];
  let rows: Array<{ payload: unknown }> = [];
  const signaling = {
    send: async (room: string, sender: string, msg: unknown) => { sent.push({ room, sender, msg }); },
    poll: async (_room: string, cursor: number) => ({ msgs: rows.splice(0) as unknown[], cursor }),
    purgeExpired: async () => {},
  };
  const session = new WebRtcSession({
    signaling: signaling as any,
    uid: 'uid-1', myDeviceId: 'phone-1',
    iceServers: extra.iceServers,
    ...(extra.upgradeIceServers ? { upgradeIceServers: extra.upgradeIceServers } : {}),
    onStatus: () => {}, onFrame: () => {},
    natProbe: async () => undefined, // 本组不关 NAT 采集，注入缝保持 hermetic
  });
  const restorePc = (): void => {
    if (prevPc === undefined) delete g.RTCPeerConnection;
    else g.RTCPeerConnection = prevPc;
  };
  try {
    await withLocalStorage(undefined, () => session.connect('desk-1'));
  } catch (e) {
    restorePc();
    throw e;
  }
  const sid = (sent.find((m) => m.msg?.type === 'offer')!.msg as { sid: string }).sid;
  return {
    session, sent, caps, sid,
    pollRows: (r) => { rows = r; },
    drivePoll: () => (session as unknown as { poll: () => Promise<void> }).poll(),
    restore: () => { session.teardown(); restorePc(); },
  };
}

/** performUpgrade 在 poll 分支里是 fire-and-forget——等一个宏任务让微任务链落定再断言。 */
const flushMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test('upgrade 帧 → setConfiguration 全量翻转 + iceRestart offer（同 sid、无 meta）', async () => {
  const stun: RTCIceServer[] = [{ urls: 'stun:stun.example.com' }];
  const turn: RTCIceServer[] = [{ urls: 'turn:turn.example.com', username: 'u', credential: 'p' }];
  const h = await connectForUpgrade({ iceServers: turn, upgradeIceServers: [...stun, ...turn] });
  try {
    h.pollRows([{ payload: { type: 'upgrade', sid: h.sid } }]);
    await h.drivePoll();
    await flushMicrotasks();
    assert.equal(h.caps.setConfigurationCalls.length, 1, 'upgrade 帧必须触发一次 setConfiguration');
    assert.deepEqual(h.caps.setConfigurationCalls[0], { iceServers: [...stun, ...turn], iceTransportPolicy: 'all' },
      '整体替换：全量 STUN+TURN（顺序齐）+ policy 翻转 all，键齐无多余');
    assert.deepEqual(h.caps.createOfferOpts[1], { iceRestart: true }, '重协商必须 iceRestart（[0] 为 connect 首 offer）');
    const offers = h.sent.filter((m) => m.msg?.type === 'offer');
    assert.equal(offers.length, 2, '首 offer + restart offer');
    const msg = offers[1]!.msg;
    assert.equal(msg.sid, h.sid, 'restart offer 必须与活会话同 sid（双端守卫都按 sid 路由）');
    assert.equal(msg.from, 'phone-1');
    assert.deepEqual(msg.sdp, { type: 'offer', sdp: 'v=0 fake' });
    assert.ok(!('meta' in msg), 'restart offer 不带 meta（旧版兼容；access 已随首 offer 入桶）');
    assert.deepEqual(Object.keys(msg).sort(), ['from', 'sdp', 'sid', 'type'], '帧纪律钉死：无任何多余键');
  } finally {
    h.restore();
  }
});

test('restartPending 闸：pending 中第二个 upgrade 帧不再 createOffer；answer 到达后复位', async () => {
  const stun: RTCIceServer[] = [{ urls: 'stun:stun.example.com' }];
  const turn: RTCIceServer[] = [{ urls: 'turn:turn.example.com', username: 'u', credential: 'p' }];
  const h = await connectForUpgrade({ iceServers: turn, upgradeIceServers: [...stun, ...turn] });
  try {
    // 首 answer 落定 remoteSet=true（模拟活会话）
    h.pollRows([{ payload: { type: 'answer', sid: h.sid, sdp: { type: 'answer', sdp: 'v=0 a1' } } }]);
    await h.drivePoll();
    assert.equal(h.caps.setRemoteCount, 1);
    // 连发两行 upgrade → createOffer 仅 1 次（[0] 首 offer + [1] restart）
    h.pollRows([{ payload: { type: 'upgrade', sid: h.sid } }, { payload: { type: 'upgrade', sid: h.sid } }]);
    await h.drivePoll();
    await flushMicrotasks();
    assert.equal(h.caps.createOfferOpts.length, 2, 'pending 中第二个 upgrade 帧不得再 createOffer');
    assert.deepEqual(h.caps.createOfferOpts[1], { iceRestart: true });
    // restart answer（remoteSet 已 true）仍须 setRemoteDescription——重协商 answer 不得被 !remoteSet 吞掉
    h.pollRows([{ payload: { type: 'answer', sid: h.sid, sdp: { type: 'answer', sdp: 'v=0 a2' } } }]);
    await h.drivePoll();
    assert.equal(h.caps.setRemoteCount, 2, '重协商 answer 必须再调一次 setRemoteDescription');
    // pending 已复位 → 第三个 upgrade 帧 → createOffer 第 2 次（总第 3 次）
    h.pollRows([{ payload: { type: 'upgrade', sid: h.sid } }]);
    await h.drivePoll();
    await flushMicrotasks();
    assert.equal(h.caps.createOfferOpts.length, 3, 'answer 复位 pending 后须能再次升级');
    assert.deepEqual(h.caps.createOfferOpts[2], { iceRestart: true });
  } finally {
    h.restore();
  }
});

test('sid 守卫：非本 sid 的 upgrade 帧静默忽略', async () => {
  const h = await connectForUpgrade({ iceServers: [{ urls: 'stun:stun.example.com' }] });
  try {
    h.pollRows([{ payload: { type: 'upgrade', sid: 'other-sid' } }]);
    await h.drivePoll();
    await flushMicrotasks();
    assert.equal(h.caps.setConfigurationCalls.length, 0, '非本 sid 不得触达 setConfiguration');
    assert.equal(h.caps.createOfferOpts.length, 1, '只有 connect 首 offer，零额外 pc 调用');
    assert.equal(h.sent.filter((m) => m.msg?.type === 'offer').length, 1, '不得发出任何 restart offer');
  } finally {
    h.restore();
  }
});

test('缺 upgradeIceServers：setConfiguration 回传 opts.iceServers 原表（整体替换防呆，Review Focus #5）', async () => {
  const iceServers: RTCIceServer[] = [{ urls: 'stun:stun.example.com' }];
  const h = await connectForUpgrade({ iceServers });
  try {
    h.pollRows([{ payload: { type: 'upgrade', sid: h.sid } }]);
    await h.drivePoll();
    await flushMicrotasks();
    assert.equal(h.caps.setConfigurationCalls.length, 1);
    assert.equal(h.caps.setConfigurationCalls[0]!.iceServers, iceServers,
      '必须显式回传原表（引用同）——省略会回落空表静默丢 STUN/TURN');
    assert.equal(h.caps.setConfigurationCalls[0]!.iceTransportPolicy, 'all');
  } finally {
    h.restore();
  }
});

test('upgradeIceServersFor：relay → [stun…, stage…]；all → undefined（回传原表）', async () => {
  const { upgradeIceServersFor } = await import('./signaling-web.js');
  const stun: RTCIceServer[] = [{ urls: 'stun:stun.example.com' }];
  const stage: RTCIceServer[] = [{ urls: 'turn:turn.example.com', username: 'u', credential: 'p' }];
  assert.deepEqual(upgradeIceServersFor('relay', stun, stage), [...stun, ...stage], 'relay 暖场段升级翻全量 STUN+TURN');
  assert.equal(upgradeIceServersFor('all', stun, stage), undefined, '非 relay 段回传 opts.iceServers 原表（调用方 ?? 落定）');
});
