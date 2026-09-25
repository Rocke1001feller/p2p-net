#!/usr/bin/env node
/**
 * 接入类型 × 路径类型矩阵（Wave 2 W2-1）：events.jsonl → stdout 矩阵表。
 *
 * 用法：node scripts/access-matrix.mjs [events.jsonl 路径]（缺省 ~/.p2p-net/logs/events.jsonl）
 *
 * 口径（计划钉死）：
 * - join session_start(access) × session_end(pathType) by sid；同 sid 重开取最新 start。
 * - 无 access 字段的 start 一律计入 'unknown' 桶（Review Focus #1：旧版 PWA 兼容）。
 * - 样本 <20 的单元格标注「N不足」（cost-model §6.1：N<20 的点估计禁止外推）。
 * - 孤儿 end（无 start 配对）忽略，不抛。
 *
 * 零依赖纯 Node（Node 20+）；buildAccessMatrix/renderAccessMatrix 为纯函数，供单测 import。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 外推禁令阈值（cost-model §6.1）：样本数低于此值的单元格标注 N不足。 */
export const MIN_SAMPLE = 20;

/** 矩阵列（pathType 取值域，与 src/pathType.ts 同序）。 */
const PATH_TYPES = ['direct', 'relay', 'tunnel', 'unknown'];

const norm = (v) => (typeof v === 'string' && v !== '' ? v : 'unknown');

/**
 * 事件对象序列 → { matrix, samples }。
 * matrix: Map<access, Map<pathType, number>>（仅 start+end 配对成功的会话）；
 * samples: Map<access, number>（全部 session_start 计数，含未配对）。
 */
export function buildAccessMatrix(events) {
  const starts = new Map(); // sid → access
  const matrix = new Map();
  const samples = new Map();
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const name = e.name ?? e.event;
    if (typeof e.sid !== 'string' || e.sid === '') continue;
    if (name === 'session_start') {
      const access = norm(e.access);
      starts.set(e.sid, access);
      samples.set(access, (samples.get(access) ?? 0) + 1);
    } else if (name === 'session_end') {
      const access = starts.get(e.sid);
      if (access === undefined) continue; // 孤儿 end：忽略
      const pathType = norm(e.pathType);
      const row = matrix.get(access) ?? new Map();
      row.set(pathType, (row.get(pathType) ?? 0) + 1);
      matrix.set(access, row);
    }
  }
  return { matrix, samples };
}

/** { matrix, samples } → 文本矩阵表（行 access 字母序，列 pathType 固定序，末列样本数）。 */
export function renderAccessMatrix({ matrix, samples }, minN = MIN_SAMPLE) {
  const accesses = [...new Set([...samples.keys(), ...matrix.keys()])].sort();
  const cell = (access, p) => {
    const n = matrix.get(access)?.get(p) ?? 0;
    return n < minN ? `${n} (N不足)` : String(n);
  };
  const header = ['access', ...PATH_TYPES, 'sessions'];
  const rows = accesses.map((a) => [a, ...PATH_TYPES.map((p) => cell(a, p)), String(samples.get(a) ?? 0)]);
  if (rows.length === 0) rows.push(['（无会话事件）', ...PATH_TYPES.map(() => '—'), '0']);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n') + '\n';
}

const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const path = process.argv[2] ?? join(homedir(), '.p2p-net', 'logs', 'events.jsonl');
  const events = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch { /* 坏行跳过：轮转截断/写一半的尾行不得杀死分析 */ }
  }
  process.stdout.write(renderAccessMatrix(buildAccessMatrix(events)));
}
