/** 浏览器侧 NAT facts 采集器（Wave 2 W2-2）单测：注入假 PC 工厂（构造 candidate
 *  字符串序列），不打真实外网、不起真实 RTCPeerConnection。判定语义与 host 侧同源
 *  （judgeMappingConsistency 经 p2p-net/browser 单一事实源）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { collectNatFactsWeb, parseSrflxCandidate, stunOnlyServers, type PcLike } from './natfacts-web.js';

const HOST_CAND = 'candidate:1 1 udp 2113937151 192.168.1.2 51234 typ host generation 0';
const srflx = (ip: string, port: number): string =>
  `candidate:2 1 udp 1686052607 ${ip} ${port} typ srflx raddr 192.168.1.2 rport 51234 generation 0`;

/** 假 PC 工厂：每台 PC 在 setLocalDescription 后按脚本吐 candidate（null = gathering 结束）。 */
function fakePcFactory(scripts: (string | null)[][], state?: { created: number; closed: number }) {
  let i = 0;
  return (_cfg: { iceServers: RTCIceServer[] }): PcLike => {
    if (state) state.created += 1;
    const script = scripts[i++] ?? [];
    const pc: PcLike = {
      onicecandidate: null,
      createDataChannel: () => ({}),
      createOffer: async () => ({ type: 'offer', sdp: 'v=0 fake' }),
      setLocalDescription: async () => {
        for (const c of script) pc.onicecandidate?.({ candidate: c === null ? null : { candidate: c } });
      },
      close: () => {
        if (state) state.closed += 1;
      },
    };
    return pc;
  };
}

const STUN = [{ urls: ['stun:10.0.0.1:3478'] }];

test('parseSrflxCandidate：srflx 提取 ip/port；host/relay/畸形 → null', () => {
  assert.deepEqual(parseSrflxCandidate(srflx('1.2.3.4', 4000)), { ip: '1.2.3.4', port: 4000 });
  assert.equal(parseSrflxCandidate(HOST_CAND), null);
  assert.equal(parseSrflxCandidate('candidate:3 1 udp 255 10.0.0.1 5000 typ relay raddr 1.2.3.4 rport 4000'), null);
  assert.equal(parseSrflxCandidate('garbage'), null);
});

test('两个 PC 同映射 → endpoint-independent，servers=2；port 变 → endpoint-dependent', async () => {
  const state = { created: 0, closed: 0 };
  const f1 = await collectNatFactsWeb(STUN, 500, fakePcFactory([
    [HOST_CAND, srflx('1.2.3.4', 4000), null],
    [srflx('1.2.3.4', 4000), null],
  ], state));
  assert.deepEqual(f1, { hasSrflx: true, srflxPortStable: null, mappingConsistency: 'endpoint-independent', servers: 2 });
  assert.equal(state.created, 2, '计划钉死：两个 PC 实例各取首个 srflx');
  assert.equal(state.closed, 2, '采集完必须 close，不留悬挂');

  const f2 = await collectNatFactsWeb(STUN, 500, fakePcFactory([
    [srflx('1.2.3.4', 4000), null],
    [srflx('1.2.3.4', 4001), null],
  ]));
  assert.equal(f2.mappingConsistency, 'endpoint-dependent');
  assert.equal(f2.servers, 2);
});

test('无 srflx（对称/全阻）→ hasSrflx=false、servers=0、不抛', async () => {
  const facts = await collectNatFactsWeb(STUN, 500, fakePcFactory([[HOST_CAND, null], [null]]));
  assert.deepEqual(facts, { hasSrflx: false, srflxPortStable: null, mappingConsistency: 'unknown', servers: 0 });
});

test('单 PC 拿到 srflx → servers=1、mappingConsistency=unknown（单观测不可判）', async () => {
  const facts = await collectNatFactsWeb(STUN, 500, fakePcFactory([[srflx('1.2.3.4', 4000), null], [null]]));
  assert.deepEqual(facts, { hasSrflx: true, srflxPortStable: null, mappingConsistency: 'unknown', servers: 1 });
});

test('PC 沉默（无 candidate 事件）→ 超时退化，不抛不悬挂', async () => {
  const state = { created: 0, closed: 0 };
  const t0 = Date.now();
  const facts = await collectNatFactsWeb(STUN, 80, fakePcFactory([[], []], state));
  assert.ok(Date.now() - t0 < 2_000, '应按注入的超时返回');
  assert.deepEqual(facts, { hasSrflx: false, srflxPortStable: null, mappingConsistency: 'unknown', servers: 0 });
  assert.equal(state.closed, 2, '超时也必须 close 两个 PC');
});

test('stunOnlyServers：turn:/turns: 转 stun:/stuns:（探针只要 binding，不要 TURN 分配），去重去凭据', () => {
  const out = stunOnlyServers([
    { urls: ['turn:10.0.0.1:3478?transport=udp'], username: 'u', credential: 'c' },
    { urls: 'turns:10.0.0.2:5349' },
    { urls: ['stun:10.0.0.3:3478', 'stun:10.0.0.3:3478'] },
  ]);
  assert.equal(out.length, 1);
  const urls = (out[0] as { urls: string[] }).urls;
  assert.deepEqual(urls.sort(), ['stun:10.0.0.1:3478?transport=udp', 'stun:10.0.0.3:3478', 'stuns:10.0.0.2:5349'].sort());
  assert.ok(!('username' in out[0]!), 'stun binding 无需凭据，不下发');
});

test('无可用 STUN url（空 iceServers）→ 立即退化，不建 PC', async () => {
  const state = { created: 0, closed: 0 };
  const facts = await collectNatFactsWeb([], 80, fakePcFactory([[srflx('1.2.3.4', 4000)]], state));
  assert.deepEqual(facts, { hasSrflx: false, srflxPortStable: null, mappingConsistency: 'unknown', servers: 0 });
  assert.equal(state.created, 0, '没有 STUN 目标时建 PC 无意义');
});
