import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldCacheResponse } from './assetCache.js';

// 2026-09-23 蜂窝浸泡实证：每次会话重连都全量重下 ~5.5MB 资产（40s+ 白屏），
// 因为 SW 对 /s/ 隧道响应零缓存。修复：按上游 Cache-Control 语义缓存长命资产
// （vite/webpack 内容哈希资产均为 immutable），no-store 的 HTML/API 绝不进缓存。

test('immutable 资产 → 缓存', () => {
  assert.equal(shouldCacheResponse('public, max-age=31536000, immutable'), true);
});

test('长 max-age（≥86400）无 immutable 也缓存', () => {
  assert.equal(shouldCacheResponse('public, max-age=86400'), true);
  assert.equal(shouldCacheResponse('max-age=604800'), true);
});

test('no-store / no-cache → 绝不缓存（HTML、API）', () => {
  assert.equal(shouldCacheResponse('no-cache, no-store, must-revalidate'), false);
  assert.equal(shouldCacheResponse('no-store'), false);
  assert.equal(shouldCacheResponse('no-cache'), false);
});

test('短 max-age / 缺失 / 畸形 → 不缓存', () => {
  assert.equal(shouldCacheResponse('public, max-age=3600'), false);
  assert.equal(shouldCacheResponse(null), false);
  assert.equal(shouldCacheResponse(''), false);
  assert.equal(shouldCacheResponse('max-age=abc'), false);
});

test('private/set-cookie 语义无 no-store 但长命：按 max-age 判定（隧道内同源 scope 无跨用户共享风险）', () => {
  assert.equal(shouldCacheResponse('private, max-age=31536000'), true);
});
