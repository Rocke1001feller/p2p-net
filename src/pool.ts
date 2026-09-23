/**
 * proxy 通道池（2026-09-23 Wave 1，spec D2）：队头阻塞（HOL）治理的同构纯函数层。
 * Node host 与 PWA 共用（经 browser.ts barrel 出包）——通道对象只依赖最小结构
 * （bufferedAmount/readyState），werift RTCDataChannel 与浏览器原生均满足。
 */

/** 池化选路所需的最小通道结构。 */
export interface PooledChannel {
  readonly bufferedAmount: number;
  readonly readyState?: string;
}

/** 池大小钉死 4（spec D2）：1 条请求面 + 3 条余量，真机标定前不再拍脑袋加通道。 */
export const PROXY_POOL_SIZE = 4;

/** open 通道中 bufferedAmount 最小者的下标；无可选通道 → -1。稀疏数组留洞跳过。 */
export function pickLeastBufferedIdx(chs: readonly (PooledChannel | undefined)[]): number {
  let best = -1;
  let bestAmt = Infinity;
  for (let i = 0; i < chs.length; i++) {
    const c = chs[i];
    if (!c) continue;
    if (c.readyState !== undefined && c.readyState !== 'open') continue;
    if (c.bufferedAmount < bestAmt) { bestAmt = c.bufferedAmount; best = i; }
  }
  return best;
}

/** 通道 label → 池下标：'proxy'（0.1.0 单通道兼容）→ 0，'proxyN' → N；非法/越界 → -1。 */
export function proxyLabelIdx(label: string): number {
  if (label === 'proxy') return 0;
  const m = /^proxy(\d+)$/.exec(label);
  if (!m) return -1;
  const n = Number(m[1]);
  return n >= 0 && n < 16 ? n : -1;
}
