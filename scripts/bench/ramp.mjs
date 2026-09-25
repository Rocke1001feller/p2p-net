#!/usr/bin/env node
/**
 * W2-3 饱和压测 driver 的 ramp 数学与统计纯函数（零依赖 ESM）。
 *
 * 被 scripts/bench/tunnel-saturation.mjs（driver）与
 * src/tests/bench-driver.test.ts（测试）共用——判据语义单一事实源在此，
 * driver 不得另写一套。
 */

/**
 * 爬坡序列：把 total 个连接按 ratePerSec 速率摊到 tickMs 拍里。
 * 非整数每拍速率用累加器平铺余数（如 20.5/拍 → 20,21,20,21…），
 * 末拍收零头，保证 Σticks === total 严格成立。
 *
 * @param {{total:number, ratePerSec:number, tickMs:number}} opts
 * @returns {number[]} 每拍应建连接数
 */
export function benchRamp({ total, ratePerSec, tickMs }) {
  if (!Number.isFinite(total) || total <= 0) throw new Error(`benchRamp: total 必须为正数，得 ${total}`);
  if (!Number.isFinite(ratePerSec) || ratePerSec <= 0) throw new Error(`benchRamp: ratePerSec 必须为正数，得 ${ratePerSec}`);
  if (!Number.isFinite(tickMs) || tickMs <= 0) throw new Error(`benchRamp: tickMs 必须为正数，得 ${tickMs}`);
  const perTick = (ratePerSec * tickMs) / 1000;
  const ticks = [];
  let built = 0;
  let acc = 0;
  while (built < total) {
    acc += perTick;
    let n = Math.floor(acc);
    acc -= n;
    if (built + n > total) n = total - built; // 末拍收零头
    ticks.push(n);
    built += n;
  }
  return ticks;
}

/**
 * 样本汇总：成功率 + p95（最近秩法）。
 * 失败样本（ok:false）计入 okRate 分母，但**不进** p95——其 rttMs 占位值
 * （如 0）会把延迟分布拉假。p95 仅对成功样本的 rttMs 取最近秩。
 *
 * @param {{ok:boolean, rttMs:number}[]} samples
 * @returns {{okRate:number, p95Ms:number|null}} 空样本/全失败时 p95Ms=null
 */
export function summarize(samples) {
  if (samples.length === 0) return { okRate: 0, p95Ms: null };
  const okRtts = samples.filter((s) => s.ok).map((s) => s.rttMs).sort((a, b) => a - b);
  const okRate = okRtts.length / samples.length;
  if (okRtts.length === 0) return { okRate, p95Ms: null };
  const rank = Math.ceil(0.95 * okRtts.length);
  return { okRate, p95Ms: okRtts[rank - 1] };
}

/**
 * 饱和判据（v0.3.x 标定口径）：30s 滑窗内
 *   - 新建连接成功率 < 95%，或
 *   - 心跳 p95 RTT > 3× 基线（基线未建立或为 0 时此判据跳过——0×3=0 是退化
 *     阈值，本机 loopback 亚毫秒基线下不得误报）。
 * 返回触发原因列表（人读），未饱和返回 null。
 *
 * @param {{connOkRate:number, hbP95Ms:number|null, baselineP95Ms:number|null}} windowStat
 * @returns {string[]|null}
 */
export function checkSaturated({ connOkRate, hbP95Ms, baselineP95Ms }) {
  const reasons = [];
  if (connOkRate < 0.95) reasons.push(`新建成功率 ${connOkRate.toFixed(3)} < 0.95`);
  if (baselineP95Ms !== null && baselineP95Ms > 0 && hbP95Ms !== null && hbP95Ms > 3 * baselineP95Ms) {
    reasons.push(`心跳 p95 ${hbP95Ms}ms > 3×基线 ${baselineP95Ms}ms`);
  }
  return reasons.length > 0 ? reasons : null;
}
