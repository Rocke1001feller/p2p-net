import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeFrame,
  decodeFrame,
  chunkB64,
  isReq,
  isReqAbort,
  isResHead,
  isResChunk,
  isWsOpen,
  isWsOpenOk,
  isWsOpenErr,
  isWsMsg,
  isWsClose,
  isPing,
  isPong,
  encodeResChunkBin,
  encodeWsMsgBin,
  decodeBinFrame,
  isBinFrame,
  chunkU8,
} from '../frames.js';

test('encodeFrame/decodeFrame 往返一致（全部帧型）', () => {
  const frames: unknown[] = [
    { k: 'req', id: 1, port: 3000, method: 'GET', path: '/x?y=1', headers: { 'x-a': 'b' }, bodyB64: null },
    { k: 'req', id: 2, port: 3001, method: 'POST', path: '/', headers: {}, bodyB64: 'aGVsbG8=' },
    { k: 'req-abort', id: 3 },
    { k: 'res-head', id: 4, status: 200, headers: { 'content-type': 'text/plain' } },
    { k: 'res-chunk', id: 5, dataB64: 'YQ==', done: false },
    { k: 'res-chunk', id: 5, done: true },
    { k: 'ws-open', wid: 6, path: '/ws' },
    { k: 'ws-open-ok', wid: 6 },
    { k: 'ws-open-err', wid: 6 },
    { k: 'ws-msg', wid: 6, text: 'hi' },
    { k: 'ws-msg', wid: 6, dataB64: 'AAEC' },
    { k: 'ws-close', wid: 6, code: 1000, reason: 'bye' },
    { k: 'ping', t: 1725600000000 },
    { k: 'pong', t: 1725600000000 },
  ];
  for (const f of frames) {
    const buf = encodeFrame(f);
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual(decodeFrame(buf), f);
  }
});

test('decodeFrame 非法 JSON → null', () => {
  assert.equal(decodeFrame(Buffer.from('not-json{')), null);
  assert.equal(decodeFrame(Buffer.from('')), null);
});

test('chunkB64 边界：0 / 16384 / 16385 字节', () => {
  assert.deepEqual(chunkB64(Buffer.alloc(0)), []);

  const exact = Buffer.alloc(16384, 7);
  const pieces1 = chunkB64(exact);
  assert.equal(pieces1.length, 1);
  assert.deepEqual(Buffer.from(pieces1[0], 'base64'), exact);

  const over = Buffer.alloc(16385, 9);
  const pieces2 = chunkB64(over);
  assert.equal(pieces2.length, 2);
  assert.equal(Buffer.from(pieces2[0], 'base64').length, 16384);
  assert.equal(Buffer.from(pieces2[1], 'base64').length, 1);
  assert.deepEqual(Buffer.concat(pieces2.map((p) => Buffer.from(p, 'base64'))), over);
});

test('type guards 收窄', () => {
  assert.equal(isReq({ k: 'req', id: 1, method: 'GET', path: '/' }), true); // 老 POC 无 port 也可收窄，port 校验归 bridge（400 帧）
  assert.equal(isReq({ k: 'req', id: 1, port: 3000, method: 'GET', path: '/' }), true);
  assert.equal(isReq({ k: 'res-head' }), false);
  assert.equal(isReq(null), false);
  assert.equal(isReqAbort({ k: 'req-abort', id: 2 }), true);
  assert.equal(isResHead({ k: 'res-head', id: 3, status: 200, headers: {} }), true);
  assert.equal(isResChunk({ k: 'res-chunk', id: 4 }), true);
  assert.equal(isWsOpen({ k: 'ws-open', wid: 5, path: '/w' }), true);
  assert.equal(isWsOpenOk({ k: 'ws-open-ok', wid: 5 }), true);
  assert.equal(isWsOpenErr({ k: 'ws-open-err', wid: 5 }), true);
  assert.equal(isWsMsg({ k: 'ws-msg', wid: 5, text: 'x' }), true);
  assert.equal(isWsMsg({ k: 'ws-msg', wid: 5, dataB64: 'x' }), true);
  assert.equal(isWsMsg({ k: 'ws-msg', wid: 5 }), false);
  assert.equal(isWsClose({ k: 'ws-close', wid: 5, code: 1000 }), true);
  assert.equal(isPing({ k: 'ping', t: 1 }), true);
  assert.equal(isPong({ k: 'pong', t: 1 }), true);
  assert.equal(isPing({ k: 'pong', t: 1 }), false);
});

test('二进制 res-chunk 往返：含 payload / 仅 done', () => {
  const payload = new Uint8Array([1, 2, 3, 250]);
  assert.deepEqual(decodeBinFrame(encodeResChunkBin(42, payload, false)), { k: 'res-chunk', id: 42, data: payload });
  assert.deepEqual(decodeBinFrame(encodeResChunkBin(42, null, true)), { k: 'res-chunk', id: 42, done: true });
});

test('二进制 ws-msg 往返 + 大 id 无符号（>2^31）', () => {
  const payload = new Uint8Array([0, 159, 146, 150]);
  assert.deepEqual(decodeBinFrame(encodeWsMsgBin(7, payload)), { k: 'ws-msg', wid: 7, data: payload });
  const f = decodeBinFrame(encodeResChunkBin(0xf0000001, null, true));
  assert.equal(f?.k, 'res-chunk');
  assert.equal((f as { id: number }).id, 0xf0000001);
});

test('decodeBinFrame 拒垃圾：JSON 文本 / 短帧 / 未知 kind → null', () => {
  assert.equal(decodeBinFrame(new TextEncoder().encode('{"k":"res-chunk","id":1}')), null);
  assert.equal(decodeBinFrame(new Uint8Array([1, 2])), null);
  assert.equal(decodeBinFrame(new Uint8Array([9, 0, 0, 0, 1, 0])), null);
  assert.equal(isBinFrame(new TextEncoder().encode('{"k":"ping"}')), false);
});

test('chunkU8 边界：16384 / 16385 字节，原始字节不经过 base64', () => {
  const exact = new Uint8Array(16384).fill(7);
  assert.equal(chunkU8(exact).length, 1);
  const over = new Uint8Array(16385).fill(9);
  const pieces = chunkU8(over);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].length, 16384);
  assert.equal(pieces[1].length, 1);
});
