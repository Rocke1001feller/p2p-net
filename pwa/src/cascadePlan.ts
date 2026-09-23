/**
 * 级联段落规划（纯函数，从 session.ts 抽离便于单测）。
 * dev 覆盖语义以 URL 参数文档为准：?transport=relay = 只跑 TURN 段（smoke TURN 变体）。
 * 2026-09-23 修复：旧实现 forceTurn 仍保留 tunnel 段，强制中继验收时永远被隧道截胡。
 */
export type StageMode = 'p2p' | 'tunnel' | 'turn';

export function planStageModes(opts: { forceTurn?: boolean; forceTunnel?: boolean; p2pFullIce?: boolean }): StageMode[] {
  if (opts.forceTunnel) return ['tunnel'];
  if (opts.forceTurn) return ['turn'];
  return ['p2p', 'tunnel', 'turn'];
}
