// addIce 去 ufrag 兜底的行为锁（2026-09-12 真机根因）
import test from 'node:test';
import assert from 'node:assert/strict';
import { Peer, type PcLike } from './peer.js';

// 最小 PcLike stub：带 ufrag 的候选一律拒绝（复现 werift "No media section matched ..."），
// 去掉 ufrag 后接受。
function makePcStub(): { pc: PcLike; added: any[]; } {
  const added: any[] = [];
  const pc: any = {
    connectionState: 'new',
    localDescription: null,
    ondatachannel: null,
    onicecandidate: null,
    oniceconnectionstatechange: null,
    onconnectionstatechange: null,
    async setRemoteDescription() {},
    async setLocalDescription() { this.localDescription = { type: 'answer', sdp: 'v=0' }; return this.localDescription; },
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; },
    async createAnswer() { return { type: 'answer', sdp: 'v=0' }; },
    async addIceCandidate(c: any) {
      if (c.usernameFragment) throw new Error('No media section matched the ICE username fragment');
      added.push(c);
    },
    createDataChannel(label: string) { return { label, readyState: 'connecting', send() {}, close() {} } as any; },
    async getStats() { return new Map(); },
    close() {},
  };
  return { pc, added };
}

test('同会话 ufrag 对不上时，去 ufrag 兜底仍能把候选加进去', async () => {
  const { pc, added } = makePcStub();
  const peer = new Peer([], { transport: 'all', pcFactory: () => pc });
  await peer.acceptOffer('sid-1', { type: 'offer', sdp: 'v=0' }, {
    onIce: () => {}, onChannel: () => {}, onStatus: () => {},
  });
  await peer.addIce({ candidate: 'candidate:1 1 UDP 1 1.2.3.4 5000 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ufrag-mismatch' });
  assert.equal(added.length, 1, '兜底必须把候选加进去（否则 ICE 候选集残缺 → 数据面时通时断）');
  assert.equal(added[0].usernameFragment, undefined, '兜底时不得再带 ufrag');
});

test('真正不可用的候选仍然被隔离（不会抛出去拖垮连接环）', async () => {
  const pc: any = makePcStub().pc;
  pc.addIceCandidate = async () => { throw new Error('bad candidate'); };
  const peer = new Peer([], { transport: 'all', pcFactory: () => pc });
  await peer.acceptOffer('sid-2', { type: 'offer', sdp: 'v=0' }, {
    onIce: () => {}, onChannel: () => {}, onStatus: () => {},
  });
  await assert.doesNotReject(peer.addIce({ candidate: 'x', usernameFragment: 'u' }));
});
