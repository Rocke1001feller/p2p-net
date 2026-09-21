import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PORTS } from './contracts.js';

test('PORTS 与 contracts/ports.json 一致', () => {
  const raw = JSON.parse(readFileSync(new URL('../contracts/ports.json', import.meta.url), 'utf8'));
  assert.deepEqual(PORTS, raw);
});

test('端口段不与 DevAnyWhere 19527-19529 冲突', () => {
  for (const p of Object.values(PORTS)) {
    assert.ok(p < 19527 || p > 19529, `${p} 落在老段内`);
  }
});
