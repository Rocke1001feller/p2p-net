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

// ---- 记忆化重级联（2026-09-26 用户裁决：长服务不粘中继；隧道上次成功则先行） ----

test('lastMode=tunnel：隧道段提到最前（跳过 10s p2p 白等）', () => {
  assert.deepEqual(planStageModes({}, 'tunnel'), ['tunnel', 'p2p', 'turn']);
});

test('lastMode=p2p：维持原序（p2p 上次成功，值得先赌）', () => {
  assert.deepEqual(planStageModes({}, 'p2p'), ['p2p', 'tunnel', 'turn']);
});

test('lastMode=turn/null/undefined：维持原序（中继记忆不值钱）', () => {
  assert.deepEqual(planStageModes({}, 'turn'), ['p2p', 'tunnel', 'turn']);
  assert.deepEqual(planStageModes({}, null), ['p2p', 'tunnel', 'turn']);
  assert.deepEqual(planStageModes({}), ['p2p', 'tunnel', 'turn']);
});

test('dev 覆盖压过记忆化：forceTurn/forceTunnel 不受 lastMode 影响', () => {
  assert.deepEqual(planStageModes({ forceTurn: true }, 'tunnel'), ['turn']);
  assert.deepEqual(planStageModes({ forceTunnel: true }, 'tunnel'), ['tunnel']);
});
