import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChannelMessage, handleProxyMessage } from './signaling-web.js';
import { encodeResChunkBin, encodeWsMsgBin } from 'p2p-net/browser';

test('proxy 通道任何合法帧都是活性证明（不独厚 pong）', () => {
  // 2026-09-23 真机实证：批量传输期间 ctrl 心跳被饿死/丢失，15s 无 pong 误判死亡拆连。
  // 数据帧在流本身就是活着的证据——res-chunk 也必须刷新心跳。
  let proofs = 0;
  const frames: unknown[] = [];
  const sinks = { onProof: () => { proofs += 1; }, onFrame: (m: unknown) => frames.push(m) };
  handleProxyMessage(JSON.stringify({ k: 'res-chunk', id: 1, dataB64: 'x' }), sinks);
  handleProxyMessage(JSON.stringify({ k: 'pong', t: 1 }), sinks);
  handleProxyMessage(JSON.stringify({ k: 'res-head', id: 2, status: 200, headers: {} }), sinks);
  assert.equal(proofs, 3, '三帧都应记活性证明');
  assert.equal(frames.length, 3, '所有帧（含 proxy 上的 pong）都上交路由层');
});

test('非法帧：不记活性、不上交', () => {
  let proofs = 0;
  const frames: unknown[] = [];
  handleProxyMessage('not-json{{{', { onProof: () => { proofs += 1; }, onFrame: (m: unknown) => frames.push(m) });
  assert.equal(proofs, 0);
  assert.equal(frames.length, 0);
});

test('二进制帧入站：res-chunk/ws-msg 记活性并上交，Uint8Array 体不丢字节', () => {
  let proofs = 0;
  const frames: any[] = [];
  const sinks = { onProof: () => { proofs += 1; }, onFrame: (m: unknown) => frames.push(m) };
  const payload = new Uint8Array([5, 6, 7, 251]);
  handleChannelMessage(encodeResChunkBin(9, payload, false).buffer as ArrayBuffer, sinks);
  handleChannelMessage(encodeWsMsgBin(3, payload).buffer as ArrayBuffer, sinks);
  assert.equal(proofs, 2);
  assert.equal(frames[0].k, 'res-chunk');
  assert.equal(frames[0].id, 9);
  assert.deepEqual(frames[0].data, payload);
  assert.equal(frames[1].k, 'ws-msg');
  assert.equal(frames[1].wid, 3);
  assert.deepEqual(frames[1].data, payload);
});

test('二进制垃圾帧：不记活性、不上交；JSON 文本路径不受影响', () => {
  let proofs = 0;
  const frames: any[] = [];
  const sinks = { onProof: () => { proofs += 1; }, onFrame: (m: unknown) => frames.push(m) };
  handleChannelMessage(new Uint8Array([1, 2]).buffer as ArrayBuffer, sinks);
  handleChannelMessage(JSON.stringify({ k: 'res-head', id: 1, status: 200, headers: {} }), sinks);
  assert.equal(proofs, 1, '仅 JSON 合法帧记活性');
  assert.equal(frames.length, 1);
});
