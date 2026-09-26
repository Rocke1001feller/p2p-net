import test from 'node:test';
import assert from 'node:assert/strict';
import { isSigMessage, roomFor, parseRoom, type SigMessage } from './protocol.js';

test('isSigMessage：offer/answer/ice/hello/bye/tunnel/upgrade 既有类型守卫不破', () => {
  for (const t of ['offer', 'answer', 'ice', 'hello', 'bye', 'tunnel', 'upgrade']) {
    assert.ok(isSigMessage({ type: t, sid: 's1' }), `type=${t} 应通过守卫`);
  }
  assert.ok(!isSigMessage({ type: 'nope', sid: 's1' }));
  assert.ok(!isSigMessage({ type: 'offer' })); // 缺 sid
  assert.ok(!isSigMessage(null));
});

test('tunnel-session：新类型通过守卫，phase/access 可选平铺', () => {
  const msg: SigMessage = { type: 'tunnel-session', sid: 'tun-1', phase: 'start', access: 'cellular-ct', from: 'dev-1' };
  assert.ok(isSigMessage(msg));
  assert.ok(isSigMessage({ type: 'tunnel-session', sid: 'tun-2' })); // 无 phase/access 也过（可选兼容）
});

test('房间名构造/解析往返（回归）', () => {
  const r = roomFor('uid-1', 'dev-9');
  assert.deepEqual(parseRoom(r), { uid: 'uid-1', deviceId: 'dev-9' });
  assert.equal(parseRoom('bad-room'), null);
});
