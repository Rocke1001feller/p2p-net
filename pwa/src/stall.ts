/**
 * stallSuspect（2026-09-23 Wave 1，spec D5）：徽章双驱动的「疑似卡顿」判定。
 *
 * 要灭掉的谎言（60min 浸泡实录）：链路自报 connected、ctrl 心跳 5s 一拍正常、
 * 徽章绿油油——但数据面已 587s 零回帧，用户以为"好好的"，其实在干等。
 * 三条件全真才亮黄灯：① 控制面活着（非 tunnel 且心跳新鲜）；② 有在途请求；
 * ③ 数据面全局静默超阈（默认 5s：短于 WEDGE 60s 判死线，长于正常首帧排队）。
 * 缺一不亮：心跳死了是「断」不是「卡」（走拆连）；空闲链路静默是常态。
 */
export interface StallInput {
  /** 控制面活着（cascade.isOpen：dc open 且心跳新鲜；tunnel 模式调用方恒传 false）。 */
  ctrlAlive: boolean;
  /** 在途请求数（inflightSw.size）。 */
  inFlight: number;
  /** 数据面全局静默时长 ms（liveness.silentFor()）。 */
  silentMs: number;
  /** 静默阈值（默认 5s；URL 参数真机标定可改）。 */
  thresholdMs?: number;
}

export function stallSuspect({ ctrlAlive, inFlight, silentMs, thresholdMs = 5_000 }: StallInput): boolean {
  return ctrlAlive && inFlight > 0 && silentMs > thresholdMs;
}
