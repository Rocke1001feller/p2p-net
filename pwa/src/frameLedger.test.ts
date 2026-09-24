import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameLedger, wireBytes } from './frameLedger.js';

test('trackReq/settleReq 计数与字节；未知 gid 销账不计', () => {
  const l = new FrameLedger();
  const req = { k: 'req', id: 1, port: 3000, method: 'GET', path: '/', headers: {} };
  l.trackReq(1, 3000, '/', req);
  assert.equal(l.sent, 1);
  assert.equal(l.bytesSent, JSON.stringify(req).length);
  l.settleReq(1, { k: 'res-chunk', id: 1, data: new Uint8Array(100) });
  assert.equal(l.res, 1);
  assert.equal(l.bytesRecv, 106); // 二进制帧 = 6B 头 + payload
  l.settleReq(999, { k: 'res-chunk', id: 999 });
  assert.equal(l.res, 1);
});

test('harvestHung 超阈摘除 + lastHung + log 回调', () => {
  const l = new FrameLedger();
  const logs: string[] = [];
  l.trackReq(1, 3000, '/slow');
  const out = l.harvestHung(Date.now() + 10_000, 9_000, (m) => logs.push(m));
  assert.equal(out.length, 1);
  assert.equal(out[0].path, '/slow');
  assert.equal(l.hung, 1);
  assert.equal(l.lastHung.length, 1);
  assert.equal(l.inFlight.size, 0);
  assert.equal(logs.length, 1);
});

test('settleReq 多帧响应：每一帧都计 bytesRecv，res 按请求只计一次（修复轮 Fix 1）', () => {
  const l = new FrameLedger();
  const req = { k: 'req', id: 1, port: 3000, method: 'GET', path: '/', headers: {} };
  l.trackReq(1, 3000, '/', req);
  const head = { k: 'res-head', id: 1, status: 200, headers: {} };
  const c1 = { k: 'res-chunk', id: 1, data: new Uint8Array(100) };
  const c2 = { k: 'res-chunk', id: 1, data: new Uint8Array(50) };
  l.settleReq(1, head);
  l.settleReq(1, c1);
  l.settleReq(1, c2);
  assert.equal(l.res, 1, 'res 仍按请求只计一次（delete-gate 内）');
  assert.equal(
    l.bytesRecv,
    wireBytes(head) + wireBytes(c1) + wireBytes(c2),
    'res-head 之后的每个 res-chunk 都是线上字节，必须计入（与 host meterDc 对账口径）',
  );
});

test('wireBytes：Uint8Array → 6+len；JSON → 序列化长度；环形 → 0', () => {
  assert.equal(wireBytes({ data: new Uint8Array(10) }), 16);
  assert.equal(wireBytes({ k: 'pong', t: 1 }), JSON.stringify({ k: 'pong', t: 1 }).length);
  const cyc: any = {}; cyc.self = cyc;
  assert.equal(wireBytes(cyc), 0);
});

test('sampleWireStats：浏览器判据 selected===true；首拍建基线，增量累进 + pathType', () => {
  const l = new FrameLedger();
  const pair = { type: 'candidate-pair', id: 'p1', state: 'succeeded', selected: true, localCandidateId: 'l1', bytesSent: 1000, bytesReceived: 2000 };
  const local = { type: 'local-candidate', id: 'l1', candidateType: 'relay' };
  l.sampleWireStats([pair, local]);
  assert.equal(l.pathType, 'relay');
  assert.equal(l.wireBytesSent, 0, '首拍只建基线不计增量');
  assert.equal(l.wireBytesRecv, 0);
  l.sampleWireStats([{ ...pair, bytesSent: 1400, bytesReceived: 2600 }, local]);
  assert.equal(l.wireBytesSent, 400);
  assert.equal(l.wireBytesRecv, 600);
});

test('sampleWireStats：无选定对不污染；nominated 优先；计数回退负增量钳零', () => {
  const l = new FrameLedger();
  l.sampleWireStats([{ type: 'candidate-pair', id: 'p1', state: 'in-progress' }]);
  assert.equal(l.pathType, 'unknown');
  assert.equal(l.wireBytesSent, 0);
  const stats = [
    { type: 'candidate-pair', id: 'p1', state: 'succeeded', localCandidateId: 'l1', bytesSent: 1, bytesReceived: 1 },
    { type: 'candidate-pair', id: 'p2', state: 'succeeded', nominated: true, localCandidateId: 'l2', bytesSent: 9, bytesReceived: 9 },
    { type: 'local-candidate', id: 'l2', candidateType: 'srflx' },
  ];
  l.sampleWireStats(stats);
  assert.equal(l.pathType, 'direct');
  l.sampleWireStats([{ ...stats[1], bytesSent: 3, bytesReceived: 3 }, stats[2]]);
  assert.equal(l.wireBytesSent, 0, 'pc 重置计数回退：负增量钳零');
});

test('sampleWireStats：双侧规则——local prflx + remote relay → relay（F8 真机实证形态）', () => {
  const l = new FrameLedger();
  const pair = { type: 'candidate-pair', id: 'p1', state: 'succeeded', nominated: true, localCandidateId: 'l1', remoteCandidateId: 'r1', bytesSent: 100, bytesReceived: 200 };
  l.sampleWireStats([pair, { type: 'local-candidate', id: 'l1', candidateType: 'prflx' }, { type: 'remote-candidate', id: 'r1', candidateType: 'relay' }]);
  assert.equal(l.pathType, 'relay', '任一端 relay 即中继，只看本端会漏报');
  l.sampleWireStats([pair, { type: 'local-candidate', id: 'l1', candidateType: 'prflx' }, { type: 'remote-candidate', id: 'r1', candidateType: 'srflx' }]);
  assert.equal(l.pathType, 'direct', '两端均直连候选才是 direct');
});

test('noteTunnelFrame：tunnel 响应帧计入 wire 桶且 pathType=tunnel', () => {
  const l = new FrameLedger();
  l.noteTunnelFrame({ k: 'res-chunk', id: 1, dataB64: 'AAAA' });
  assert.equal(l.pathType, 'tunnel');
  assert.ok(l.wireBytesRecv > 0, '隧道响应帧字节入 wire 桶');
});
