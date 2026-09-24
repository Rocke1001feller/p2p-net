/**
 * 数据面活性判定（2026-09-23 中继洪泛事故整改）。
 *
 * 事故：中继模式加载 devanywhere-ui 时 host 在 125ms 内向有序 DataChannel 灌入 ~6MB
 * chunk（8MiB 背压未触发），蜂窝 TURN 线速远低于此；后发请求的 res-head 排在大文件
 * chunk 之后，>9s 零回帧。旧看门狗按「单请求 9s 无首帧」判死，拆掉了**健康但慢**的
 * 连接 → 重建重灌 → 死循环白屏。
 *
 * 正确口径：看门狗要检测的是**黑洞**（全局零字节流动），不是**慢**（首帧在排队）。
 * 只要有任何回帧在流，链路即活；慢由 SW 自身超时与背压上限去兜。
 */
export const WEDGE_MS = 60_000; // 全局无任何回帧多久算黑洞（建连宽限同此值）
// 2026-09-23 蜂窝浸泡放宽 20s→60s：洪泛期手机端（中端机 + 大 JS 解析占线程）排空变慢，
// 25-40s 的静默是「慢」不是「死」，20s 阈值把可完成的传输拦腰拆连，且重连触发全量重下
// 构成死亡螺旋。真黑洞由 SW 单请求 45s 超时先兜（用户先看到 504 而非整页白屏）。

export class DataPlaneLiveness {
  private lastProofAt = 0;

  /** wedgeMs 入 constructor（N4，spec D7）：缺省 WEDGE_MS；URL ?wedge= 真机标定由 shell 注入。 */
  constructor(private readonly wedgeMs: number = WEDGE_MS) {}

  /** 建连成功记一笔：新连接给完整宽限窗口。 */
  noteOpen(now = Date.now()): void {
    this.lastProofAt = now;
  }

  /** 任何数据面回帧（res-head/res-chunk/ws-*）都算活性证明。 */
  noteFrame(now = Date.now()): void {
    this.lastProofAt = now;
  }

  /** 判死条件：有在途请求 且 全局静默超阈。无在途请求的空闲链路永不拆。 */
  wedged(inflight: number, now = Date.now()): boolean {
    if (inflight <= 0) return false;
    return now - this.lastProofAt > this.wedgeMs;
  }

  /** 诊断：距上次活性证明多久（ms），供日志浮层/状态导出。 */
  silentFor(now = Date.now()): number {
    return now - this.lastProofAt;
  }
}
