import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBindResponse } from './cloud.js';

// 2026-09-22 真机实锤：DDL returns uuid → PostgREST 直返裸字符串，
// 旧实现只认 {device_id} 对象形态 → 手机端绑定即抛错、永远连不上。
test('parseBindResponse：裸 uuid 字符串（DDL returns uuid 真实形态）', () => {
  assert.equal(parseBindResponse('bc0a0566-3f63-450c-a95c-5a27d26933ee'), 'bc0a0566-3f63-450c-a95c-5a27d26933ee');
});

test('parseBindResponse：jsonb 对象形态兜底（D-M1-3 历史形态）', () => {
  assert.equal(parseBindResponse({ device_id: 'x-y-z' }), 'x-y-z');
});

test('parseBindResponse：垃圾输入一律 null（调用方抛人话）', () => {
  for (const junk of [null, undefined, '', {}, { device_id: '' }, { device_id: 42 }, 0, false]) {
    assert.equal(parseBindResponse(junk), null, `junk=${JSON.stringify(junk)}`);
  }
});
