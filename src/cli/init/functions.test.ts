import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('turn-credentials 不再硬编码 host', () => {
  const src = readFileSync('supabase/functions/turn-credentials/index.ts', 'utf8');
  assert.doesNotMatch(src, /39\.106\.59\.183/);
  assert.match(src, /TURN_HOSTS/);
  assert.match(src, /TURN_STATIC_AUTH_SECRET/);
});

test('redeem-pairing-ticket 原子消费 pending 票', () => {
  const src = readFileSync('supabase/functions/redeem-pairing-ticket/index.ts', 'utf8');
  assert.match(src, /pending/);
  assert.match(src, /generate_link/);
});

// 2026-09-22 真机实锤：Management API 内联源码部署通道不解析远程 import，
// jsr:/https:/npm: 一律 BOOT_ERROR 503（本仓 turn-credentials 用 node: 内置模块不受影响）。
test('edge functions 禁止远程 import（inline 部署通道不解析）', () => {
  for (const slug of ['redeem-pairing-ticket', 'turn-credentials']) {
    const src = readFileSync(`supabase/functions/${slug}/index.ts`, 'utf8');
    assert.doesNotMatch(src, /from\s+["'](?:jsr:|https?:|npm:)/, `${slug} 含远程 import`);
  }
});
