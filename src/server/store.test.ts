import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig, loadConfig } from './store.js';

test('config.json 0600 原子写 + 往返一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-store-'));
  saveConfig(dir, { supabaseUrl: 'https://x.supabase.co', publishableKey: 'k', tunnelSecret: 'ts', relays: [{ ip: '1.2.3.4' }] });
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600);
  assert.equal(loadConfig(dir).relays[0].ip, '1.2.3.4');
});

test('缺 config 报可操作错误', () => {
  assert.throws(() => loadConfig(mkdtempSync(join(tmpdir(), 'p2p-net-store-'))), /p2p-net init/);
});
