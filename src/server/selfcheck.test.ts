/** 自检探针（2026-09-25 真机事故治理：458s 信令黑洞 + localhost :3001 挂起 254s/273s
 *  双症状同时发生却无法区分因果——因为当时没有任何量化留痕。debugging 优先原则：
 *  凡是能快速定位问题的可观测性建设一概必做）。
 *
 *  钉死的语义：
 *  - 每 intervalMs 对 scanner 发现的每个本地服务做 HTTP 级探测（TCP connect 测不出
 *    事件循环停顿——内核 backlog 会代答握手，必须拿到 HTTP 响应才算活着）；
 *  - 任何 HTTP 状态码都算 ok（404/405 也是活进程）；超时/网络错误才算 fail；
 *  - 每目标三态机 ok|slow|fail，只在状态翻转时发 selfcheck_alert（稳态零噪音）；
 *  - 信令面复用 signalingHealth 快照：consecutiveFailures 0↔>0 翻转时发告警；
 *  - 每 heartbeatCycles 周期发一条 selfcheck_heartbeat 紧凑快照（基线对照，防「无事件=健康」歧义）；
 *  - 探针异常逐目标隔离，绝不拖垮循环；stop() 后不再发射。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Logger } from '../log/logger.js';
import { startSelfcheck, type SigSnapshot } from './selfcheck.js';

interface Ev { name: string; data: Record<string, unknown> }

function fakeLogger(): { log: Logger; events: Ev[] } {
  const events: Ev[] = [];
  const noop = () => {};
  return {
    events,
    log: { debug: noop, info: noop, warn: noop, error: noop, flush: noop, event: (name, data) => events.push({ name, data }) },
  };
}

async function until(fn: () => boolean, ms = 5000, what = ''): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function okFetch(delayMs = 0): typeof fetch {
  return (() => new Promise((resolve) => setTimeout(() => resolve(new Response('ok', { status: 200 })), delayMs))) as unknown as typeof fetch;
}

function failFetch(): typeof fetch {
  return (() => Promise.reject(new Error('connect ECONNREFUSED'))) as unknown as typeof fetch;
}

const sigOk: SigSnapshot = { consecutiveFailures: 0, recovering: false, recreated: false, pollsOk: 10, pollsFailed: 0, lastPollMs: 42 };

test('首轮全部健康：无告警，心跳按周期携带目标与信令快照', async () => {
  const { log, events } = fakeLogger();
  const h = startSelfcheck({
    log,
    getServices: () => [{ port: 3001, name: 'ui' }, { port: 19728, name: 'discovery' }],
    signalingHealth: () => sigOk,
    intervalMs: 15,
    heartbeatCycles: 2,
    fetchImpl: okFetch(),
  });
  try {
    await until(() => events.filter((e) => e.name === 'selfcheck_heartbeat').length >= 2, 5000, '应发出至少 2 条心跳');
    assert.equal(events.filter((e) => e.name === 'selfcheck_alert').length, 0, '健康稳态不许有告警');
    const hb = events.find((e) => e.name === 'selfcheck_heartbeat')!;
    const targets = hb.data.targets as Array<{ port: number; ok: boolean; ms: number }>;
    assert.equal(targets.length, 2);
    assert.ok(targets.every((t) => t.ok && typeof t.ms === 'number'));
    const sig = hb.data.sig as SigSnapshot;
    assert.equal(sig.consecutiveFailures, 0);
    assert.equal(sig.lastPollMs, 42);
  } finally {
    h.stop();
  }
});

test('任何 HTTP 状态码都算活（404 不告警），网络错误才算 fail', async () => {
  const { log, events } = fakeLogger();
  const notFound = (() => Promise.resolve(new Response('nf', { status: 404 }))) as unknown as typeof fetch;
  const h = startSelfcheck({
    log,
    getServices: () => [{ port: 3001, name: 'ui' }],
    intervalMs: 15,
    heartbeatCycles: 100, // 本轮不看心跳
    fetchImpl: notFound,
  });
  try {
    await sleep(80);
    assert.equal(events.filter((e) => e.name === 'selfcheck_alert').length, 0, '404 是活进程，不得告警');
  } finally {
    h.stop();
  }
});

test('服务失联 → 一次告警；持续失联不重复；恢复 → 一次恢复告警（翻转语义）', async () => {
  const { log, events } = fakeLogger();
  let up = false;
  const fetchImpl = (() => (up ? Promise.resolve(new Response('ok')) : Promise.reject(new Error('connect ECONNREFUSED')))) as unknown as typeof fetch;
  const h = startSelfcheck({
    log,
    getServices: () => [{ port: 3001, name: 'ui' }],
    intervalMs: 15,
    heartbeatCycles: 100,
    fetchImpl,
  });
  try {
    await until(() => events.some((e) => e.name === 'selfcheck_alert'), 5000, '失联应告警');
    const downAlerts = events.filter((e) => e.name === 'selfcheck_alert');
    assert.equal(downAlerts.length, 1, '持续失联只告警一次');
    assert.equal(downAlerts[0]!.data.ok, false);
    assert.equal(downAlerts[0]!.data.port, 3001);
    assert.equal(typeof downAlerts[0]!.data.err, 'string');
    await sleep(60);
    assert.equal(events.filter((e) => e.name === 'selfcheck_alert').length, 1, '稳态失联不重复告警');
    up = true;
    await until(() => events.filter((e) => e.name === 'selfcheck_alert').length === 2, 5000, '恢复应再告警一次');
    const up2 = events.filter((e) => e.name === 'selfcheck_alert')[1]!;
    assert.equal(up2.data.ok, true);
    assert.equal(typeof up2.data.ms, 'number', '恢复告警携带延迟');
  } finally {
    h.stop();
  }
});

test('慢响应（≥ slowMs）进 slow 态告警一次，恢复常态再告警；延迟进心跳', async () => {
  const { log, events } = fakeLogger();
  let delay = 40;
  const fetchImpl = (() => new Promise((r) => setTimeout(() => r(new Response('ok')), delay))) as unknown as typeof fetch;
  const h = startSelfcheck({
    log,
    getServices: () => [{ port: 3001, name: 'ui' }],
    intervalMs: 15,
    slowMs: 25,
    heartbeatCycles: 100,
    fetchImpl,
  });
  try {
    await until(() => events.some((e) => e.name === 'selfcheck_alert'), 5000, '慢响应应告警');
    const a1 = events.filter((e) => e.name === 'selfcheck_alert')[0]!;
    assert.equal(a1.data.state, 'slow');
    assert.ok((a1.data.ms as number) >= 25);
    await sleep(60);
    assert.equal(events.filter((e) => e.name === 'selfcheck_alert').length, 1, '持续慢不重复告警');
    delay = 0;
    await until(() => events.filter((e) => e.name === 'selfcheck_alert').length === 2, 5000, '恢复常速应告警');
    assert.equal(events.filter((e) => e.name === 'selfcheck_alert')[1]!.data.state, 'ok');
  } finally {
    h.stop();
  }
});

test('信令失败开始/恢复各告警一次；心跳携带 sig 快照', async () => {
  const { log, events } = fakeLogger();
  let sig: SigSnapshot = sigOk;
  const h = startSelfcheck({
    log,
    getServices: () => [],
    signalingHealth: () => sig,
    intervalMs: 15,
    heartbeatCycles: 2,
    fetchImpl: okFetch(),
  });
  try {
    sig = { consecutiveFailures: 3, recovering: true, recreated: false, pollsOk: 10, pollsFailed: 3, lastError: 'signaling poll failed: 401' };
    await until(() => events.some((e) => e.name === 'selfcheck_alert' && e.data.target === 'signaling'), 5000, '信令失败应告警');
    const a = events.find((e) => e.name === 'selfcheck_alert' && e.data.target === 'signaling')!;
    assert.equal(a.data.ok, false);
    assert.equal(a.data.err, 'signaling poll failed: 401');
    sig = sigOk;
    await until(() => events.filter((e) => e.name === 'selfcheck_alert' && e.data.target === 'signaling').length === 2, 5000, '信令恢复应告警');
    const hb = events.filter((e) => e.name === 'selfcheck_heartbeat').at(-1)!;
    assert.deepEqual(hb.data.sig, { consecutiveFailures: 0, recovering: false, recreated: false, pollsOk: 10, pollsFailed: 0, lastPollMs: 42 });
  } finally {
    h.stop();
  }
});

test('单目标探针抛异常被隔离，循环与其他目标不受影响', async () => {
  const { log, events } = fakeLogger();
  const fetchImpl = ((input: unknown) => {
    const url = String(input);
    if (url.includes(':3001')) throw new Error('sync boom');
    return Promise.resolve(new Response('ok'));
  }) as unknown as typeof fetch;
  const h = startSelfcheck({
    log,
    getServices: () => [{ port: 3001, name: 'ui' }, { port: 19728, name: 'discovery' }],
    intervalMs: 15,
    heartbeatCycles: 1,
    fetchImpl,
  });
  try {
    await until(() => events.some((e) => e.name === 'selfcheck_heartbeat'), 5000, '心跳不受单目标异常影响');
    const hb = events.find((e) => e.name === 'selfcheck_heartbeat')!;
    const targets = hb.data.targets as Array<{ port: number; ok: boolean }>;
    assert.equal(targets.find((t) => t.port === 3001)!.ok, false);
    assert.equal(targets.find((t) => t.port === 19728)!.ok, true);
  } finally {
    h.stop();
  }
});

test('stop() 后不再发射任何事件', async () => {
  const { log, events } = fakeLogger();
  const h = startSelfcheck({
    log,
    getServices: () => [{ port: 3001, name: 'ui' }],
    intervalMs: 10,
    heartbeatCycles: 1,
    fetchImpl: okFetch(),
  });
  await until(() => events.some((e) => e.name === 'selfcheck_heartbeat'), 5000, 'stop 前应有心跳');
  h.stop();
  const n = events.length;
  await sleep(60);
  assert.equal(events.length, n, 'stop 后零发射');
});
