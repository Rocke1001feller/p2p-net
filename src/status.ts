/**
 * candidate-pair stats → 状态灯映射（纯函数）。
 *
 * 判定字段依据 Task 1 gate4 spike 取证（examples/gate4/README.md）：
 * werift 0.24.4 的 candidate-pair 行**没有 selected 字段**，选定对用 state==='succeeded'
 * （nominated 亦在）；浏览器侧是 selected===true 语法。两判据都写，state 为主——双侧通吃。
 */

/** getStats() 展平后的行（werift RTCStatsReport / 浏览器 RTCStatsReport 皆可 `.values()` 展开）。 */
export type StatsRow = Record<string, any>;

function selectedPair(rows: StatsRow[]): StatsRow | undefined {
  return rows.find((r) => r.type === 'candidate-pair' && (r.selected === true || r.state === 'succeeded'));
}

export function pairTypeFromStats(rows: StatsRow[]): 'p2p' | 'relay' | null {
  const pair = selectedPair(rows);
  if (!pair) return null;
  const local = rows.find((r) => r.id === pair.localCandidateId);
  const remote = rows.find((r) => r.id === pair.remoteCandidateId);
  // 任一端是 relay 候选，流量就必然过 TURN——本地优先的取法会漏报对端 relay
  // （2026-09-22 蜂窝真机实锤：手机 local=srflx / 桌面 local=relay，同一对两侧判定相反）。
  if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') return 'relay';
  const t = local?.candidateType ?? remote?.candidateType;
  if (t === 'host' || t === 'srflx') return 'p2p';
  return null;
}

/** ctrl 通道 ping/pong 的 RTT 是带外测的；这里取 candidate-pair 的 currentRoundTripTime（秒）兜底。 */
export function rttFromStats(rows: StatsRow[]): number | undefined {
  const pair = selectedPair(rows);
  return typeof pair?.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : undefined;
}

export function relayAddrFromStats(rows: StatsRow[]): string | undefined {
  const pair = selectedPair(rows);
  const local = rows.find((r) => r.id === pair?.localCandidateId);
  return local?.candidateType === 'relay' ? `${local.address}:${local.port}` : undefined;
}
