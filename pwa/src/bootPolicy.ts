/**
 * boot 自动连接目标裁决（2026-09-24 真机门禁 F6）。
 *
 * 旧行为：boot() 只在 desk.id 存在时自动 startConnect，而 desk.id 只来自 URL 票据
 * （/connect?t=&d= 扫码直达）。普通重进（无 ?t=）停在设备页等人点卡——已配对用户
 * 每次回来都要手动点一次，与「扫码即登录」的形态矛盾（真机冷启动实测实锤）。
 *
 * 裁决（用户拍板 2026-09-25：缺陷，修复）：已登录且无票据时，自动重连最近桌面
 * （LS_DESK_ID 记忆）；从未配过对则无目标，停在设备页（首次使用原行为）。
 */

export interface BootTargetCtx {
  /** auth.getSession() 有活跃会话。 */
  loggedIn: boolean;
  /** URL 票据带来的 deskId（?t=&d= 扫码直达；无票据为空串）。 */
  ticketDeskId: string;
  /** 本地记忆的最近连接桌面（LS_DESK_ID；无记忆为 null）。 */
  lastDeskId: string | null;
}

export function bootConnectTarget(c: BootTargetCtx): string | null {
  if (!c.loggedIn) return null; // 未登录走扫码/票据兑换路由，不在此决策
  if (c.ticketDeskId) return c.ticketDeskId;
  return c.lastDeskId || null;
}
