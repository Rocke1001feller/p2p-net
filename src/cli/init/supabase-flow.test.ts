import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { bootstrapSupabase, InitError, type BootstrapDeps } from './supabase.js';
import { SupabaseMgmt, MgmtError } from './mgmt.js';
import { prompt } from './prompt.js';
import type { Logger } from '../../log/logger.js';

function fakeLogger() {
  const lines: Record<string, unknown>[] = [];
  const log: Logger = {
    debug: (layer, msg, ctx) => lines.push({ level: 'debug', layer, msg, ...ctx }),
    info: (layer, msg, ctx) => lines.push({ level: 'info', layer, msg, ...ctx }),
    warn: (layer, msg, ctx) => lines.push({ level: 'warn', layer, msg, ...ctx }),
    error: (layer, msg, ctx) => lines.push({ level: 'error', layer, msg, ...ctx }),
    event: (name, data) => lines.push({ event: name, ...data }),
    flush: () => {},
  };
  return { log, lines };
}

type Call = { method: string; url: string; headers: Record<string, string>; body: any };

interface HarnessOpts {
  adminUsersStatus?: number; // 默认 200；422 模拟账号已存在（幂等续跑）
  sigRows?: () => unknown[]; // 覆盖信令读回结果；默认返回刚写入的行
  turnStatus?: number; // 默认 200
  turnRawBody?: string; // 覆盖 turn-credentials 响应原文
}

/** 单 mock fetch 同时扮演 Management API 与数据面（api.supabase.com / *.supabase.co 分流），
 *  按语义步骤名记录调用顺序（calls），并留存全部请求供断言（reqs）。 */
function makeHarness(o: HarnessOpts = {}) {
  const calls: string[] = [];
  const reqs: Call[] = [];
  let sigPayload: any = null;
  const f = (async (url: unknown, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const u = String(url);
    const method = String(init.method ?? 'GET');
    const path = new URL(u).pathname;
    const c: Call = {
      method,
      url: u,
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    reqs.push(c);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

    if (u.includes('api.supabase.com')) {
      const m = path.match(/^\/v1\/projects\/([^/]+)(\/.*)?$/);
      const sub = m?.[2] ?? '';
      if (path === '/v1/organizations') {
        calls.push('listOrgs');
        return json([{ id: 'oslug', slug: 'oslug', name: 'Org' }]);
      }
      if (path === '/v1/projects' && method === 'POST') {
        calls.push('createProject');
        return json({ id: 'newref' }, 201);
      }
      if (m && !sub && method === 'GET') {
        calls.push('waitHealthy');
        return json({ status: 'ACTIVE_HEALTHY' });
      }
      if (sub === '/database/query') {
        calls.push('runQuery');
        return json([]);
      }
      if (sub === '/functions' && method === 'GET') {
        calls.push('deployFunctions');
        return json([]);
      }
      if (sub === '/functions' && method === 'POST') return json({ slug: c.body?.slug }, 201);
      if (sub.startsWith('/functions/') && method === 'PATCH') return json({ slug: 'x' });
      if (sub === '/secrets') {
        calls.push('setSecrets');
        return json({}, 201);
      }
      if (sub === '/api-keys') {
        calls.push('getApiKeys');
        return json([
          { name: 'anon', api_key: 'anon-jwt' },
          { name: 'service_role', api_key: 'sr-jwt' },
        ]);
      }
      throw new Error(`unexpected mgmt call: ${method} ${u}`);
    }

    if (path === '/auth/v1/admin/users') {
      calls.push('createUser');
      const status = o.adminUsersStatus ?? 200;
      return json(status === 200 ? { id: 'uid-1' } : { msg: 'User already registered' }, status);
    }
    if (path === '/auth/v1/token') {
      calls.push('signIn');
      return json({ access_token: 'user-jwt', user: { id: 'uid-1' } });
    }
    if (path === '/rest/v1/signaling_messages' && method === 'POST') {
      calls.push('probeSignaling');
      sigPayload = c.body?.payload;
      return new Response('', { status: 201 });
    }
    if (path === '/rest/v1/signaling_messages') {
      return json(o.sigRows ? o.sigRows() : [{ id: 1, payload: sigPayload }]);
    }
    if (path === '/functions/v1/turn-credentials') {
      calls.push('probeTurn');
      const raw = o.turnRawBody ?? JSON.stringify({ iceServers: [{ urls: ['stun:1.2.3.4:3478'] }] });
      return new Response(raw, { status: o.turnStatus ?? 200 });
    }
    throw new Error(`unexpected call: ${method} ${u}`);
  }) as typeof fetch;
  return { f, calls, reqs };
}

function baseOpts(log: Logger) {
  return {
    token: 'mgmt-token',
    projectRef: 'ref1',
    adminEmail: 'a@b.c',
    adminPassword: 'pw-test',
    turnSecret: 'ts-test',
    turnHosts: ['1.2.3.4', '5.6.7.8'],
    log,
  };
}

function harnessDeps(f: typeof fetch, extra: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return { mgmt: new SupabaseMgmt('mgmt-token', f), fetchImpl: f, ...extra };
}

function assertOrder(calls: string[], expected: string[]): void {
  let idx = -1;
  for (const name of expected) {
    const i = calls.indexOf(name, idx + 1);
    assert.ok(i > idx, `步骤 ${name} 缺失或顺序错误；实际顺序：${calls.join(' → ')}`);
    idx = i;
  }
}

test('全流程编排：waitHealthy→DDL→函数→secrets→建号→自验，顺序正确', async () => {
  const { f, calls, reqs } = makeHarness();
  const { log, lines } = fakeLogger();
  const r = await bootstrapSupabase(baseOpts(log), harnessDeps(f));

  assertOrder(calls, [
    'waitHealthy',
    'runQuery',
    'deployFunctions',
    'setSecrets',
    'getApiKeys',
    'createUser',
    'signIn',
    'probeSignaling',
    'probeTurn',
  ]);

  // DDL 整包原文上送
  const ddl = reqs.find((c) => c.url.includes('/database/query'));
  assert.equal(ddl?.body?.query, readFileSync('supabase/ddl/0001_core.sql', 'utf8'));

  // secrets：TURN_STATIC_AUTH_SECRET 原值 + TURN_HOSTS JSON 数组
  const secrets = reqs.find((c) => c.url.includes('/secrets'))?.body as { name: string; value: string }[];
  assert.deepEqual(
    Object.fromEntries(secrets.map((s) => [s.name, s.value])),
    { TURN_STATIC_AUTH_SECRET: 'ts-test', TURN_HOSTS: '["1.2.3.4","5.6.7.8"]' },
  );

  // admin 建号：service_role bearer，email_confirm 免验证
  const cu = reqs.find((c) => c.url.includes('/auth/v1/admin/users'));
  assert.equal(cu?.headers['authorization'], 'Bearer sr-jwt');
  assert.equal(cu?.headers['apikey'], 'sr-jwt');
  assert.deepEqual(cu?.body, { email: 'a@b.c', password: 'pw-test', email_confirm: true });

  // 自验走 publishable key + 用户 JWT（service_role 只在建号一个请求出现）
  const sigWrite = reqs.find((c) => c.url.includes('/rest/v1/signaling_messages') && c.method === 'POST');
  assert.equal(sigWrite?.headers['apikey'], 'anon-jwt');
  assert.equal(sigWrite?.headers['authorization'], 'Bearer user-jwt');
  assert.equal(sigWrite?.body?.room, 'sig:uid-1:probe');
  assert.equal(typeof sigWrite?.body?.payload?.probe, 'string');
  const turn = reqs.find((c) => c.url.includes('/functions/v1/turn-credentials'));
  assert.equal(turn?.headers['apikey'], 'anon-jwt');
  assert.equal(turn?.headers['authorization'], 'Bearer user-jwt');
  const srCalls = reqs.filter((c) => JSON.stringify(c.headers).includes('sr-jwt'));
  assert.deepEqual(srCalls.map((c) => c.url), ['https://ref1.supabase.co/auth/v1/admin/users']);

  assert.deepEqual(r, {
    projectRef: 'ref1',
    supabaseUrl: 'https://ref1.supabase.co',
    publishableKey: 'anon-jwt',
  });

  // 每步日志分层 supabase；token/service_role/turnSecret/密码 绝不进日志
  assert.ok(lines.length >= 8, `日志行数不足：${lines.length}`);
  for (const l of lines) assert.equal(l.layer, 'supabase', JSON.stringify(l));
  const logText = JSON.stringify(lines);
  for (const secret of ['mgmt-token', 'sr-jwt', 'ts-test', 'pw-test']) {
    assert.ok(!logText.includes(secret), `日志泄漏 ${secret}`);
  }
});

test('provisioning 中轮询等待而非报错；waitHealthy 超时包装成人话（Review Focus #4）', async () => {
  const { log } = fakeLogger();
  const mgmt = {
    waitHealthy: async () => {
      throw new MgmtError(0, '', 'waitHealthy(ref1) 180000ms 内未 ACTIVE_HEALTHY（最后状态 COMING_UP）');
    },
  } as unknown as SupabaseMgmt;
  await assert.rejects(bootstrapSupabase(baseOpts(log), { mgmt }), (e) => {
    assert.ok(e instanceof InitError, `应为 InitError，实际 ${e}`);
    assert.equal(e.step, 'waitHealthy');
    assert.match(e.message, /180s 内就绪/);
    assert.match(e.message, /supabase\.com 控制台/);
    assert.match(e.message, /重跑 init/);
    assert.ok(e.cause instanceof MgmtError);
    return true;
  });
});

test('网络层裸 TypeError 包装成带修复建议的 InitError（不含 token）', async () => {
  const { log } = fakeLogger();
  const f = (async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/projects/ref1') {
      return new Response(JSON.stringify({ status: 'ACTIVE_HEALTHY' }), { status: 200 });
    }
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(bootstrapSupabase(baseOpts(log), { mgmt: new SupabaseMgmt('mgmt-token', f) }), (e) => {
    assert.ok(e instanceof InitError, `应为 InitError，实际 ${e}`);
    assert.equal(e.step, 'runQuery');
    assert.ok(e.cause instanceof TypeError);
    assert.match(e.message, /SQL Editor/);
    assert.ok(!e.message.includes('mgmt-token'), `错误消息泄漏 token: ${e.message}`);
    return true;
  });
});

test('turn-credentials 畸形 2xx JSON（裸 SyntaxError）包装成 InitError', async () => {
  const { f } = makeHarness({ turnRawBody: 'not json{' });
  const { log } = fakeLogger();
  await assert.rejects(bootstrapSupabase(baseOpts(log), harnessDeps(f)), (e) => {
    assert.ok(e instanceof InitError, `应为 InitError，实际 ${e}`);
    assert.equal(e.step, 'probeTurn');
    assert.ok(e.cause instanceof SyntaxError, `cause=${e.cause}`);
    assert.match(e.message, /重跑 init/);
    return true;
  });
});

test('信令写入成功但轮询读回超时 → InitError 指向 RLS', async () => {
  const { f, calls } = makeHarness({ sigRows: () => [] });
  const { log } = fakeLogger();
  await assert.rejects(
    bootstrapSupabase(baseOpts(log), harnessDeps(f, { probeTimeoutMs: 60, probeIntervalMs: 10 })),
    (e) => {
      assert.ok(e instanceof InitError, `应为 InitError，实际 ${e}`);
      assert.equal(e.step, 'probeSignaling');
      assert.match(e.message, /RLS/);
      assert.match(e.message, /重跑 init/);
      return true;
    },
  );
  assertOrder(calls, ['probeSignaling']); // 写入确实发生过
});

test('未给 projectRef 时新建 project（listOrgs→createProject）后继续编排', async () => {
  const { f, calls, reqs } = makeHarness();
  const { log, lines } = fakeLogger();
  const { projectRef: _omit, ...rest } = baseOpts(log);
  const r = await bootstrapSupabase(rest, harnessDeps(f));

  assertOrder(calls, ['listOrgs', 'createProject', 'waitHealthy', 'probeTurn']);
  assert.equal(r.projectRef, 'newref');
  assert.equal(r.supabaseUrl, 'https://newref.supabase.co');
  const cp = reqs.find((c) => c.url.endsWith('/v1/projects') && c.method === 'POST');
  assert.equal(cp?.body?.organization_slug, 'oslug');
  assert.equal(cp?.body?.name, 'p2p-net');
  assert.equal(cp?.body?.region, 'ap-southeast-1');
  assert.match(cp?.body?.db_pass ?? '', /^[0-9a-f]{48}$/);
  assert.ok(!JSON.stringify(lines).includes(cp?.body?.db_pass), '日志泄漏 db_pass');
});

test('首账号已存在（422）幂等跳过，流程继续到自验', async () => {
  const { f, calls } = makeHarness({ adminUsersStatus: 422 });
  const { log, lines } = fakeLogger();
  const r = await bootstrapSupabase(baseOpts(log), harnessDeps(f));
  assert.equal(r.publishableKey, 'anon-jwt');
  assertOrder(calls, ['createUser', 'signIn', 'probeSignaling', 'probeTurn']);
  assert.ok(lines.some((l) => typeof l.msg === 'string' && l.msg.includes('已存在')));
});

test('prompt secret 模式不回显输入', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let captured = '';
  output.on('data', (chunk) => {
    captured += chunk.toString();
  });
  const rl = createInterface({ input, output, terminal: true });
  try {
    const p = prompt(rl, 'Password: ', { secret: true });
    input.write('s3cret\n');
    assert.equal(await p, 's3cret');
    assert.ok(captured.includes('Password: '), `问题未打印: ${JSON.stringify(captured)}`);
    assert.ok(!captured.includes('s3cret'), `回显泄漏: ${JSON.stringify(captured)}`);
  } finally {
    rl.close();
  }
});

test('prompt 普通模式原样回显并返回答案', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let captured = '';
  output.on('data', (chunk) => {
    captured += chunk.toString();
  });
  const rl = createInterface({ input, output, terminal: true });
  try {
    const p = prompt(rl, 'Email: ');
    input.write('alice@example.com\n');
    assert.equal(await p, 'alice@example.com');
    assert.ok(captured.includes('Email: '));
    assert.ok(captured.includes('alice@example.com'), `普通模式应回显: ${JSON.stringify(captured)}`);
  } finally {
    rl.close();
  }
});
