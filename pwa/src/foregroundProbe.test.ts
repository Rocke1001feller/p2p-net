import test from 'node:test';
import assert from 'node:assert/strict';
import { ForegroundProbe, shouldProbeOnForeground } from './foregroundProbe.js';

// 2026-09-25 实测：浏览器后台数小时后回前台，host 隧道腿已被静默回收（网关 502），
// 但 PWA 数据面逐请求无状态——没流量就没失败，徽章停在旧绿灯，四大功能静默全灭。

test('触发条件：有会话 ∧ 后台超阈（默认 60s）才探', () => {
  assert.equal(shouldProbeOnForeground({ hiddenForMs: 61_000, bfcacheRestore: false, sessionActive: true }), true);
  assert.equal(shouldProbeOnForeground({ hiddenForMs: 59_999, bfcacheRestore: false, sessionActive: true }), false); // 阈值内：短暂切后台不探
  assert.equal(shouldProbeOnForeground({ hiddenForMs: 3_600_000, bfcacheRestore: false, sessionActive: false }), false); // 无会话：重连退避循环负责
  assert.equal(shouldProbeOnForeground({ hiddenForMs: null, bfcacheRestore: false, sessionActive: true }), false); // 未记录 hidden 不乱探
});

test('bfcache 恢复无论时长必探（冻结期心跳/看门狗停走，活性证据皆陈旧）；无会话仍不探', () => {
  assert.equal(shouldProbeOnForeground({ hiddenForMs: 3_000, bfcacheRestore: true, sessionActive: true }), true);
  assert.equal(shouldProbeOnForeground({ hiddenForMs: null, bfcacheRestore: true, sessionActive: true }), true);
  assert.equal(shouldProbeOnForeground({ hiddenForMs: null, bfcacheRestore: true, sessionActive: false }), false);
});

test('thresholdMs 可覆盖（真机标定）；默认 60s', () => {
  assert.equal(shouldProbeOnForeground({ hiddenForMs: 6_000, bfcacheRestore: false, sessionActive: true, thresholdMs: 5_000 }), true);
  assert.equal(shouldProbeOnForeground({ hiddenForMs: 61_000, bfcacheRestore: false, sessionActive: true, thresholdMs: 120_000 }), false);
});

function harness(probeResults: boolean[]) {
  const downs: boolean[] = [];
  let calls = 0;
  const probe = new ForegroundProbe({
    sessionActive: () => true,
    probe: async () => probeResults[Math.min(calls++, probeResults.length - 1)],
    setDown: (on) => downs.push(on),
  });
  return { probe, downs, calls: () => calls };
}

test('状态迁移：探活失败 → 先中性后黄灯（probing 不动徽章，fail 才亮）', async () => {
  const { probe, downs } = harness([false]);
  assert.equal(await probe.onForeground(61_000, false), true);
  assert.deepEqual(downs, [false, true]);
});

test('状态迁移：探活成功 → 中性收尾（不亮黄灯，恢复原状态）', async () => {
  const { probe, downs } = harness([true]);
  assert.equal(await probe.onForeground(61_000, false), true);
  assert.deepEqual(downs, [false, false]);
});

test('去抖防重入：pageshow 与 visibilitychange 连发只探一次', async () => {
  const { probe, calls } = harness([true]);
  const [a, b] = await Promise.all([probe.onForeground(61_000, false), probe.onForeground(61_000, true)]);
  assert.equal(a, true);
  assert.equal(b, false);
  assert.equal(calls(), 1);
});

test('黄灯点击重试：跳过阈值判定直接再探；失败再亮灯、成功熄灭', async () => {
  const { probe, downs, calls } = harness([false, false, true]);
  await probe.onForeground(61_000, false); // 失败 → 黄灯
  await probe.retry();                     // 重试仍失败 → 先中性再回黄灯
  await probe.retry();                     // host 已恢复 → 成功熄灭
  assert.deepEqual(downs, [false, true, false, true, false, false]);
  assert.equal(calls(), 3);
});

test('判定不触发时一发都不探（阈值内/无会话），徽章零打扰', async () => {
  let active = false;
  const downs: boolean[] = [];
  let calls = 0;
  const probe = new ForegroundProbe({
    sessionActive: () => active,
    probe: async () => { calls++; return true; },
    setDown: (on) => downs.push(on),
  });
  active = true;
  assert.equal(await probe.onForeground(30_000, false), false); // 阈值内
  active = false;
  assert.equal(await probe.onForeground(61_000, false), false); // 无会话
  assert.equal(await probe.retry(), false);                     // 无会话重试也守卫
  assert.equal(calls, 0);
  assert.deepEqual(downs, []);
});
