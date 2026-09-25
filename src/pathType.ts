/**
 * 传输路径分类（Wave 1 增补，spec D9 测量支柱）：容量方程的中继率/字节因子两大参数的实测来源。
 * 方法照抄 v3 tc-accounting（DevAnyWhere-v3 cores/devanywhere-net packages/core/src/status.ts + facts.ts）。
 *
 * 判据双形态（2026-09-25 机制甲1：原 PWA 孪生副本已消灭，host 与 PWA 共用本实现）：
 * - werift：candidate-pair 行**无 selected 字段**；选定对 = state==='succeeded'（nominated 优先）。
 * - 浏览器：selected===true 优先，回退 nominated/首个 succeeded。
 * werift 行永远不带 selected，故统一判据对 werift 输入严格等价于旧「仅 state」判据。
 * **双侧规则**：localCandidateId/remoteCandidateId 两端的 candidateType 任一为 relay → 中继
 * （F8 实证：本端 srflx/prflx ↔ 对端 relay 是同一条对，只看本端两侧会判出相反结论）；
 * 两端均 host/srflx/prflx → 直连；remote 行缺失回落本端判定。
 * PWA 经 'p2p-net/browser' 消费本模块（见 src/browser.ts）；双侧语义一致性由共享语料
 * contracts/path-type-corpus.json + src/tests|pwa/src 两侧 *.parity.ts 机械钉死（机制甲3/丙1）。
 */

export type PathType = 'direct' | 'relay' | 'tunnel' | 'unknown';

export function classifyCandidateType(ct: string | undefined): PathType {
  if (ct === 'relay') return 'relay';
  if (ct === 'host' || ct === 'srflx' || ct === 'prflx') return 'direct';
  return 'unknown';
}

// 帧级归类：隧道网关转发的帧带 via:'tunnel'，与 getStats 判定正交（tunnel 段不过 DataChannel）
export function classifyVia(via: string | undefined): PathType {
  return via === 'tunnel' ? 'tunnel' : 'unknown';
}

/** 选定对 stats 归类。found=false 表示当前快照无选定对（ICE 重建中等）——
 *  调用方据此跳过本轮累计（既不污染 pathType 也不动增量基线）。 */
export function selectedPairStats(stats: any[]): { pathType: PathType; wireSent: number; wireRecv: number; found: boolean } {
  // 双形态选定对判据：selected===true（浏览器）→ nominated → 首个 succeeded；werift 无 selected 字段，
  // 对该输入严格退化为旧判据（state==='succeeded'，nominated 优先）。
  const pairs = stats.filter((s) => s?.type === 'candidate-pair' && (s.selected === true || s.state === 'succeeded'));
  const pair = pairs.find((p) => p.selected === true) ?? pairs.find((p) => p.nominated) ?? pairs[0];
  if (!pair) return { pathType: 'unknown', wireSent: 0, wireRecv: 0, found: false };
  const loc = stats.find((s) => s?.type === 'local-candidate' && s.id === pair.localCandidateId);
  const rem = stats.find((s) => s?.type === 'remote-candidate' && s.id === pair.remoteCandidateId);
  // 双侧规则（F8 真机实证，与 status.ts pairTypeFromStats 同源）：任一端 relay 候选即过 TURN——
  // 只看本端会把「本端 srflx/prflx ↔ 对端 relay」的同一条对误判成直连（两侧各自看本端，结论相反）。
  const locType = classifyCandidateType(loc?.candidateType);
  const remType = classifyCandidateType(rem?.candidateType);
  const pathType = locType === 'relay' || remType === 'relay' ? 'relay'
    : locType !== 'unknown' ? locType
    : remType;
  return {
    pathType,
    wireSent: pair.bytesSent ?? 0,
    wireRecv: pair.bytesReceived ?? 0,
    found: true,
  };
}
