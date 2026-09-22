/** p2p-net doctor（Task 20）单测：全部外部面（store/auth/fetch/signaling/verifyVps/tcpConnect/
 *  scanner/serviceStatus）经 deps 注入，零真实网络/文件系统/服务管理器；
 *  节奏参数（signalPollMs/signalTimeoutMs/scannerWaitMs/tcpTimeoutMs）注入小值保持测试快。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AuthError, type AuthState } from '../server/auth.js';
import { ConfigError, type AppConfig } from '../server/store.js';
import type { Layer } from '../log/logger.js';
import type { SigMessage } from '../signaling/protocol.js';
import type { VpsVerifyResult } from './init/vps.js';
import { ServiceError } from './service.js';
import { runDoctor, runDoctorCli, type DoctorCheck, type DoctorDeps, type SignalingLike } from './doctor.js';

const CFG: AppConfig = {
  supabaseUrl: 'https://sb.example.test',
  publishableKey: 'anon-key',
  tunnelSecret: 'tunnel-secret-value',
  relays: [{ ip: '1.2.3.4' }, { ip: '5.6.7.8' }],
};

const AUTH: AuthState = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  expiresAt: Date.now() + 3_600_000,
  uid: 'uid-1',
  email: 'u@example.test',
};

interface Rec {
  tcp: string[];
  purges: number;
  scannerStops: number;
  sentRoom?: string;
  sentTtl?: number;
  msg?: SigMessage;
}

function makeRec(): Rec {
  return { tcp: [], purges: 0, scannerStops: 0 };
}

function okFetch(): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.includes('/rest/v1/devices')) return new Response('[]', { status: 200 });
    if (u.includes('/functions/v1/turn-credentials')) {
      return new Response(JSON.stringify({ iceServers: [{ urls: ['turn:1.2.3.4:3478'] }] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function fakeSignaling(rec: Rec, behavior: 'ok' | 'timeout' | 'sendThrow' | 'pollThrow' = 'ok') {
  return (): SignalingLike => ({
    async send(room, _sender, msg, _kind, ttl) {
      rec.sentRoom = room;
      rec.sentTtl = ttl;
      if (behavior === 'sendThrow') throw new Error('insert denied');
      rec.msg = msg;
    },
    async poll(_room, cursor) {
      if (behavior === 'pollThrow') throw new Error('select denied');
      if (behavior === 'timeout' || !rec.msg) return { msgs: [], cursor };
      return { msgs: [{ id: 1, sender: 'doctor', payload: rec.msg }], cursor: 1 };
    },
    async purgeExpired() {
      rec.purges += 1;
    },
  });
}

function happyDeps(rec: Rec, over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    loadConfigFn: () => CFG,
    loadAuthFn: () => AUTH,
    saveAuthFn: () => {},
    ensureFreshTokenFn: async () => AUTH,
    signalingFactory: fakeSignaling(rec),
    verifyVpsFn: async (): Promise<VpsVerifyResult> => ({ httpsOk: true, certDaysLeft: 30, tunnelAlive: true }),
    tcpConnect: async (host) => {
      rec.tcp.push(host);
    },
    scannerFactory: () => ({
      list: () => [{ port: 5173, name: 'Vite' }],
      start() {},
      stop() {
        rec.scannerStops += 1;
      },
    }),
    serviceStatusFn: async () => ({ installed: true, running: true, nodePath: process.execPath }),
    signalPollMs: 10,
    signalTimeoutMs: 150,
    scannerWaitMs: 50,
    tcpTimeoutMs: 50,
    requestTimeoutMs: 1000,
    ...over,
  };
}

const layers = (checks: DoctorCheck[]): Layer[] => checks.map((c) => c.layer);
const byLayer = (checks: DoctorCheck[], l: Layer): DoctorCheck[] => checks.filter((c) => c.layer === l);

// ---------- 全绿汇总 ----------

test('全绿：七层按级联顺序全过（vps 每 relay 一条），输出不含 token/secret', async () => {
  const rec = makeRec();
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(rec));
  assert.deepEqual(layers(checks), ['auth', 'supabase', 'signaling', 'ice', 'vps', 'vps', 'scanner', 'service']);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  // 信令自回环：写自己 doctor 房间、短 TTL、读回带往返耗时、事后清场
  assert.equal(rec.sentRoom, 'sig:uid-1:doctor');
  assert.ok(rec.sentTtl !== undefined && rec.sentTtl <= 60, `TTL 应短（实测 ${rec.sentTtl}）`);
  assert.ok(rec.purges >= 1, 'purgeExpired 应被尽力调用');
  assert.match(byLayer(checks, 'signaling')[0].detail, /往返 \d+ms/);
  // TURN：edge fn 通过 + 每台 relay 3478 TCP 探活
  assert.deepEqual(rec.tcp, ['1.2.3.4', '5.6.7.8']);
  // 扫描器必须收尾（无悬挂 handle）
  assert.equal(rec.scannerStops, 1);
  // 凭据纪律：序列化报告绝不含 token/secret（uid/email/ip 可以）
  const s = JSON.stringify(checks);
  assert.ok(!s.includes(AUTH.accessToken) && !s.includes(AUTH.refreshToken) && !s.includes(CFG.tunnelSecret), '报告不得含凭据');
});

test('CLI 全绿：人话逐层输出 + OK 汇总 + 退出码 0；--json 输出可解析', async () => {
  const lines: string[] = [];
  const code = await runDoctorCli(['--dir', '/tmp/x'], { ...happyDeps(makeRec()), fetchImpl: okFetch(), out: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.startsWith('✓ auth')), lines.join('\n'));
  assert.match(lines[lines.length - 1], /^OK：全部 8 项检查通过$/);

  const jsonLines: string[] = [];
  const code2 = await runDoctorCli(['--json', '--dir', '/tmp/x'], { ...happyDeps(makeRec()), fetchImpl: okFetch(), out: (l) => jsonLines.push(l) });
  assert.equal(code2, 0);
  const parsed = JSON.parse(jsonLines.join('\n')) as DoctorCheck[];
  assert.equal(parsed.length, 8);
  assert.ok(parsed.every((c) => c.ok === true));
});

// ---------- auth 层归因 ----------

test('config 缺失 → layer=auth（fix 含 p2p-net init），依赖层标注「依赖 auth 层通过」，scanner/service 仍实跑', async () => {
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), {
    loadConfigFn: () => {
      throw new ConfigError('缺少配置 /tmp/x/config.json：请先运行 p2p-net init');
    },
  }));
  const auth = byLayer(checks, 'auth')[0];
  assert.equal(auth.ok, false);
  assert.match(auth.fix ?? '', /p2p-net init/);
  for (const l of ['supabase', 'signaling', 'ice', 'vps'] as const) {
    const c = byLayer(checks, l)[0];
    assert.equal(c.ok, false, l);
    assert.match(c.detail, /依赖 auth 层通过/);
  }
  assert.ok(byLayer(checks, 'scanner')[0].ok);
  assert.ok(byLayer(checks, 'service')[0].ok);

  // CLI：退出码 = 失败数（auth + 4 个依赖层 = 5），人话输出含 ✗ 与修复行
  const lines: string[] = [];
  const code = await runDoctorCli(['--dir', '/tmp/x'], {
    ...happyDeps(makeRec(), {
      loadConfigFn: () => {
        throw new ConfigError('缺少配置 /tmp/x/config.json：请先运行 p2p-net init');
      },
    }),
    fetchImpl: okFetch(),
    out: (l) => lines.push(l),
  });
  assert.equal(code, 5);
  assert.ok(lines.some((l) => l.startsWith('✗ auth')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('修复：')), '失败层必须给修复建议');
  assert.match(lines[lines.length - 1], /未通过 5\/7 项/);
});

test('auth.json 缺失 → layer=auth，fix 含 p2p-net login；vps 只依赖 cfg 仍实跑全绿', async () => {
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), { loadAuthFn: () => null }));
  const auth = byLayer(checks, 'auth')[0];
  assert.equal(auth.ok, false);
  assert.match(auth.fix ?? '', /p2p-net login/);
  assert.equal(byLayer(checks, 'vps').length, 2);
  assert.ok(byLayer(checks, 'vps').every((c) => c.ok), 'vps 探针无鉴权，auth 挂配置在仍应实跑');
  for (const l of ['supabase', 'signaling', 'ice'] as const) {
    assert.match(byLayer(checks, l)[0].detail, /依赖 auth 层通过/);
  }
});

test('auth.json 损坏（ConfigError）→ layer=auth，fix 指引重新 login', async () => {
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), {
    loadAuthFn: () => {
      throw new ConfigError('凭据 /tmp/x/auth.json 不是合法 JSON，请重新运行 p2p-net login（原因：x）');
    },
  }));
  const auth = byLayer(checks, 'auth')[0];
  assert.equal(auth.ok, false);
  assert.match(auth.fix ?? '', /p2p-net login/);
});

test('refresh 401（AuthError）→ layer=auth，fix 含 p2p-net login；不循环重试续期', async () => {
  let refreshCalls = 0;
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), {
    ensureFreshTokenFn: async () => {
      refreshCalls += 1;
      throw new AuthError('token 续期失败：HTTP 401。登录态已失效，请重新运行 p2p-net login');
    },
  }));
  const auth = byLayer(checks, 'auth')[0];
  assert.equal(auth.ok, false);
  assert.match(auth.fix ?? '', /p2p-net login/);
  assert.equal(refreshCalls, 1, 'doctor 是新进程：续期只试一次，归因后走人');
});

// ---------- signaling / ice / vps 层归因 ----------

test('signaling 自回环超时 → layer=signaling，fix 含 RLS；清场仍执行；后续层继续跑', async () => {
  const rec = makeRec();
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(rec, { signalingFactory: fakeSignaling(rec, 'timeout') }));
  const c = byLayer(checks, 'signaling')[0];
  assert.equal(c.ok, false);
  assert.match(c.fix ?? '', /RLS/);
  assert.ok(rec.purges >= 1, '超时也应尽力清场');
  assert.ok(byLayer(checks, 'ice')[0].ok, '首败不阻断后续层');
});

test('signaling 写入/读回抛错 → layer=signaling，fix 含 RLS', async () => {
  for (const b of ['sendThrow', 'pollThrow'] as const) {
    const rec = makeRec();
    const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(rec, { signalingFactory: fakeSignaling(rec, b) }));
    const c = byLayer(checks, 'signaling')[0];
    assert.equal(c.ok, false, b);
    assert.match(c.fix ?? '', /RLS/);
  }
});

test('turn-credentials 500 / 空 iceServers → layer=ice，fix 含 TURN_HOSTS；edge fn 失败时不再探 relay TCP', async () => {
  const variants: [string, typeof fetch][] = [
    ['500', (async (u: unknown) =>
      String(u).includes('turn-credentials')
        ? new Response('err', { status: 500 })
        : new Response('[]', { status: 200 })) as typeof fetch],
    ['empty', (async (u: unknown) =>
      String(u).includes('turn-credentials')
        ? new Response(JSON.stringify({ iceServers: [] }), { status: 200 })
        : new Response('[]', { status: 200 })) as typeof fetch],
  ];
  for (const [label, fetchImpl] of variants) {
    const rec = makeRec();
    const checks = await runDoctor({ dir: '/tmp/x', fetchImpl }, happyDeps(rec));
    const c = byLayer(checks, 'ice')[0];
    assert.equal(c.ok, false, label);
    assert.match(c.fix ?? '', /TURN_HOSTS/, label);
    assert.equal(rec.tcp.length, 0, 'edge fn 失败时 relay TCP 无意义，不应发起');
  }
});

test('edge fn 正常但一台 relay 3478 拒连 → layer=ice 部分失败，detail 点名故障 relay', async () => {
  const rec = makeRec();
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(rec, {
    tcpConnect: async (host) => {
      rec.tcp.push(host);
      if (host === '5.6.7.8') throw new Error('connect ECONNREFUSED');
    },
  }));
  const c = byLayer(checks, 'ice')[0];
  assert.equal(c.ok, false);
  assert.match(c.detail, /5\.6\.7\.8/);
  assert.ok(!/1\.2\.3\.4 不通/.test(c.detail), '健康 relay 不得被点名');
  assert.match(c.fix ?? '', /coturn/);
  assert.match(c.fix ?? '', /安全组|3478/);
});

test('vps https/隧道不通 → layer=vps，fix 含 安全组 与端口清单；其余层不受影响', async () => {
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), {
    verifyVpsFn: async (ip) =>
      ip === '1.2.3.4'
        ? { httpsOk: false, certDaysLeft: -1, tunnelAlive: false }
        : { httpsOk: true, certDaysLeft: 30, tunnelAlive: true },
  }));
  const vps = byLayer(checks, 'vps');
  assert.equal(vps.length, 2);
  const bad = vps.find((c) => c.detail.includes('1.2.3.4'));
  assert.ok(bad);
  assert.equal(bad.ok, false);
  assert.match(bad.fix ?? '', /安全组/);
  assert.match(bad.fix ?? '', /443\/tcp/);
  assert.match(bad.fix ?? '', /3478/);
  const good = vps.find((c) => c.detail.includes('5.6.7.8'));
  assert.ok(good?.ok);
  assert.ok(byLayer(checks, 'scanner')[0].ok, '首败不阻断后续层');
  assert.ok(byLayer(checks, 'service')[0].ok);
});

test('vps 证书 <1 天 / 证书探测失败(-1) → 仍 ok，detail 带警告文案', async () => {
  for (const days of [0, -1] as const) {
    const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), {
      verifyVpsFn: async (): Promise<VpsVerifyResult> => ({ httpsOk: true, certDaysLeft: days, tunnelAlive: true }),
    }));
    const c = byLayer(checks, 'vps')[0];
    assert.equal(c.ok, true, `certDaysLeft=${days} 不得判负`);
    assert.match(c.detail, /证书/);
    assert.match(c.detail, /即将到期|探测失败/);
  }
});

// ---------- scanner / service 层归因 ----------

test('scanner：空清单 → ok 人话；枚举失败 → ok=false 且 fix 点名 OS 工具；stop 必调', async () => {
  const rec1 = makeRec();
  const checks1 = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(rec1, {
    scannerFactory: () => ({
      list: () => [],
      start() {},
      stop() {
        rec1.scannerStops += 1;
      },
    }),
  }));
  const c1 = byLayer(checks1, 'scanner')[0];
  assert.equal(c1.ok, true);
  assert.match(c1.detail, /未发现本地服务/);
  assert.equal(rec1.scannerStops, 1);

  const rec2 = makeRec();
  const checks2 = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(rec2, {
    scannerFactory: ({ log }) => ({
      list: () => [],
      start() {
        log.warn('scanner', '监听端口枚举失败，本轮跳过', { cmd: 'lsof' });
      },
      stop() {
        rec2.scannerStops += 1;
      },
    }),
  }));
  const c2 = byLayer(checks2, 'scanner')[0];
  assert.equal(c2.ok, false);
  assert.match(c2.fix ?? '', /lsof/);
  assert.equal(rec2.scannerStops, 1);
});

test('service：未安装/装了没跑/node 路径失效 → ok=false 且 fix 含 p2p-net service install；不支持平台 → ok 跳过', async () => {
  const scenarios = [
    { s: { installed: false, running: false, nodePath: process.execPath }, fix: /p2p-net service install/, label: '未安装' },
    { s: { installed: true, running: false, nodePath: process.execPath, lastCrashTail: 'x' }, fix: /service logs|service install/, label: '装了没跑' },
    { s: { installed: true, running: true, nodePath: '/nonexistent/node' }, fix: /p2p-net service install/, label: 'node 路径失效' },
  ];
  for (const sc of scenarios) {
    const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), { serviceStatusFn: async () => sc.s }));
    const c = byLayer(checks, 'service')[0];
    assert.equal(c.ok, false, sc.label);
    assert.match(c.fix ?? '', sc.fix, sc.label);
  }

  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), {
    serviceStatusFn: async () => {
      throw new ServiceError('当前平台（win32）暂不支持常驻服务，Phase 2 规划；可先 p2p-net start 前台运行');
    },
  }));
  const c = byLayer(checks, 'service')[0];
  assert.equal(c.ok, true, '不支持的平台不算失败');
  assert.match(c.detail, /暂不支持服务化.*跳过/);
});

// ---------- 探针隔离 ----------

test('单个探针抛异常被归因到该层，不中断后续层、不崩整个 run', async () => {
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), {
    verifyVpsFn: async () => {
      throw new Error('boom');
    },
  }));
  const vps = byLayer(checks, 'vps');
  assert.equal(vps.length, 2, '每 relay 独立归因');
  assert.ok(vps.every((c) => !c.ok));
  assert.ok(byLayer(checks, 'scanner')[0].ok);
  assert.ok(byLayer(checks, 'service')[0].ok);
});
