import test from 'node:test';
import assert from 'node:assert/strict';
import { bootGateDecision, dataPlaneAlive, healthDecision } from './workbenchRecovery.js';

test('dataPlaneAlive：上游真实应答（200/404/405/301）都算活', () => {
  for (const s of [200, 301, 302, 400, 401, 403, 404, 405, 500]) {
    assert.equal(dataPlaneAlive(s), true, `status ${s} 应判活（回帧路径活着）`);
  }
});

test('dataPlaneAlive：合成失败（502 网关 / 503 SW 快败 / 504 超时）算死', () => {
  for (const s of [502, 503, 504]) {
    assert.equal(dataPlaneAlive(s), false, `status ${s} 应判死`);
  }
});

test('bootGateDecision：探活活→boot；死→defer；defer 超限→giveup', () => {
  assert.equal(bootGateDecision({ dataPlaneReady: true, deferCount: 0 }), 'boot');
  assert.equal(bootGateDecision({ dataPlaneReady: true, deferCount: 99 }), 'boot');
  assert.equal(bootGateDecision({ dataPlaneReady: false, deferCount: 0 }), 'defer');
  assert.equal(bootGateDecision({ dataPlaneReady: false, deferCount: 2 }), 'defer');
  assert.equal(bootGateDecision({ dataPlaneReady: false, deferCount: 3 }), 'giveup');
});

test('healthDecision：已 boot→ok；未 boot 重载未超限→reload；超限→giveup', () => {
  assert.equal(healthDecision({ booted: true, reloadCount: 0 }), 'ok');
  assert.equal(healthDecision({ booted: false, reloadCount: 0 }), 'reload');
  assert.equal(healthDecision({ booted: false, reloadCount: 2 }), 'reload');
  assert.equal(healthDecision({ booted: false, reloadCount: 3 }), 'giveup');
});
