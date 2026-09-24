/**
 * 连接失败后的动作裁决（2026-09-24 真机门禁 F3）。
 *
 * 旧行为：只有 isRetry（自动重试）失败才 scheduleReconnect；手动重试（isRetry=false）
 * 进入 startConnect 时已把 wasConnected/reconnectAttempt 清零、清掉待触发定时器——
 * 手动尝试再失败，自动重连循环就此死掉，桌面端恢复后手机仍连不上（"重连无反应"）。
 *
 * 裁决：进入 startConnect 时先捕获自动重连上下文（曾连上/退避节拍/定时器待触发），
 * 手动失败只要带上下文就恢复 scheduleReconnect；首次手动失败仍只出卡片不静默循环
 * （原设计意图：冷启动第一次连不上不应偷偷退避轮询）。
 */

export interface ReconnectCtx {
  /** 本次尝试是否为自动重试（scheduleReconnect 排入的）。 */
  isRetry: boolean;
  /** 进入 startConnect 时：本会话曾连上过。 */
  wasConnected: boolean;
  /** 进入 startConnect 时：退避节拍计数（>0 表示自动重连循环进行中）。 */
  reconnectAttempt: number;
  /** 进入 startConnect 时：已有待触发的重连定时器。 */
  timerPending: boolean;
}

export function onConnectFailure(c: ReconnectCtx): { reconnect: boolean; sheet: boolean } {
  const autoCtx = c.isRetry || c.wasConnected || c.reconnectAttempt > 0 || c.timerPending;
  return { reconnect: autoCtx, sheet: !c.isRetry };
}
