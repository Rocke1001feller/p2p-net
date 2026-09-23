import test from 'node:test';
import assert from 'node:assert/strict';
import type { RTCDataChannel } from 'werift';
import { PeerSession } from '../host.js';

function stubDc(): { dc: RTCDataChannel; sent: (string | Uint8Array)[]; state: { bufferedAmount: number } } {
  const sent: (string | Uint8Array)[] = [];
  const state = { bufferedAmount: 0 };
  const dc = {
    readyState: 'open',
    onmessage: null as null | ((ev: { data: unknown }) => void),
    send(d: string | Uint8Array) { sent.push(typeof d === 'string' ? d : new Uint8Array(d)); },
    close() { /* noop */ },
  } as unknown as RTCDataChannel;
  Object.defineProperty(dc, 'bufferedAmount', { get: () => state.bufferedAmount });
  return { dc, sent, state };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function feedReq(dc: RTCDataChannel, id: number, port = 1): void {
  dc.onmessage!({ data: JSON.stringify({ k: 'req', id, port, method: 'GET', path: '/', headers: {} }) });
}

test('res 帧落最闲通道而非到达通道；onSettled 后 reqDc 清空', async () => {
  const s = new PeerSession(undefined, () => true);
  const a = stubDc(); const b = stubDc(); const c = stubDc();
  s.wireChannel(a.dc, 'proxy'); s.wireChannel(b.dc, 'proxy1'); s.wireChannel(c.dc, 'proxy2');
  a.state.bufferedAmount = 500_000; // 到达通道最忙 → res 应选 b/c
  feedReq(a.dc, 1);                 // port 1：localhost ECONNREFUSED → 502 两帧
  await until(() => b.sent.length + c.sent.length >= 2);
  assert.equal(a.sent.length, 0, 'res 不得回到达通道');
  await until(() => (s as any).reqDc.size === 0);
});

test('ws-open 选最闲并粘滞；ws-close 删映射', async () => {
  const s = new PeerSession(1, () => true);
  const a = stubDc(); const b = stubDc();
  s.wireChannel(a.dc, 'proxy'); s.wireChannel(b.dc, 'proxy1');
  a.state.bufferedAmount = 500_000;
  const open = { k: 'ws-open', wid: 7, path: '/', port: 1 };
  a.dc.onmessage!({ data: JSON.stringify(open) });
  await until(() => b.sent.length >= 1); // open-err（port 1 无 ws 服务）落 b
  assert.deepEqual([...(s as any).widDc.keys()], [7]);
  a.dc.onmessage!({ data: JSON.stringify({ k: 'ws-close', wid: 7, code: 1000 }) });
  assert.equal((s as any).widDc.size, 0);
});

test('两会话隔离：A 的选路与计数不污染 B（Review Focus #4）', async () => {
  const s1 = new PeerSession(undefined, () => true);
  const s2 = new PeerSession(undefined, () => true);
  const a1 = stubDc(); const a2 = stubDc();
  s1.wireChannel(a1.dc, 'proxy'); s2.wireChannel(a2.dc, 'proxy');
  feedReq(a1.dc, 1);
  await until(() => a1.sent.length >= 2);
  assert.equal(a2.sent.length, 0);
  assert.equal((s2 as any).reqDc.size, 0);
});
