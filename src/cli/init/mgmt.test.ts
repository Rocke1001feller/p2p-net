import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseMgmt, MgmtError } from './mgmt.js';

function mockFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url, init) => {
    const u = String(url);
    for (const [key, body] of Object.entries(routes)) {
      if (u.includes(key)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

test('runQuery 必带 User-Agent（WAF 1010 教训）', async () => {
  let seenUA = '';
  const f: typeof fetch = (async (url, init) => {
    seenUA = String((init?.headers as Record<string, string>)?.['User-Agent'] ?? '');
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  const m = new SupabaseMgmt('tok', f);
  await m.runQuery('ref1', 'select 1');
  assert.ok(seenUA.startsWith('p2p-net/'), `UA=${seenUA}`);
});

test('waitHealthy 轮询直到 healthy，超时报错', async () => {
  let n = 0;
  const f: typeof fetch = (async () => {
    n++;
    return new Response(JSON.stringify({ status: n < 3 ? 'COMING_UP' : 'ACTIVE_HEALTHY' }), { status: 200 });
  }) as typeof fetch;
  const m = new SupabaseMgmt('tok', f);
  await m.waitHealthy('ref1', 5000);
  assert.ok(n >= 3);

  const stuck = new SupabaseMgmt('tok', mockFetch({ '/projects/stuck': { status: 'COMING_UP' } }));
  await assert.rejects(stuck.waitHealthy('stuck', 0), (e) => e instanceof MgmtError);
});

type Call = { method: string; url: string; headers: Record<string, string>; body: any };

/** 记录全部请求的 mock fetch：handler 按请求给响应。 */
function recorder(handler: (c: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: unknown, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const c: Call = {
      method: String(init?.method ?? 'GET'),
      url: String(url),
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const r = handler(c);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

test('runQuery POST { query } 到 /database/query 并返回行', async () => {
  const { f, calls } = recorder((c) => {
    assert.ok(c.url.endsWith('/v1/projects/ref1/database/query'), c.url);
    return { body: [{ n: 1 }] };
  });
  const m = new SupabaseMgmt('tok', f);
  const rows = await m.runQuery('ref1', 'select 1 as n');
  assert.deepEqual(rows, [{ n: 1 }]);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { query: 'select 1 as n' });
  assert.equal(calls[0].headers['Authorization'], 'Bearer tok');
});

test('4xx/5xx 抛 MgmtError（带 status + body 摘要）', async () => {
  const m = new SupabaseMgmt('tok', (async () => new Response('JWT could not be decoded', { status: 401 })) as typeof fetch);
  await assert.rejects(m.listOrgs(), (e) => {
    assert.ok(e instanceof MgmtError);
    assert.equal(e.status, 401);
    assert.match(e.body, /JWT could not be decoded/);
    return true;
  });
});

test('listOrgs / listProjects 裁剪为契约形状', async () => {
  const m = new SupabaseMgmt('tok', mockFetch({
    '/organizations': [{ id: 'oid', slug: 'oslug', name: 'Org', extra: 1 }],
    '/projects': [{ id: 'p1', name: 'Proj', region: 'ap-southeast-1', status: 'ACTIVE_HEALTHY', database: {} }],
  }));
  const orgs = await m.listOrgs();
  assert.deepEqual(orgs, [{ id: 'oslug', name: 'Org' }]); // slug 为非废弃字段，id 透传它供 createProject 用
  const projects = await m.listProjects();
  assert.deepEqual(projects, [{ id: 'p1', name: 'Proj', region: 'ap-southeast-1', status: 'ACTIVE_HEALTHY' }]);
});

test('createProject 映射字段并返回 { id }', async () => {
  const { f, calls } = recorder(() => ({ status: 201, body: { id: 'newref', name: 'My' } }));
  const m = new SupabaseMgmt('tok', f);
  const r = await m.createProject({ orgId: 'oslug', name: 'My', region: 'ap-southeast-1', dbPass: 'pw' });
  assert.deepEqual(r, { id: 'newref' });
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { organization_slug: 'oslug', name: 'My', region: 'ap-southeast-1', db_pass: 'pw' });
});

test('getApiKeys 抽取 anon/service_role', async () => {
  const m = new SupabaseMgmt('tok', mockFetch({
    '/api-keys': [
      { name: 'anon', api_key: 'anon-jwt', type: 'legacy' },
      { name: 'service_role', api_key: 'sr-jwt', type: 'legacy' },
    ],
  }));
  assert.deepEqual(await m.getApiKeys('ref1'), { anon: 'anon-jwt', serviceRole: 'sr-jwt' });
});

test('setSecrets 转数组 POST /secrets', async () => {
  const { f, calls } = recorder((c) => {
    assert.ok(c.url.endsWith('/v1/projects/ref1/secrets'), c.url);
    return { status: 201 };
  });
  const m = new SupabaseMgmt('tok', f);
  await m.setSecrets('ref1', { TURN_HOSTS: '["1.2.3.4"]', TURN_STATIC_AUTH_SECRET: 's' });
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, [
    { name: 'TURN_HOSTS', value: '["1.2.3.4"]' },
    { name: 'TURN_STATIC_AUTH_SECRET', value: 's' },
  ]);
});

test('deployFunctions 纯 API：不存在 POST 创建，已存在 PATCH 更新；每个请求带 UA+Auth', async () => {
  const { f, calls } = recorder((c) => {
    if (c.url.endsWith('/functions') && c.method === 'GET') return { body: [{ slug: 'turn-credentials' }] };
    if (c.method === 'PATCH') return { body: { slug: 'turn-credentials' } };
    if (c.method === 'POST') return { status: 201, body: { slug: c.body?.slug } };
    throw new Error(`unexpected ${c.method} ${c.url}`);
  });
  const m = new SupabaseMgmt('tok', f);
  await m.deployFunctions('ref1');

  for (const c of calls) {
    assert.ok(c.headers['User-Agent']?.startsWith('p2p-net/'), `无 UA: ${c.method} ${c.url}`);
    assert.equal(c.headers['Authorization'], 'Bearer tok');
  }
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch?.url.endsWith('/functions/turn-credentials'), '已有函数走 PATCH');
  assert.match(patch?.body?.body, /TURN_STATIC_AUTH_SECRET/);
  assert.equal(patch?.body?.verify_jwt, true);
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post?.body?.slug, 'redeem-pairing-ticket', '新函数走 POST 创建');
  assert.match(post?.body?.body, /generateLink/);
  assert.equal(post?.body?.verify_jwt, false, 'redeem 是登录前置端点，verify_jwt=false');
});
