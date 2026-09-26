/**
 * 暖场升级轮状态机（Wave 2 W2-6；裁决：e2e/wave2-upgrade-wheel-spike-2026-09-26.md §2.4）。
 * 纯逻辑：定时器全部由调用方驱动（可测性）；host 挂 PeerSession，PWA 为执行手。
 * 状态机：warm → upgrading → direct | fallback；首连 direct 直接终态（无升级必要）。
 * 纪律：不感知地址/候选细节；emit 只带 from/to/ms（ms = 最近一次 attempt 起的驻留时长，
 * 不是数据面中断时长——中断口径见 plan Global Constraints）。
 */
export type UpgradePath = 'relay' | 'direct';
export type UpgradeState = 'warm' | 'upgrading' | 'direct' | 'fallback';

export interface UpgradeWheelOpts {
  /** relay 稳定暖场时长（默认 10s = 2 个 stats tick，STATS_INTERVAL_MS=5s）。 */
  warmMs?: number;
  /** 单次 attempt 观测窗（默认 15s = 3 tick；Safari 宽容窗，spike §2.2-4：8s 窗内可不迁）。 */
  observeMs?: number;
  /** 总 attempt 上限（默认 2 = 首发 + 重试一次）。 */
  maxAttempts?: number;
}

export type UpgradeAction =
  | { kind: 'send-upgrade' }
  | { kind: 'emit'; from: 'relay'; to: 'direct' | 'fallback'; ms: number };

export class UpgradeWheel {
  readonly warmMs: number;
  readonly observeMs: number;
  readonly maxAttempts: number;
  private st: UpgradeState = 'warm';
  private seenConnect = false;
  private attempts = 0;
  private attemptSince = 0;
  private isClosed = false;

  constructor(opts: UpgradeWheelOpts = {}) {
    this.warmMs = opts.warmMs ?? 10_000;
    this.observeMs = opts.observeMs ?? 15_000;
    this.maxAttempts = opts.maxAttempts ?? 2;
  }

  get state(): UpgradeState { return this.st; }
  get closed(): boolean { return this.isClosed; }

  /** 状态 tick 驱动（幂等）：首连定路径；warm 期自然转 direct 终态（非轮功，不 emit）。 */
  onConnected(path: UpgradePath, _now: number): null {
    if (this.isClosed) return null;
    if (!this.seenConnect) {
      this.seenConnect = true;
      if (path === 'direct') this.st = 'direct';
      return null;
    }
    if (this.st === 'warm' && path === 'direct') this.st = 'direct';
    return null;
  }

  /** 暖场计时到期：warm → upgrading，发首帧（attempt 1）。 */
  onWarmTimeout(now: number): UpgradeAction | null {
    if (this.isClosed || this.st !== 'warm' || !this.seenConnect) return null;
    this.st = 'upgrading';
    this.attempts = 1;
    this.attemptSince = now;
    return { kind: 'send-upgrade' };
  }

  /** 观测期 pairType tick：见 direct → 终态 + emit。relay 一律 null（渐近迁移继续观测）。 */
  onPairType(path: UpgradePath, now: number): UpgradeAction | null {
    if (this.isClosed || this.st !== 'upgrading' || path !== 'direct') return null;
    this.st = 'direct';
    return { kind: 'emit', from: 'relay', to: 'direct', ms: now - this.attemptSince };
  }

  /** 观测窗到期：还有次数 → 重发；否则终态 fallback + emit。 */
  onObserveTimeout(now: number): UpgradeAction | null {
    if (this.isClosed || this.st !== 'upgrading') return null;
    if (this.attempts < this.maxAttempts) {
      this.attempts += 1;
      this.attemptSince = now;
      return { kind: 'send-upgrade' };
    }
    this.st = 'fallback';
    return { kind: 'emit', from: 'relay', to: 'fallback', ms: now - this.attemptSince };
  }

  close(): void { this.isClosed = true; }
}
