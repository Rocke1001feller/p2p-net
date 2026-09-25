import test from 'node:test';
import assert from 'node:assert/strict';
import { onConnectFailure, onConnectStopped } from './reconnectPolicy.js';

// 2026-09-24 真机门禁 F3：自动重连循环运行中，用户手动点「重试」→ startConnect(isRetry=false)
// 把 wasConnected/reconnectAttempt 清零并清掉待触发定时器；手动尝试再失败时旧代码只在
// isRetry 时 scheduleReconnect → 自动重连循环被杀，桌面端恢复后手机仍连不上（"重连无反应"）。

test('首次手动连接失败：只出重试卡片，不启动自动重连（原设计意图保留）', () => {
  const r = onConnectFailure({ isRetry: false, wasConnected: false, reconnectAttempt: 0, timerPending: false });
  assert.deepEqual(r, { reconnect: false, sheet: true });
});

test('手动重试失败但此前有会话上下文：必须恢复自动重连 + 仍出卡片反馈（F3 核心）', () => {
  for (const ctx of [
    { isRetry: false, wasConnected: true, reconnectAttempt: 0, timerPending: false },   // 曾连上过
    { isRetry: false, wasConnected: false, reconnectAttempt: 2, timerPending: false },  // 退避节拍进行中
    { isRetry: false, wasConnected: false, reconnectAttempt: 0, timerPending: true },   // 定时器待触发
  ]) {
    const r = onConnectFailure(ctx);
    assert.equal(r.reconnect, true, `自动重连上下文不得被手动重试杀死: ${JSON.stringify(ctx)}`);
    assert.equal(r.sheet, true, '手动尝试失败仍要给人话反馈');
  }
});

test('自动重试失败：继续排下一跳，不出卡片（原行为不变）', () => {
  const r = onConnectFailure({ isRetry: true, wasConnected: true, reconnectAttempt: 3, timerPending: false });
  assert.deepEqual(r, { reconnect: true, sheet: false });
});

// 2026-09-25 真机门禁 F9：看门狗在自动重试的 connect() 进行中触发 → cascade.stop() →
// 在途 connect 抛 'stopped' → startConnect catch 无条件静默 return；同时 onCascadeStatus
// 的 'off' 分支要求 wasConnected===true（手动重试进入时已清零、重试成功才回设）→
// 两侧都不 scheduleReconnect 且无待触发定时器 → 自动重连循环永久死亡（页面谎称「正在重连…」，
// 桌面端恢复 3 分钟仍零自愈，只有手动点击/刷新能救——CDP 铁证 08:02:06Z 冻结）。

test('F9 核心：看门狗中断进行中的自动重试 → 必须续命自动重连循环', () => {
  const r = onConnectStopped({
    superseded: false, manualStop: false,
    isRetry: true, wasConnected: false, reconnectAttempt: 2, timerPending: false,
  });
  assert.deepEqual(r, { reconnect: true, sheet: false });
});

test('看门狗中断手动重试但带自动上下文 → 续命 + 出卡片（与 onConnectFailure 同口径）', () => {
  const r = onConnectStopped({
    superseded: false, manualStop: false,
    isRetry: false, wasConnected: true, reconnectAttempt: 0, timerPending: false,
  });
  assert.deepEqual(r, { reconnect: true, sheet: true });
});

test('首次手动连接被中断（无自动上下文）→ 不偷启循环，出卡片交代（旧行为是卡死 connecting 遮罩）', () => {
  const r = onConnectStopped({
    superseded: false, manualStop: false,
    isRetry: false, wasConnected: false, reconnectAttempt: 0, timerPending: false,
  });
  assert.deepEqual(r, { reconnect: false, sheet: true });
});

test('被更新的 startConnect 取代（superseded）→ 旧实例必须静默（新实例已接管循环）', () => {
  const r = onConnectStopped({
    superseded: true, manualStop: false,
    isRetry: true, wasConnected: true, reconnectAttempt: 3, timerPending: false,
  });
  assert.deepEqual(r, { reconnect: false, sheet: false });
});

test('用户主动断开（manualStop）→ 静默（手动断开语义就是杀循环）', () => {
  const r = onConnectStopped({
    superseded: false, manualStop: true,
    isRetry: true, wasConnected: true, reconnectAttempt: 1, timerPending: true,
  });
  assert.deepEqual(r, { reconnect: false, sheet: false });
});
