/** 会话事件流（Task 19）：p2p-net 的可观测性主干。
 *
 *  两个原语，皆为纯函数/薄封装：
 *  - recordSessionEvent：事件直写 Logger.event（events.jsonl；轮转归 logger 管，本模块不持久化）。
 *  - aggregateSessions：事件序列 → /status 的 sessions 实时聚合（纯函数，可单测）。
 *
 *  聚合口径（plan 裁决 #4，events.test.ts 钉死）：
 *  - active：有 session_start 且无 session_end 的 sid 数（end 后立即摘掉；同 sid 重开即新会话，
 *    旧 mode/rtt 不残留）。
 *  - byMode：只统计活跃会话**最新**一条 cascade_choice 的 mode。
 *  - avgRttMs：活跃会话最新 rttMs 的均值；无人带 rtt（或无活跃会话）时为 null。
 *  - 垃圾容忍：end-without-start / 对未开会话发 cascade_choice / 空 sid 一律忽略，绝不抛。
 *    （事件环形缓冲满后旧 start 被挤出，后到的 end 天然会撞上 end-without-start。）
 *
 *  纪律：SessionEvent 只带 sid/mode/rtt/bytes/reason/pathType——token/secret/URL 绝不进事件（start.ts
 *  装配处同纪律）。
 */

import type { Logger } from '../log/logger.js';
import type { PathType } from '../pathType.js';

export interface SessionEvent {
  name: 'session_start' | 'session_end' | 'cascade_choice' | 'tunnel_reconnect';
  /** 会话标识：WebRTC 会话为客户端 deviceId；tunnel_reconnect 为 relay ip。 */
  sid: string;
  mode?: 'p2p' | 'relay' | 'tunnel';
  rttMs?: number;
  bytesUp?: number;
  bytesDown?: number;
  /** 会话终态路径类型与 wire 字节（Wave 1 增补，spec D9）：host 视角 getStats 选定对增量。 */
  pathType?: PathType;
  wireBytesUp?: number;
  wireBytesDown?: number;
  /** 接入类型分桶（Wave 2 W2-1）：PWA 侧标注经 offer meta 流入；缺省/旧版 = 'unknown'。
   *  取值域：'cellular-ct'|'cellular-cu'|'cellular-other'|'wifi-home'|'wifi-office'|'other'|'unknown'。 */
  access?: string;
  reason?: string;
}

export interface SessionsSummary {
  active: number;
  byMode: Record<string, number>;
  avgRttMs: number | null;
}

/** 直写 log.event：name 出列作事件名，其余字段原样进 data（保持这个厚度，不加工）。 */
export function recordSessionEvent(log: Logger, e: SessionEvent): void {
  const { name, ...data } = e;
  log.event(name, data);
}

/** 事件序列 → 会话聚合（纯函数）。输入乱序/残缺不抛，按上开口径尽力聚合。 */
export function aggregateSessions(events: SessionEvent[]): SessionsSummary {
  const sessions = new Map<string, { mode?: string; rttMs?: number }>();
  for (const e of events) {
    if (!e || typeof e.sid !== 'string' || e.sid === '') continue;
    if (e.name === 'session_start') {
      sessions.set(e.sid, {}); // 重开即新会话：旧 mode/rtt 清零
    } else if (e.name === 'session_end') {
      sessions.delete(e.sid); // end-without-start 天然 no-op
    } else if (e.name === 'cascade_choice') {
      const s = sessions.get(e.sid);
      if (!s) continue; // 未开会话的模式更新属噪声（如环形缓冲已挤出其 start），忽略
      if (typeof e.mode === 'string') s.mode = e.mode;
      if (typeof e.rttMs === 'number' && Number.isFinite(e.rttMs)) s.rttMs = e.rttMs;
    }
    // tunnel_reconnect：与会话聚合计数无关
  }

  const byMode: Record<string, number> = {};
  const rtts: number[] = [];
  for (const s of sessions.values()) {
    if (s.mode !== undefined) byMode[s.mode] = (byMode[s.mode] ?? 0) + 1;
    if (s.rttMs !== undefined) rtts.push(s.rttMs);
  }
  return {
    active: sessions.size,
    byMode,
    avgRttMs: rtts.length > 0 ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
  };
}
