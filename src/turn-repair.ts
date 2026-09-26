/**
 * W2-7：werift TURN 438 stale-nonce 恢复循环。
 *
 * 这是对上游缺陷的兜底（同 consent-watchdog 哲学），不是修复上游。
 * 证据：e2e/n3-turn-transport-and-coturn-forensics.md §2.5（2026-09-26 判别实验）。
 *
 * 根因链（werift 0.24.4 ice/src/turn/protocol.js）：
 *  - coturn stale-nonce 默认 600s，先于第二次 allocation REFRESH（+997s）过期——每会话必撞 438；
 *  - requestWithRetry(:493-524) 对 438 只重试一次；并发 438（REFRESH 与 ChannelBind 刷新
 *    同为 500s 周期、同相在飞）的 nonce 竞态下单次重试未止血（实测 30 条/14s/零成功）；
 *  - refresh 循环(:337-364) catch 后睡满 500s > 剩余 lifetime → allocation 必死 →
 *    数据面黑洞 → PWA 15s pong 饿死 → 整会话重建（17min 钟表级死亡）。
 *
 * 本模块在安装点对 TurnProtocol.prototype.requestWithRetry 做一层包裹：
 * 原实现先跑（保留其 401/438 单次重试语义），438 抛出后进入**有界恢复循环**——
 * 取 438 响应携带的最新 nonce 立即重试，默认最多 4 次（25ms×attempt 退避，≤250ms）。
 * 只认 438：其余错误（401 收尾、403、网络错误）原样抛出，行为不变。
 *
 * 触及的未文档化接口：TurnProtocol.prototype.{request,nonce,server}、
 * Message.{transactionId,getAttributeValue}——全部特性检测；werift 跨 minor 升级时
 * src/tests/turn-repair.test.ts 的形状守卫会红，强制人工复核。
 */

import { randomBytes } from 'node:crypto';
import { TurnProtocol } from 'werift';

export interface Turn438RepairEvent {
  /** recovered=循环内恢复；exhausted=循环耗尽仍 438；aborted=438 后撞非 438 原样抛出；skipped_shape=原型形状不符未安装 */
  outcome: 'recovered' | 'exhausted' | 'aborted' | 'skipped_shape';
  /** 恢复循环实际消耗的重试次数（不含原实现的尝试） */
  attempts: number;
  /** 触发请求的 STUN method（werift methods 枚举值） */
  method?: number;
  ms: number;
  err?: string;
}

export interface Turn438RepairOptions {
  onEvent?: (e: Turn438RepairEvent) => void;
  /** 恢复循环最大重试次数，默认 4（438 每次都带新 nonce，竞态窗口为毫秒级） */
  maxAttempts?: number;
  /** 退避基数 ms，第 n 次重试前睡 baseDelayMs*n，默认 25（上限合计 250ms） */
  baseDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 25;

interface TurnProtoInternal {
  request(request: unknown, addr: unknown): Promise<unknown>;
  nonce?: unknown;
  server?: unknown;
}

interface StaleNonce {
  nonce: unknown;
  addr?: unknown;
}

function read438(err: unknown): StaleNonce | null {
  const e = err as {
    response?: { getAttributeValue?: (key: string) => unknown };
    addr?: unknown;
  } | null;
  if (!e || typeof e.response?.getAttributeValue !== 'function') return null;
  const errorCode = e.response.getAttributeValue('ERROR-CODE');
  if (!Array.isArray(errorCode) || errorCode[0] !== 438) return null;
  const nonce = e.response.getAttributeValue('NONCE');
  if (nonce === undefined || nonce === null) return null;
  return { nonce, addr: e.addr };
}

let installed = false;

export function installTurn438Repair(opts: Turn438RepairOptions = {}): boolean {
  if (installed) return true;
  const proto = TurnProtocol.prototype as unknown as Record<string, unknown>;
  if (typeof proto.requestWithRetry !== 'function' || typeof proto.request !== 'function') {
    opts.onEvent?.({ outcome: 'skipped_shape', attempts: 0, ms: 0 });
    return false;
  }
  const original = proto.requestWithRetry as (
    this: TurnProtoInternal,
    request: unknown,
    addr: unknown,
  ) => Promise<unknown>;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);

  proto.requestWithRetry = async function (
    this: TurnProtoInternal,
    request: { transactionId: Buffer; messageMethod?: number },
    addr: unknown,
  ): Promise<unknown> {
    let first: unknown;
    try {
      return await original.call(this, request, addr);
    } catch (err) {
      first = err;
    }
    let stale = read438(first);
    if (!stale) throw first;
    const started = Date.now();
    let attempts = 0;
    let lastErr: unknown = first;
    while (attempts < maxAttempts) {
      attempts += 1;
      this.nonce = stale.nonce;
      if (Array.isArray(stale.addr)) this.server = stale.addr;
      request.transactionId = randomBytes(12);
      if (baseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempts));
      }
      try {
        const result = await this.request(request, this.server ?? addr);
        opts.onEvent?.({
          outcome: 'recovered',
          attempts,
          method: request.messageMethod,
          ms: Date.now() - started,
        });
        return result;
      } catch (err) {
        lastErr = err;
        const next = read438(err);
        if (!next) {
          // 服务器变卦（438 后撞非 438）：原样抛出，但必须留痕——这正是最该可观测的时刻
          opts.onEvent?.({
            outcome: 'aborted',
            attempts,
            method: request.messageMethod,
            ms: Date.now() - started,
            err: String(err),
          });
          throw err;
        }
        stale = next;
      }
    }
    opts.onEvent?.({
      outcome: 'exhausted',
      attempts,
      method: request.messageMethod,
      ms: Date.now() - started,
      err: String(lastErr),
    });
    throw lastErr;
  };
  installed = true;
  return true;
}
