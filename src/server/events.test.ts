/** 会话事件流（Task 19）单测：aggregateSessions 纯函数语义 + recordSessionEvent 直写 logger。
 *  brief Step 1 钉死主用例；其余用例钉垃圾容忍（end-without-start / 重复 cascade_choice /
 *  缺 rtt / 无 mode）与「只统计活跃会话的最新 cascade_choice」口径。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Logger } from '../log/logger.js';
import { aggregateSessions, recordSessionEvent, type SessionEvent } from './events.js';

test('聚合：活跃数/模式分布/平均 RTT（brief 钉死用例）', () => {
  const agg = aggregateSessions([
    { name: 'session_start', sid: 'a' },
    { name: 'cascade_choice', sid: 'a', mode: 'relay', rttMs: 100 },
    { name: 'session_start', sid: 'b' },
    { name: 'cascade_choice', sid: 'b', mode: 'p2p', rttMs: 20 },
    { name: 'session_end', sid: 'a', reason: 'bye' },
  ]);
  assert.equal(agg.active, 1);
  assert.deepEqual(agg.byMode, { p2p: 1 });
  assert.equal(agg.avgRttMs, 20);
});

test('聚合：空事件流 → 全零（avgRttMs 为 null）', () => {
  assert.deepEqual(aggregateSessions([]), { active: 0, byMode: {}, avgRttMs: null });
});

test('聚合：同 sid 重复 cascade_choice 取最新（mode/rtt 皆以最后一次为准）', () => {
  const agg = aggregateSessions([
    { name: 'session_start', sid: 'a' },
    { name: 'cascade_choice', sid: 'a', mode: 'relay', rttMs: 100 },
    { name: 'cascade_choice', sid: 'a', mode: 'p2p', rttMs: 30 },
  ]);
  assert.deepEqual(agg, { active: 1, byMode: { p2p: 1 }, avgRttMs: 30 });
});

test('聚合：同 sid 结束后重开 → 旧的 mode/rtt 不残留（新会话从头计）', () => {
  const agg = aggregateSessions([
    { name: 'session_start', sid: 'a' },
    { name: 'cascade_choice', sid: 'a', mode: 'relay', rttMs: 100 },
    { name: 'session_end', sid: 'a' },
    { name: 'session_start', sid: 'a' },
    { name: 'cascade_choice', sid: 'a', mode: 'p2p', rttMs: 10 },
  ]);
  assert.deepEqual(agg, { active: 1, byMode: { p2p: 1 }, avgRttMs: 10 });
});

test('聚合：活跃会话但尚无 cascade_choice → byMode 不计、avgRttMs 为 null', () => {
  const agg = aggregateSessions([{ name: 'session_start', sid: 'a' }]);
  assert.deepEqual(agg, { active: 1, byMode: {}, avgRttMs: null });
});

test('聚合：多活跃会话只有部分带 rtt → 均值只算有 rtt 的', () => {
  const agg = aggregateSessions([
    { name: 'session_start', sid: 'a' },
    { name: 'cascade_choice', sid: 'a', mode: 'p2p', rttMs: 40 },
    { name: 'session_start', sid: 'b' },
    { name: 'cascade_choice', sid: 'b', mode: 'relay' }, // 无 rtt
  ]);
  assert.deepEqual(agg, { active: 2, byMode: { p2p: 1, relay: 1 }, avgRttMs: 40 });
});

test('聚合：垃圾容忍——end-without-start / 对未开会话发 cascade_choice / 缺 sid，一律不抛且不计数', () => {
  const agg = aggregateSessions([
    { name: 'session_end', sid: 'ghost', reason: 'closed' }, // 无 start 的 end：no-op
    { name: 'cascade_choice', sid: 'ghost', mode: 'p2p', rttMs: 5 }, // 无活跃会话的模式更新：忽略
    { name: 'tunnel_reconnect', sid: '1.1.1.1' }, // 与会话计数无关
    { name: 'session_start', sid: '' }, // 空 sid：忽略
  ] as SessionEvent[]);
  assert.deepEqual(agg, { active: 0, byMode: {}, avgRttMs: null });
});

test('recordSessionEvent：直写 log.event（name 出列，其余字段原样进 data），不带多余加工', () => {
  const written: Array<{ name: string; data: Record<string, unknown> }> = [];
  const log = {
    debug() {}, info() {}, warn() {}, error() {},
    event: (name: string, data: Record<string, unknown>) => written.push({ name, data }),
    flush() {},
  } as Logger;
  const e: SessionEvent = { name: 'cascade_choice', sid: 'a', mode: 'relay', rttMs: 100 };
  recordSessionEvent(log, e);
  assert.deepEqual(written, [{ name: 'cascade_choice', data: { sid: 'a', mode: 'relay', rttMs: 100 } }]);
});

// ---- Wave 2 W2-1：接入类型分桶——access 随 session_start 透传，旧版无 access 兼容 ----

test('session_start 带 access 透传进 events.jsonl 数据', () => {
  const lines: [string, any][] = [];
  const log = { event: (n: string, d: any) => lines.push([n, d]) } as any;
  recordSessionEvent(log, { name: 'session_start', sid: 'a', access: 'cellular-ct' });
  assert.deepEqual(lines, [['session_start', { sid: 'a', access: 'cellular-ct' }]]);
});

test('无 access 的旧版会话事件不变（兼容）', () => {
  const lines: [string, any][] = [];
  const log = { event: (n: string, d: any) => lines.push([n, d]) } as any;
  recordSessionEvent(log, { name: 'session_start', sid: 'b' });
  assert.deepEqual(lines, [['session_start', { sid: 'b' }]]);
});

// ---- Wave 2 W2-2：NAT facts——紧凑串随 session_start 透传，绝不带 ip ----

test('session_start 带 nat 紧凑串透传进 events.jsonl 数据', () => {
  const lines: [string, any][] = [];
  const log = { event: (n: string, d: any) => lines.push([n, d]) } as any;
  recordSessionEvent(log, { name: 'session_start', sid: 'a', access: 'cellular-ct', nat: 'm:ep-ind,servers:2' });
  assert.deepEqual(lines, [['session_start', { sid: 'a', access: 'cellular-ct', nat: 'm:ep-ind,servers:2' }]]);
});

// ---- Wave 2 W2-6：upgrade 事件——聚合层容忍（switch 未命中即忽略，不进 active/byMode） ----

test('aggregateSessions 容忍 upgrade 事件：不计 active 不影响 byMode', () => {
  const s = aggregateSessions([
    { name: 'session_start', sid: 'a' },
    { name: 'upgrade', sid: 'a', from: 'relay', to: 'direct', ms: 800 },
  ]);
  assert.equal(s.active, 1);
});
