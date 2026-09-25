/** 自检探针（2026-09-25 真机事故治理：458s 信令黑洞 + localhost :3001 挂起 254s/273s
 *  双症状并发却无法区分因果——当时没有任何量化留痕。debugging 优先原则：
 *  凡是能快速定位问题的可观测性建设一概必做）。
 *
 *  形态：
 *  - 每 intervalMs（默认 5s）对 scanner 发现的每个本地服务做 HTTP 级探测：
 *    必须拿到 HTTP 响应（任何状态码）才算 ok——TCP connect 测不出事件循环停顿
 *    （内核 backlog 代答握手），16:47 事故的 :3001 挂起正是这种假活；
 *  - 每目标三态机 ok|slow|fail，只在翻转时发 selfcheck_alert（稳态零噪音，
 *    类比 cascade_choice 节流教训：稳态每 5s 一条 × 4 服务 = 7 万行/日，不可接受）；
 *  - 信令面复用 HostAgent.signalingHealth 快照，0↔>0 翻转时告警（target='signaling'）；
 *  - 每 heartbeatCycles（默认 12 ≈ 60s）发一条 selfcheck_heartbeat 紧凑快照——
 *    基线对照，消除「无事件=健康还是探针死了」的歧义；
 *  - 全部经 log.event 写 events.jsonl（只带 port/延迟/错误类，无任何凭据）。
 *
 *  纪律：探针是被观测系统的旁路，自身绝不能成为故障源——逐目标 try/catch 隔离，
 *  单周期超时由 AbortSignal.timeout 兜底，stop() 后在途回调不再发射。
 */

import type { Logger } from '../log/logger.js';

/** 信令面健康快照（与 HostAgent.signalingHealth 同形 + lastPollMs；结构子集即可传入）。 */
export interface SigSnapshot {
  consecutiveFailures: number;
  lastError?: string;
  recovering: boolean;
  recreated: boolean;
  pollsOk: number;
  pollsFailed: number;
  lastPollMs?: number;
}

export interface SelfcheckTarget {
  port: number;
  name: string;
}

export interface SelfcheckOpts {
  log: Logger;
  getServices(): SelfcheckTarget[];
  /** 缺省（stub/旧装配）时心跳省略 sig 字段。 */
  signalingHealth?: () => SigSnapshot;
  intervalMs?: number;
  /** 单目标 HTTP 探测超时（默认 3000ms）：超过即判 fail——:3001 挂起 254s 那类停顿。 */
  timeoutMs?: number;
  /** ok 但延迟 ≥ 此值（默认 1000ms）进 slow 态。 */
  slowMs?: number;
  /** 每多少周期发一条心跳（默认 12，interval 5s 时 ≈ 60s）。 */
  heartbeatCycles?: number;
  fetchImpl?: typeof fetch;
}

export interface SelfcheckHandle {
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_SLOW_MS = 1_000;
const DEFAULT_HEARTBEAT_CYCLES = 12;

type TargetState = 'ok' | 'slow' | 'fail';

export function startSelfcheck(opts: SelfcheckOpts): SelfcheckHandle {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const slowMs = opts.slowMs ?? DEFAULT_SLOW_MS;
  const heartbeatCycles = opts.heartbeatCycles ?? DEFAULT_HEARTBEAT_CYCLES;
  const emit = (name: string, data: Record<string, unknown>): void => {
    if (!stopped) opts.log.event(name, data);
  };

  const targetStates = new Map<number, TargetState>();
  let sigFailing: boolean | undefined; // undefined = 首周期未采样，不告警
  let cycle = 0;
  let running = false; // 单周期串行：上一周期未落定不重叠（同 pollOnce 的 polling 闸门）
  let stopped = false;

  const probe = async (t: SelfcheckTarget): Promise<{ port: number; ok: boolean; ms?: number; err?: string }> => {
    const t0 = Date.now();
    try {
      await fetchImpl(`http://127.0.0.1:${t.port}/`, { signal: AbortSignal.timeout(timeoutMs) });
      return { port: t.port, ok: true, ms: Date.now() - t0 };
    } catch (e) {
      // 超时（TimeoutError）与连接拒绝（ECONNREFUSED）同一语义：服务不可用
      return { port: t.port, ok: false, err: e instanceof Error ? e.message : String(e) };
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const results = await Promise.all(opts.getServices().map((t) => probe(t)));
      if (stopped) return;

      for (const r of results) {
        const state: TargetState = !r.ok ? 'fail' : r.ms !== undefined && r.ms >= slowMs ? 'slow' : 'ok';
        const prev = targetStates.get(r.port);
        targetStates.set(r.port, state);
        // 首周期仅健康态静默建基线（启动期服务陆续就绪是常态）；起步即 slow/fail 都值得留痕一行
        if (prev === undefined && state === 'ok') continue;
        if (prev === state) continue;
        emit('selfcheck_alert', {
          target: `127.0.0.1:${r.port}`,
          port: r.port,
          state,
          ok: r.ok,
          ...(r.ms !== undefined ? { ms: r.ms } : {}),
          ...(r.err !== undefined ? { err: r.err } : {}),
        });
      }

      const sig = opts.signalingHealth?.();
      if (sig) {
        const failing = sig.consecutiveFailures > 0;
        // 首样本即失败也告警（与目标 fail 的「起步即失联值得留痕」同口径）；
        // 健康首样本静默建基线；此后按翻转告警。
        if (failing !== sigFailing && (sigFailing !== undefined || failing)) {
          emit('selfcheck_alert', {
            target: 'signaling',
            state: failing ? 'fail' : 'ok',
            ok: !failing,
            consecutiveFailures: sig.consecutiveFailures,
            ...(failing && sig.lastError !== undefined ? { err: sig.lastError } : {}),
          });
        }
        sigFailing = failing;
      }

      cycle++;
      if (cycle % heartbeatCycles === 0) {
        emit('selfcheck_heartbeat', {
          targets: results.map((r) => ({ port: r.port, ok: r.ok, ...(r.ms !== undefined ? { ms: r.ms } : {}) })),
          ...(sig ? { sig } : {}),
        });
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
