import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DISCOVERY_PORT, STUN_PORT, isPlausibleTunnelUrl, stunServersFromRelays } from './constants.js';

// 端口契约 parity 门禁：constants.ts 的端口值必须等于 contracts/ports.json（单一事实源）。
// 本测试是「PWA 侧端口副本」复发类的歼灭工事——谁把字面量回填进 constants.ts，这里立刻红。
// （故意改错实证：见 mech/ports 分支提交信息 / 当次报告。）
test('端口契约 parity：PWA 导出值 === contracts/ports.json', () => {
  const raw = JSON.parse(readFileSync(new URL('../../contracts/ports.json', import.meta.url), 'utf8'));
  assert.equal(DISCOVERY_PORT, raw.DISCOVERY_PORT, 'DISCOVERY_PORT 与 contracts/ports.json 不一致');
  assert.equal(STUN_PORT, raw.STUN_PORT, 'STUN_PORT 与 contracts/ports.json 不一致');
});

test('stunServersFromRelays 打的就是契约 STUN 端口', () => {
  const raw = JSON.parse(readFileSync(new URL('../../contracts/ports.json', import.meta.url), 'utf8'));
  assert.deepEqual(stunServersFromRelays([{ url: 'https://203.0.113.9' }]), [
    { urls: [`stun:203.0.113.9:${raw.STUN_PORT}`] },
  ]);
});

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
