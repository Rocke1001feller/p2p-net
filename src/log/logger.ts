/** NDJSON 分层 logger（spec §6 可观测性基建）—— 同步 appendFileSync，崩溃不丢尾。
 *  current.jsonl 超 maxBytes（默认 10MB）轮转为 <ts>.jsonl，仅留最新 maxFiles（默认 5）个；
 *  event() 写 events.jsonl，同轮转策略（轮转名 events-<ts>.jsonl）。
 *  flush() 为同步 no-op 占位：保持 API 稳定，后续若改异步不破坏调用方。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type Layer =
  | 'auth' | 'supabase' | 'signaling' | 'ice' | 'tunnel'
  | 'vps' | 'bridge' | 'scanner' | 'pairing' | 'service';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(layer: Layer, msg: string, ctx?: Record<string, unknown>): void;
  info(layer: Layer, msg: string, ctx?: Record<string, unknown>): void;
  warn(layer: Layer, msg: string, ctx?: Record<string, unknown>): void;
  error(layer: Layer, msg: string, ctx?: Record<string, unknown>): void;
  event(name: string, data: Record<string, unknown>): void;
  flush(): void;
}

export interface LoggerOpts {
  dir: string;
  comp: string;
  maxBytes?: number;
  maxFiles?: number;
}

export function createLogger(opts: LoggerOpts): Logger {
  const { dir, comp } = opts;
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 5;
  mkdirSync(dir, { recursive: true });

  const curPath = join(dir, 'current.jsonl');
  const evPath = join(dir, 'events.jsonl');
  let curSize = existsSync(curPath) ? statSync(curPath).size : 0;
  let evSize = existsSync(evPath) ? statSync(evPath).size : 0;

  /** base 文件轮转为 <prefix><ts>.jsonl（毫秒冲突时加 -N 后缀），并修剪到最新 maxFiles 个。 */
  function rotate(base: string, prefix: string): void {
    let name = `${prefix}${Date.now()}`;
    for (let i = 1; existsSync(join(dir, `${name}.jsonl`)); i++) name = `${prefix}${Date.now()}-${i}`;
    renameSync(join(dir, base), join(dir, `${name}.jsonl`));
    const rotated = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && (prefix === '' ? /^\d/.test(f) : f.startsWith(prefix)))
      .sort();
    for (const f of rotated.slice(0, Math.max(0, rotated.length - maxFiles))) unlinkSync(join(dir, f));
  }

  function write(level: Level, layer: Layer, msg: string, ctx?: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, comp, layer, msg, ...ctx }) + '\n';
    if (curSize > maxBytes) {
      rotate('current.jsonl', '');
      curSize = 0;
    }
    appendFileSync(curPath, line);
    curSize += Buffer.byteLength(line);
  }

  function event(name: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), comp, name, ...data }) + '\n';
    if (evSize > maxBytes) {
      rotate('events.jsonl', 'events-');
      evSize = 0;
    }
    appendFileSync(evPath, line);
    evSize += Buffer.byteLength(line);
  }

  return {
    debug: (layer, msg, ctx) => write('debug', layer, msg, ctx),
    info: (layer, msg, ctx) => write('info', layer, msg, ctx),
    warn: (layer, msg, ctx) => write('warn', layer, msg, ctx),
    error: (layer, msg, ctx) => write('error', layer, msg, ctx),
    event,
    flush: () => {},
  };
}
