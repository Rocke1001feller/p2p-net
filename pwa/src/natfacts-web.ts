/**
 * 浏览器侧 NAT facts 采集器（Wave 2 W2-2）：两个 RTCPeerConnection 实例各取首个
 * srflx candidate 的 ip/port（浏览器无法 raw STUN——采集器与 host 侧不同属正当边界，
 * 但 facts 语义相同），判定调 p2p-net/browser 的同一个 judgeMappingConsistency（schema
 * 单一事实源，禁止在本目录建孪生——twin-guard 门禁）。
 *
 * 退化语义（采集失败静默，绝不抛）：
 *  - 无 srflx（对称 NAT/UDP 全阻）→ hasSrflx:false、servers:0；
 *  - 单 PC 拿到 srflx → servers:1、mappingConsistency:'unknown'（单观测不可判）；
 *  - web 侧两轮来自不同本地端点（独立 PC），无法测同端点时域稳定性 → srflxPortStable 恒 null；
 *  - 浏览器不给 candidate 的服务器归属 → servers 退化为成功采集到 srflx 的 PC 数
 *    （语义：可达 STUN 端点数下限）。
 */

import { judgeMappingConsistency, type NatFacts, type SrflxObservation } from 'p2p-net/browser';

const DEFAULT_TIMEOUT_MS = 3_000;

/** ICE candidate 事件最小面（RTCPeerConnectionIceEvent 同形，测试注入假 PC 的缝）。 */
export interface IceCandidateEventLike {
  candidate: { candidate: string } | null;
}

/** RTCPeerConnection 最小结构面。 */
export interface PcLike {
  onicecandidate: ((ev: IceCandidateEventLike) => void) | null;
  createDataChannel(label: string): unknown;
  createOffer(): Promise<{ type: string; sdp: string }>;
  setLocalDescription(desc: { type: string; sdp: string }): Promise<void>;
  close(): void;
}

export type PcFactory = (cfg: { iceServers: RTCIceServer[] }) => PcLike;

const defaultPcFactory: PcFactory = (cfg) => new RTCPeerConnection(cfg) as unknown as PcLike;

const DEGENERATE: NatFacts = { hasSrflx: false, srflxPortStable: null, mappingConsistency: 'unknown', servers: 0 };

/** candidate 字符串解析：`... <ip> <port> typ srflx ...` → srflx 观测；非 srflx/畸形 → null。 */
export function parseSrflxCandidate(candidate: string): SrflxObservation | null {
  const parts = candidate.trim().split(/\s+/);
  const typIdx = parts.indexOf('typ');
  if (typIdx < 0 || parts[typIdx + 1] !== 'srflx') return null;
  const ip = parts[4];
  const port = Number(parts[5]);
  if (!ip || !Number.isInteger(port)) return null;
  return { ip, port };
}

/**
 * 探针只要 STUN binding：turn:/turns: 转 stun:/stuns:（同机 coturn 同一端口应答 binding，
 * 避免探针 PC 触发 TURN 分配税），stun: 原样保留，去重去凭据。
 */
export function stunOnlyServers(iceServers: RTCIceServer[]): RTCIceServer[] {
  const urls: string[] = [];
  for (const srv of iceServers) {
    const list = Array.isArray(srv.urls) ? srv.urls : [srv.urls];
    for (const u of list) {
      if (typeof u !== 'string') continue;
      const stun = u.replace(/^turns:/, 'stuns:').replace(/^turn:/, 'stun:');
      if (/^stuns?:/.test(stun) && !urls.includes(stun)) urls.push(stun);
    }
  }
  return urls.length ? [{ urls }] : [];
}

/** 单 PC：空 datachannel + createOffer 触发 gathering，取首个 srflx；结束/超时/出错 → null。 */
function gatherFirstSrflx(pcFactory: PcFactory, iceServers: RTCIceServer[], timeoutMs: number): Promise<SrflxObservation | null> {
  return new Promise((resolve) => {
    let done = false;
    let pc: PcLike;
    try {
      pc = pcFactory({ iceServers });
    } catch {
      resolve(null);
      return;
    }
    const finish = (obs: SrflxObservation | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        pc.close();
      } catch { /* best-effort */ }
      resolve(obs);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) {
        finish(null); // gathering 结束仍无 srflx（对称/全阻）
        return;
      }
      const srflx = parseSrflxCandidate(ev.candidate.candidate);
      if (srflx) finish(srflx);
    };
    try {
      pc.createDataChannel('natfacts'); // 无 m 段的 offer 不触发 ICE gathering
      void pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => finish(null));
    } catch {
      finish(null);
    }
  });
}

/**
 * 采两轮（两个 PC 实例，各取首个 srflx），汇总为 NatFacts。绝不抛：
 * 无可用 STUN url 立即退化；单轮失败/超时/畸形静默降级（不阻断调用方的连接流程）。
 */
export async function collectNatFactsWeb(
  stunUrls: RTCIceServer[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  pcFactory: PcFactory = defaultPcFactory,
): Promise<NatFacts> {
  const servers = stunOnlyServers(stunUrls);
  if (servers.length === 0) return DEGENERATE;
  const [o1, o2] = await Promise.all([
    gatherFirstSrflx(pcFactory, servers, timeoutMs),
    gatherFirstSrflx(pcFactory, servers, timeoutMs),
  ]);
  const got = [o1, o2].filter((o): o is SrflxObservation => o !== null);
  if (got.length === 0) return DEGENERATE;
  return {
    hasSrflx: true,
    srflxPortStable: null,
    mappingConsistency: judgeMappingConsistency(got),
    servers: got.length,
  };
}
