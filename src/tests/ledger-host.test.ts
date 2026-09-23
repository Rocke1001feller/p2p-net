import test from 'node:test';
import assert from 'node:assert/strict';
import type { RTCDataChannel } from 'werift';
import { HostAgent, PeerSession, makeLedger } from '../host.js';

function stubDc(): { dc: RTCDataChannel; sent: (string | Uint8Array)[] } {
  const sent: (string | Uint8Array)[] = [];
  const dc = {
    readyState: 'open', bufferedAmount: 0,
    onmessage: null as null | ((ev: { data: unknown }) => void),
    send(d: string | Uint8Array) { sent.push(typeof d === 'string' ? d : new Uint8Array(d)); },
    close() { /* noop */ },
  } as unknown as RTCDataChannel;
  return { dc, sent };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('PeerSession 账本：req/resDone 计数 + 双向字节；会话间隔离（Review Focus #4）', async () => {
  const s1 = new PeerSession(undefined, () => true);
  const s2 = new PeerSession(undefined, () => true);
  const a = stubDc(); const b = stubDc();
  s1.wireChannel(a.dc, 'proxy'); s2.wireChannel(b.dc, 'proxy');
  a.dc.onmessage!({ data: JSON.stringify({ k: 'req', id: 1, port: 1, method: 'GET', path: '/', headers: {} }) });
  await until(() => a.sent.length >= 2); // 502 两帧
  await until(() => s1.ledger.resDone === 1);
  assert.equal(s1.ledger.req, 1);
  assert.ok(s1.ledger.bytesSent > 0, '出站字节已计');
  assert.ok(s1.ledger.bytesRecv > 0, '入站字节已计');
  assert.deepEqual({ ...s2.ledger }, makeLedger(), 's2 账本零污染');
});

test('HostAgent.dataPlaneSnapshot 求和全部活跃会话 + 路径分布', () => {
  const agent = new HostAgent({
    supabaseUrl: '', publishableKey: '', accessToken: () => null,
    deviceId: 'desk', uid: 'u', turnFetcher: async () => ({ iceServers: [] }),
  });
  const s1 = new PeerSession(); const s2 = new PeerSession();
  s1.ledger.req = 3; s1.ledger.bytesSent = 100; s1.ledger.bytesRecv = 40;
  s1.ledger.pathType = 'relay'; s1.ledger.wireBytesSent = 500;
  s2.ledger.req = 1; s2.ledger.bytesSent = 7; s2.ledger.bytesRecv = 5; s2.ledger.resDone = 1;
  s2.ledger.wireBytesRecv = 60;
  (agent as any).sessions.set('k1', s1);
  (agent as any).sessions.set('k2', s2);
  const snap = agent.dataPlaneSnapshot();
  assert.equal(snap.sessions, 2);
  assert.deepEqual(snap.totals, { req: 4, resDone: 1, bytesSent: 107, bytesRecv: 45, pathType: 'unknown', wireBytesSent: 500, wireBytesRecv: 60 });
  assert.deepEqual(snap.byPath, { direct: 0, relay: 1, tunnel: 0, unknown: 1 });
});

test('PeerSession wire 采样器：getStats 选定对增量累进 wire 字节 + pathType；dispose 停拍（spec D9）', async () => {
  const s = new PeerSession(undefined, () => true);
  let sent = 1000; let recv = 2000;
  const rows = () => new Map<string, any>([
    ['p1', { type: 'candidate-pair', id: 'p1', state: 'succeeded', nominated: true, localCandidateId: 'l1', bytesSent: sent, bytesReceived: recv }],
    ['l1', { type: 'local-candidate', id: 'l1', candidateType: 'relay' }],
  ]);
  (s.peer as any).pc = { getStats: async () => rows() };
  s.startWireSampler(20); // 测试缝：小节拍（生产默认 5000）
  await until(() => s.ledger.pathType === 'relay');
  assert.equal(s.ledger.wireBytesSent, 0, '首拍只建基线');
  sent = 1500; recv = 2700;
  await until(() => s.ledger.wireBytesSent >= 500 && s.ledger.wireBytesRecv >= 700);
  s.dispose();
  assert.equal((s as any).wireTimer, undefined, 'dispose 必须停拍（防间隔泄漏）');
});
