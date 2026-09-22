import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError, ensureFreshToken, loginWithPassword, type AuthState } from './auth.js';
import type { AppConfig } from './store.js';

const CFG: AppConfig = { supabaseUrl: 'https://x.supabase.co', publishableKey: 'pk-test', tunnelSecret: 'ts', relays: [] };

/** 各用例的 refreshToken 全局唯一：auth.ts 的单飞/退避按 refreshToken 记账，隔离跨用例串扰。 */

test('loginWithPassword 走 password grant 并映射为 AuthState', async () => {
  const seen: { url?: string; headers?: Record<string, string>; body?: unknown } = {};
  const f = (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    seen.url = String(url);
    seen.headers = init?.headers;
    seen.body = init?.body ? JSON.parse(init.body) : undefined;
    return new Response(JSON.stringify({
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expires_in: 3600,
      user: { id: 'u-1', email: 'a@b.c' },
    }), { status: 200 });
  }) as typeof fetch;
  const before = Date.now();
  const a = await loginWithPassword(CFG, 'a@b.c', 's3cret-pass', { fetchImpl: f });
  const after = Date.now();
  assert.equal(a.accessToken, 'at-1');
  assert.equal(a.refreshToken, 'rt-1');
  assert.equal(a.uid, 'u-1');
  assert.equal(a.email, 'a@b.c');
  assert.ok(a.expiresAt >= before + 3600_000 && a.expiresAt <= after + 3600_000, `expiresAt=${a.expiresAt} 不在 [${before + 3600_000}, ${after + 3600_000}]`);
  assert.ok(seen.url?.startsWith('https://x.supabase.co/auth/v1/token?grant_type=password'), `url=${seen.url}`);
  assert.equal(seen.headers?.apikey, 'pk-test');
  assert.deepEqual(seen.body, { email: 'a@b.c', password: 's3cret-pass' });
});

test('login 失败抛 AuthError，文案可操作且不含密码', async () => {
  const f = (async () => new Response(
    JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' }),
    { status: 400 },
  )) as typeof fetch;
  const err: unknown = await loginWithPassword(CFG, 'a@b.c', 's3cret-pass', { fetchImpl: f }).then(
    () => { throw new Error('应抛 AuthError'); },
    (e) => e,
  );
  assert.ok(err instanceof AuthError, `got ${err}`);
  assert.match(err.message, /p2p-net login/);
  assert.ok(!err.message.includes('s3cret-pass'), '错误文案不得含密码');
});

test('login 网络错误包装为可操作 AuthError（不泄密码）', async () => {
  const f = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  const err: unknown = await loginWithPassword(CFG, 'a@b.c', 's3cret-pass', { fetchImpl: f }).then(
    () => { throw new Error('应抛 AuthError'); },
    (e) => e,
  );
  assert.ok(err instanceof AuthError, `got ${err}`);
  assert.match(err.message, /p2p-net login/);
  assert.ok(!err.message.includes('s3cret-pass'), '错误文案不得含密码');
});

test('新鲜 token 原样返回（剩余 >60s，不发任何请求）', async () => {
  let calls = 0;
  const f = (async () => { calls++; throw new Error('不应发请求'); }) as typeof fetch;
  const a: AuthState = { accessToken: 'at', refreshToken: 'rt-fresh', expiresAt: Date.now() + 3600_000, uid: 'u1', email: 'a@b.c' };
  const r = await ensureFreshToken(CFG, a, { fetchImpl: f });
  assert.equal(r, a); // 同一引用，零改动
  assert.equal(calls, 0);
});

test('临期 token 自动 refresh（注入 fetch）', async () => {
  const seen: { url?: string; headers?: Record<string, string>; body?: unknown } = {};
  const f = (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    seen.url = String(url);
    seen.headers = init?.headers;
    seen.body = init?.body ? JSON.parse(init.body) : undefined;
    return new Response(JSON.stringify({
      access_token: 'at-2',
      refresh_token: 'rt-2',
      expires_in: 3600,
      user: { id: 'u-1', email: 'a@b.c' },
    }), { status: 200 });
  }) as typeof fetch;
  // expiresAt = now+30s → 落在 60s 余量内 → 触发 refresh
  const old: AuthState = { accessToken: 'at-old', refreshToken: 'rt-refresh', expiresAt: Date.now() + 30_000, uid: 'u-1', email: 'a@b.c' };
  const before = Date.now();
  const r = await ensureFreshToken(CFG, old, { fetchImpl: f });
  const after = Date.now();
  assert.equal(r.accessToken, 'at-2');
  assert.equal(r.refreshToken, 'rt-2');
  assert.equal(r.uid, 'u-1');
  assert.equal(r.email, 'a@b.c');
  assert.ok(r.expiresAt >= before + 3600_000 && r.expiresAt <= after + 3600_000, `expiresAt 未按 expires_in 换算：${r.expiresAt}`);
  assert.ok(r.expiresAt > old.expiresAt);
  assert.ok(seen.url?.startsWith('https://x.supabase.co/auth/v1/token?grant_type=refresh_token'), `url=${seen.url}`);
  assert.equal(seen.headers?.apikey, 'pk-test');
  assert.deepEqual(seen.body, { refresh_token: 'rt-refresh' });
});

test('refresh 响应缺 user/refresh_token 时沿用旧值（rotation 关闭场景）', async () => {
  const f = (async () => new Response(
    JSON.stringify({ access_token: 'at-3', expires_in: 600 }),
    { status: 200 },
  )) as typeof fetch;
  const old: AuthState = { accessToken: 'at-old', refreshToken: 'rt-keep', expiresAt: Date.now() + 1_000, uid: 'u-9', email: 'k@b.c' };
  const r = await ensureFreshToken(CFG, old, { fetchImpl: f });
  assert.equal(r.accessToken, 'at-3');
  assert.equal(r.refreshToken, 'rt-keep');
  assert.equal(r.uid, 'u-9');
  assert.equal(r.email, 'k@b.c');
});

test('并发 ensureFreshToken 单飞（只发一次 refresh，结果共享）', async () => {
  let calls = 0;
  const f = (async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20)); // 拉开并发窗口
    return new Response(JSON.stringify({
      access_token: 'at-new',
      refresh_token: 'rt-new',
      expires_in: 3600,
      user: { id: 'u-1', email: 'a@b.c' },
    }), { status: 200 });
  }) as typeof fetch;
  const old: AuthState = { accessToken: 'at-old', refreshToken: 'rt-single-flight', expiresAt: Date.now() + 10_000, uid: 'u-1', email: 'a@b.c' };
  const [r1, r2] = await Promise.all([
    ensureFreshToken(CFG, old, { fetchImpl: f }),
    ensureFreshToken(CFG, old, { fetchImpl: f }),
  ]);
  assert.equal(calls, 1);
  assert.equal(r1.accessToken, 'at-new');
  assert.deepEqual(r2, r1);
});

test('refresh 失败抛 AuthError 并提示重新 login（不泄 refreshToken）', async () => {
  const f = (async () => new Response(
    JSON.stringify({ error: 'invalid_grant', msg: 'Invalid Refresh Token' }),
    { status: 400 },
  )) as typeof fetch;
  const old: AuthState = { accessToken: 'at-old', refreshToken: 'rt-fail', expiresAt: Date.now() + 5_000, uid: 'u-1', email: 'a@b.c' };
  const err: unknown = await ensureFreshToken(CFG, old, { fetchImpl: f }).then(
    () => { throw new Error('应抛 AuthError'); },
    (e) => e,
  );
  assert.ok(err instanceof AuthError, `got ${err}`);
  assert.match(err.message, /p2p-net login/);
  assert.ok(!err.message.includes('rt-fail'), '错误文案不得含 refreshToken');
});

test('refresh 失败后 60s 冷却期内不再打令牌端点（失败退避）', async () => {
  let calls = 0;
  const f = (async () => {
    calls++;
    return new Response(JSON.stringify({ msg: 'Invalid Refresh Token' }), { status: 400 });
  }) as typeof fetch;
  const old: AuthState = { accessToken: 'at-old', refreshToken: 'rt-cooldown', expiresAt: Date.now() + 5_000, uid: 'u-1', email: 'a@b.c' };
  await assert.rejects(ensureFreshToken(CFG, old, { fetchImpl: f }), AuthError);
  await assert.rejects(ensureFreshToken(CFG, old, { fetchImpl: f }), (e: unknown) => {
    assert.ok(e instanceof AuthError);
    assert.match(e.message, /p2p-net login/);
    return true;
  });
  assert.equal(calls, 1); // 第二次在冷却期内被退避拦截，未发请求
});
