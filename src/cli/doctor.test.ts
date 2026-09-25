/** p2p-net doctor（Task 20）单测：全部外部面（store/auth/fetch/signaling/verifyVps/stunProbe/
 *  scanner/serviceStatus）经 deps 注入，零真实网络/文件系统/服务管理器；
 *  节奏参数（signalPollMs/signalTimeoutMs/scannerWaitMs/stunTimeoutMs）注入小值保持测试快。
 *  例外：默认 STUN 探针（defaultStunProbe）打本地 UDP 回环——手工协议帧必须真发真收才算数。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';

import { AuthError, type AuthState } from '../server/auth.js';
import { SCANNER_ENUM_FAILED_CODE } from '../server/scanner.js';
import { ConfigError, type AppConfig } from '../server/store.js';
import type { Layer } from '../log/logger.js';
import type { SigMessage } from '../signaling/protocol.js';
import type { VpsVerifyResult } from './init/vps.js';
import { ServiceError } from './service.js';
import { defaultStunProbe, runDoctor, runDoctorCli, type DoctorCheck, type DoctorDeps, type SignalingLike } from './doctor.js';

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
  stun: string[];
  nat: string[];
  purges: number;
  scannerStops: number;
  sentRoom?: string;
  sentTtl?: number;
  msg?: SigMessage;
}

function makeRec(): Rec {
  return { stun: [], nat: [], purges: 0, scannerStops: 0 };
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
    stunProbe: async (host) => {
      rec.stun.push(host);
    },
    natCollector: async (servers) => {
      rec.nat = servers.map((s) => s.host);
      return { hasSrflx: true, srflxPortStable: true, mappingConsistency: 'endpoint-independent' as const, servers: servers.length };
    },
    scannerFactory: () => ({
      list: () => [{ port: 5173, name: 'Vite' }],
      start() {},
      ready: () => Promise.resolve(),
      stop() {
        rec.scannerStops += 1;
      },
    }),
    serviceStatusFn: async () => ({ installed: true, running: true, nodePath: process.execPath }),
    signalPollMs: 10,
    signalTimeoutMs: 150,
    scannerWaitMs: 50,
    stunTimeoutMs: 50,
    requestTimeoutMs: 1000,
    ...over,
  };
}

const layers = (checks: DoctorCheck[]): Layer[] => checks.map((c) => c.layer);
const byLayer = (checks: DoctorCheck[], l: Layer): DoctorCheck[] => checks.filter((c) => c.layer === l);

// ---------- 全绿汇总 ----------

test('全绿：八层按级联顺序全过（vps 每 relay 一条），输出不含 token/secret', async () => {
  const rec = makeRec();
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(rec));
  assert.deepEqual(layers(checks), ['auth', 'supabase', 'signaling', 'ice', 'vps', 'vps', 'scanner', 'service', 'nat']);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  // 信令自回环：写自己 doctor 房间、短 TTL、读回带往返耗时、事后清场
  assert.equal(rec.sentRoom, 'sig:uid-1:doctor');
  assert.ok(rec.sentTtl !== undefined && rec.sentTtl <= 60, `TTL 应短（实测 ${rec.sentTtl}）`);
  assert.ok(rec.purges >= 1, 'purgeExpired 应被尽力调用');
  assert.match(byLayer(checks, 'signaling')[0].detail, /往返 \d+ms/);
  // TURN：edge fn 通过 + 每台 relay 3478 STUN/UDP 探活
  assert.deepEqual(rec.stun, ['1.2.3.4', '5.6.7.8']);
  // NAT facts（W2-2 第 8 层）：STUN 地址从 cfg.relays 推导（relay.ip + STUN_PORT 契约），无鉴权依赖
  assert.deepEqual(rec.nat, ['1.2.3.4', '5.6.7.8']);
  const nat = byLayer(checks, 'nat')[0];
  assert.equal(nat.ok, true);
  assert.match(nat.detail, /^mapping=endpoint-independent servers=2$/);
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
  assert.ok(lines.some((l) => l.startsWith('✓ nat')), lines.join('\n'));
  assert.match(lines[lines.length - 1], /^OK：全部 9 项检查通过$/);

  const jsonLines: string[] = [];
  const code2 = await runDoctorCli(['--json', '--dir', '/tmp/x'], { ...happyDeps(makeRec()), fetchImpl: okFetch(), out: (l) => jsonLines.push(l) });
  assert.equal(code2, 0);
  const parsed = JSON.parse(jsonLines.join('\n')) as DoctorCheck[];
  assert.equal(parsed.length, 9);
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
  for (const l of ['supabase', 'signaling', 'ice', 'vps', 'nat'] as const) {
    const c = byLayer(checks, l)[0];
    assert.equal(c.ok, false, l);
    assert.match(c.detail, /依赖 auth 层通过/);
  }
  assert.ok(byLayer(checks, 'scanner')[0].ok);
  assert.ok(byLayer(checks, 'service')[0].ok);

  // CLI：退出码 = 失败数（auth + 5 个依赖层 = 6），人话输出含 ✗ 与修复行
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
  assert.equal(code, 6);
  assert.ok(lines.some((l) => l.startsWith('✗ auth')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('修复：')), '失败层必须给修复建议');
  assert.match(lines[lines.length - 1], /未通过 6\/8 项/);
});

test('auth.json 缺失 → layer=auth，fix 含 p2p-net login；vps 只依赖 cfg 仍实跑全绿', async () => {
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), { loadAuthFn: () => null }));
  const auth = byLayer(checks, 'auth')[0];
  assert.equal(auth.ok, false);
  assert.match(auth.fix ?? '', /p2p-net login/);
  assert.equal(byLayer(checks, 'vps').length, 2);
  assert.ok(byLayer(checks, 'vps').every((c) => c.ok), 'vps 探针无鉴权，auth 挂配置在仍应实跑');
  assert.ok(byLayer(checks, 'nat')[0].ok, 'nat 探针同样只依赖 cfg.relays（无鉴权），auth 挂仍实跑');
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

test('turn-credentials 500 / 空 iceServers → layer=ice，fix 含 TURN_HOSTS；edge fn 失败时不再探 relay STUN', async () => {
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
    assert.equal(rec.stun.length, 0, 'edge fn 失败时 relay STUN 探活无意义，不应发起');
  }
});

test('edge fn 正常但一台 relay STUN 探活超时 → layer=ice 部分失败，detail 点名故障 relay', async () => {
  const rec = makeRec();
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(rec, {
    stunProbe: async (host) => {
      rec.stun.push(host);
      if (host === '5.6.7.8') throw new Error('STUN 5.6.7.8:3478/udp 50ms 无响应');
    },
  }));
  const c = byLayer(checks, 'ice')[0];
  assert.equal(c.ok, false);
  assert.match(c.detail, /5\.6\.7\.8/);
  assert.match(c.detail, /STUN/);
  assert.ok(!c.detail.includes('1.2.3.4'), '健康 relay 不得被点名');
  assert.match(c.fix ?? '', /coturn/);
  assert.match(c.fix ?? '', /安全组|3478/);
});

test('中间盒 SYN 代答场景：STUN 探针全部超时 → ice 判负（6c 实锤：旧裸 TCP connect 探活在此假绿）', async () => {
  // 真机事故：coturn 已停、3478 无监听，但腾讯云 DDoS SYN 代理代答握手，nc -vz 全「通」。
  // 判活必须发真实 STUN 协议帧收 Binding Response——本测试钉死「探针失败即判负」的语义。
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), {
    stunProbe: async () => {
      throw new Error('STUN 无响应');
    },
  }));
  const c = byLayer(checks, 'ice')[0];
  assert.equal(c.ok, false);
  assert.match(c.detail, /STUN 探活失败：1\.2\.3\.4、5\.6\.7\.8/);
  assert.match(c.fix ?? '', /coturn/);
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
      ready: () => Promise.resolve(),
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
        // 结构化归因（M1）：枚举失败由 ctx.code 标识，doctor 不依赖文案匹配
        log.warn('scanner', '监听端口枚举失败，本轮跳过', { cmd: 'lsof', code: SCANNER_ENUM_FAILED_CODE });
      },
      ready: () => Promise.resolve(),
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

test('scanner：warn 有「枚举失败」文案但无结构化 code → 不误判枚举失败（文案不再是检测依据）', async () => {
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), {
    scannerFactory: ({ log }) => ({
      list: () => [],
      start() {
        log.warn('scanner', '监听端口枚举失败，本轮跳过', { cmd: 'lsof' }); // 无 code：不得触发枚举归因
      },
      ready: () => Promise.resolve(),
      stop() {},
    }),
  }));
  const c = byLayer(checks, 'scanner')[0];
  assert.equal(c.ok, true, '无结构化 code 的 warn 不得判枚举失败');
  assert.match(c.detail, /未发现本地服务/);
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

// ---------- nat 层归因（Wave 2 W2-2 第 8 层） ----------

test('nat：coturn 不可达（servers=0）→ layer=nat ok=false + fix 点名安全组，其余层照常（首败不阻断）', async () => {
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), {
    natCollector: async () => ({ hasSrflx: false, srflxPortStable: null, mappingConsistency: 'unknown' as const, servers: 0 }),
  }));
  const nat = byLayer(checks, 'nat')[0];
  assert.equal(nat.ok, false);
  assert.match(nat.detail, /^mapping=unknown servers=0$/);
  assert.match(nat.fix ?? '', /coturn/);
  assert.match(nat.fix ?? '', /安全组/);
  // detail 只带聚合语义（mapping/servers），绝不含 srflx ip（事件纪律同 events.ts）
  for (const l of ['auth', 'supabase', 'signaling', 'ice', 'scanner', 'service'] as const) {
    assert.ok(byLayer(checks, l).every((c) => c.ok), `${l} 不受 nat 失败影响`);
  }
});

test('nat：只配 1 台 relay 时退化（mappingConsistency=unknown, servers=1）仍 ok（Review Focus #2）', async () => {
  const oneRelay: AppConfig = { ...CFG, relays: [{ ip: '1.2.3.4' }] };
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), {
    loadConfigFn: () => oneRelay,
    natCollector: async () => ({ hasSrflx: true, srflxPortStable: true, mappingConsistency: 'unknown' as const, servers: 1 }),
  }));
  const nat = byLayer(checks, 'nat')[0];
  assert.equal(nat.ok, true, 'ok 判据 = servers≥1，单 relay 应答即过');
  assert.match(nat.detail, /^mapping=unknown servers=1$/);
});

test('nat：采集器自身抛错 → guard 归因到 nat 层，不中断整个 run', async () => {
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), {
    natCollector: async () => {
      throw new Error('boom');
    },
  }));
  const nat = byLayer(checks, 'nat')[0];
  assert.equal(nat.ok, false);
  assert.match(nat.detail, /探针自身异常/);
  assert.ok(byLayer(checks, 'service')[0].ok, 'nat 在 service 之后，前面的层不受影响');
});

test('nat：relays 为空 → ok 跳过（与 vps 层空 relays 同纪律）；cfg 缺失 → gated', async () => {
  const noRelay: AppConfig = { ...CFG, relays: [] };
  const checks = await runDoctor({ dir: '/tmp/x', fetchImpl: okFetch() }, happyDeps(makeRec(), {
    loadConfigFn: () => noRelay,
  }));
  const nat = byLayer(checks, 'nat')[0];
  assert.equal(nat.ok, true);
  assert.match(nat.detail, /无 relays.*跳过/);
});

// ---------- 默认 STUN 探针（真实 UDP 回环，不打桩） ----------

type StunServerBehavior = 'respond' | 'wrongTxn' | 'silent';

/** 本地 UDP 回环：按 behavior 回 Binding Response / 回坏 txn / 沉默。 */
function stunServer(behavior: StunServerBehavior): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.on('message', (msg, rinfo) => {
      if (behavior === 'silent' || msg.length < 20) return;
      const res = Buffer.alloc(20);
      msg.copy(res, 0, 0, 20); // 拷请求头（magic cookie + transaction ID 原样带回）
      res.writeUInt16BE(0x0101, 0); // Binding Success Response
      res.writeUInt16BE(0, 2);
      if (behavior === 'wrongTxn') res.writeUInt8(res.readUInt8(8) ^ 0xff, 8); // 破坏 transaction ID
      socket.send(res, rinfo.port, rinfo.address, () => {});
    });
    socket.bind(0, '127.0.0.1', () => {
      const addr = socket.address() as AddressInfo;
      resolve({ port: addr.port, close: () => socket.close() });
    });
  });
}

test('默认 STUN 探针：收到 transaction ID 匹配的 Binding Response → 判活', async () => {
  const srv = await stunServer('respond');
  try {
    await defaultStunProbe('127.0.0.1', srv.port, 1000);
  } finally {
    srv.close();
  }
});

test('默认 STUN 探针：对端沉默 → 按超时判死（及时返回不悬挂）', async () => {
  const srv = await stunServer('silent');
  try {
    const t0 = Date.now();
    await assert.rejects(defaultStunProbe('127.0.0.1', srv.port, 200), /无响应/);
    assert.ok(Date.now() - t0 < 2_000, `应在超时附近返回（实测 ${Date.now() - t0}ms）`);
  } finally {
    srv.close();
  }
});

test('默认 STUN 探针：transaction ID 不匹配的响应被忽略 → 超时判死', async () => {
  const srv = await stunServer('wrongTxn');
  try {
    await assert.rejects(defaultStunProbe('127.0.0.1', srv.port, 200), /无响应/);
  } finally {
    srv.close();
  }
});
