/** 隧道腿计量（F10：/status 对隧道腿失明——成本模型缺最贵变量）。
 *  钉死的语义：
 *  - 账本 pathType 恒 'tunnel'；字节口径与 PeerSession 一致（JSON 帧串长度，
 *    ws 帧头/压缩开销不计——注释须如实标注）；
 *  - 入站：isReq → req++；任何帧字节都计 bytesRecv；
 *  - 出站：res-chunk 且 done=true → resDone++（head/未完成 chunk 不计）；
 *  - 出站非 JSON 串（防御）：字节照计、不抛异常、resDone 不误增；
 *  - 多帧逐次累计，进程期不清零（隧道腿无 host 侧会话生命周期）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TunnelMeter } from './meter.js';

test('入站 req 帧：req 计数 + 字节累计；非 req 帧只计字节', () => {
  const m = new TunnelMeter();
  m.recordInbound({ k: 'req', id: 1, port: 3001, method: 'GET', path: '/s/3001/api', headers: {}, via: 'tunnel' });
  assert.equal(m.ledger.req, 1);
  const afterReq = m.ledger.bytesRecv;
  assert.ok(afterReq > 0);
  assert.equal(m.ledger.wireBytesRecv, afterReq, '隧道 wire 口径 = JSON 帧长');
  m.recordInbound({ k: 'ws-msg', wid: 1, text: 'x' });
  assert.equal(m.ledger.req, 1, 'ws-msg 不是 req');
  assert.ok(m.ledger.bytesRecv > afterReq, '任何入站帧都计字节');
});

test('出站：仅 res-chunk done=true 计 resDone；字节全计', () => {
  const m = new TunnelMeter();
  m.recordOutbound(JSON.stringify({ k: 'res-head', id: 1, status: 200, headers: {} }));
  assert.equal(m.ledger.resDone, 0, 'res-head 不是完成');
  m.recordOutbound(JSON.stringify({ k: 'res-chunk', id: 1, dataB64: 'aGk=', done: false }));
  assert.equal(m.ledger.resDone, 0, '未完成的 chunk 不计');
  m.recordOutbound(JSON.stringify({ k: 'res-chunk', id: 1, dataB64: '', done: true }));
  assert.equal(m.ledger.resDone, 1);
  assert.ok(m.ledger.bytesSent > 0);
  assert.equal(m.ledger.wireBytesSent, m.ledger.bytesSent);
});

test('出站非法 JSON：字节照计、不抛、不误增 resDone', () => {
  const m = new TunnelMeter();
  m.recordOutbound('not-json{{{');
  assert.equal(m.ledger.resDone, 0);
  assert.equal(m.ledger.bytesSent, Buffer.byteLength('not-json{{{'));
});

test('pathType 恒 tunnel；多帧逐次累计', () => {
  const m = new TunnelMeter();
  assert.equal(m.ledger.pathType, 'tunnel');
  for (let i = 1; i <= 3; i++) {
    m.recordInbound({ k: 'req', id: i, port: 3001, method: 'GET', path: '/s/3001/x', headers: {}, via: 'tunnel' });
    m.recordOutbound(JSON.stringify({ k: 'res-chunk', id: i, dataB64: '', done: true }));
  }
  assert.equal(m.ledger.req, 3);
  assert.equal(m.ledger.resDone, 3);
});
