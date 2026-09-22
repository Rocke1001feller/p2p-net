import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startControlPlane, startDiscovery } from './control.js';
import { PORTS } from '../contracts.js';
import type { Logger } from '../log/logger.js';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {}, event() {} } as unknown as Logger;

test('/services 返回分组清单所需字段', async () => {
  const srv = startDiscovery({ log: nullLogger, getServices: () => [{ port: 5173, name: 'Vite' }], deviceId: () => 'dev1' });
  const r = await fetch(`http://127.0.0.1:${PORTS.DISCOVERY_PORT}/services`).then((x) => x.json());
  assert.deepEqual(r.services, [{ name: 'Vite', url: '/s/5173/' }]);
  assert.equal(r.self.deviceId, 'dev1');
  srv.close();
});

test('端口被占时报"谁占用+怎么办"而非堆栈（Review Focus #3）', async () => {
  const blocker = await import('node:http').then((m) => m.createServer().listen(PORTS.CONTROL_PORT, '127.0.0.1'));
  await new Promise((r) => blocker.on('listening', r));
  assert.throws(() => startControlPlane({ log: nullLogger, getStatus: () => ({}) }), /19727 被占用/);
  blocker.close();
});

test('/status 透传 getStatus()，响应为 JSON', async (t) => {
  const status = { uptime: 12, sessions: 1, mode: 'dev' };
  const srv = startControlPlane({ log: nullLogger, getStatus: () => status });
  t.after(() => { srv.close(); srv.closeAllConnections(); });
  const res = await fetch(`http://127.0.0.1:${PORTS.CONTROL_PORT}/status`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await res.json(), status);
});

test('两个平面只绑 127.0.0.1（绝不绑 0.0.0.0）', async (t) => {
  const a = startControlPlane({ log: nullLogger, getStatus: () => ({}) });
  const b = startDiscovery({ log: nullLogger, getServices: () => [], deviceId: () => 'd' });
  t.after(() => { a.close(); b.close(); a.closeAllConnections(); b.closeAllConnections(); });
  await Promise.all([a, b].map((s) => new Promise((r) => s.on('listening', r))));
  for (const [srv, port] of [[a, PORTS.CONTROL_PORT], [b, PORTS.DISCOVERY_PORT]] as const) {
    const addr = srv.address();
    assert.ok(addr && typeof addr === 'object');
    assert.equal(addr.address, '127.0.0.1');
    assert.equal(addr.port, port);
  }
});

test('/services：console 为空数组占位字段；未知路径与非 GET 一律 404', async (t) => {
  const srv = startDiscovery({ log: nullLogger, getServices: () => [], deviceId: () => 'dev1' });
  t.after(() => { srv.close(); srv.closeAllConnections(); });
  const r = await fetch(`http://127.0.0.1:${PORTS.DISCOVERY_PORT}/services`).then((x) => x.json());
  assert.deepEqual(r.console, []);
  assert.deepEqual(r.services, []);
  assert.equal(r.self.deviceId, 'dev1');
  const notFound = await fetch(`http://127.0.0.1:${PORTS.DISCOVERY_PORT}/nope`);
  assert.equal(notFound.status, 404);
  await notFound.text();
  const posted = await fetch(`http://127.0.0.1:${PORTS.DISCOVERY_PORT}/services`, { method: 'POST' });
  assert.equal(posted.status, 404);
  await posted.text();
});

test('发现端口被占时同样同步抛人话（19728）', async () => {
  const blocker = createServer().listen(PORTS.DISCOVERY_PORT, '127.0.0.1');
  await new Promise((r) => blocker.on('listening', r));
  assert.throws(
    () => startDiscovery({ log: nullLogger, getServices: () => [], deviceId: () => 'd' }),
    /19728 被占用/,
  );
  blocker.close();
});
