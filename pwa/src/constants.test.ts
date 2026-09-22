import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlausibleTunnelUrl } from './constants.js';

test('isPlausibleTunnelUrl：正常形态放行', () => {
  assert.equal(isPlausibleTunnelUrl('https://49.233.155.13/tunnel/s/47290b9b-6dbd-4be7-9ba6-5ff8b2a5593c'), true);
  assert.equal(isPlausibleTunnelUrl('https://relay.example.com/tunnel/s/abc-123/'), true);
  assert.equal(isPlausibleTunnelUrl('http://10.0.0.2:8080/tunnel/s/x'), true);
});

test('isPlausibleTunnelUrl：损坏/截断/缺段一律拒绝', () => {
  // 2026-09-22 真机实锤的脏串（含 U+FFFD）
  assert.equal(isPlausibleTunnelUrl('https:2\uFFFDO9.233.155.13/tunnel/s/47290b9b-6dbd-4be7-9ba6-5ff8b2a5593c'), false);
  // 缺 /tunnel/s/<sid> 路径（裸源）——探针会命中 SPA 回退页
  assert.equal(isPlausibleTunnelUrl('https://49.233.155.13'), false);
  assert.equal(isPlausibleTunnelUrl('https://49.233.155.13/'), false);
  // 缺 sid / 缺 tunnel 段 / 截断
  assert.equal(isPlausibleTunnelUrl('https://49.233.155.13/tunnel/s/'), false);
  assert.equal(isPlausibleTunnelUrl('https://49.233.155.13/s/47290b9b'), false);
  assert.equal(isPlausibleTunnelUrl('https://49.233.155.13/tunnel'), false);
  // 空白与非 http
  assert.equal(isPlausibleTunnelUrl(''), false);
  assert.equal(isPlausibleTunnelUrl('ftp://x/tunnel/s/y'), false);
});
