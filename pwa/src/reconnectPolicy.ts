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

export interface StoppedCtx extends ReconnectCtx {
  /** 本次实例已被更新的 startConnect 取代（gen 过期）：迟到的 'stopped'。 */
  superseded: boolean;
  /** 用户主动断开（stopSession）。 */
  manualStop: boolean;
}

/**
 * connect() 抛 'stopped' 时的裁决（2026-09-25 真机门禁 F9）。
 *
 * F9 事故：看门狗在自动重试的 connect() 进行中触发 → cascade.stop() → 在途 connect 抛
 * 'stopped' → 旧 catch 无条件静默 return；同时 onCascadeStatus 的 'off' 分支要求
 * wasConnected===true（手动重试进入时已清零、重试成功才回设）→ 两侧都不 scheduleReconnect、
 * 无待触发定时器 → 自动重连循环永久死亡，页面谎称「正在重连…」，桌面端恢复也救不回来。
 *
 * 裁决：被取代/手动断开 → 静默（新实例已接管 / 手动断开语义就是杀循环）；
 * 其余外部中断（看门狗/排障 flap）视同连接失败，按 onConnectFailure 口径裁决。
 */
export function onConnectStopped(c: StoppedCtx): { reconnect: boolean; sheet: boolean } {
  if (c.superseded || c.manualStop) return { reconnect: false, sheet: false };
  return onConnectFailure(c);
}
