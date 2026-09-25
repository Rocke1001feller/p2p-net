import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { startControlPlane, startDiscovery } from './control.js';
import type { Logger } from '../log/logger.js';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {}, event() {} } as unknown as Logger;

/** 测试一律动态端口（listen(0)）：开发机常驻 host 钉死契约端口 19727/19728，绑固定端口必败。
 *  listen() 的 bind 是异步生效的，address() 在 'listening' 前返回 null——先等事件再读端口。 */
async function listening(srv: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    srv.once('listening', resolve);
    srv.once('error', reject);
  });
  const addr = srv.address();
  assert.ok(addr && typeof addr === 'object');
  return addr.port;
}

test('/services 返回分组清单所需字段', async (t) => {
  const srv = startDiscovery({ log: nullLogger, port: 0, getServices: () => [{ port: 5173, name: 'Vite' }], deviceId: () => 'dev1' });
  t.after(() => { srv.close(); srv.closeAllConnections(); });
  const port = await listening(srv);
  const r = await fetch(`http://127.0.0.1:${port}/services`).then((x) => x.json());
  assert.deepEqual(r.services, [{ name: 'Vite', url: '/s/5173/' }]);
  assert.equal(r.self.deviceId, 'dev1');
});

test('端口被占时报"谁占用+怎么办"而非堆栈（Review Focus #3）', async (t) => {
  const blocker = createServer().listen(0, '127.0.0.1');
  t.after(() => { blocker.close(); blocker.closeAllConnections(); });
  const port = await listening(blocker);
  assert.throws(
    () => startControlPlane({ log: nullLogger, port, getStatus: () => ({}) }),
    new RegExp(`${port} 被占用`),
  );
});

test('/status 透传 getStatus()，响应为 JSON', async (t) => {
  const status = { uptime: 12, sessions: 1, mode: 'dev' };
  const srv = startControlPlane({ log: nullLogger, port: 0, getStatus: () => status });
  t.after(() => { srv.close(); srv.closeAllConnections(); });
  const port = await listening(srv);
  const res = await fetch(`http://127.0.0.1:${port}/status`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await res.json(), status);
});

test('两个平面只绑 127.0.0.1（绝不绑 0.0.0.0）', async (t) => {
  const a = startControlPlane({ log: nullLogger, port: 0, getStatus: () => ({}) });
  const b = startDiscovery({ log: nullLogger, port: 0, getServices: () => [], deviceId: () => 'd' });
  t.after(() => { a.close(); b.close(); a.closeAllConnections(); b.closeAllConnections(); });
  const [portA, portB] = await Promise.all([a, b].map(listening));
  for (const srv of [a, b] as const) {
    const addr = srv.address();
    assert.ok(addr && typeof addr === 'object');
    assert.equal(addr.address, '127.0.0.1');
    assert.ok(addr.port > 0, '动态端口必须已落实');
  }
  // 功能实证：服务确实在各自落实的端口上可达（防断言空转）
  assert.equal((await fetch(`http://127.0.0.1:${portA}/status`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${portB}/services`)).status, 200);
});

test('/services：console 为空数组占位字段；未知路径与非 GET 一律 404', async (t) => {
  const srv = startDiscovery({ log: nullLogger, port: 0, getServices: () => [], deviceId: () => 'dev1' });
  t.after(() => { srv.close(); srv.closeAllConnections(); });
  const port = await listening(srv);
  const r = await fetch(`http://127.0.0.1:${port}/services`).then((x) => x.json());
  assert.deepEqual(r.console, []);
  assert.deepEqual(r.services, []);
  assert.equal(r.self.deviceId, 'dev1');
  const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(notFound.status, 404);
  await notFound.text();
  const posted = await fetch(`http://127.0.0.1:${port}/services`, { method: 'POST' });
  assert.equal(posted.status, 404);
  await posted.text();
});

test('发现端口被占时同样同步抛人话', async (t) => {
  const blocker = createServer().listen(0, '127.0.0.1');
  t.after(() => { blocker.close(); blocker.closeAllConnections(); });
  const port = await listening(blocker);
  assert.throws(
    () => startDiscovery({ log: nullLogger, port, getServices: () => [], deviceId: () => 'd' }),
    new RegExp(`${port} 被占用`),
  );
});
