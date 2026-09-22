import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

test('pwa-dist 产物无任何硬编码后端', () => {
  if (!existsSync('pwa-dist/index.html')) return; // 未构建时跳过（prepack 负责构建）
  const js = readFileSync('pwa-dist/index.html', 'utf8');
  assert.doesNotMatch(js, /39\.106\.59\.183|lyfyzzgviwpxtpylbzcx/);
});
