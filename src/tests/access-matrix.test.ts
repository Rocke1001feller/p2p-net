/** access-matrix 脚本单测（Wave 2 W2-1）：events.jsonl → access × pathType 计数矩阵。
 *  计划钉死：fixture = 两条 start+end 配对 + 一条无 access 的 start + 一条孤儿 end；
 *  断言矩阵、unknown 桶（Review Focus #1：旧版 PWA 无 access 必须落 unknown）与孤儿忽略。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAccessMatrix, renderAccessMatrix } from '../../scripts/access-matrix.mjs';

const FIXTURE = [
  { name: 'session_start', sid: 'a', access: 'cellular-ct' },
  { name: 'session_end', sid: 'a', pathType: 'direct' },
  { name: 'session_start', sid: 'b', access: 'wifi-home' },
  { name: 'session_end', sid: 'b', pathType: 'relay' },
  { name: 'session_start', sid: 'c' }, // 旧版 PWA：无 access 字段
  { name: 'session_end', sid: 'ghost', pathType: 'direct' }, // 孤儿 end（无 start 配对）
];

test('buildAccessMatrix：start×end 按 sid join；无 access 的 start 计 unknown 桶；孤儿 end 忽略', () => {
  const { matrix, samples } = buildAccessMatrix(FIXTURE);
  assert.equal(matrix.get('cellular-ct')?.get('direct'), 1);
  assert.equal(matrix.get('wifi-home')?.get('relay'), 1);
  assert.equal(samples.get('cellular-ct'), 1);
  assert.equal(samples.get('wifi-home'), 1);
  assert.equal(samples.get('unknown'), 1, '无 access 字段的 start 一律计入 unknown 桶（Review Focus #1 兼容钉死）');
  assert.ok(!matrix.has('unknown') || (matrix.get('unknown')?.size ?? 0) === 0, 'unknown 的 start 无 end 配对，矩阵无有效单元格');
  // 孤儿 end 不产生任何矩阵单元格
  const totalCells = [...matrix.values()].reduce((n, row) => n + [...row.values()].reduce((a, b) => a + b, 0), 0);
  assert.equal(totalCells, 2, '孤儿 end 不得进矩阵');
});

test('renderAccessMatrix：矩阵表含各桶样本数；样本 <20 的单元格标注 N不足（禁止外推纪律）', () => {
  const out = renderAccessMatrix(buildAccessMatrix(FIXTURE));
  assert.match(out, /cellular-ct/);
  assert.match(out, /wifi-home/);
  assert.match(out, /unknown/, 'unknown 桶必须出现在矩阵表（含仅有 start 无 end 的桶）');
  assert.match(out, /N不足/, '样本 <20 的单元格必须标注 N不足');
});

test('buildAccessMatrix：垃圾容忍——坏对象/缺 sid/空 access 不抛且不计数', () => {
  const { matrix, samples } = buildAccessMatrix([
    null,
    { name: 'session_start' }, // 缺 sid
    { name: 'session_start', sid: '' }, // 空 sid
    { name: 'session_start', sid: 'x', access: '' }, // 空串 access → unknown
    { name: 'cascade_choice', sid: 'x', mode: 'p2p' }, // 与本矩阵无关的事件
    { name: 'session_end', sid: 'x' }, // 缺 pathType → unknown
  ]);
  assert.equal(samples.get('unknown'), 1);
  assert.equal(matrix.get('unknown')?.get('unknown'), 1, '缺 pathType 的 end 落 unknown 列');
});
