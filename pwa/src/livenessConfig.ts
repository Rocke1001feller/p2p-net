/**
 * N4 活性阈值（2026-09-23 Wave 1，spec D7）：判死参数入 config，URL 可真机标定。
 *
 * 为什么敢把 LIVENESS 从 45s 收回 15s（commit a038d8d 的 45s 是旧世界妥协）：
 *  ① pc 'failed' 事件 0ms 拆连（signaling-web emitPcStatus）——真黑洞由 ICE 层秒级上报；
 *  ② 任何数据面回帧都刷 lastPongAt（handleProxyMessage onProof）——传输期心跳被饿死不误判；
 *  ③ stall 黄灯（stall.ts）5s 示警——「慢」与「死」在用户侧分开，不再需要靠长窗口遮羞。
 * 15s = 3 拍心跳；仍拿不准时 ?liveness=45 现场标定，用真机数据说话。
 */
export interface LivenessConfig {
  /** ctrl 心跳周期（ms）。 */
  pingMs: number;
  /** 心跳断供判死窗口（ms）。 */
  livenessMs: number;
  /** 数据面全局静默判死窗口（ms，dataPlaneLiveness）。 */
  wedgeMs: number;
}

export const DEFAULT_LIVENESS: LivenessConfig = { pingMs: 5_000, livenessMs: 15_000, wedgeMs: 60_000 };

/** URL ?ping=&liveness=&wedge=（秒）覆盖——真机标定专用，不进生产默认。 */
export function livenessFromQuery(q: URLSearchParams): LivenessConfig {
  const sec = (name: string, dflt: number): number => {
    const v = Number(q.get(name));
    return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : dflt;
  };
  return {
    pingMs: sec('ping', DEFAULT_LIVENESS.pingMs),
    livenessMs: sec('liveness', DEFAULT_LIVENESS.livenessMs),
    wedgeMs: sec('wedge', DEFAULT_LIVENESS.wedgeMs),
  };
}
