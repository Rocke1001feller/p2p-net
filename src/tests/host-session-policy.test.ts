/**
 * 会话摘除策略单测（2026-09-12 根因修复）。
 *
 * 背景（真机实证）：Android 直连下 Files / Source Control 全部 30s 超时 → SW 回 504。
 * 原因链：蜂窝抖动 → pc 进 disconnected（可自愈）→ 被映射成 failed → host 立即把会话从
 * sessions 摘除但没 dispose（pc 仍然活着且继续上报状态）→ 该客户端后续 ice 帧被丢、
 * 在途请求成孤儿；客户端因 dc.readyState 仍是 open 而显示"假直连"，永不重连。
 *
 * 策略断言：只有客户端明确 closed 才立即摘；connected 保持；其余（connecting/disconnected/
 * failed）都走宽限期，抖动期不得摘会话。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerSession, SESSION_GRACE_MS, sessionDisposition } from '../host.js';

test('sessionDisposition：只有 closed 立即摘除', () => {
  assert.equal(sessionDisposition('closed'), 'drop');
  assert.equal(sessionDisposition('connected'), 'keep');
});

test('sessionDisposition：抖动/失败态一律走宽限，不秒摘（回归护栏）', () => {
  // 这条是本次缺陷的直接护栏：disconnected 若被判成 drop/keep 都会红
  assert.equal(sessionDisposition('disconnected'), 'grace');
  assert.equal(sessionDisposition('failed'), 'grace');
  assert.equal(sessionDisposition('connecting'), 'grace');
});

test('PeerSession 宽限：到期回调一次，clearGrace 可取消，dispose 后不再触发', async () => {
  const s = new PeerSession(undefined);
  let fired = 0;
  s.startGrace(SESSION_GRACE_MS, () => { fired += 1; });
  s.startGrace(SESSION_GRACE_MS, () => { fired += 1; }); // 重复调用不得叠加计时器
  s.clearGrace();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fired, 0, 'clearGrace 后不应触发');

  const s2 = new PeerSession(undefined);
  let fired2 = 0;
  s2.startGrace(5, () => { fired2 += 1; });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fired2, 1, '宽限到期应恰好回调一次');

  const s3 = new PeerSession(undefined);
  let fired3 = 0;
  s3.startGrace(5, () => { fired3 += 1; });
  s3.dispose();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fired3, 0, 'dispose 后不得再回调（避免摘除已释放会话）');
});

test('PeerSession.dispose 幂等', () => {
  const s = new PeerSession(undefined);
  s.dispose();
  s.dispose();
  assert.equal(s.lastStatus.state, 'closed');
});
