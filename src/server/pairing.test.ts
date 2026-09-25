/** pairing 模块测试（Task 17）：出票/票据轮询/设备绑定/TURN 取凭据走 Supabase 纯 REST
 *  （注入 fetch fake 断言请求形态）；配对环（出票→逐 relay 打 URL→轮询→回执/换票）全由
 *  注入的出票/轮询 fake + 毫秒级间隔驱动，零真实网络、零真实等待。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';

import {
  bindDeviceAuth,
  buildConnectUrl,
  fetchTurnCredentials,
  getTicketStatus,
  issuePairingTicket,
  PairingError,
  startPairingLoop,
} from './pairing.js';
import type { Logger } from '../log/logger.js';
import type { AppConfig } from './store.js';

const CFG: AppConfig = { supabaseUrl: 'https://x.supabase.co', publishableKey: 'pk-test', tunnelSecret: 'ts', relays: [] };

interface SeenReq {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** 记录请求形态并回固定 JSON 响应的 fetch fake。 */
function recordingFetch(status: number, payload: unknown, seen: SeenReq): typeof fetch {
  return (async (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    seen.url = String(url);
    seen.method = init?.method ?? 'GET';
    seen.headers = init?.headers;
    seen.body = init?.body ? JSON.parse(init.body) : undefined;
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
}

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

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 2));
  }
}

test('connect URL 形态：u= 直达隧道公网入口 /tunnel/s/<deviceId>（PWA parseScan 原样存 tunnelUrl）', () => {
  assert.equal(
    buildConnectUrl('1.2.3.4', 't-1', 'dev-9'),
    'https://1.2.3.4/connect?t=t-1&d=dev-9&u=https%3A%2F%2F1.2.3.4%2Ftunnel%2Fs%2Fdev-9',
  );
});

test('出票走 PostgREST 且带用户 JWT', async () => {
  const seen: SeenReq = {};
  const f = recordingFetch(201, [{ id: 'uuid-1' }], seen);
  const t = await issuePairingTicket(CFG, 'jwt-1', f);
  assert.equal(t.ticketId, 'uuid-1');
  assert.equal(seen.url, 'https://x.supabase.co/rest/v1/pairing_tickets');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers?.['Authorization'], 'Bearer jwt-1');
  assert.equal(seen.headers?.['apikey'], 'pk-test');
  assert.equal(seen.headers?.['Prefer'], 'return=representation');
  // 显式 expires_at（2h）：不依赖服务端列默认，存量环境免 DDL 变更（2026-09-25 联通臂实测票据 120s 过短）
  const body = seen.body as { expires_at?: unknown };
  assert.ok(body && typeof body.expires_at === 'string', '出票体必须显式携带 expires_at');
  const deltaMs = new Date(body.expires_at as string).getTime() - Date.now();
  assert.ok(deltaMs > 119 * 60_000 && deltaMs <= 120 * 60_000 + 5_000, `expires_at 应在 ~120min 后，实际 ${Math.round(deltaMs / 60000)}min`);
});

test('出票非 2xx 抛 PairingError，文案不含 token', async () => {
  const f = recordingFetch(401, { message: 'JWT expired' }, {});
  const err: unknown = await issuePairingTicket(CFG, 'jwt-secret-1', f).then(
    () => { throw new Error('应抛 PairingError'); },
    (e) => e,
  );
  assert.ok(err instanceof PairingError, `got ${err}`);
  assert.match(err.message, /HTTP 401/);
  assert.ok(!err.message.includes('jwt-secret-1'), '错误文案不得含 accessToken');
});

test('出票响应缺 id 抛 PairingError', async () => {
  const f = recordingFetch(201, [], {});
  await assert.rejects(issuePairingTicket(CFG, 'jwt-1', f), PairingError);
});

test('票据状态轮询：URL 形态 + 状态映射', async () => {
  for (const status of ['pending', 'redeemed', 'expired'] as const) {
    const seen: SeenReq = {};
    const f = recordingFetch(200, [{ status }], seen);
    const s = await getTicketStatus(CFG, 'jwt-1', 'ticket-9', f);
    assert.equal(s, status);
    assert.equal(seen.url, 'https://x.supabase.co/rest/v1/pairing_tickets?id=eq.ticket-9&select=status');
    assert.equal(seen.method, 'GET');
    assert.equal(seen.headers?.['Authorization'], 'Bearer jwt-1');
  }
});

test('票据行不存在（空数组）抛 PairingError', async () => {
  const f = recordingFetch(200, [], {});
  await assert.rejects(getTicketStatus(CFG, 'jwt-1', 'ticket-gone', f), PairingError);
});

test('bindDeviceAuth 走 rpc/bind_device_auth（desktop + hostname），返回设备 uuid', async () => {
  const seen: SeenReq = {};
  const f = recordingFetch(200, '3f6d1c2e-0000-4000-8000-abcdefabcdef', seen);
  const id = await bindDeviceAuth(CFG, 'jwt-1', f);
  assert.equal(id, '3f6d1c2e-0000-4000-8000-abcdefabcdef');
  assert.equal(seen.url, 'https://x.supabase.co/rest/v1/rpc/bind_device_auth');
  assert.equal(seen.method, 'POST');
  assert.deepEqual(seen.body, { p_role: 'desktop', p_hostname: hostname() });
  assert.equal(seen.headers?.['Authorization'], 'Bearer jwt-1');
  assert.equal(seen.headers?.['apikey'], 'pk-test');
});

test('fetchTurnCredentials 走 functions/v1/turn-credentials 并映射 TurnCredentials', async () => {
  const seen: SeenReq = {};
  const ice = [{ urls: ['stun:1.1.1.1:3478'] }, { urls: ['turn:1.1.1.1:3478?transport=udp'], username: 'u', credential: 'c' }];
  const f = recordingFetch(200, { iceServers: ice, ttlSeconds: 21600 }, seen);
  const creds = await fetchTurnCredentials(CFG, 'jwt-1', f);
  assert.equal(seen.url, 'https://x.supabase.co/functions/v1/turn-credentials');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers?.['Authorization'], 'Bearer jwt-1');
  assert.deepEqual(creds.iceServers, ice);
  assert.equal(creds.ttlSeconds, 21600);
});

test('配对环：出票 → 逐 relay 打 URL → 轮询 → redeemed 回执 → 换新票重打', async () => {
  const { log, lines } = fakeLogger();
  const printed: { ip: string; url: string }[] = [];
  const redeemed: string[] = [];
  let issueN = 0;
  let pollN = 0;
  const handle = startPairingLoop(
    {
      cfg: CFG,
      accessToken: () => 'at-1',
      relays: [{ ip: '1.1.1.1' }, { ip: '2.2.2.2' }],
      deviceId: 'dev-1',
      log,
      printTicket: (ip, url) => printed.push({ ip, url }),
      onRedeemed: (ticketId) => redeemed.push(ticketId),
    },
    {
      issueTicket: async () => ({ ticketId: `t-${++issueN}` }),
      // 第一张票第 2 次轮询 redeemed；后续票保持 pending（环不应连环换票刷屏）
      pollStatus: async (_cfg, _token, id) => (id === 't-1' && ++pollN >= 2 ? 'redeemed' : 'pending'),
      pollIntervalMs: 5,
      ticketTtlMs: 10_000,
    },
  );
  try {
    await waitFor(() => redeemed.length === 1 && issueN >= 2);
    assert.deepEqual(redeemed, ['t-1']);
    // 每台 relay 各打一张（URL 形态 = PWA 扫码载荷）
    const t1 = printed.filter((p) => p.url.includes('t=t-1&'));
    assert.deepEqual(t1.map((p) => p.ip), ['1.1.1.1', '2.2.2.2']);
    assert.equal(t1[0].url, 'https://1.1.1.1/connect?t=t-1&d=dev-1&u=https%3A%2F%2F1.1.1.1%2Ftunnel%2Fs%2Fdev-1');
    // 换票后对新票重打
    await waitFor(() => printed.some((p) => p.url.includes('t=t-2&')));
  } finally {
    handle.stop();
  }
  // stop 后不再出票/轮询
  const issueAtStop = issueN;
  const pollAtStop = pollN;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(issueN, issueAtStop, 'stop 后不得再出票');
  assert.equal(pollN, pollAtStop, 'stop 后不得再轮询');
  assert.ok(!lines.some((l) => l.level === 'error'), `环内不应出现 error 级日志: ${JSON.stringify(lines)}`);
});

test('配对环：120s 到期（本地判定）→ 换新票并重打 QR', async () => {
  const { log } = fakeLogger();
  const printed: string[] = [];
  let issueN = 0;
  const handle = startPairingLoop(
    {
      cfg: CFG,
      accessToken: () => 'at-1',
      relays: [{ ip: '1.1.1.1' }],
      deviceId: 'dev-1',
      log,
      printTicket: (_ip, url) => printed.push(url),
    },
    {
      issueTicket: async () => ({ ticketId: `t-${++issueN}` }),
      pollStatus: async () => 'pending',
      pollIntervalMs: 5,
      ticketTtlMs: 20,
    },
  );
  try {
    await waitFor(() => issueN >= 2);
    assert.ok(printed.some((u) => u.includes('t=t-1&')));
    assert.ok(printed.some((u) => u.includes('t=t-2&')), '过期后必须重打新票 QR');
  } finally {
    handle.stop();
  }
});

test('配对环：服务端回 expired → 换新票重打', async () => {
  const { log } = fakeLogger();
  const printed: string[] = [];
  let issueN = 0;
  const handle = startPairingLoop(
    {
      cfg: CFG,
      accessToken: () => 'at-1',
      relays: [{ ip: '1.1.1.1' }],
      deviceId: 'dev-1',
      log,
      printTicket: (_ip, url) => printed.push(url),
    },
    {
      issueTicket: async () => ({ ticketId: `t-${++issueN}` }),
      pollStatus: async (_c, _t, id) => (id === 't-1' ? 'expired' : 'pending'),
      pollIntervalMs: 5,
      ticketTtlMs: 60_000,
    },
  );
  try {
    await waitFor(() => printed.some((u) => u.includes('t=t-2&')));
  } finally {
    handle.stop();
  }
});

test('配对环：轮询瞬时失败不崩环（warn 留痕，下轮继续）', async () => {
  const { log, lines } = fakeLogger();
  const redeemed: string[] = [];
  let pollN = 0;
  const handle = startPairingLoop(
    {
      cfg: CFG,
      accessToken: () => 'at-1',
      relays: [{ ip: '1.1.1.1' }],
      deviceId: 'dev-1',
      log,
      printTicket: () => {},
      onRedeemed: (t) => redeemed.push(t),
    },
    {
      issueTicket: async () => ({ ticketId: 't-1' }),
      pollStatus: async () => {
        pollN += 1;
        if (pollN === 1) throw new Error('模拟网络抖动');
        return pollN >= 3 ? 'redeemed' : 'pending';
      },
      pollIntervalMs: 5,
      ticketTtlMs: 10_000,
    },
  );
  try {
    await waitFor(() => redeemed.length === 1);
    assert.ok(lines.some((l) => l.level === 'warn' && /轮询失败/.test(String(l.msg))), `缺轮询失败 warn: ${JSON.stringify(lines)}`);
  } finally {
    handle.stop();
  }
});

test('配对环：出票失败不崩环（warn 留痕，退避后重试成功）', async () => {
  const { log, lines } = fakeLogger();
  const printed: string[] = [];
  let issueN = 0;
  const handle = startPairingLoop(
    {
      cfg: CFG,
      accessToken: () => 'at-1',
      relays: [{ ip: '1.1.1.1' }],
      deviceId: 'dev-1',
      log,
      printTicket: (_ip, url) => printed.push(url),
    },
    {
      issueTicket: async () => {
        issueN += 1;
        if (issueN === 1) throw new Error('模拟 Supabase 抖动');
        return { ticketId: `t-${issueN}` };
      },
      pollStatus: async () => 'pending',
      pollIntervalMs: 5,
      ticketTtlMs: 10_000,
    },
  );
  try {
    await waitFor(() => printed.length === 1);
    assert.ok(lines.some((l) => l.level === 'warn' && /出票失败/.test(String(l.msg))), `缺出票失败 warn: ${JSON.stringify(lines)}`);
  } finally {
    handle.stop();
  }
});
