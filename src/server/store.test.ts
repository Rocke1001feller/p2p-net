import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig, loadConfig, saveAuth, loadAuth, resolveUpgradeWheel, type AppConfig } from './store.js';

test('config.json 0600 原子写 + 往返一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-store-'));
  saveConfig(dir, { supabaseUrl: 'https://x.supabase.co', publishableKey: 'k', tunnelSecret: 'ts', relays: [{ ip: '1.2.3.4' }] });
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600);
  assert.equal(loadConfig(dir).relays[0].ip, '1.2.3.4');
});

test('缺 config 报可操作错误', () => {
  assert.throws(() => loadConfig(mkdtempSync(join(tmpdir(), 'p2p-net-store-'))), /p2p-net init/);
});

test('auth.json 落盘权限 0600 且往返一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-store-'));
  // AuthState 形态（Task 14）：accessToken/refreshToken/expiresAt/uid/email
  const auth = { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, uid: 'u1', email: 'a@b.c' };
  saveAuth(dir, auth);
  assert.equal(statSync(join(dir, 'auth.json')).mode & 0o777, 0o600);
  assert.deepEqual(loadAuth(dir), auth);
});

// W2-6 Task 4：升级轮配置段（缺省全开；env P2P_NET_UPGRADE=0 强关压过 config，P2P_NET_GZIP=0 先例）
test('resolveUpgradeWheel：缺省全开', () => {
  assert.deepEqual(resolveUpgradeWheel(undefined, {}), { enabled: true });
});

test('resolveUpgradeWheel：config 关 → false；env P2P_NET_UPGRADE=0 强关（压过 config 开）', () => {
  assert.deepEqual(resolveUpgradeWheel({ enabled: false }, {}), { enabled: false });
  assert.deepEqual(resolveUpgradeWheel(undefined, { P2P_NET_UPGRADE: '0' }), { enabled: false });
  assert.deepEqual(resolveUpgradeWheel({ enabled: true }, { P2P_NET_UPGRADE: '0' }), { enabled: false });
});

test('resolveUpgradeWheel：数值段透传，缺省键不出现', () => {
  assert.deepEqual(
    resolveUpgradeWheel({ warmMs: 5000, observeMs: 9000, maxAttempts: 3 }, {}),
    { enabled: true, warmMs: 5000, observeMs: 9000, maxAttempts: 3 },
  );
});

test('config 落盘回读：upgradeWheel 段原样往返', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-store-'));
  const cfg: AppConfig = {
    supabaseUrl: 'https://x.supabase.co', publishableKey: 'k', tunnelSecret: 's',
    relays: [{ ip: '203.0.113.9' }], upgradeWheel: { enabled: false, warmMs: 5000 },
  };
  saveConfig(dir, cfg);
  const back = loadConfig(dir);
  assert.deepEqual(back.upgradeWheel, { enabled: false, warmMs: 5000 });
});
