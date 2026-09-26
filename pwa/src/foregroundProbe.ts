/**
 * 前台探活（2026-09-26，隧道僵尸腿事件的 PWA 侧兜底）。
 *
 * 要灭掉的谎言（2026-09-25 实测）：手机浏览器后台数小时后回前台，host 通往 VPS 的
 * 隧道腿早已被中间设备静默回收（网关对 /s/* 返 502 desktop offline），但 PWA 数据面
 * 是逐请求无状态设计——没有流量就没有失败，徽章停在旧状态绿灯，四大功能静默全灭，
 * 用户无感知；host 重启恢复后，不刷新页面的用户同样不知道已经好了。
 *
 * 对策：回前台信号（visibilitychange→visible / pageshow persisted 的 bfcache 恢复）
 * 且后台时长超阈（默认 60s）且有活跃会话 → 对当前会话发一次轻量探活（shell 侧用
 * 发现端点 GET /services，dataPlaneAlive 口径，约 4s 超时）。bfcache 恢复无论时长
 * 必探：JS 冻结期间心跳与看门狗全部停走，一切活性证据皆陈旧。
 *
 * 徽章语义（绘制在 ui.ts）：
 *  - 探活进行中保持中性（不动旧徽章，失败未证实前不吓人）；
 *  - 失败 → 黄灯「连接待恢复，点我重试」，点击标题即 retry() 再探；
 *  - 成功 → 恢复原状态（黄灯本来就是覆盖层，熄灭即复原）。
 */
export interface ForegroundProbeInput {
  /** 页面不可见时长 ms；null = 本生命周期未记录到 hidden（冷启动首次 visible 等）。 */
  hiddenForMs: number | null;
  /** bfcache 恢复（pageshow persisted=true）：定时器被冻结过，活性证据一律不可信。 */
  bfcacheRestore: boolean;
  /** 当前有活跃会话（cascade.isOpen）；无会话不探——重连由既有退避循环负责。 */
  sessionActive: boolean;
  /** 不可见时长阈值（默认 60s；URL ?probehidden= 真机标定可改）。 */
  thresholdMs?: number;
}

/** 默认不可见阈值：短于此不探（短暂切后台是常态，探活浪费且无谓打扰）。 */
export const FOREGROUND_PROBE_HIDDEN_MS = 60_000;
/** 探活请求超时：够慢链路回帧，又不让用户对着黄灯干等。 */
export const FOREGROUND_PROBE_TIMEOUT_MS = 4_000;

export function shouldProbeOnForeground({
  hiddenForMs, bfcacheRestore, sessionActive, thresholdMs = FOREGROUND_PROBE_HIDDEN_MS,
}: ForegroundProbeInput): boolean {
  if (!sessionActive) return false;
  if (bfcacheRestore) return true;
  return hiddenForMs !== null && hiddenForMs > thresholdMs;
}

export interface ForegroundProbeHooks {
  /** 当前有活跃会话（cascade.isOpen）。 */
  sessionActive: () => boolean;
  /** 发一次轻量探活；true = 数据面活着。 */
  probe: () => Promise<boolean>;
  /** 徽章命令：true = 黄灯「连接待恢复，点我重试」；false = 中性/恢复原状态。 */
  setDown: (on: boolean) => void;
}

/**
 * 探活状态机（去抖与相位迁移的唯一权威）：
 * idle → probing（徽章中性）→ ok: idle（恢复原状态）/ fail: down（黄灯可点重试）。
 * pageshow 与 visibilitychange 在 bfcache 恢复时可能连发、用户可能连点，
 * inFlight 守卫保证同一时刻只有一发探活在飞。
 */
export class ForegroundProbe {
  private inFlight = false;

  constructor(
    private readonly hooks: ForegroundProbeHooks,
    private readonly hiddenThresholdMs: number = FOREGROUND_PROBE_HIDDEN_MS,
  ) {}

  /** 回前台信号入口；返回是否真的发出了探活（被判定/去抖拦下则为 false）。 */
  async onForeground(hiddenForMs: number | null, bfcacheRestore: boolean): Promise<boolean> {
    if (!shouldProbeOnForeground({
      hiddenForMs, bfcacheRestore,
      sessionActive: this.hooks.sessionActive(),
      thresholdMs: this.hiddenThresholdMs,
    })) return false;
    return this.run();
  }

  /** 黄灯点击重试：跳过触发判定直接再探（无会话仍守卫——徽章已由状态条如实交代）。 */
  async retry(): Promise<boolean> {
    if (!this.hooks.sessionActive()) return false;
    return this.run();
  }

  private async run(): Promise<boolean> {
    if (this.inFlight) return false; // 去抖防重入：连发信号/连点只探一次
    this.inFlight = true;
    this.hooks.setDown(false); // 探活进行中徽章保持中性
    try {
      const ok = await this.hooks.probe();
      this.hooks.setDown(!ok);
      return true;
    } finally {
      this.inFlight = false;
    }
  }
}
