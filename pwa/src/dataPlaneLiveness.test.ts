import test from 'node:test';
import assert from 'node:assert/strict';
import { DataPlaneLiveness, WEDGE_MS } from './dataPlaneLiveness.js';

test('有在途请求但回帧持续在流 → 不判死（洪泛下首帧排队的正常态）', () => {
  const l = new DataPlaneLiveness();
  const t0 = 1_000_000;
  l.noteOpen(t0);
  // t0+40s：某请求已等 40s（远超旧 9s 口径），但 1s 前仍有回帧在流
  l.noteFrame(t0 + 39_000);
  assert.equal(l.wedged(3, t0 + 40_000), false);
});

test('有在途请求且全局静默超阈 → 判死（真黑洞）', () => {
  const l = new DataPlaneLiveness();
  const t0 = 1_000_000;
  l.noteOpen(t0);
  assert.equal(l.wedged(1, t0 + WEDGE_MS + 1), true);
});

test('无在途请求 → 永不判死（空闲链路不拆）', () => {
  const l = new DataPlaneLiveness();
  const t0 = 1_000_000;
  l.noteOpen(t0);
  assert.equal(l.wedged(0, t0 + 10 * WEDGE_MS), false);
});

test('建连宽限期：noteOpen 后阈值窗口内零回帧也不判死', () => {
  const l = new DataPlaneLiveness();
  const t0 = 1_000_000;
  l.noteOpen(t0);
  assert.equal(l.wedged(2, t0 + WEDGE_MS - 1), false);
});

test('任何数据面帧都算活性证明（res-head/res-chunk/ws-* 同权）', () => {
  const l = new DataPlaneLiveness();
  const t0 = 1_000_000;
  l.noteOpen(t0);
  l.noteFrame(t0 + WEDGE_MS + 1); // 静默超阈后来一帧 → 活性刷新
  assert.equal(l.wedged(5, t0 + WEDGE_MS + 2), false);
});
