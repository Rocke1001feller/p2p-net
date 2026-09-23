/**
 * 传输路径分类（Wave 1 增补，spec D9 测量支柱）：容量方程的中继率/字节因子两大参数的实测来源。
 * 方法照抄 v3 tc-accounting（DevAnyWhere-v3 cores/devanywhere-net packages/core/src/status.ts + facts.ts）。
 *
 * 判据（werift 侧，勿想当然）：candidate-pair 行**无 selected 字段**；选定对 = state==='succeeded'
 * （nominated 者亦在其中，多对时优先取 nominated）；localCandidateId → local-candidate.candidateType：
 * relay→中继，host/srflx/prflx→直连。PWA 浏览器侧用标准 selected===true（见 pwa/src/frameLedger.ts）。
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

// werift candidate-pair 无 selected 字段：选定对 = state==='succeeded'（nominated 优先）
export function selectedPairStats(stats: any[]): { pathType: PathType; wireSent: number; wireRecv: number } {
  const pairs = stats.filter((s) => s?.type === 'candidate-pair' && s.state === 'succeeded');
  const nominated = pairs.find((p) => p.nominated);
  const pair = nominated ?? pairs[0];
  if (!pair) return { pathType: 'unknown', wireSent: 0, wireRecv: 0 };
  const loc = stats.find((s) => s?.type === 'local-candidate' && s.id === pair.localCandidateId);
  return {
    pathType: classifyCandidateType(loc?.candidateType),
    wireSent: pair.bytesSent ?? 0,
    wireRecv: pair.bytesReceived ?? 0,
  };
}
