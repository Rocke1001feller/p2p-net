import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLsofOutput, parseSsOutput, probePort, createScanner,
  DEFAULT_WHITELIST, NEVER_PORTS,
} from './scanner.js';
import type { Logger } from '../log/logger.js';

const LSOF = `COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    1234  dev   20u  IPv4 0xXXX      0t0  TCP 127.0.0.1:3000 (LISTEN)
python  2345  dev   5u   IPv4 0xYYY      0t0  TCP *:8000 (LISTEN)`;

const BIG_HTML = `<html><head><title>My App</title></head><body>${'x'.repeat(100)}</body></html>`;

function fakeLogger(): Logger {
  return {
    debug() {}, info() {}, warn() {}, error() {},
    event() {}, flush() {},
  };
}

test('解析 lsof 输出', () => {
  assert.deepEqual(parseLsofOutput(LSOF).sort(), [3000, 8000]);
});

test('解析 ss 输出', () => {
  const SS = 'State Recv-Q Send-Q Local Address:Port\nLISTEN 0 128 127.0.0.1:5173 0.0.0.0:*\n';
  assert.deepEqual(parseSsOutput(SS), [5173]);
});

test('lsof 解析：IPv6 括号地址、同端口去重、非回环/通配绑定排除', () => {
  const out = [
    'COMMAND  PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
    'node 1234 dev 20u IPv4 0x1 0t0 TCP 127.0.0.1:3000 (LISTEN)',
    'node 1234 dev 21u IPv6 0x2 0t0 TCP [::1]:3000 (LISTEN)', // 同端口 v4/v6 双绑 → 去重
    'node 1234 dev 22u IPv4 0x3 0t0 TCP 192.168.1.5:9000 (LISTEN)', // 绑定具体网卡 IP：127.0.0.1 不可达 → 排除
    'node 1234 dev 23u IPv4 0x4 0t0 UDP 127.0.0.1:4000', // 非 LISTEN/TCP → 排除
  ].join('\n');
  assert.deepEqual(parseLsofOutput(out), [3000]);
});

test('ss 解析：通配/v6 回环收取，网卡 IP 绑定排除', () => {
  const SS = [
    'State Recv-Q Send-Q Local Address:Port Peer Address:Port',
    'LISTEN 0 511 *:3000 *:*',
    'LISTEN 0 4096 [::1]:5173 [::]:*',
    'LISTEN 0 128 192.168.1.5:9000 0.0.0.0:*',
  ].join('\n');
  assert.deepEqual(parseSsOutput(SS), [3000, 5173]);
});

test('probePort 只认 2xx + text/html + >64B，取 title', async () => {
  const html = `<html><head><title>My App</title></head><body>${'x'.repeat(100)}</body></html>`;
  const f = (async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  assert.deepEqual(await probePort(3000, f), { port: 3000, name: 'My App' });
  const f404 = (async () => new Response('no', { status: 404 })) as typeof fetch;
  assert.equal(await probePort(3000, f404), null);
});

test('probePort：跟随一次重定向（只跟 path，不跨主机）', async () => {
  const f = (async (url: unknown) => {
    if (String(url).endsWith('/home')) {
      return new Response(BIG_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response(null, { status: 302, headers: { location: '/home' } });
  }) as typeof fetch;
  assert.deepEqual(await probePort(3000, f), { port: 3000, name: 'My App' });
});

test('probePort：二次重定向不再跟随 → null', async () => {
  const f = (async () => new Response(null, { status: 302, headers: { location: '/next' } })) as typeof fetch;
  assert.equal(await probePort(3000, f), null);
});

test('probePort：非 text/html（2xx 也不行）→ null', async () => {
  const f = (async () => new Response('x'.repeat(200), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  assert.equal(await probePort(3000, f), null);
});

test('probePort：空壳 200（正文 ≤64B）→ null', async () => {
  const f = (async () => new Response('<title>Hi</title>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  assert.equal(await probePort(3000, f), null);
});

test('probePort：连接拒绝/网络错误 → null（不在场信号，绝不抛错）', async () => {
  const f = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  assert.equal(await probePort(3000, f), null);
});

test('probePort：取不到 <title> 回退「网页服务 · 端口」；title 折叠空白且截 40 字符', async () => {
  const noTitle = `<html><head></head><body>${'x'.repeat(100)}</body></html>`;
  const f1 = (async () => new Response(noTitle, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  assert.deepEqual(await probePort(3000, f1), { port: 3000, name: '网页服务 · 3000' });

  const messy = `<html><head><title>  Multi\n   Line   ${'T'.repeat(50)}</title></head><body>${'x'.repeat(100)}</body></html>`;
  const f2 = (async () => new Response(messy, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  const r = await probePort(3000, f2);
  assert.ok(r);
  assert.equal(r.name, `Multi Line ${'T'.repeat(50)}`.slice(0, 40));
  assert.equal(r.name.length, 40);
});

test('默认白名单含 Top10，NEVER 含本包控制端口', () => {
  for (const p of [3000, 5173, 8000, 8080]) assert.ok(DEFAULT_WHITELIST.includes(p));
  assert.ok(NEVER_PORTS.has(19727) && NEVER_PORTS.has(19728));
});

test('DEFAULT_WHITELIST / NEVER_PORTS 精确集合', () => {
  assert.deepEqual(DEFAULT_WHITELIST, [3000, 3001, 4200, 5000, 5173, 8000, 8080, 8081, 8888, 9000]);
  assert.deepEqual(
    [...NEVER_PORTS].sort((a, b) => a - b),
    [3003, 4173, 18080, 18088, 19700, 19727, 19728, 19729],
  );
});

test('createScanner：list 初始为空，start 幂等，stop 清定时器（不阻碍进程退出）', () => {
  const s = createScanner({ extraWhitelist: [12345], log: fakeLogger() });
  assert.deepEqual(s.list(), []);
  s.start();
  s.start(); // 幂等：不叠加定时器
  s.stop();
  s.start();
  s.stop();
});
