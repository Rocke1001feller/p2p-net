import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfig } from './config.js';

test('正常加载 /config.json', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ supabaseUrl: 'https://x.supabase.co', publishableKey: 'k', relays: [{ url: 'https://1.2.3.4' }] }), { status: 200 })) as typeof fetch;
  const c = await loadRuntimeConfig();
  assert.equal(c.supabaseUrl, 'https://x.supabase.co');
});

test('缺失/损坏时抛带指引的 ConfigError 而非白屏（Review Focus #5）', async () => {
  globalThis.fetch = (async () => { throw new Error('network'); }) as typeof fetch;
  await assert.rejects(loadRuntimeConfig(), /config\.json 缺失或损坏.*p2p-net init/s);
  globalThis.fetch = (async () => new Response('{broken', { status: 200 })) as typeof fetch;
  await assert.rejects(loadRuntimeConfig(), /config\.json 缺失或损坏/s);
});
