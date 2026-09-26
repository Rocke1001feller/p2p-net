/**
 * turn→tunnel 回迁看门狗（2026-09-26 用户裁决：中继只做短程过渡，长服务必须迁回隧道）。
 *
 * turn 会话期间按节拍（默认 60s）轻量探隧道网关：活 → onAlive（shell 触发重级联，
 * 记忆化段序会落回 tunnel）并自停；未活/抛错 → 静默排下一拍。非 turn 会话空转不探。
 * 纯逻辑：时钟由调用方注入（可测性纪律，同 ForegroundProbe/P2pUpgrade）。
 */
export interface TunnelBackcheckOpts {
  isTurnActive: () => boolean;
  probe: () => Promise<boolean>;
  onAlive: () => void;
  intervalMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (t: unknown) => void;
}

export class TunnelBackcheck {
  private readonly intervalMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (t: unknown) => void;
  private timer: unknown = null;
  private stopped = true;

  constructor(private readonly opts: TunnelBackcheckOpts) {
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((t) => clearTimeout(t as Parameters<typeof clearTimeout>[0]));
  }

  start(): void {
    if (!this.stopped) return; // 重入不双排
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) { this.clearTimeoutFn(this.timer); this.timer = null; }
  }

  private schedule(): void {
    this.timer = this.setTimeoutFn(() => void this.tick(), this.intervalMs);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    if (!this.opts.isTurnActive()) { this.stopped = true; return; } // 模式切走：使命终结
    let alive = false;
    try { alive = await this.opts.probe(); } catch { alive = false; } // 抛错=未活，静默
    if (this.stopped) return;
    if (alive) { this.stopped = true; this.opts.onAlive(); return; }
    this.schedule();
  }
}
