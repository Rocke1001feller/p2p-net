import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHidden, hideService, unhideService } from './hiddenServices.js';
import { LS_HIDDEN_SERVICES } from './constants.js';
import type { PickStorage } from './consolePick.js';

const memStorage = (m = new Map<string, string>()): PickStorage => ({
  getItem: (k) => m.get(k) ?? null,
  setItem: (k, v) => void m.set(k, v),
});

test('readHidden：空存储返回 []', () => {
  assert.deepEqual(readHidden(memStorage(), 'desk-a'), []);
});

test('hide→read 往返；按 deviceId 隔离（A 机隐藏不影响 B 机）', () => {
  const m = new Map<string, string>();
  const s = memStorage(m);
  hideService(s, 'desk-a', 57255);
  hideService(s, 'desk-a', 3000);
  assert.deepEqual(readHidden(s, 'desk-a'), [57255, 3000]);
  assert.deepEqual(readHidden(s, 'desk-b'), []);
  hideService(s, 'desk-b', 3001);
  assert.deepEqual(readHidden(s, 'desk-a'), [57255, 3000]);
  assert.deepEqual(readHidden(s, 'desk-b'), [3001]);
});

test('hide 幂等（重复隐藏不重复记录）；unhide 只删目标端口', () => {
  const s = memStorage();
  hideService(s, 'desk-a', 3001);
  hideService(s, 'desk-a', 3001);
  hideService(s, 'desk-a', 3002);
  assert.deepEqual(readHidden(s, 'desk-a'), [3001, 3002]);
  unhideService(s, 'desk-a', 3001);
  assert.deepEqual(readHidden(s, 'desk-a'), [3002]);
  unhideService(s, 'desk-a', 9999); // 不在列表：静默无操作
  assert.deepEqual(readHidden(s, 'desk-a'), [3002]);
});

test('脏数据防御：JSON 损坏 / 值不是数组 / 元素是字符串数字 → 强制转换或丢弃，不抛', () => {
  const m = new Map<string, string>();
  const s = memStorage(m);
  m.set(LS_HIDDEN_SERVICES, '{not json');
  assert.deepEqual(readHidden(s, 'desk-a'), []);
  m.set(LS_HIDDEN_SERVICES, JSON.stringify({ 'desk-a': 'nope' }));
  assert.deepEqual(readHidden(s, 'desk-a'), []);
  m.set(LS_HIDDEN_SERVICES, JSON.stringify({ 'desk-a': ['57255', 3001, -1, 'abc', null] }));
  assert.deepEqual(readHidden(s, 'desk-a'), [57255, 3001]);
});

test('storage 抛错（隐私模式）→ readHidden 返回 []，hide/unhide 静默', () => {
  const throwing: PickStorage = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
  };
  assert.deepEqual(readHidden(throwing, 'desk-a'), []);
  hideService(throwing, 'desk-a', 3001); // 不抛即合格
  unhideService(throwing, 'desk-a', 3001);
});
