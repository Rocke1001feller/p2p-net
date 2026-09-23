import test from 'node:test';
import assert from 'node:assert/strict';
import { planStageModes } from './cascadePlan.js';

test('默认级联：p2p 直连 → 隧道 → TURN 中继', () => {
  assert.deepEqual(planStageModes({}), ['p2p', 'tunnel', 'turn']);
});

test('transport=relay（forceTurn）：只跑 TURN 段——不得含隧道段', () => {
  // 真机实证：forceTurn 仍保留 tunnel 段，中继修复验收时永远落在隧道，测不到 DC 数据面
  assert.deepEqual(planStageModes({ forceTurn: true }), ['turn']);
});

test('tunnel=1（forceTunnel）：只跑隧道段', () => {
  assert.deepEqual(planStageModes({ forceTunnel: true }), ['tunnel']);
});

test('forceTurn 与 p2pFullIce 同给：仍只跑 TURN 段', () => {
  assert.deepEqual(planStageModes({ forceTurn: true, p2pFullIce: true }), ['turn']);
});
