/** start 编排测试（Task 17）：全部外部面（store/auth/scanner/control/discovery/HostAgent/
 *  TunnelClient/出票/轮询/fetch/QR/stdout/log）经 deps 注入 fake，断言装配顺序与接线参数；
 *  唯一真实运行的是配对环本体（出票/轮询由 fake 驱动）。每个用例结尾 await handle.stop()，
 *  不得有泄漏的定时器/监听器。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';

import { PORTS } from '../contracts.js';
import type { HostAgentOptions, HostStatus } from '../host.js';
import type { Logger } from '../log/logger.js';
import { AuthError, type AuthState } from '../server/auth.js';
import type { startControlPlane, startDiscovery } from '../server/control.js';
import { buildConnectUrl } from '../server/pairing.js';
import type { Scanner, ServiceInfo } from '../server/scanner.js';
import type { AppConfig } from '../server/store.js';
import { runStart, type RunStartDeps } from './start.js';

const CFG: AppConfig = {
  supabaseUrl: 'https://x.supabase.co',
  publishableKey: 'pk-test',
  tunnelSecret: 'tun-secret-hex',
  relays: [{ ip: '1.1.1.1' }, { ip: '2.2.2.2' }],
  // deviceId 缺省：走 bind_device_auth RPC 取回并落 config.json 复用
};
const AUTH: AuthState = { accessToken: 'at-old', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000, uid: 'uid-1', email: 'a@b.c' };
const FRESH: AuthState = { ...AUTH, accessToken: 'at-fresh' };
const DEVICE_ID = 'dev-1';

function assertOrder(calls: string[], expected: string[]): void {
  let idx = -1;
  for (const name of expected) {
    const i = calls.indexOf(name, idx + 1);
    assert.ok(i > idx, `步骤 ${name} 缺失或顺序错误；实际顺序：${calls.join(' → ')}`);
    idx = i;
  }
}

async function waitFor(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor 超时：${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

interface MakeOpts {
  /** loadAuth 的返回（默认 AUTH；null = 未登录）。 */
  auth?: unknown;
  /** ensureFreshToken 的返回（默认 FRESH；传 AUTH 表示未变更）。 */
  freshToken?: AuthState;
  ensureError?: Error;
  /** 逐次调用定制 ensureFreshToken 行为（callIndex 从 1 起）；设置后覆盖 freshToken/ensureError。 */
  ensureImpl?: (callIndex: number) => AuthState | Promise<AuthState>;
  /** 周期续期间隔（注入小值驱动测试；缺省走生产 10min，测试期间不会触发）。 */
  tokenRefreshIntervalMs?: number;
  /** 装配中途失败注入：startDiscovery 抛该错误。 */
  throwAtDiscovery?: Error;
  /** scanner 上报的服务清单（默认一个 5173；隧道数据面测试注入真监听端口）。 */
  services?: ServiceInfo[];
  cfg?: AppConfig;
}

function makeDeps(overrides: MakeOpts = {}) {
  const calls: string[] = [];
  const printed: string[] = [];
  const qrs: string[] = [];
  const logLines: Record<string, unknown>[] = [];
  const stops: string[] = [];
  const log: Logger = {
    debug: (layer, msg, ctx) => logLines.push({ level: 'debug', layer, msg, ...ctx }),
    info: (layer, msg, ctx) => logLines.push({ level: 'info', layer, msg, ...ctx }),
    warn: (layer, msg, ctx) => logLines.push({ level: 'warn', layer, msg, ...ctx }),
    error: (layer, msg, ctx) => logLines.push({ level: 'error', layer, msg, ...ctx }),
    event: (name, data) => logLines.push({ event: name, ...data }),
    flush: () => {},
  };
  const cfg = overrides.cfg ?? CFG;
  let hostOpts: HostAgentOptions | undefined;
  let savedAuth: unknown;
  let savedConfig: AppConfig | undefined;
  let controlGetStatus: (() => unknown) | undefined;
  let discoveryArgs: { getServices(): ServiceInfo[]; deviceId(): string } | undefined;
  let ensureCalls = 0;
  const tunnelUrls: string[] = [];
  /** 逐条隧道捕获 onReconnect 回调（测试手动触发隧道重连事件）。 */
  const reconnectCbs: Array<() => void> = [];
  /** 逐条隧道捕获 onFrame 回调（隧道数据面测试手动驱动 relay 下发帧）。 */
  const frameCbs: Array<(frame: unknown) => void> = [];
  /** 隧道出站帧（桥经 dc shim → TunnelClient.send 的回帧；JSON 对象形态）。 */
  const sentFrames: Record<string, unknown>[] = [];

  const scanner: Scanner = {
    list: () => overrides.services ?? [{ port: 5173, name: 'Vite' }],
    start: () => calls.push('scanner.start'),
    ready: () => Promise.resolve(),
    stop: () => stops.push('scanner.stop'),
  };
  const fakeServer = (name: string) => ({
    close: (cb?: (err?: Error) => void) => {
      stops.push(`${name}.close`);
      cb?.();
    },
  });

  const deps: RunStartDeps = {
    configDir: '/tmp/p2p-net-start-test',
    log,
    out: (l) => printed.push(l),
    printQr: (text) => qrs.push(text),
    fetchImpl: (async () => {
      throw new Error('不应发真实请求');
    }) as typeof fetch,
    loadConfigFn: () => {
      calls.push('loadConfig');
      return cfg;
    },
    saveConfigFn: (_dir, c) => {
      calls.push('saveConfig');
      savedConfig = c;
    },
    loadAuthFn: () => {
      calls.push('loadAuth');
      return overrides.auth === undefined ? AUTH : overrides.auth;
    },
    saveAuthFn: (_dir, a) => {
      calls.push('saveAuth');
      savedAuth = a;
    },
    ensureFreshTokenFn: async () => {
      calls.push('ensureFreshToken');
      const n = ++ensureCalls;
      if (overrides.ensureImpl) return overrides.ensureImpl(n);
      if (overrides.ensureError) throw overrides.ensureError;
      return overrides.freshToken ?? FRESH;
    },
    bindDeviceFn: async () => {
      calls.push('bindDevice');
      return DEVICE_ID;
    },
    createScannerFn: () => {
      calls.push('createScanner');
      return scanner;
    },
    startControlPlaneFn: ((o: { getStatus(): unknown }) => {
      calls.push('control');
      controlGetStatus = o.getStatus;
      return fakeServer('control');
    }) as typeof startControlPlane,
    startDiscoveryFn: ((o: { getServices(): ServiceInfo[]; deviceId(): string }) => {
      calls.push('discovery');
      if (overrides.throwAtDiscovery) throw overrides.throwAtDiscovery;
      discoveryArgs = o;
      return fakeServer('discovery');
    }) as typeof startDiscovery,
    hostAgentFactory: (o) => {
      calls.push('hostAgent.new');
      hostOpts = o;
      return {
        start: () => calls.push('host.start'),
        stop: () => stops.push('host.stop'),
      };
    },
    tunnelFactory: () => {
      calls.push('tunnel.new');
      return {
        connect: (url) => {
          calls.push('tunnel.connect');
          tunnelUrls.push(url);
        },
        send: (obj) => {
          sentFrames.push(obj as Record<string, unknown>);
        },
        isOpen: true,
        onFrame: (cb) => {
          frameCbs.push(cb);
        },
        onReconnect: (cb) => {
          reconnectCbs.push(cb);
        },
        close: () => stops.push('tunnel.close'),
      };
    },
    issuePairingTicketFn: async () => {
      calls.push('issueTicket');
      return { ticketId: 't-1' };
    },
    pollTicketStatusFn: async () => 'pending',
    tokenRefreshIntervalMs: overrides.tokenRefreshIntervalMs,
  };
  return {
    deps,
    calls,
    printed,
    qrs,
    logLines,
    stops,
    tunnelUrls,
    reconnectCbs,
    frameCbs,
    sentFrames,
    hostOpts: (): HostAgentOptions => {
      assert.ok(hostOpts, 'HostAgent 未被装配');
      return hostOpts;
    },
    savedAuth: () => savedAuth,
    savedConfig: () => savedConfig,
    ensureCallCount: () => ensureCalls,
    controlStatus: () => {
      assert.ok(controlGetStatus);
      return controlGetStatus();
    },
    discoveryServices: () => {
      assert.ok(discoveryArgs);
      return discoveryArgs.getServices();
    },
    discoveryDeviceId: () => {
      assert.ok(discoveryArgs);
      return discoveryArgs.deviceId();
    },
  };
}

test('start 编排：装配顺序 + HostAgent 白名单/令牌闭包 + 每 relay 隧道与 QR', async () => {
  const ctx = makeDeps();
  const handle = await runStart({}, ctx.deps);
  try {
    // 装配顺序（brief Step 3）：config → auth → 续期(变更→重存) → 绑设备(落 config) →
    // scanner → 控制面/发现端点 → HostAgent → 每 relay 隧道 → 出票
    assertOrder(ctx.calls, [
      'loadConfig', 'loadAuth', 'ensureFreshToken', 'saveAuth', 'bindDevice', 'saveConfig',
      'createScanner', 'scanner.start', 'control', 'discovery',
      'hostAgent.new', 'host.start', 'tunnel.connect', 'issueTicket',
    ]);
    assert.deepEqual(ctx.savedAuth(), FRESH, '续期后的新令牌必须重存 auth.json');
    assert.deepEqual(ctx.savedConfig(), { ...CFG, deviceId: DEVICE_ID }, 'deviceId 必须落 config.json 复用');

    // HostAgent 接线
    const ho = ctx.hostOpts();
    assert.equal(ho.deviceId, DEVICE_ID);
    assert.equal(ho.uid, AUTH.uid);
    assert.equal(ho.supabaseUrl, CFG.supabaseUrl);
    assert.equal(ho.publishableKey, CFG.publishableKey);
    assert.equal(typeof ho.turnFetcher, 'function');
    assert.equal(ho.accessToken(), 'at-fresh', 'HostAgent 必须拿续期后的令牌');
    assert.equal(typeof ho.isPortAllowed, 'function', 'isPortAllowed 必须传入 HostAgent（§5.3 白名单）');
    const allow = ho.isPortAllowed!;
    assert.equal(allow(5173), true, '扫描到的服务端口应放行');
    assert.equal(allow(3000), true, '默认白名单端口应放行');
    assert.equal(allow(PORTS.DISCOVERY_PORT), true, '发现端点应放行（PWA 经桥拉 /services）');
    assert.equal(allow(3003), false, 'NEVER 端口永不放行');
    assert.equal(allow(PORTS.CONTROL_PORT), false, '控制面端口属 NEVER 集合，不放行');
    assert.equal(allow(PORTS.TUNNEL_RELAY_PORT), false, '隧道 relay 端口属 NEVER 集合，不放行');
    assert.equal(allow(9999), false, '未知端口不放行');

    // onStatus → 会话事件流（Task 19 ruling #2）：connected → session_start + cascade_choice
    ho.onStatus?.({ state: 'connected', pairType: 'p2p', rttMs: 42, deviceId: DEVICE_ID, clientKey: 'phone-1' } as HostStatus);
    assert.ok(
      ctx.logLines.some((l) => l.event === 'session_start' && l.sid === 'phone-1'),
      `缺 session_start 事件: ${JSON.stringify(ctx.logLines)}`,
    );
    assert.ok(
      ctx.logLines.some((l) => l.event === 'cascade_choice' && l.sid === 'phone-1' && l.mode === 'p2p' && l.rttMs === 42),
      `缺 cascade_choice 事件: ${JSON.stringify(ctx.logLines)}`,
    );

    // 每 relay 一条隧道：URL 形态 + HMAC(tunnelSecret, deviceId) token
    assert.equal(ctx.tunnelUrls.length, 2);
    const expectToken = createHmac('sha256', CFG.tunnelSecret).update(DEVICE_ID).digest('hex');
    assert.equal(ctx.tunnelUrls[0], `wss://1.1.1.1/tunnel/desktop?sid=${DEVICE_ID}&token=${expectToken}`);
    assert.equal(ctx.tunnelUrls[1], `wss://2.2.2.2/tunnel/desktop?sid=${DEVICE_ID}&token=${expectToken}`);

    // 控制面 getStatus（Task 19 ruling #8 真聚合形态）/ 发现端点
    const st = ctx.controlStatus() as { uptime: unknown; deviceId: unknown; sessions: unknown; services: unknown; mode: unknown };
    assert.equal(typeof st.uptime, 'number');
    assert.equal(st.deviceId, DEVICE_ID);
    assert.deepEqual(st.sessions, { active: 1, byMode: { p2p: 1 }, avgRttMs: 42 }, 'sessions 应为事件环形缓冲的实时聚合');
    assert.equal(st.services, 1, 'services 为 scanner.list().length');
    assert.equal(st.mode, 'foreground');
    assert.deepEqual(ctx.discoveryServices(), [{ port: 5173, name: 'Vite' }]);
    assert.equal(ctx.discoveryDeviceId(), DEVICE_ID);

    // 出票打 QR：每台 relay 一张（配对环首 cycle 落定后断言）
    await flush();
    const url1 = buildConnectUrl('1.1.1.1', 't-1', DEVICE_ID);
    const url2 = buildConnectUrl('2.2.2.2', 't-1', DEVICE_ID);
    assert.ok(ctx.qrs.includes(url1), `缺 relay 1.1.1.1 的 QR: ${ctx.qrs.join(' | ')}`);
    assert.ok(ctx.qrs.includes(url2), `缺 relay 2.2.2.2 的 QR: ${ctx.qrs.join(' | ')}`);
    assert.ok(ctx.printed.some((l) => l.includes(url1)), `stdout 缺配对链接: ${ctx.printed.join(' | ')}`);

    // 未传 --foreground：常驻服务横幅提示（ruling #7）
    assert.ok(ctx.printed.some((l) => l.includes('service install')), `缺常驻服务横幅: ${ctx.printed.join(' | ')}`);

    // 秘密纪律：stdout/QR/日志绝不含 token/secret/隧道 token（URL 含 ticketId+deviceId 是设计）
    const surfaced = ctx.printed.join('\n') + ctx.qrs.join('\n') + JSON.stringify(ctx.logLines);
    for (const s of ['tun-secret-hex', 'at-old', 'at-fresh', 'rt-1', expectToken]) {
      assert.ok(!surfaced.includes(s), `输出/日志泄漏秘密: ${s}`);
    }
  } finally {
    await handle.stop();
  }
  // stop 语义：scanner/host/隧道×2/两个 server 全部收尾，配对环不再出票
  for (const s of ['scanner.stop', 'host.stop', 'control.close', 'discovery.close']) {
    assert.ok(ctx.stops.includes(s), `stop 缺 ${s}: ${ctx.stops.join()}`);
  }
  assert.equal(ctx.stops.filter((s) => s === 'tunnel.close').length, 2);
  const issues = ctx.calls.filter((c) => c === 'issueTicket').length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctx.calls.filter((c) => c === 'issueTicket').length, issues, 'stop 后配对环不得再出票');
});

test('start --foreground：抑制常驻服务横幅', async () => {
  const ctx = makeDeps();
  const handle = await runStart({ foreground: true }, ctx.deps);
  try {
    await flush();
    assert.ok(!ctx.printed.some((l) => l.includes('service install')), 'foreground 模式不应打横幅');
    assert.ok(ctx.qrs.length > 0, '配对 QR 仍应正常输出');
  } finally {
    await handle.stop();
  }
});

test('start 未登录：引导 p2p-net login，任何组件不起', async () => {
  const ctx = makeDeps({ auth: null });
  await assert.rejects(runStart({}, ctx.deps), /p2p-net login/);
  assert.deepEqual(ctx.calls, ['loadConfig', 'loadAuth']);
});

test('start token 续期失败：人话报错（含 p2p-net login，不含 refreshToken），不起任何组件', async () => {
  const ctx = makeDeps({
    ensureError: new AuthError('token 续期失败：Invalid Refresh Token。登录态已失效，请重新运行 p2p-net login'),
  });
  await assert.rejects(runStart({}, ctx.deps), (e: unknown) => {
    assert.ok(e instanceof AuthError, `应为 AuthError，实际 ${e}`);
    assert.match(e.message, /p2p-net login/);
    assert.ok(!e.message.includes('rt-1'), '错误文案不得含 refreshToken');
    return true;
  });
  assert.deepEqual(ctx.calls, ['loadConfig', 'loadAuth', 'ensureFreshToken']);
});

test('start：token 未变不重存 auth；config 已有 deviceId 时复用（不打 RPC、不重落盘）', async () => {
  const ctx = makeDeps({ freshToken: AUTH, cfg: { ...CFG, deviceId: 'dev-cached' } });
  const handle = await runStart({}, ctx.deps);
  try {
    assert.ok(!ctx.calls.includes('saveAuth'), 'token 未变不应重存');
    assert.ok(!ctx.calls.includes('bindDevice'), '已有 deviceId 不应再打 bind RPC');
    assert.ok(!ctx.calls.includes('saveConfig'), 'deviceId 未变不应重落 config');
    assert.equal(ctx.hostOpts().deviceId, 'dev-cached');
    // 隧道 URL 的 sid 也用复用的 deviceId
    assert.ok(ctx.tunnelUrls[0]?.includes('sid=dev-cached&'));
  } finally {
    await handle.stop();
  }
});

const NEWER: AuthState = { ...AUTH, accessToken: 'at-newer' };

test('运行期 token 周期续期：闭包读到新令牌 + saveAuth 重存 + stop 后不再续期', async () => {
  const ctx = makeDeps({
    tokenRefreshIntervalMs: 5,
    ensureImpl: (n) => (n === 1 ? FRESH : NEWER),
  });
  const handle = await runStart({}, ctx.deps);
  try {
    assert.equal(ctx.hostOpts().accessToken!(), 'at-fresh', '启动时闭包读到初始续期令牌');
    await waitFor(() => ctx.hostOpts().accessToken!() === 'at-newer', 'HostAgent accessToken 闭包应读到周期续期后的新令牌');
    await waitFor(() => ctx.calls.filter((c) => c === 'saveAuth').length >= 2, '周期续期令牌变更必须重存 auth.json');
    assert.deepEqual(ctx.savedAuth(), NEWER);
    // 令牌本身绝不进日志
    assert.ok(!JSON.stringify(ctx.logLines).includes('at-newer'), '日志不得含新令牌');
  } finally {
    await handle.stop();
  }
  // stop 后静默：不再发起任何续期
  const ensureCallsAtStop = ctx.ensureCallCount();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctx.ensureCallCount(), ensureCallsAtStop, 'stop 后不得再发起续期');
});

test('周期续期 AuthError：人话日志 + auth_refresh_failed 事件，进程保活', async () => {
  const ctx = makeDeps({
    tokenRefreshIntervalMs: 5,
    ensureImpl: (n) => {
      if (n === 1) return FRESH;
      throw new AuthError('token 续期失败：Invalid Refresh Token。登录态已失效，请重新运行 p2p-net login');
    },
  });
  const handle = await runStart({}, ctx.deps);
  try {
    await waitFor(() => ctx.logLines.some((l) => l.event === 'auth_refresh_failed'), '缺 auth_refresh_failed 事件');
    const errLine = ctx.logLines.find((l) => l.level === 'error' && l.layer === 'auth');
    assert.ok(errLine, `缺 auth 层 error 日志: ${JSON.stringify(ctx.logLines)}`);
    assert.match(String(errLine.msg), /p2p-net login/, '错误文案应含 login 指引');
    assert.ok(!JSON.stringify(ctx.logLines).includes('rt-1'), '日志不得含 refreshToken');
    // 进程保活：没有任何组件被收尾，HostAgent/配对环仍在跑
    assert.deepEqual(ctx.stops, [], `续期失败不得停组件: ${ctx.stops.join()}`);
  } finally {
    await handle.stop();
  }
});

test('装配中途失败：已启动组件反向回退，原始错误原样传播', async () => {
  const boom = new Error('19728 被占用：可能已有一个 p2p-net 实例，运行 `p2p-net status` 确认');
  const ctx = makeDeps({ throwAtDiscovery: boom });
  await assert.rejects(runStart({}, ctx.deps), (e: unknown) => {
    assert.equal(e, boom, '原始错误必须原样传播（不得重包装）');
    return true;
  });
  // discovery 之前已起 scanner + control：两者都必须被收尾
  assert.ok(ctx.stops.includes('scanner.stop'), `scanner 未回退: ${ctx.stops.join()}`);
  assert.ok(ctx.stops.includes('control.close'), `control 未回退: ${ctx.stops.join()}`);
  // 后起的先收（反向回退）
  assert.ok(
    ctx.stops.indexOf('control.close') < ctx.stops.indexOf('scanner.stop'),
    `回退顺序应为先 control 后 scanner: ${ctx.stops.join()}`,
  );
  // discovery 之后的组件不应起来
  assert.ok(!ctx.calls.includes('hostAgent.new'), 'HostAgent 不应装配');
  assert.ok(!ctx.calls.includes('tunnel.connect'), '隧道不应连接');
  assert.ok(!ctx.calls.includes('issueTicket'), '配对不应出票');
});


test('会话事件映射：onStatus 序列 → 环形缓冲 → getStatus 聚合（ruling #2/#7）', async () => {
  const ctx = makeDeps();
  const handle = await runStart({}, ctx.deps);
  try {
    const ho = ctx.hostOpts();
    const emit = (s: { state: HostStatus['state']; clientKey: string; pairType?: HostStatus['pairType']; rttMs?: number }) =>
      ho.onStatus?.({ pairType: null, deviceId: DEVICE_ID, ...s } as HostStatus);
    const sessionsAgg = () => (ctx.controlStatus() as { sessions: unknown }).sessions;

    // connecting：无会话事件（自愈/中间态不进会话流）
    emit({ state: 'connecting', clientKey: 'p1' });
    assert.ok(!ctx.logLines.some((l) => l.event === 'session_start'), 'connecting 不得发 session_start');

    // connected → session_start + cascade_choice（sid = clientKey，ruling #1/#2）
    emit({ state: 'connected', clientKey: 'p1', pairType: 'relay', rttMs: 100 });
    assert.ok(ctx.logLines.some((l) => l.event === 'session_start' && l.sid === 'p1'));
    assert.ok(ctx.logLines.some((l) => l.event === 'cascade_choice' && l.sid === 'p1' && l.mode === 'relay' && l.rttMs === 100));
    assert.deepEqual(sessionsAgg(), { active: 1, byMode: { relay: 1 }, avgRttMs: 100 });

    // 重复完全相同的状态 → 零新事件（Peer 每 5s stats 重发，不得刷屏 events.jsonl）
    const n = ctx.logLines.length;
    emit({ state: 'connected', clientKey: 'p1', pairType: 'relay', rttMs: 100 });
    emit({ state: 'connected', clientKey: 'p1', pairType: 'relay', rttMs: 100 });
    assert.equal(ctx.logLines.length, n, '重复相同状态不得再发事件');
    assert.equal(ctx.logLines.filter((l) => l.event === 'session_start' && l.sid === 'p1').length, 1, '同 sid 无 end 不得重复 session_start');

    // rtt 跨越阈值（100→120，|Δ|=20 ≥ 15ms）→ 补一条 cascade_choice；session_start 仍只一条
    emit({ state: 'connected', clientKey: 'p1', pairType: 'relay', rttMs: 120 });
    assert.equal(ctx.logLines.filter((l) => l.event === 'session_start' && l.sid === 'p1').length, 1);
    assert.equal(ctx.logLines.filter((l) => l.event === 'cascade_choice' && l.sid === 'p1').length, 2);
    assert.deepEqual(sessionsAgg(), { active: 1, byMode: { relay: 1 }, avgRttMs: 120 }, '聚合取最新 cascade_choice');

    // 第二台手机并发：pairType null → mode 回落 'p2p'；clientKey 区分两台设备
    emit({ state: 'connected', clientKey: 'p2', pairType: null, rttMs: 20 });
    assert.deepEqual(sessionsAgg(), { active: 2, byMode: { relay: 1, p2p: 1 }, avgRttMs: 70 });

    // disconnected：ICE 可自愈瞬时态（peer.ts 2026-09-12 修复注释），不得终结会话
    emit({ state: 'disconnected', clientKey: 'p1' });
    assert.ok(!ctx.logLines.some((l) => l.event === 'session_end' && l.sid === 'p1'), 'disconnected 不得发 session_end');
    assert.deepEqual(sessionsAgg(), { active: 2, byMode: { relay: 1, p2p: 1 }, avgRttMs: 70 });

    // closed → session_end(reason=closed)
    emit({ state: 'closed', clientKey: 'p1' });
    assert.ok(ctx.logLines.some((l) => l.event === 'session_end' && l.sid === 'p1' && l.reason === 'closed'));
    assert.deepEqual(sessionsAgg(), { active: 1, byMode: { p2p: 1 }, avgRttMs: 20 });

    // failed → session_end(reason=failed)
    emit({ state: 'failed', clientKey: 'p2' });
    assert.ok(ctx.logLines.some((l) => l.event === 'session_end' && l.sid === 'p2' && l.reason === 'failed'));
    assert.deepEqual(sessionsAgg(), { active: 0, byMode: {}, avgRttMs: null });

    // 已结束的 sid 再收 closed → 不重复 session_end（无 start 的 end 是噪声）
    const ends = ctx.logLines.filter((l) => l.event === 'session_end' && l.sid === 'p2').length;
    emit({ state: 'closed', clientKey: 'p2' });
    assert.equal(ctx.logLines.filter((l) => l.event === 'session_end' && l.sid === 'p2').length, ends, 'end 不得重发');

    // 隧道重连 → tunnel_reconnect（sid = relay ip）
    assert.equal(ctx.reconnectCbs.length, 2, '每 relay 应注册一个 onReconnect');
    ctx.reconnectCbs[0]!();
    assert.ok(ctx.logLines.some((l) => l.event === 'tunnel_reconnect' && l.sid === '1.1.1.1'));

    // 事件纪律：SessionEvent 只带 sid/mode/rtt/reason，token/secret 绝不进事件流
    const ev = JSON.stringify(ctx.logLines.filter((l) => l.event));
    for (const s of ['tun-secret-hex', 'at-old', 'at-fresh', 'rt-1']) {
      assert.ok(!ev.includes(s), `事件泄漏秘密: ${s}`);
    }
  } finally {
    await handle.stop();
  }
});

test('会话事件环形缓冲：容量 2000 FIFO 丢最旧；events.jsonl 写透不受缓冲影响', async () => {
  const ctx = makeDeps();
  const handle = await runStart({}, ctx.deps);
  try {
    const ho = ctx.hostOpts();
    const emit = (clientKey: string) =>
      ho.onStatus?.({ state: 'connected', pairType: 'p2p', rttMs: 10, deviceId: DEVICE_ID, clientKey } as HostStatus);
    // 2100 个不同 sid 各一条 connected（每条产生 session_start + cascade_choice 两个事件 → 4200 条）
    for (let i = 0; i < 2100; i++) emit(`s-${i}`);
    // 写透：events.jsonl 流拿到全部 2100 条 session_start（环形缓冲只影响内存聚合视图）
    assert.equal(ctx.logLines.filter((l) => l.event === 'session_start').length, 2100, 'log 写透不得丢事件');
    // 环形缓冲只留最新 2000 条事件 = 最近 1000 个 sid 的 (start, cascade)
    const agg = (ctx.controlStatus() as { sessions: { active: number; byMode: Record<string, number>; avgRttMs: number | null } }).sessions;
    assert.equal(agg.active, 1000, '环形缓冲应按 FIFO 丢掉最旧事件');
    assert.deepEqual(agg.byMode, { p2p: 1000 });
    assert.equal(agg.avgRttMs, 10);
    // 最早被挤出缓冲的 sid 再收 end：聚合层垃圾容忍，不抛不错乱
    ho.onStatus?.({ state: 'closed', pairType: null, deviceId: DEVICE_ID, clientKey: 's-0' } as HostStatus);
    assert.ok(ctx.logLines.some((l) => l.event === 'session_end' && l.sid === 's-0'));
  } finally {
    await handle.stop();
  }
});


test('cascade_choice 节流：|Δrtt|<15ms 抖动零事件；pairType 变化或阈值穿越才发（基线=上次已发）', async () => {
  const ctx = makeDeps();
  const handle = await runStart({}, ctx.deps);
  try {
    const ho = ctx.hostOpts();
    const emit = (pairType: HostStatus['pairType'], rttMs: number) =>
      ho.onStatus?.({ state: 'connected', pairType, rttMs, deviceId: DEVICE_ID, clientKey: 'p1' } as HostStatus);
    const cascades = () => ctx.logLines.filter((l) => l.event === 'cascade_choice' && l.sid === 'p1');

    // 首次 connected 必发（建立基线 100ms）
    emit('relay', 100);
    assert.equal(cascades().length, 1, '首次 connected 必发 cascade_choice');

    // 阈值下抖动（评审修复点：Peer 每 ~5s stats 重发，真实 RTT 整数毫秒几乎每次都变）：
    // 105(Δ5)、112(Δ12)、114(Δ14) 一律不发——基线是「上次已发」的 100，而非上次观测
    for (const rtt of [105, 112, 114]) emit('relay', rtt);
    assert.equal(cascades().length, 1, '|Δrtt|<15ms 的抖动不得发 cascade_choice（否则环形缓冲将被刷穿）');

    // 116：vs 已发基线 100 的 |Δ|=16 ≥ 15 → 发，基线随之更新为 116
    emit('relay', 116);
    assert.equal(cascades().length, 2, '阈值穿越（vs 上次已发基线）必须发');
    assert.equal(cascades().at(-1)!.rttMs, 116);

    // 120：vs 新基线 116 的 Δ=4 → 不发（验证基线随发射更新，未锚死首个值）
    emit('relay', 120);
    assert.equal(cascades().length, 2);

    // pairType 翻转：rtt 不变也必发（链路模式切换是关键观测点）
    emit('p2p', 120);
    assert.equal(cascades().length, 3, 'pairType 变化必发 cascade_choice');
    assert.equal(cascades().at(-1)!.mode, 'p2p');

    // 聚合视图始终取最新已发 cascade
    assert.deepEqual((ctx.controlStatus() as { sessions: unknown }).sessions, { active: 1, byMode: { p2p: 1 }, avgRttMs: 120 });
  } finally {
    await handle.stop();
  }
});

test('隧道数据面接线：req/ws 帧派发到本地桥；白名单外端口 fail-closed；坏帧不杀进程', async () => {
  // 真本地服务（随机端口），经 scanner 上报进入白名单
  const httpServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`hello:${req.url}`);
  });
  await new Promise<void>((r) => httpServer.listen(0, r));
  const httpPort = (httpServer.address() as AddressInfo).port;
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on('listening', r));
  const wsPort = (wss.address() as AddressInfo).port;
  wss.on('connection', (ws) => ws.on('message', (d) => ws.send(`echo:${d}`)));

  const ctx = makeDeps({ services: [{ port: httpPort, name: 'T' }, { port: wsPort, name: 'W' }] });
  const handle = await runStart({ foreground: true }, ctx.deps);
  const framesOf = (pred: (f: Record<string, unknown>) => boolean) => ctx.sentFrames.filter(pred);
  const resDone = (id: number) => (f: Record<string, unknown>) => f.k === 'res-chunk' && f.id === id && f.done === true;
  const bodyOf = (id: number) =>
    framesOf((f) => f.k === 'res-chunk' && f.id === id && typeof f.dataB64 === 'string')
      .map((f) => Buffer.from(f.dataB64 as string, 'base64').toString('utf8'))
      .join('');
  try {
    // 每条隧道必须注册 onFrame（relay 下发帧的派发入口；未注册 = 数据面断）
    assert.equal(ctx.frameCbs.length, 2, '每条隧道必须注册 onFrame 回调');
    const rx = ctx.frameCbs[0]!;

    // req：/s/<port>/<rest> 解析 + 重写 → HttpBridge 触达真本地服务，200/body/done 回帧
    rx({ k: 'req', id: 1, port: 0, method: 'GET', path: `/s/${httpPort}/hello?q=1`, headers: {}, via: 'tunnel' });
    await waitFor(() => framesOf(resDone(1)).length > 0, 'req 1 应收齐 done 帧');
    const head1 = framesOf((f) => f.k === 'res-head' && f.id === 1)[0];
    assert.equal(head1?.status, 200, `req 1 应 200，实际帧：${JSON.stringify(framesOf((f) => f.id === 1))}`);
    assert.equal(bodyOf(1), `hello:/hello?q=1`, '路径应剥掉 /s/<port> 前缀且保留 search');

    // 白名单外端口（9999 无监听：若穿透派发会 502；403 证明闸门拦在派发层）→ fail-closed
    rx({ k: 'req', id: 2, port: 0, method: 'GET', path: '/s/9999/x', headers: {}, via: 'tunnel' });
    await waitFor(() => framesOf(resDone(2)).length > 0, 'req 2 应收齐 done 帧');
    assert.equal(framesOf((f) => f.k === 'res-head' && f.id === 2)[0]?.status, 403, '白名单外端口必须 403');
    assert.match(bodyOf(2), /not allowed/);

    // 畸形路径（无 /s/<port> 前缀）→ 400
    rx({ k: 'req', id: 3, port: 0, method: 'GET', path: '/nope', headers: {}, via: 'tunnel' });
    await waitFor(() => framesOf(resDone(3)).length > 0, 'req 3 应收齐 done 帧');
    assert.equal(framesOf((f) => f.k === 'res-head' && f.id === 3)[0]?.status, 400, '畸形路径必须 400');

    // req-abort：无在途请求时静默吞掉，不回帧不抛错
    const n0 = ctx.sentFrames.length;
    rx({ k: 'req-abort', id: 999 });
    await flush();
    assert.equal(ctx.sentFrames.length, n0, 'req-abort 无在途请求不得回帧');

    // ws-open 白名单外端口 → ws-open-err（fail-closed）
    rx({ k: 'ws-open', wid: 1, path: '/s/9999/ws' });
    await waitFor(() => framesOf((f) => f.k === 'ws-open-err' && f.wid === 1).length > 0, 'wid 1 应回 ws-open-err');

    // ws 全双工：open-ok → 客户端发 text → echo 回帧 → close 透传
    rx({ k: 'ws-open', wid: 2, path: `/s/${wsPort}/ws` });
    await waitFor(() => framesOf((f) => f.k === 'ws-open-ok' && f.wid === 2).length > 0, 'wid 2 应回 ws-open-ok');
    rx({ k: 'ws-msg', wid: 2, text: 'ping' });
    await waitFor(
      () => framesOf((f) => f.k === 'ws-msg' && f.wid === 2 && f.text === 'echo:ping').length > 0,
      'wid 2 应收到 echo 回帧',
    );
    rx({ k: 'ws-close', wid: 2, code: 1000 });
    await waitFor(() => framesOf((f) => f.k === 'ws-close' && f.wid === 2).length > 0, 'wid 2 关闭应透传回帧');

    // 重连清场：在途 ws 被 closeAll 关掉（回 ws-close 帧），本地在途请求被 abortAll
    rx({ k: 'ws-open', wid: 3, path: `/s/${wsPort}/ws` });
    await waitFor(() => framesOf((f) => f.k === 'ws-open-ok' && f.wid === 3).length > 0, 'wid 3 应回 ws-open-ok');
    ctx.reconnectCbs[0]!();
    await waitFor(() => framesOf((f) => f.k === 'ws-close' && f.wid === 3).length > 0, '重连清场应关掉在途 ws');
    assert.ok(ctx.logLines.some((l) => l.event === 'tunnel_reconnect'), '重连事件仍应记录');

    // 坏帧隔离：非对象/未知帧静默丢弃，进程与后续帧处理不受影响
    rx(null);
    rx(42);
    rx({ k: 'mystery' });
    rx({ k: 'req', id: 4, port: 0, method: 'GET', path: `/s/${httpPort}/ok`, headers: {}, via: 'tunnel' });
    await waitFor(() => framesOf(resDone(4)).length > 0, '坏帧之后正常帧仍应被处理');
    assert.equal(framesOf((f) => f.k === 'res-head' && f.id === 4)[0]?.status, 200);

    // 出站帧纪律：token/secret 绝不进回帧
    const out = JSON.stringify(ctx.sentFrames);
    for (const s of ['tun-secret-hex', 'at-old', 'at-fresh', 'rt-1']) {
      assert.ok(!out.includes(s), `隧道回帧泄漏秘密: ${s}`);
    }
  } finally {
    await handle.stop();
    await new Promise<void>((r) => httpServer.close(() => r()));
    await new Promise<void>((r) => wss.close(() => r()));
  }
});
