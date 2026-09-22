/** p2p-net status（Task 19）单测：fetch/port/输出全经 deps 注入（fake fetch 路径），
 *  另有一条真实 node:http 回环服务器用例钉「真 HTTP + 真端口注入」（结尾必 closeAllConnections，
 *  不留悬挂 handle）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PORTS } from '../contracts.js';
import { runStatus } from './status.js';

interface Ctx {
  code: number;
  outLines: string[];
  errLines: string[];
}

const BODY = {
  uptime: 3723.4,
  deviceId: 'desk-1',
  sessions: { active: 2, byMode: { p2p: 1, relay: 1 }, avgRttMs: 60 },
  services: 3,
  mode: 'foreground',
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

async function run(deps: Parameters<typeof runStatus>[0]): Promise<Ctx> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const code = await runStatus({ ...deps, out: (l) => outLines.push(l), err: (l) => errLines.push(l) });
  return { code, outLines, errLines };
}

test('status：正常返回 → 人话摘要（设备/活跃会话/模式分布/RTT/服务数），exit 0', async () => {
  const ctx = await run({ fetchImpl: fakeFetch(BODY) });
  assert.equal(ctx.code, 0);
  assert.deepEqual(ctx.errLines, []);
  const text = ctx.outLines.join('\n');
  assert.match(text, /desk-1/, '摘要缺 deviceId');
  assert.match(text, /活跃会话：2/, '摘要缺活跃会话数');
  assert.match(text, /p2p 1.*relay 1|p2p: 1.*relay: 1/, '摘要缺模式分布');
  assert.match(text, /60\s*ms/, '摘要缺平均 RTT');
  assert.match(text, /3 个/, '摘要缺服务数');
  assert.match(text, /1 小时 2 分/, `uptime 应格式化为人话: ${text}`);
});

test('status：无活跃会话/avgRttMs null → 不打 RTT 段', async () => {
  const ctx = await run({ fetchImpl: fakeFetch({ ...BODY, sessions: { active: 0, byMode: {}, avgRttMs: null } }) });
  assert.equal(ctx.code, 0);
  const text = ctx.outLines.join('\n');
  assert.match(text, /活跃会话：0/);
  assert.ok(!/RTT/.test(text), `无活跃会话不应打 RTT: ${text}`);
});

test('status：连接拒绝/超时（fetch 抛错）→ 人话「服务未运行」引导 service status，exit 1', async () => {
  for (const err of [new Error('fetch failed'), new DOMException('The operation timed out.', 'TimeoutError')]) {
    const ctx = await run({
      fetchImpl: (async () => {
        throw err;
      }) as typeof fetch,
    });
    assert.equal(ctx.code, 1);
    assert.equal(ctx.outLines.length, 0);
    assert.match(ctx.errLines.join('\n'), /服务未运行/);
    assert.match(ctx.errLines.join('\n'), /p2p-net service status/);
  }
});

test('status：非 2xx → 人话报错（含 HTTP 状态码），exit 1', async () => {
  const ctx = await run({ fetchImpl: fakeFetch({ error: 'internal' }, 500) });
  assert.equal(ctx.code, 1);
  assert.match(ctx.errLines.join('\n'), /500/);
  assert.match(ctx.errLines.join('\n'), /p2p-net service status/);
});

test('status：2xx 但响应体畸形 → 人话报错 exit 1（不抛堆栈）', async () => {
  const ctx = await run({
    fetchImpl: (async () => new Response('not json', { status: 200 })) as typeof fetch,
  });
  assert.equal(ctx.code, 1);
  assert.match(ctx.errLines.join('\n'), /p2p-net service status/);
});

test('status：旧形态响应（sessions 为数字）容错渲染，不崩', async () => {
  const ctx = await run({ fetchImpl: fakeFetch({ uptime: 1, deviceId: 'd', sessions: 2, services: 0, mode: 'foreground' }) });
  assert.equal(ctx.code, 0);
  assert.match(ctx.outLines.join('\n'), /活跃会话：2/);
});

test('status：真实回环服务器端到端——注入端口打 /status，默认端口取 PORTS.CONTROL_PORT', async (t) => {
  let hitPath = '';
  const srv: Server = createServer((req, res) => {
    hitPath = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(BODY));
  });
  t.after(() => {
    srv.close();
    srv.closeAllConnections();
  });
  const port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as AddressInfo).port)));
  const ctx = await run({ port });
  assert.equal(ctx.code, 0);
  assert.equal(hitPath, '/status');
  assert.match(ctx.outLines.join('\n'), /desk-1/);
  // 端口契约纪律：默认端口必须来自 PORTS（逻辑里绝不硬编码 19727）
  assert.equal(PORTS.CONTROL_PORT, 19727);
});

test('status：真实回环——端口无人监听 → 服务未运行 exit 1（AbortSignal.timeout 真链路）', async () => {
  // 理论空闲端口：先 listen 拿到再关掉，保证该端口此刻无人监听
  const probe = createServer();
  const port = await new Promise<number>((r) => probe.listen(0, '127.0.0.1', () => r((probe.address() as AddressInfo).port)));
  await new Promise<void>((r) => probe.close(() => r()));
  const ctx = await run({ port, timeoutMs: 1000 });
  assert.equal(ctx.code, 1);
  assert.match(ctx.errLines.join('\n'), /服务未运行/);
});
