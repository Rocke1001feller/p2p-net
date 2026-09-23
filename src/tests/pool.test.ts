import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLeastBufferedIdx, proxyLabelIdx, PROXY_POOL_SIZE } from '../pool.js';

test('pickLeastBufferedIdx：open 通道中 bufferedAmount 最小者', () => {
  assert.equal(pickLeastBufferedIdx([{ bufferedAmount: 5 }, { bufferedAmount: 0 }, { bufferedAmount: 3 }]), 1);
  assert.equal(pickLeastBufferedIdx([{ bufferedAmount: 0, readyState: 'closed' }, { bufferedAmount: 9 }]), 1);
  assert.equal(pickLeastBufferedIdx([]), -1);
  assert.equal(pickLeastBufferedIdx([{ bufferedAmount: 0, readyState: 'closed' }]), -1);
  // host 按 label 下标注册，稀疏数组留洞不得炸
  const sparse: ({ bufferedAmount: number } | undefined)[] = [];
  sparse[2] = { bufferedAmount: 1 };
  assert.equal(pickLeastBufferedIdx(sparse), 2);
  // readyState 缺省（DcLike 为可选字段）视为可选中
  assert.equal(pickLeastBufferedIdx([{ bufferedAmount: 7 }]), 0);
});

test('proxyLabelIdx：proxy→0、proxyN→N、非法→-1', () => {
  assert.equal(proxyLabelIdx('proxy'), 0);
  assert.equal(proxyLabelIdx('proxy0'), 0);
  assert.equal(proxyLabelIdx('proxy3'), 3);
  assert.equal(proxyLabelIdx('ctrl'), -1);
  assert.equal(proxyLabelIdx('proxyx'), -1);
  assert.equal(proxyLabelIdx('proxy99'), -1);
});

test('PROXY_POOL_SIZE 钉死 4（spec D2）', () => assert.equal(PROXY_POOL_SIZE, 4));
