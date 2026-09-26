/**
 * W2-6 暖场升级轮 × host 集成（Task 3）：
 * PeerSession 挂轮 + 状态 tick 驱动 + upgrade 帧纪律（恰 {type,sid,from} 三键）
 * + 重协商原位应答路由（upgrading 中同 from offer 不换绑/不动账本/不发 session 事件）。
 *
 * harness 镜像 host.integration.test.ts（内存信令 stub + 私有面结构铸造触达，
 * 先例见 signaling-watchdog.test.ts）；stub pc 镜像 peer.test.ts（pcFactory 缝）。
 * 定时用真实短毫秒（warmMs=20 observeMs=30）+ 宽余 sleep，禁用假定时器库。
 * 全程 stub/假 SDP——零监听端口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HostAgent, PeerSession, type HostAgentOptions, type HostStatus } from '../host.js';
import { Peer, type LinkStatus, type PcLike } from '../peer.js';
import { UpgradeWheel } from '../upgradeWheel.js';
import { roomFor, type IceCandidateLike, type SdpLike, type SigMessage } from '../signaling/protocol.js';
import type { PollResult } from '../signaling/client.js';

// ---- 内存信令 stub（SignalingClientLike；sent() 留痕供帧断言）----

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
    return { msgs: rows, cursor: rows.length ? rows[rows.length - 1]!.id : cursor };
  }

  async purgeExpired(): Promise<void> {}

  /** 某房间已发帧（发送序）。 */
  sent(room: string): SigMessage[] {
    return (this.boxes.get(room) ?? []).map((r) => r.payload);
  }
}

// ---- stub pc（镜像 peer.test.ts：werift 真实 pc 不进本套件，零端口）----

interface StubCalls {
  closeCount: number;
  addedIce: IceCandidateLike[];
  remoteDescriptions: SdpLike[];
}

function makeStubPc(): { pc: PcLike; calls: StubCalls } {
  const calls: StubCalls = { closeCount: 0, addedIce: [], remoteDescriptions: [] };
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
      void opts;
      return { label } as unknown as ReturnType<PcLike['createDataChannel']>;
    },
    async getStats() { return new Map() as never; },
    close() { calls.closeCount++; },
  };
  return { pc, calls };
}

// ---- 共享常量与探针 ----

const UID = 'u-wheel';
const HOST = 'desk-wheel';
/** 测试节拍：真实短毫秒（生产缺省 10s/15s 由 upgrade-wheel.test.ts 钉）。 */
const WHEEL = { warmMs: 20, observeMs: 30 };

type UpgradeEvent = { sid: string; from: 'relay'; to: 'direct' | 'fallback'; ms: number };

async function until(fn: () => boolean, ms = 2000, what = ''): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 私有面触达（结构铸造先例：host.integration.test.ts / signaling-watchdog.test.ts）。 */
function reach(agent: HostAgent): {
  onSignal: (m: unknown) => Promise<void>;
  sessions: Map<string, PeerSession>;
  onSessionStatus: (k: string, s: PeerSession, st: LinkStatus) => void;
} {
  return agent as unknown as {
    onSignal: (m: unknown) => Promise<void>;
    sessions: Map<string, PeerSession>;
    onSessionStatus: (k: string, s: PeerSession, st: LinkStatus) => void;
  };
}

function mkAgent(over: {
  sig: MemSignaling;
  statuses?: HostStatus[];
  upgrades?: UpgradeEvent[];
  upgradeWheel?: HostAgentOptions['upgradeWheel'];
}): HostAgent {
  return new HostAgent({
    supabaseUrl: 'http://unused.invalid',
    publishableKey: 'pk',
    accessToken: () => null,
    deviceId: HOST,
    uid: UID,
    turnFetcher: async () => ({ iceServers: [] }),
    signaling: over.sig,
    pollMs: 30,
    ...(over.statuses ? { onStatus: (s: HostStatus) => over.statuses!.push(s) } : {}),
    ...(over.upgrades ? { onUpgrade: (e: UpgradeEvent) => over.upgrades!.push(e) } : {}),
    ...(over.upgradeWheel ? { upgradeWheel: over.upgradeWheel } : {}),
  });
}

/** bogus offer 入表（acceptOffer 失败但会话已登记——镜像 seedBogusSession），返回会话对象。 */
async function seedOffer(agent: HostAgent, key: string, sid = 's1'): Promise<PeerSession> {
  await reach(agent)
    .onSignal({ type: 'offer', sid, from: key, sdp: { type: 'offer', sdp: 'v=0 bogus' } })
    .catch(() => {});
  const s = reach(agent).sessions.get(key);
  assert.ok(s, 'bogus offer 后会话应已入表');
  return s;
}

/** 直驱会话状态回调（等同 Peer 上报的状态 tick，绕过 ICE——测的是轮驱动不是网络）。 */
function driveStatus(agent: HostAgent, key: string, s: PeerSession, st: LinkStatus): void {
  reach(agent).onSessionStatus(key, s, st);
}

/** 会话清理（未 start 的 agent.stop() 早退，这里逐会话 dispose——计时器防漏收尾）。 */
function disposeAll(agent: HostAgent): void {
  const sessions = reach(agent).sessions;
  for (const s of sessions.values()) s.dispose();
  sessions.clear();
}

/** 发进某客户端房间的 upgrade 帧序列。 */
function upgradeFrames(sig: MemSignaling, key: string): SigMessage[] {
  return sig.sent(roomFor(UID, key)).filter((m) => m.type === 'upgrade');
}

// ---- (a) 门控 ----

test('(a) 门控缺省开：offer 后 session 挂 wheel + 存 sid', async () => {
  const sig = new MemSignaling();
  const agent = mkAgent({ sig }); // 缺省：无 upgradeWheel 配置 → 开
  try {
    const s = await seedOffer(agent, 'phone-a');
    assert.equal(s.sid, 's1', 'offer 的 sid 必须落会话（upgrade 帧回路由 PWA 的唯一凭据）');
    const w = s.wheel;
    assert.ok(w instanceof UpgradeWheel, '缺省门控开：offer 后应挂升级轮');
    assert.equal(w.state, 'warm', '新挂的轮从 warm 起步');
  } finally {
    disposeAll(agent);
  }
});

test('(a) 门控 enabled:false → 不挂轮、不驱动（零帧零 emit）', async () => {
  const sig = new MemSignaling();
  const upgrades: UpgradeEvent[] = [];
  const agent = mkAgent({ sig, upgrades, upgradeWheel: { enabled: false, ...WHEEL } });
  const KEY = 'phone-aoff';
  try {
    const s = await seedOffer(agent, KEY);
    assert.equal(s.sid, 's1', '门控关只摘轮，sid 照存');
    assert.equal(s.wheel, undefined, 'enabled:false 全关：不得挂轮');
    driveStatus(agent, KEY, s, { state: 'connected', pairType: 'relay' });
    await sleep(80); // 远超 warmMs+observeMs
    assert.equal(upgradeFrames(sig, KEY).length, 0, '无轮不得出 upgrade 帧');
    assert.equal(upgrades.length, 0, '无轮不得 emit 终态');
  } finally {
    disposeAll(agent);
  }
});

// ---- (b) 暖场流 ----

test('(b) 暖场：relay 首连过 warmMs → upgrade 帧入客户端房间（恰 {type,sid,from} 三键）', async () => {
  const sig = new MemSignaling();
  const agent = mkAgent({ sig, upgradeWheel: WHEEL });
  const KEY = 'phone-b';
  try {
    const s = await seedOffer(agent, KEY);
    driveStatus(agent, KEY, s, { state: 'connected', pairType: 'relay' });
    await until(() => upgradeFrames(sig, KEY).length >= 1, 2000, '过 warmMs 应出首帧（attempt 1）');
    const f = upgradeFrames(sig, KEY)[0]!;
    assert.deepEqual(Object.keys(f).sort(), ['from', 'sid', 'type'], '帧纪律：恰三键，绝无 token/URL/地址');
    assert.equal(f.type, 'upgrade');
    assert.equal(f.sid, 's1');
    assert.equal(f.from, HOST);
    assert.equal(s.wheel!.state, 'upgrading', '首帧发出后轮进 upgrading');
  } finally {
    disposeAll(agent);
  }
});

// ---- (c) 升级成功 ----

test('(c) 升级成功：upgrading 观测窗见 direct → onUpgrade 终态 + 定时器全清（无第二帧）', async () => {
  const sig = new MemSignaling();
  const upgrades: UpgradeEvent[] = [];
  const agent = mkAgent({ sig, upgrades, upgradeWheel: WHEEL });
  const KEY = 'phone-c';
  try {
    const s = await seedOffer(agent, KEY);
    driveStatus(agent, KEY, s, { state: 'connected', pairType: 'relay' });
    await until(() => upgradeFrames(sig, KEY).length >= 1, 2000, '首帧');
    driveStatus(agent, KEY, s, { state: 'connected', pairType: 'p2p' }); // 观测窗内见 direct
    await until(() => upgrades.length >= 1, 2000, '见 direct 应 emit 终态');
    const e = upgrades[0]!;
    assert.deepEqual(Object.keys(e).sort(), ['from', 'ms', 'sid', 'to'], '终态事件恰四键（绝无地址）');
    assert.equal(e.sid, KEY, 'onUpgrade.sid = 客户端 deviceId（与 session_start 同键供 join）');
    assert.equal(e.from, 'relay');
    assert.equal(e.to, 'direct');
    assert.ok(e.ms >= 0, 'ms 为驻留时长，非负');
    await sleep(80); // 远超 2×observeMs：终态后定时器已清
    assert.equal(upgradeFrames(sig, KEY).length, 1, '终态后不得再发 upgrade 帧');
    assert.equal(upgrades.length, 1, '终态只 emit 一次');
  } finally {
    disposeAll(agent);
  }
});

// ---- (d) 观测窗重试→回退 ----

test('(d) 观测窗重试→回退：保持 relay → 第二帧（attempt 2）→ fallback 终态，之后无第三帧', async () => {
  const sig = new MemSignaling();
  const upgrades: UpgradeEvent[] = [];
  const agent = mkAgent({ sig, upgrades, upgradeWheel: WHEEL });
  const KEY = 'phone-d';
  try {
    const s = await seedOffer(agent, KEY);
    driveStatus(agent, KEY, s, { state: 'connected', pairType: 'relay' });
    await until(() => upgradeFrames(sig, KEY).length >= 1, 2000, '首帧（attempt 1）');
    await until(() => upgradeFrames(sig, KEY).length >= 2, 2000, '观测窗保持 relay 应重发（attempt 2）');
    const f2 = upgradeFrames(sig, KEY)[1]!;
    assert.deepEqual(Object.keys(f2).sort(), ['from', 'sid', 'type'], '重发帧同样守三键纪律');
    assert.equal(f2.sid, 's1');
    await until(() => upgrades.length >= 1, 2000, '次数用尽应 fallback 终态');
    const e = upgrades[0]!;
    assert.equal(e.sid, KEY);
    assert.equal(e.from, 'relay');
    assert.equal(e.to, 'fallback');
    assert.ok(e.ms >= 0);
    assert.equal(s.wheel!.state, 'fallback');
    await sleep(80); // 再过观测窗：次数用尽，无第三帧、无二次 emit
    assert.equal(upgradeFrames(sig, KEY).length, 2, 'maxAttempts=2 用尽后不得有第三帧');
    assert.equal(upgrades.length, 1);
  } finally {
    disposeAll(agent);
  }
});

// ---- (e) 重协商路由 ----

test('(e) 重协商：upgrading 中同 from 再 offer（同 sid）→ 原位应答（不换绑/不拆 PC/无 replaced/出新 answer）', async () => {
  const sig = new MemSignaling();
  const statuses: HostStatus[] = [];
  const agent = mkAgent({ sig, statuses, upgradeWheel: WHEEL });
  const KEY = 'phone-e';
  const { pc: stubPc, calls } = makeStubPc();
  const stubPeer = new Peer([], { pcFactory: () => stubPc });
  // PeerSession 第三参缝注入 stub peer（生产 ctor 恒缺省 real Peer——此缝专供测试，
  // 先例：同文件 sessionGraceMs 测试缝）。会话手工入表，轮驱动仍全走生产路径。
  const session = new PeerSession(undefined, undefined, stubPeer);
  session.sid = 's1';
  session.wheel = new UpgradeWheel(WHEEL);
  reach(agent).sessions.set(KEY, session);
  try {
    // 首连已建（初始 offer 已应答：stub 咽第一次）
    await session.peer.acceptOffer('s1', { type: 'offer', sdp: 'v=0 initial' }, {
      onChannel: () => {},
      onIce: () => {},
      onStatus: () => {},
    });
    assert.equal(calls.remoteDescriptions.length, 1);
    // 生产路径驱动进 upgrading（暖场首帧已发）
    driveStatus(agent, KEY, session, { state: 'connected', pairType: 'relay' });
    await until(() => upgradeFrames(sig, KEY).length >= 1, 2000, '暖场首帧');
    assert.equal(session.wheel!.state, 'upgrading');
    const closesBefore = calls.closeCount;
    // PWA 收 upgrade 帧后 ICE restart 重协商：同 from、**同 sid**（裁决：PWA 轮询守卫 m.sid!==this.sid
    // 与 host session.sid 都要求会话 sid 不变）、新 SDP 的 offer 行注入。
    await reach(agent).onSignal({ type: 'offer', sid: 's1', from: KEY, sdp: { type: 'offer', sdp: 'v=0 restart' } });
    assert.equal(reach(agent).sessions.get(KEY), session, '重协商不得换绑：sessions 表仍是同一对象');
    assert.equal(calls.closeCount, closesBefore, '原位应答不得拆 PC——closeCount 纹丝不动（数据面存续）');
    assert.equal(calls.remoteDescriptions.length, 2, '同一 stubPc 实例原位再咽一次 restart SDP');
    assert.equal(statuses.filter((x) => x.endReason === 'replaced').length, 0, '重协商不得发 replaced 终态帧');
    const answers = sig.sent(roomFor(UID, KEY)).filter((m) => m.type === 'answer');
    assert.equal(answers.length, 1, '重协商必须出列恰好一份新 answer');
    assert.equal(answers[0]!.sid, 's1', 'answer 随会话 sid 回路由');
    assert.deepEqual(answers[0]!.sdp, { type: 'answer', sdp: 'v=0 stub' }, 'answer 取自重协商后 localDescription');
    assert.equal(agent.sessionCount, 1, '不新建不摘除：会话数不变');
  } finally {
    disposeAll(agent);
  }
});

// ---- (f) 换绑保全 ----

test('(f) 换绑保全：warm 期（非 upgrading）同 from 再 offer → 旧换绑路径逐字保留', async () => {
  const sig = new MemSignaling();
  const statuses: HostStatus[] = [];
  const agent = mkAgent({ sig, statuses, upgradeWheel: WHEEL });
  const KEY = 'phone-f';
  try {
    const first = await seedOffer(agent, KEY, 's1');
    assert.equal(first.wheel!.state, 'warm', '未驱动状态 tick：轮仍在 warm（非 upgrading）');
    await reach(agent)
      .onSignal({ type: 'offer', sid: 's2', from: KEY, sdp: { type: 'offer', sdp: 'v=0 bogus' } })
      .catch(() => {});
    const terms = statuses.filter((x) => x.endReason === 'replaced');
    assert.equal(terms.length, 1, 'warm 期重 offer 必须走旧换绑：恰好一次 replaced 终态帧');
    assert.equal(terms[0]!.state, 'closed');
    assert.equal(terms[0]!.clientKey, KEY);
    const second = reach(agent).sessions.get(KEY);
    assert.ok(second);
    assert.notEqual(second, first, '换绑必须是新 PeerSession');
    assert.equal(second!.sid, 's2', '新会话存新 sid');
    assert.ok(second!.wheel, '新会话同样挂轮');
    assert.equal(agent.sessionCount, 1);
    assert.equal(upgradeFrames(sig, KEY).length, 0, '旧换绑路径不发 upgrade 帧');
  } finally {
    disposeAll(agent);
  }
});

// ---- (g) dispose 防漏 ----

test('(g) dispose 防漏：upgrading 中途 closed → 双计时器清 + 轮 close（无帧无 emit）', async () => {
  const sig = new MemSignaling();
  const upgrades: UpgradeEvent[] = [];
  const agent = mkAgent({ sig, upgrades, upgradeWheel: WHEEL });
  const KEY = 'phone-g';
  try {
    const s = await seedOffer(agent, KEY);
    driveStatus(agent, KEY, s, { state: 'connected', pairType: 'relay' });
    await until(() => upgradeFrames(sig, KEY).length >= 1, 2000, '首帧后处 upgrading（观测计时在臂）');
    assert.equal(s.wheel!.state, 'upgrading');
    driveStatus(agent, KEY, s, { state: 'closed', pairType: null }); // 显式关闭 → dropSession → dispose
    assert.equal(agent.sessionCount, 0, '显式 closed 立即摘除');
    assert.equal(s.wheel!.closed, true, 'dispose 必须 close 升级轮');
    await sleep(100); // 远超 2×observeMs：观测计时若未清会再发帧/emit
    assert.equal(upgradeFrames(sig, KEY).length, 1, 'dispose 后不得再发 upgrade 帧');
    assert.equal(upgrades.length, 0, 'dispose 后不得 emit 终态');
  } finally {
    disposeAll(agent);
  }
});

// ---- (h) 首连 direct ----

test('(h) 首连 direct：无升级必要 —— 永不出 upgrade 帧、永不 emit', async () => {
  const sig = new MemSignaling();
  const upgrades: UpgradeEvent[] = [];
  const agent = mkAgent({ sig, upgrades, upgradeWheel: WHEEL });
  const KEY = 'phone-h';
  try {
    const s = await seedOffer(agent, KEY);
    driveStatus(agent, KEY, s, { state: 'connected', pairType: 'p2p' });
    assert.equal(s.wheel!.state, 'direct', '首连 direct 直接终态');
    await sleep(80); // 远超 warmMs+observeMs
    assert.equal(upgradeFrames(sig, KEY).length, 0, '首连 direct 不出 upgrade 帧');
    assert.equal(upgrades.length, 0);
    // 终态幂等护栏：后续 relay tick 不得复活发车
    driveStatus(agent, KEY, s, { state: 'connected', pairType: 'relay' });
    await sleep(80);
    assert.equal(upgradeFrames(sig, KEY).length, 0, '首连已定 direct：后续 tick 不得发车');
    assert.equal(upgrades.length, 0);
  } finally {
    disposeAll(agent);
  }
});
