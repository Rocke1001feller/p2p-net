import test from 'node:test';
import assert from 'node:assert/strict';
import { PoolRouter } from './poolRouter.js';

const ch = (amt: number, state = 'open') => ({ bufferedAmount: amt, readyState: state });

test('req / req-abort 恒走 proxy0（请求面单通道保序）', () => {
  const r = new PoolRouter(() => [ch(0), ch(0)]);
  assert.equal(r.channelFor({ k: 'req', id: 1 }), 0);
  assert.equal(r.channelFor({ k: 'req-abort', id: 1 }), 0);
});

test('ws-open 选最闲并按 wid 粘滞；ws-close 删映射后重选', () => {
  const chs = [ch(5000), ch(0), ch(100)];
  const r = new PoolRouter(() => chs);
  assert.equal(r.channelFor({ k: 'ws-open', wid: 7 }), 1);
  chs[2].bufferedAmount = -1; // 之后即使 pool[2] 更闲也不漂移
  assert.equal(r.channelFor({ k: 'ws-msg', wid: 7 }), 1);
  assert.equal(r.channelFor({ k: 'ws-close', wid: 7 }), 1);
  assert.equal(r.channelFor({ k: 'ws-open', wid: 7 }), 2); // close 后映射已删，重新选
});

test('全通道非 open → ws-open 回落 0（调用方兜底 dcs[0]）', () => {
  const r = new PoolRouter(() => [ch(0, 'closed'), ch(0, 'closed')]);
  assert.equal(r.channelFor({ k: 'ws-open', wid: 1 }), 0);
});
