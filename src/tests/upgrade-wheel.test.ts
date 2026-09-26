import test from 'node:test';
import assert from 'node:assert/strict';
import { UpgradeWheel } from '../upgradeWheel.js';

test('默认值：warmMs=10s observeMs=15s maxAttempts=2（Safari 宽容窗，spike §2.2-4）', () => {
  const w = new UpgradeWheel();
  assert.equal(w.warmMs, 10_000);
  assert.equal(w.observeMs, 15_000);
  assert.equal(w.maxAttempts, 2);
  assert.equal(w.state, 'warm');
  assert.equal(w.closed, false);
});

test('首连 direct：终态 direct，之后全惰性', () => {
  const w = new UpgradeWheel();
  assert.equal(w.onConnected('direct', 1000), null);
  assert.equal(w.state, 'direct');
  assert.equal(w.onWarmTimeout(11_000), null);
  assert.equal(w.onObserveTimeout(11_000), null);
});

test('relay 暖场 → warmTimeout → send-upgrade（attempt 1）', () => {
  const w = new UpgradeWheel();
  w.onConnected('relay', 1000);
  assert.equal(w.state, 'warm');
  assert.deepEqual(w.onWarmTimeout(11_000), { kind: 'send-upgrade' });
  assert.equal(w.state, 'upgrading');
});

test('warm 期自然转 direct：终态（非轮功不 emit），warmTimeout 不再发帧', () => {
  const w = new UpgradeWheel();
  w.onConnected('relay', 1000);
  w.onConnected('direct', 6000);
  assert.equal(w.state, 'direct');
  assert.equal(w.onWarmTimeout(11_000), null);
  assert.equal(w.onPairType('direct', 12_000), null);
});

test('onConnected 幂等：重复 relay tick 不动作不推进', () => {
  const w = new UpgradeWheel();
  w.onConnected('relay', 1000);
  w.onConnected('relay', 6000);
  assert.equal(w.state, 'warm');
});

test('upgrading 观测到 direct → emit(direct)，ms 自最近 attempt 起', () => {
  const w = new UpgradeWheel();
  w.onConnected('relay', 1000);
  w.onWarmTimeout(11_000);
  assert.deepEqual(w.onPairType('direct', 13_400), { kind: 'emit', from: 'relay', to: 'direct', ms: 2400 });
  assert.equal(w.state, 'direct');
  assert.equal(w.onPairType('relay', 14_000), null, '终态后 tick 惰性');
});

test('upgrading 中 relay tick 返回 null（继续观测，渐近迁移不判死）', () => {
  const w = new UpgradeWheel();
  w.onConnected('relay', 0);
  w.onWarmTimeout(10_000);
  assert.equal(w.onPairType('relay', 20_000), null);
  assert.equal(w.state, 'upgrading');
});

test('观测窗到期：重发至 maxAttempts 后 emit(fallback)', () => {
  const w = new UpgradeWheel({ maxAttempts: 2 });
  w.onConnected('relay', 0);
  w.onWarmTimeout(10_000);                       // attempt 1 @10s
  assert.deepEqual(w.onObserveTimeout(25_000), { kind: 'send-upgrade' }); // attempt 2 @25s
  assert.deepEqual(w.onObserveTimeout(40_000), { kind: 'emit', from: 'relay', to: 'fallback', ms: 15_000 });
  assert.equal(w.state, 'fallback');
  assert.equal(w.onObserveTimeout(55_000), null, '终态后惰性');
});

test('非 upgrading 态的 onPairType/onObserveTimeout 一律 null', () => {
  const w = new UpgradeWheel();
  assert.equal(w.onPairType('direct', 0), null);
  assert.equal(w.onObserveTimeout(0), null);
  w.onConnected('relay', 0);
  assert.equal(w.onObserveTimeout(30_000), null, 'warm 态无观测窗');
});

test('close 后全部方法惰性（dispose 防泄漏语义）', () => {
  const w = new UpgradeWheel();
  w.onConnected('relay', 0);
  w.close();
  assert.equal(w.closed, true);
  assert.equal(w.onWarmTimeout(10_000), null);
  assert.equal(w.onPairType('direct', 10_000), null);
  assert.equal(w.onObserveTimeout(10_000), null);
});

test('未见首连的 warmTimeout 不动作（seam 防呆）', () => {
  const w = new UpgradeWheel();
  assert.equal(w.onWarmTimeout(10_000), null);
});
