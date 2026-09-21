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
  assert.match(src, /generateLink/);
});
