/** start 编排测试（Task 17）：全部外部面（store/auth/scanner/control/discovery/HostAgent/
 *  TunnelClient/出票/轮询/fetch/QR/stdout/log）经 deps 注入 fake，断言装配顺序与接线参数；
 *  唯一真实运行的是配对环本体（出票/轮询由 fake 驱动）。每个用例结尾 await handle.stop()，
 *  不得有泄漏的定时器/监听器。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

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

  const scanner: Scanner = {
    list: () => [{ port: 5173, name: 'Vite' }],
    start: () => calls.push('scanner.start'),
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
        sessionCount: 0,
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
        onFrame: () => {},
        onReconnect: () => {},
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

    // onStatus → 事件流（ruling #5 最小映射）
    ho.onStatus?.({ state: 'connected', pairType: 'host', deviceId: DEVICE_ID } as HostStatus);
    assert.ok(
      ctx.logLines.some((l) => l.event === 'host_status' && l.state === 'connected' && l.deviceId === DEVICE_ID),
      `缺 host_status 事件: ${JSON.stringify(ctx.logLines)}`,
    );

    // 每 relay 一条隧道：URL 形态 + HMAC(tunnelSecret, deviceId) token
    assert.equal(ctx.tunnelUrls.length, 2);
    const expectToken = createHmac('sha256', CFG.tunnelSecret).update(DEVICE_ID).digest('hex');
    assert.equal(ctx.tunnelUrls[0], `wss://1.1.1.1/tunnel/desktop?sid=${DEVICE_ID}&token=${expectToken}`);
    assert.equal(ctx.tunnelUrls[1], `wss://2.2.2.2/tunnel/desktop?sid=${DEVICE_ID}&token=${expectToken}`);

    // 控制面 getStatus（ruling #4 最小形态）/ 发现端点
    const st = ctx.controlStatus() as { uptime: unknown; sessions: unknown; mode: unknown };
    assert.equal(typeof st.uptime, 'number');
    assert.equal(st.sessions, 0);
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
