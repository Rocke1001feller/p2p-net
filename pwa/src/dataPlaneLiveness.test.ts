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

test('constructor 自定义 wedgeMs（N4 真机标定）；缺省 = WEDGE_MS', () => {
  const a = new DataPlaneLiveness(1_000);
  a.noteFrame(0);
  assert.equal(a.wedged(1, 1_500), true);
  const b = new DataPlaneLiveness();
  b.noteFrame(0);
  assert.equal(b.wedged(1, 1_500), false);
  assert.equal(b.wedged(1, 61_000), true);
});

// 2026-09-25 F9：旧 wedged 只看在途数与静默——隧道期泄漏的陈旧在途计数（实测 76 条）
// + 陈旧活性证据，让「连接进行中」的实例被判黑洞；看门狗 cascade.stop() 打断健康重试，
// 叠加 'stopped' 静默 return 构成自动重连永久死亡。判死必须只针对「已打开的非隧道链路」。

test('F9：链路未打开（连接进行中/已停止）→ 不判死，即便在途>0 且静默超阈', () => {
  const l = new DataPlaneLiveness();
  const t0 = 1_000_000;
  l.noteOpen(t0);
  assert.equal(l.wedged(76, t0 + WEDGE_MS + 1, { isOpen: false, mode: null }), false);
});

test('隧道模式不参与 dc 黑洞判定（link 口径）', () => {
  const l = new DataPlaneLiveness();
  const t0 = 1_000_000;
  l.noteOpen(t0);
  assert.equal(l.wedged(5, t0 + WEDGE_MS + 1, { isOpen: true, mode: 'tunnel' }), false);
});

test('已打开的 dc 链路 + 在途>0 + 静默超阈 → 判死（link 口径不削弱真黑洞检测）', () => {
  const l = new DataPlaneLiveness();
  const t0 = 1_000_000;
  l.noteOpen(t0);
  assert.equal(l.wedged(2, t0 + WEDGE_MS + 1, { isOpen: true, mode: 'p2p' }), true);
  assert.equal(l.wedged(2, t0 + WEDGE_MS + 1, { isOpen: true, mode: 'turn' }), true);
});
