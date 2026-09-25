/**
 * 级联段落规划（纯函数，从 session.ts 抽离便于单测）。
 * dev 覆盖语义以 URL 参数文档为准：?transport=relay = 只跑 TURN 段（smoke TURN 变体）。
 * 2026-09-23 修复：旧实现 forceTurn 仍保留 tunnel 段，强制中继验收时永远被隧道截胡。
 *
 * 级联顺序裁决（2026-09-26 W2-4 复审【实测-本仓】，e2e/wave2-cascade-review-2026-09-26.md）：
 * **维持 p2p → tunnel → turn 不变**。tunnel 建连 p50 358-733ms vs TURN 4350-5437ms
 * （快 7.4-12.2×，Android/iPhone 蜂窝各 N=10）；折算单价隧道 ≈0.94-0.96 元/GB ≤
 * TURN ≈1.02 元/GB——时延与成本两维度同向。残留两发现登记待查：
 * ① Android WebView 强制 TURN 时 UI 显示「直连」但 host events=relay（stats 形态差异）；
 * ② iPhone Safari 强制 TURN 4/10 超时（疑分配竞争，未定性）。
 */
export type StageMode = 'p2p' | 'tunnel' | 'turn';

export function planStageModes(opts: { forceTurn?: boolean; forceTunnel?: boolean; p2pFullIce?: boolean }): StageMode[] {
  if (opts.forceTunnel) return ['tunnel'];
  if (opts.forceTurn) return ['turn'];
  return ['p2p', 'tunnel', 'turn'];
}
