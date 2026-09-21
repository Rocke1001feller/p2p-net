import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPortAllowed, PortNotAllowedError } from './guard.js';

test('白名单外端口抛 PortNotAllowedError', () => {
  const allow = (p: number) => p === 3000;
  assert.throws(() => assertPortAllowed(allow, 9999), PortNotAllowedError);
  assertPortAllowed(allow, 3000); // 不抛
});

test('未提供 isPortAllowed 时放行（库层向后兼容，CLI 层必须传）', () => {
  assertPortAllowed(undefined, 22); // 不抛
});

test('PortNotAllowedError 携带 port 且 message 指向配置入口', () => {
  const err = new PortNotAllowedError(22);
  assert.equal(err.port, 22);
  assert.equal(err.name, 'PortNotAllowedError');
  assert.ok(err.message.includes('22'), 'message 应含被拒端口');
});
