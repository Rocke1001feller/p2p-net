import test from 'node:test';
import assert from 'node:assert/strict';
import { roomFor, parseRoom, isSigMessage } from '../protocol.js';

test('roomFor 形状', () => {
  assert.equal(roomFor('uid-1', 'dev-2'), 'sig:uid-1:dev-2');
});

test('parseRoom 往返', () => {
  assert.deepEqual(parseRoom(roomFor('u', 'd')), { uid: 'u', deviceId: 'd' });
});

test('parseRoom 非法输入返回 null', () => {
  assert.equal(parseRoom('sig:onlyone'), null);
  assert.equal(parseRoom(''), null);
});

test('parseRoom 允许 deviceId 含冒号', () => {
  assert.deepEqual(parseRoom('sig:u:a:b'), { uid: 'u', deviceId: 'a:b' });
});

test('isSigMessage 收窄', () => {
  assert.equal(isSigMessage({ type: 'offer', sid: 's1' }), true);
  assert.equal(isSigMessage({ type: 'tunnel', sid: 's1', tunnelUrl: 'https://x/y' }), true);
  assert.equal(isSigMessage({ type: 'unknown-kind', sid: 's1' }), false);
  assert.equal(isSigMessage({ type: 'offer' }), false);
  assert.equal(isSigMessage(null), false);
  assert.equal(isSigMessage('offer'), false);
});
