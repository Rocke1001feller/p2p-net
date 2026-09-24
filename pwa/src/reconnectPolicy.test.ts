import test from 'node:test';
import assert from 'node:assert/strict';
import { onConnectFailure } from './reconnectPolicy.js';

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
