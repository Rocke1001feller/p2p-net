import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logger.js';

test('写入合法 NDJSON 且带 layer/ctx', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2pnet-log-'));
  const log = createLogger({ dir, comp: 'test' });
  log.info('vps', 'hello', { ip: '1.2.3.4' });
  log.flush();
  const line = readFileSync(join(dir, 'current.jsonl'), 'utf8').trim();
  const rec = JSON.parse(line);
  assert.equal(rec.comp, 'test');
  assert.equal(rec.layer, 'vps');
  assert.equal(rec.ip, '1.2.3.4');
});

test('event 写入 events.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2pnet-log-'));
  const log = createLogger({ dir, comp: 'test' });
  log.event('session_end', { sid: 's1', mode: 'relay', rttMs: 120 });
  log.flush();
  const rec = JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim());
  assert.equal(rec.name, 'session_end');
  assert.equal(rec.mode, 'relay');
});

test('超过 maxBytes 触发轮转，保留 maxFiles 个', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2pnet-log-'));
  const log = createLogger({ dir, comp: 'test', maxBytes: 1024, maxFiles: 3 });
  for (let i = 0; i < 200; i++) log.info('service', 'x'.repeat(50));
  log.flush();
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length <= 4, `files=${files}`); // current + 至多3个轮转
});
