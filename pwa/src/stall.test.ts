import test from 'node:test';
import assert from 'node:assert/strict';
import { stallSuspect } from './stall.js';

test('三条件全真才亮：ctrlAlive ∧ inFlight>0 ∧ silentMs>阈值', () => {
  assert.equal(stallSuspect({ ctrlAlive: true, inFlight: 3, silentMs: 6_000 }), true);
  assert.equal(stallSuspect({ ctrlAlive: false, inFlight: 3, silentMs: 6_000 }), false); // tunnel/链路死：不归 stall
  assert.equal(stallSuspect({ ctrlAlive: true, inFlight: 0, silentMs: 60_000 }), false); // 空闲链路永不亮
  assert.equal(stallSuspect({ ctrlAlive: true, inFlight: 1, silentMs: 4_999 }), false); // 阈值内（慢但未疑）
  assert.equal(stallSuspect({ ctrlAlive: true, inFlight: 1, silentMs: 5_001 }), true);
});

test('thresholdMs 可覆盖（真机标定）；默认 5s', () => {
  assert.equal(stallSuspect({ ctrlAlive: true, inFlight: 1, silentMs: 2_000, thresholdMs: 1_000 }), true);
  assert.equal(stallSuspect({ ctrlAlive: true, inFlight: 1, silentMs: 6_000, thresholdMs: 10_000 }), false);
});
