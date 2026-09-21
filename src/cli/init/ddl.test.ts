import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync('supabase/ddl/0001_core.sql', 'utf8');

test('DDL 幂等标记齐全', () => {
  assert.match(sql, /create table if not exists/i);
  assert.match(sql, /create or replace function/i);
  assert.match(sql, /drop policy if exists/i);
});

test('剥离商业逻辑：无 invites/claim/seed', () => {
  assert.doesNotMatch(sql, /invites|claim_|seed_|turnstile/i);
});

test('三张核心表 + bind_device_auth 都在', () => {
  for (const needle of ['devices', 'pairing_tickets', 'signaling_messages', 'bind_device_auth']) {
    assert.ok(sql.includes(needle), `缺 ${needle}`);
  }
});

test('signaling RLS 房间前缀约束 sig:<uid>:', () => {
  assert.match(sql, /sig:/);
  assert.match(sql, /auth\.uid\(\)/);
});
