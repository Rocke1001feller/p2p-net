import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFallbackPort, readLastGoodPort, writeLastGoodPort, type PickStorage } from './consolePick.js';

const svc = (port: number, url = `/s/${port}/`) => ({ port, url });

test('pickFallbackPort：lastGood 在清单内 → 粘性选中（防低位端口劫持）', () => {
  // 2026-09-26 事故形态：OpenCode vite 抢占 3000，真工作台 3001 被顶掉
  assert.equal(pickFallbackPort([svc(3000), svc(3001)], 3001), 3001);
});

test('pickFallbackPort：lastGood 不在清单/为空 → 回退清单首个 /s/ 服务', () => {
  assert.equal(pickFallbackPort([svc(3000), svc(3001)], 9999), 3000);
  assert.equal(pickFallbackPort([svc(3000), svc(3001)], null), 3000);
});

test('pickFallbackPort：空清单/无 /s/ 条目 → null', () => {
  assert.equal(pickFallbackPort([], null), null);
  assert.equal(pickFallbackPort([{ port: 22 }], null), null);
});

test('lastGood 存储：往返一致；脏数据/存储异常 → null 不抛', () => {
  const m = new Map<string, string>();
  const storage: PickStorage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  assert.equal(readLastGoodPort(storage), null);
  writeLastGoodPort(storage, 3001);
  assert.equal(readLastGoodPort(storage), 3001);
  m.set('p2p.lastConsolePort', 'abc');
  assert.equal(readLastGoodPort(storage), null);
  m.set('p2p.lastConsolePort', '-5');
  assert.equal(readLastGoodPort(storage), null);
  const throwing: PickStorage = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
  };
  assert.equal(readLastGoodPort(throwing), null);
  writeLastGoodPort(throwing, 3001); // 不抛即合格
});
