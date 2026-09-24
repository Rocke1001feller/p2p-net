import test from 'node:test';
import assert from 'node:assert/strict';
import { attachConsentWatchdog, consentExpired, reviveConsent, type IceTransportLike } from '../consent-watchdog.js';
import { Peer } from '../peer.js';

test('consentExpired 真值表（含 everEstablished 闩锁语义）', () => {
  assert.equal(consentExpired(null, true), false);
  assert.equal(consentExpired(undefined, true), false);
  // failed 恒算死：werift 全文件唯一置 failed 的路径就是 consent 到期（ice.js:316）
  assert.equal(consentExpired({ state: 'failed' }, false), true);
  // closed 不算死（正常关闭）
  assert.equal(consentExpired({ state: 'closed', consentFresh: false }, true), false);
  // 建链中途的 consentFresh=false 是「尚未新鲜」不是「已过期」（公网现场 11 次误报的教训）
  assert.equal(consentExpired({ state: 'connected', consentFresh: false }, false), false);
  // 建立之后掉新鲜 = 黑洞
  assert.equal(consentExpired({ state: 'connected', consentFresh: false }, true), true);
  assert.equal(consentExpired({ state: 'connected', consentFresh: true }, true), false);
});

test('reviveConsent 顺序契约：先 setState(connected) 再 queryConsent；非 failed 不 setState', () => {
  const calls: string[] = [];
  const ice: IceTransportLike = {
    state: 'failed',
    setState(s) { calls.push(`setState:${s}`); this.state = s; },
    queryConsent() { calls.push('queryConsent'); },
  };
  assert.equal(reviveConsent(ice), true);
  assert.deepEqual(calls, ['setState:connected', 'queryConsent']);

  const calls2: string[] = [];
  const ice2: IceTransportLike = { state: 'connected', setState(s) { calls2.push(`setState:${s}`); }, queryConsent() { calls2.push('queryConsent'); } };
  assert.equal(reviveConsent(ice2), true);
  assert.deepEqual(calls2, ['queryConsent']);

  assert.equal(reviveConsent(null), false);
  assert.equal(reviveConsent({}), false); // 无 queryConsent 方法：特性检测拒绝
});

test('看门狗：consent 死→revive；上限到→give-up；无 iceTransports 零副作用（Review Focus #2）', async () => {
  // 无 iceTransports（非 werift 实现 / stub pc）：30ms 内零事件零副作用
  const ev0: string[] = [];
  const d0 = attachConsentWatchdog({}, { intervalMs: 5, onEvent: (e) => ev0.push(e.kind) });
  await new Promise((r) => setTimeout(r, 30));
  d0();
  assert.deepEqual(ev0, []);

  // 必死链路（revive 救不回：consentFresh 恒 false），maxRevives=2 → revive,revive,give-up
  const ice: IceTransportLike = {
    state: 'connected', consentFresh: false,
    setState(s) { this.state = s; },
    queryConsent() { /* 对端真死：救不回 */ },
  };
  const evs: { kind: string; revives: number }[] = [];
  const d1 = attachConsentWatchdog({ iceTransports: [{ connection: ice }] }, {
    intervalMs: 5, maxRevives: 2, healthyResetMs: 1_000_000,
    onEvent: (e) => evs.push({ kind: e.kind, revives: e.revives }),
  });
  await new Promise((r) => setTimeout(r, 60));
  d1();
  assert.deepEqual(evs.map((e) => e.kind), ['revive', 'revive', 'give-up']);
  assert.deepEqual(evs.map((e) => e.revives), [1, 2, 2]);
});

test('healthyResetMs 闩锁：复活后持续健康未超窗不归零（病态链路不被无限复活）', async () => {
  const ice: IceTransportLike = {
    state: 'connected', consentFresh: true,
    setState(s) { this.state = s; },
    queryConsent() { this.consentFresh = true; },
  };
  const revives: number[] = [];
  const d = attachConsentWatchdog({ iceTransports: [{ connection: ice }] }, {
    intervalMs: 5, maxRevives: 99, healthyResetMs: 1_000,
    onEvent: (e) => { if (e.kind === 'revive') revives.push(e.revives); },
  });
  // 每 ~15ms 杀一次 consent（模拟 30s 周期的病态链路）；healthyResetMs=1s 窗口内 revives 只增不减
  const killer = setInterval(() => { ice.consentFresh = false; }, 15);
  await new Promise((r) => setTimeout(r, 100));
  clearInterval(killer); d();
  assert.ok(revives.length >= 2, `样本不足：${revives.join(',')}`);
  for (let i = 1; i < revives.length; i++) assert.ok(revives[i] > revives[i - 1], `revives 被重置：${revives.join(',')}`);
});

test('Peer 接线：建 pc 即挂看门狗；give-up 上报 failed（走宽限/终态链路）', async () => {
  const mkPc = () => ({
    connectionState: 'connected' as const,
    localDescription: null,
    ondatachannel: null, onicecandidate: null, oniceconnectionstatechange: null, onconnectionstatechange: null,
    async setRemoteDescription() {}, async setLocalDescription() {},
    async createOffer() { return { type: 'offer', sdp: '' }; },
    async createAnswer() { return { type: 'answer', sdp: '' }; },
    async addIceCandidate() {},
    createDataChannel() { return { readyState: 'open', send() {}, close() {} }; },
    async getStats() { return new Map(); },
    close() { (this as any).connectionState = 'closed'; },
    // 必死 ice：consentFresh 恒 false
    iceTransports: [{ connection: { state: 'connected', consentFresh: false, setState(s: string) { (this as any).state = s; }, queryConsent() {} } }],
  });
  const peer = new Peer([], { pcFactory: mkPc as any, consent: { intervalMs: 5, maxRevives: 1, healthyResetMs: 1_000_000 } });
  const statuses: string[] = [];
  await peer.acceptOffer('s1', { type: 'offer', sdp: '' }, {
    onChannel: () => {}, onIce: () => {}, onStatus: (s) => statuses.push(s.state),
  });
  await new Promise((r) => setTimeout(r, 60));
  peer.close();
  assert.ok(statuses.includes('failed'), `give-up 未上报 failed：${statuses.join(',')}`);
});
