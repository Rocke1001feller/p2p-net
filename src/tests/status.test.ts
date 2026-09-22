import test from 'node:test';
import assert from 'node:assert/strict';
import { pairTypeFromStats, rttFromStats, relayAddrFromStats, type StatsRow } from '../status.js';

function rowsWith(pair: StatsRow, local: StatsRow, remote: StatsRow): StatsRow[] {
  return [pair, local, remote];
}

test('selected=true + host/srflx → p2p（浏览器侧判定路径）', () => {
  const rows = rowsWith(
    { type: 'candidate-pair', selected: true, localCandidateId: 'L', remoteCandidateId: 'R' },
    { id: 'L', type: 'local-candidate', candidateType: 'host', address: '192.168.1.2', port: 50000 },
    { id: 'R', type: 'remote-candidate', candidateType: 'srflx', address: '1.2.3.4', port: 50001 },
  );
  assert.equal(pairTypeFromStats(rows), 'p2p');
});

test('state=succeeded + relay → relay（werift 侧判定路径：无 selected 字段）', () => {
  const rows = rowsWith(
    { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.031 },
    { id: 'L', type: 'local-candidate', candidateType: 'relay', address: '39.106.59.183', port: 50010 },
    { id: 'R', type: 'remote-candidate', candidateType: 'relay', address: '39.106.59.183', port: 50018 },
  );
  assert.equal(pairTypeFromStats(rows), 'relay');
  assert.equal(rttFromStats(rows), 31);
  assert.equal(relayAddrFromStats(rows), '39.106.59.183:50010');
});

test('无 selected 且无 succeeded 行 → null', () => {
  const rows: StatsRow[] = [
    { type: 'candidate-pair', state: 'in-progress', localCandidateId: 'L', remoteCandidateId: 'R' },
    { id: 'L', type: 'local-candidate', candidateType: 'host' },
    { id: 'R', type: 'remote-candidate', candidateType: 'host' },
  ];
  assert.equal(pairTypeFromStats(rows), null);
  assert.equal(rttFromStats(rows), undefined);
  assert.equal(relayAddrFromStats(rows), undefined);
});

test('local 候选缺失时回退看 remote 候选', () => {
  const rows: StatsRow[] = [
    { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' },
    { id: 'R', type: 'remote-candidate', candidateType: 'relay', address: '39.106.59.183', port: 50018 },
  ];
  assert.equal(pairTypeFromStats(rows), 'relay');
});

test('未知候选类型（prflx 等）→ null', () => {
  const rows: StatsRow[] = [
    { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' },
    { id: 'L', type: 'local-candidate', candidateType: 'prflx', address: '1.1.1.1', port: 1 },
    { id: 'R', type: 'remote-candidate', candidateType: 'prflx' },
  ];
  assert.equal(pairTypeFromStats(rows), null);
});

test('local=srflx + remote=relay → relay（任一端 relay 即过 TURN，蜂窝真机口径）', () => {
  const rows: StatsRow[] = [
    { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' },
    { id: 'L', type: 'local-candidate', candidateType: 'srflx', address: '8.8.8.8', port: 61000 },
    { id: 'R', type: 'remote-candidate', candidateType: 'relay', address: '39.106.59.183', port: 50018 },
  ];
  assert.equal(pairTypeFromStats(rows), 'relay');
});

test('rttFromStats：非数值/缺字段 → undefined', () => {
  assert.equal(rttFromStats([{ type: 'candidate-pair', state: 'succeeded' }]), undefined);
  assert.equal(rttFromStats([]), undefined);
});

test('relayAddrFromStats：local 非 relay → undefined', () => {
  const rows: StatsRow[] = [
    { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' },
    { id: 'L', type: 'local-candidate', candidateType: 'srflx', address: '8.8.8.8', port: 61000 },
    { id: 'R', type: 'remote-candidate', candidateType: 'relay' },
  ];
  assert.equal(relayAddrFromStats(rows), undefined);
});
