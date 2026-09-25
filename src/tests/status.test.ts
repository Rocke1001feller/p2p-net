import test from 'node:test';
import assert from 'node:assert/strict';
import { pairTypeFromStats, rttFromStats, relayAddrFromStats, type StatsRow } from '../status.js';
import { runStatus } from '../cli/status.js';

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

test('dataPlane 存在时打印数据面流量行；缺字段（旧进程）省略', async () => {
  const lines: string[] = [];
  const code = await runStatus({
    fetchImpl: (async () => new Response(JSON.stringify({
      uptime: 60, deviceId: 'desk-x', sessions: { active: 1, byMode: { relay: 1 }, avgRttMs: 53 },
      services: 2, mode: 'foreground',
      dataPlane: { totals: { req: 40, resDone: 40, bytesSent: 2 * 1024 * 1024, bytesRecv: 1024 * 1024 }, sessions: 1 },
    }), { status: 200 })) as typeof fetch,
    out: (l) => lines.push(l),
  });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes('数据面流量') && l.includes('上行 2.0 MiB') && l.includes('下行 1.0 MiB')), lines.join('\n'));

  const lines2: string[] = [];
  await runStatus({
    fetchImpl: (async () => new Response(JSON.stringify({ uptime: 60, deviceId: 'd', sessions: 0, services: 0 }), { status: 200 })) as typeof fetch,
    out: (l) => lines2.push(l),
  });
  assert.ok(!lines2.some((l) => l.includes('数据面流量')), '旧进程无 dataPlane → 不打该行');
});

test('F10：tunnelLinks 存在时打印隧道腿在线数；缺字段（旧进程）省略', async () => {
  const lines: string[] = [];
  await runStatus({
    fetchImpl: (async () => new Response(JSON.stringify({
      uptime: 60, deviceId: 'desk-x', sessions: { active: 0, byMode: {}, avgRttMs: null },
      services: 1, mode: 'foreground',
      dataPlane: { totals: { req: 3, resDone: 3, bytesSent: 2048, bytesRecv: 1024 }, sessions: 0, tunnelLinks: { open: 1, total: 2 } },
    }), { status: 200 })) as typeof fetch,
    out: (l) => lines.push(l),
  });
  assert.ok(lines.some((l) => l.includes('隧道兜底腿') && l.includes('1/2')), lines.join('\n'));

  const lines2: string[] = [];
  await runStatus({
    fetchImpl: (async () => new Response(JSON.stringify({
      uptime: 60, deviceId: 'd', sessions: 0, services: 0,
      dataPlane: { totals: { bytesSent: 1, bytesRecv: 1 }, sessions: 0 },
    }), { status: 200 })) as typeof fetch,
    out: (l) => lines2.push(l),
  });
  assert.ok(!lines2.some((l) => l.includes('隧道兜底腿')), '旧进程无 tunnelLinks → 不打该行');
});
