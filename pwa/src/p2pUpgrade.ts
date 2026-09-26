/**
 * tunnel→p2p 升级控制器（2026-09-26 用户裁决：做好了就是利润——p2p 零成本，隧道 0.95 元/GB）。
 *
 * 隧道会话期间按节拍跑旁路 p2p 尝试（make-before-break：旁路 WebRtcSession 建成才热切换，
 * 失败仅付 KB 级信令税，隧道服务无感）。首探 60s，连败退避 ×2（默认 480s 封顶——ep-dep NAT
 * 先验低成功率，密集尝试纯属浪费）。成功 → adopted 终态；隧道切走/断开 → stop。
 * 纯逻辑：时钟注入；attempt 由 shell 装配（旁路会话 + adoptP2pUpgrade）。
 */
export interface P2pUpgradeOpts {
  isTunnelActive: () => boolean;
  /** 一次旁路升级尝试：true = 已建成并被 adopt（控制器进终态）；false/抛错 = 失败走退避。 */
  attempt: () => Promise<boolean>;
  firstDelayMs?: number;
  backoffCapMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (t: unknown) => void;
}

export type P2pUpgradeState = 'idle' | 'probing' | 'adopted';

export class P2pUpgrade {
  private readonly firstDelayMs: number;
  private readonly backoffCapMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (t: unknown) => void;
  private timer: unknown = null;
  private stopped = true;
  private st: P2pUpgradeState = 'idle';
  private fails = 0;

  constructor(private readonly opts: P2pUpgradeOpts) {
    this.firstDelayMs = opts.firstDelayMs ?? 60_000;
    this.backoffCapMs = opts.backoffCapMs ?? 480_000;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((t) => clearTimeout(t as Parameters<typeof clearTimeout>[0]));
  }

  get state(): P2pUpgradeState { return this.st; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.st = 'idle';
    this.fails = 0;
    this.schedule(this.firstDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) { this.clearTimeoutFn(this.timer); this.timer = null; }
  }

  private schedule(ms: number): void {
    this.timer = this.setTimeoutFn(() => void this.tick(), ms);
  }

  private nextDelay(): number {
    // fails=0 后的第一次失败 → 120s（首拍 60s 已在 schedule(start) 用过），其后 ×2 封顶
    return Math.min(this.firstDelayMs * 2 ** (this.fails + 1), this.backoffCapMs);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    if (!this.opts.isTunnelActive()) { this.stopped = true; return; } // 隧道已切走：使命终结
    this.st = 'probing';
    let ok = false;
    try { ok = await this.opts.attempt(); } catch { ok = false; } // 抛错=失败，静默走退避
    if (this.stopped) return;
    if (ok) { this.st = 'adopted'; this.stopped = true; return; }
    this.st = 'idle';
    this.schedule(this.nextDelay());
    this.fails += 1;
  }
}
