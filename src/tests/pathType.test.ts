import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCandidateType, classifyVia, selectedPairStats } from '../pathType.js';

const pair = (over: object) => ({ type: 'candidate-pair', id: 'p1', state: 'succeeded', localCandidateId: 'l1', bytesSent: 1000, bytesReceived: 2000, ...over });
const local = (candidateType: string) => ({ type: 'local-candidate', id: 'l1', candidateType });

test('classifyCandidateType: relay→relay, host/srflx/prflx→direct, 其他→unknown', () => {
  assert.equal(classifyCandidateType('relay'), 'relay');
  assert.equal(classifyCandidateType('host'), 'direct');
  assert.equal(classifyCandidateType('srflx'), 'direct');
  assert.equal(classifyCandidateType('prflx'), 'direct');
  assert.equal(classifyCandidateType(undefined), 'unknown');
});

test('selectedPairStats: 无 selected 字段，取 state==succeeded 的对（werift 判据）', () => {
  const stats = [pair({}), local('relay')];
  const r = selectedPairStats(stats);
  assert.equal(r.pathType, 'relay');
  assert.equal(r.wireSent, 1000);
  assert.equal(r.wireRecv, 2000);
});

test('selectedPairStats: 多对 succeeded 时优先 nominated', () => {
  const stats = [
    pair({ id: 'p1', localCandidateId: 'l1', bytesSent: 1, bytesReceived: 1 }),
    pair({ id: 'p2', localCandidateId: 'l2', nominated: true, bytesSent: 9, bytesReceived: 9 }),
    local('relay'),
    { type: 'local-candidate', id: 'l2', candidateType: 'srflx' },
  ];
  const r = selectedPairStats(stats);
  assert.equal(r.pathType, 'direct');
  assert.equal(r.wireSent, 9);
});

test('selectedPairStats: 无 succeeded 对 → unknown，不崩', () => {
  const r = selectedPairStats([{ type: 'candidate-pair', id: 'p1', state: 'in-progress' }]);
  assert.equal(r.pathType, 'unknown');
  assert.equal(r.wireSent, 0);
});

test('tunnel 帧（via:tunnel）归类为 tunnel，不进 getStats 判定', () => {
  assert.equal(classifyVia('tunnel'), 'tunnel');
  assert.equal(classifyVia('dc'), 'unknown');
  assert.equal(classifyVia(undefined), 'unknown');
});
