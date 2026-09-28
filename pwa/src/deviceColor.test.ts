/** deviceColor 分组色契约：稳定性（同 id 恒同色）、色板边界、空串兜底、真机双设备不撞色。 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GROUP_PALETTE, deviceColor } from './deviceColor.js';

test('同一 deviceId 多次计算恒同色', () => {
  const a = deviceColor('47290b9b-6dbd-4be7-9ba6-5ff8b2a5593c');
  const b = deviceColor('47290b9b-6dbd-4be7-9ba6-5ff8b2a5593c');
  assert.equal(a, b);
});

test('结果永远在色板内且字段完整', () => {
  for (const id of ['a', 'x-1', '47290b9b', '1a41ca2f', 'desktop-xyz', '🇨🇳']) {
    const c = deviceColor(id);
    assert.ok(GROUP_PALETTE.includes(c), `${id} 越界`);
    assert.match(c.fg, /^#[0-9A-F]{6}$/);
    assert.match(c.soft, /^#[0-9A-F]{6}$/);
  }
});

test('空串/未知设备兜底品牌绿且不抛', () => {
  const c = deviceColor('');
  assert.equal(c, GROUP_PALETTE[1]);
});

test('验收双机（Mac 47290b9b / Windows 1a41ca2f）不撞色', () => {
  const mac = deviceColor('47290b9b-6dbd-4be7-9ba6-5ff8b2a5593c');
  const win = deviceColor('1a41ca2f-0432-41fd-ad83-43f3825c6e81');
  assert.notEqual(mac.fg, win.fg, '演示双机撞色会削弱分组辨识，需换散列');
});
