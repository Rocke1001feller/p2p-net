import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionVps, renderConfigJson, verifyVps, type ProvisionDeps, type SshRunnerLike, type VerifyDeps } from './vps.js';
import { SshError, type VpsCreds } from './ssh.js';
import { InitError } from './supabase.js';
import type { Logger } from '../../log/logger.js';

/** 三个 secret：SSH 密码 / TURN_SECRET / TUNNEL_SECRET——任何日志行与错误消息都不得含其值。 */
const PW = 'ssh-p@ssw0rd 含空格';
const TURN = 'turn-s3cret-value';
const TUNNEL = 'tunnel-s3cret-value';
const IP = '1.2.3.4';

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

function baseCreds(): VpsCreds {
  return { host: IP, username: 'root', password: PW };
}

function baseOpts(log: Logger) {
  return {
    turnSecret: TURN,
    tunnelSecret: TUNNEL,
    pwaDistDir: '/tmp/pwa-dist-fake',
    supabaseUrl: 'https://x.supabase.co',
    publishableKey: 'sb_publishable_x',
    log,
  };
}

/** 记录全部调用的假 runner；exec 结果按队列出队（默认退出码 0）。 */
function fakeRunner(calls: string[], execResults: { code: number; stdout: string; stderr: string }[] = []) {
  const execCommands: string[] = [];
  const putDirs: { local: string; remote: string }[] = [];
  const state = { ended: false };
  const runner: SshRunnerLike = {
    async exec(cmd: string) {
      calls.push('exec');
      execCommands.push(cmd);
      return execResults.shift() ?? { code: 0, stdout: '', stderr: '' };
    },
    async putDir(local: string, remote: string) {
      calls.push(`putDir:${remote}`);
      putDirs.push({ local, remote });
    },
    end() {
      state.ended = true;
      calls.push('end');
    },
  };
  return { runner, execCommands, putDirs, state };
}

/** 全绿验证探针 deps（config.json 200+字段齐、/ 200、证书 30 天、隧道 401）。 */
function greenVerifyDeps() {
  const fetchUrls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    const u = String(url);
    fetchUrls.push(u);
    const path = new URL(u).pathname;
    if (path === '/config.json') {
      return new Response(
        JSON.stringify({ supabaseUrl: 'https://x.supabase.co', publishableKey: 'sb_publishable_x', relays: [{ url: `https://${IP}` }] }),
        { status: 200 },
      );
    }
    if (path === '/') return new Response('<html>p2p-net</html>', { status: 200 });
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  return {
    fetchImpl,
    fetchUrls,
    certDaysLeftProbe: async () => 30,
    tunnelStatusProbe: async () => 401,
  };
}

test('写入 VPS 的 /config.json 结构正确', () => {
  const j = JSON.parse(renderConfigJson({ supabaseUrl: 'https://x.supabase.co', publishableKey: 'k', ip: '1.2.3.4' }));
  assert.equal(j.supabaseUrl, 'https://x.supabase.co');
  assert.deepEqual(j.relays, [{ url: 'https://1.2.3.4' }]);
  // 结构精确：字段全集 = supabaseUrl/publishableKey/relays（与 pwa/src/config.ts RuntimeConfig 对齐）
  assert.equal(j.publishableKey, 'k');
  assert.deepEqual(Object.keys(j).sort(), ['publishableKey', 'relays', 'supabaseUrl']);
});

test('verifyVps 四层探针全绿：config.json 200+字段、/ 200、证书 30 天、隧道 401', async () => {
  const deps = greenVerifyDeps();
  const r = await verifyVps(IP, deps);
  assert.deepEqual(r, { httpsOk: true, certDaysLeft: 30, tunnelAlive: true });
  // 探针全部走 https://<ip> 同源
  assert.deepEqual(deps.fetchUrls.sort(), [`https://${IP}/`, `https://${IP}/config.json`]);
});

test('verifyVps 对 401 隧道响应判定 alive（未授权=活着）；500/超时 → false', async () => {
  const deps = greenVerifyDeps();
  // 401 = alive 已在上一用例覆盖；此处覆盖反向：500 与网络异常（超时同型）
  const r500 = await verifyVps(IP, { ...deps, tunnelStatusProbe: async () => 500 });
  assert.equal(r500.tunnelAlive, false);
  const rTimeout = await verifyVps(IP, {
    ...deps,
    tunnelStatusProbe: async () => {
      throw new Error('隧道探测 10000ms 超时');
    },
  });
  assert.equal(rTimeout.tunnelAlive, false);
  // 隧道不绿不拖垮其余探针
  assert.equal(r500.httpsOk, true);
  assert.equal(r500.certDaysLeft, 30);
});

test('verifyVps：config.json 缺字段 / 非 200、根路径非 200、证书探测失败 → 各自不绿', async () => {
  const deps = greenVerifyDeps();

  const missingField = (async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    if (path === '/config.json') return new Response(JSON.stringify({ supabaseUrl: 'https://x.supabase.co' }), { status: 200 });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  assert.equal((await verifyVps(IP, { ...deps, fetchImpl: missingField })).httpsOk, false);

  const config500 = (async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    return new Response('x', { status: path === '/config.json' ? 500 : 200 });
  }) as typeof fetch;
  assert.equal((await verifyVps(IP, { ...deps, fetchImpl: config500 })).httpsOk, false);

  const root500 = (async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    if (path === '/config.json') {
      return new Response(JSON.stringify({ supabaseUrl: 'a', publishableKey: 'b', relays: [{ url: 'c' }] }), { status: 200 });
    }
    return new Response('x', { status: 500 });
  }) as typeof fetch;
  assert.equal((await verifyVps(IP, { ...deps, fetchImpl: root500 })).httpsOk, false);

  const r = await verifyVps(IP, {
    ...deps,
    certDaysLeftProbe: async () => {
      throw new Error('TLS 握手失败');
    },
  });
  assert.equal(r.certDaysLeft, -1);
});

test('编排顺序：connect → node-init → init 脚本(带 env) → PWA → config.json → 隧道入口 → restart → end → verify', async () => {
  const calls: string[] = [];
  const { runner, execCommands, putDirs, state } = fakeRunner(calls);
  const { log, lines } = fakeLogger();
  const verify = greenVerifyDeps();
  const deps: ProvisionDeps = {
    connectRunner: async (c) => {
      calls.push(`connect:${c.host}`);
      return runner;
    },
    ...verify,
  };

  const r = await provisionVps(baseCreds(), baseOpts(log), log, deps);

  assert.deepEqual(r, { ip: IP, pwaUrl: `https://${IP}` });
  assert.deepEqual(calls, [
    `connect:${IP}`,
    'putDir:/opt/p2p-net-init',
    'exec',
    'putDir:/opt/p2p-net/pwa',
    'exec',
    'putDir:/opt/p2p-net',
    'exec',
    'end',
  ]);

  // ① node-init 资产整目录上传（init-node.sh 需要同目录的 tunnel-relay-entry.mjs）
  assert.ok(putDirs[0].local.includes('node-init'), `local=${putDirs[0].local}`);
  // ② init 脚本经 env 注入两个 secret（命令通道允许携带；日志/错误绝不允许）
  assert.match(execCommands[0], /bash \/opt\/p2p-net-init\/init-node\.sh/);
  assert.ok(execCommands[0].includes(`TURN_SECRET='${TURN}'`), execCommands[0]);
  assert.ok(execCommands[0].includes(`TUNNEL_SECRET='${TUNNEL}'`), execCommands[0]);
  // ③ config.json 经 base64 落盘，内容与 renderConfigJson 逐字节一致
  const m = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/opt\/p2p-net\/pwa\/config\.json/.exec(execCommands[1]);
  assert.ok(m, `config.json 写入命令不符预期: ${execCommands[1]}`);
  assert.equal(
    Buffer.from(m[1], 'base64').toString('utf8'),
    renderConfigJson({ supabaseUrl: 'https://x.supabase.co', publishableKey: 'sb_publishable_x', ip: IP }),
  );
  // ④ PWA 与隧道入口落位
  assert.deepEqual(putDirs[1], { local: '/tmp/pwa-dist-fake', remote: '/opt/p2p-net/pwa' });
  assert.ok(putDirs[2].local.includes('node-init') && putDirs[2].remote === '/opt/p2p-net');
  // ⑤ 重启三服务（重跑幂等，让新配置生效）
  assert.equal(execCommands[2], 'systemctl restart p2p-net-tunnel caddy coturn');
  assert.ok(state.ended, 'runner 必须 end()');

  // 日志分层 vps 且三个 secret 全程不出现
  assert.ok(lines.length >= 6, `日志行数不足：${lines.length}`);
  for (const l of lines) assert.equal(l.layer, 'vps', JSON.stringify(l));
  const logText = JSON.stringify(lines);
  for (const secret of [PW, TURN, TUNNEL]) assert.ok(!logText.includes(secret), `日志泄漏 ${secret}`);
});

test('编排失败（SSH AUTH）：日志分层 vps 且不带任何 secret（brief 用例 3）', async () => {
  const { log, lines } = fakeLogger();
  const deps: ProvisionDeps = {
    connectRunner: async () => {
      throw new SshError('AUTH', `${IP}:22`);
    },
  };
  await assert.rejects(provisionVps(baseCreds(), baseOpts(log), log, deps), (e) => {
    assert.ok(e instanceof InitError, `应为 InitError，实际 ${e}`);
    assert.equal(e.step, 'connect');
    assert.ok(e.cause instanceof SshError);
    for (const secret of [PW, TURN, TUNNEL]) assert.ok(!e.message.includes(secret), `错误消息泄漏 ${secret}`);
    return true;
  });
  assert.ok(lines.length >= 1);
  for (const l of lines) assert.equal(l.layer, 'vps', JSON.stringify(l));
  const logText = JSON.stringify(lines);
  for (const secret of [PW, TURN, TUNNEL]) assert.ok(!logText.includes(secret), `日志泄漏 ${secret}`);
});

test('init 脚本非零退出：stderr 摘要先脱敏再进错误，runner 仍 end()', async () => {
  const calls: string[] = [];
  const { runner, state } = fakeRunner(calls, [
    { code: 1, stdout: '', stderr: `install failed: secret was ${TURN} and ${PW}` },
  ]);
  const { log, lines } = fakeLogger();
  const deps: ProvisionDeps = {
    connectRunner: async () => runner,
    ...greenVerifyDeps(),
  };
  await assert.rejects(provisionVps(baseCreds(), baseOpts(log), log, deps), (e) => {
    assert.ok(e instanceof InitError, `应为 InitError，实际 ${e}`);
    assert.equal(e.step, 'initScript');
    assert.match(e.message, /退出码 1/);
    assert.match(e.message, /重跑 init|安全组/);
    for (const secret of [PW, TURN, TUNNEL]) assert.ok(!e.message.includes(secret), `错误消息泄漏 ${secret}: ${e.message}`);
    return true;
  });
  assert.ok(state.ended, '失败路径也必须 end()');
  const logText = JSON.stringify(lines);
  for (const secret of [PW, TURN, TUNNEL]) assert.ok(!logText.includes(secret), `日志泄漏 ${secret}`);
});

test('验证不绿 → InitError(verify) 带安全组 443/3478 提示与探针状态', async () => {
  const calls: string[] = [];
  const { runner } = fakeRunner(calls);
  const { log } = fakeLogger();
  const verify = greenVerifyDeps();
  const deps: ProvisionDeps = {
    connectRunner: async () => runner,
    ...verify,
    tunnelStatusProbe: async () => 500,
    verifyRetry: { attempts: 2, intervalMs: 1 },
  };
  await assert.rejects(provisionVps(baseCreds(), baseOpts(log), log, deps), (e) => {
    assert.ok(e instanceof InitError, `应为 InitError，实际 ${e}`);
    assert.equal(e.step, 'verify');
    assert.match(e.message, /安全组/);
    assert.match(e.message, /443/);
    assert.match(e.message, /3478/);
    assert.match(e.message, /tunnelAlive=false/);
    return true;
  });
});

test('验证探针重试：首红次绿 → 成功（restart↔ACME 签发竞态回归）', async () => {
  const calls: string[] = [];
  const { runner } = fakeRunner(calls);
  const { log } = fakeLogger();
  const verify = greenVerifyDeps();
  let certCalls = 0;
  const deps: ProvisionDeps = {
    connectRunner: async () => runner,
    ...verify,
    certDaysLeftProbe: async () => (certCalls++ === 0 ? -1 : 30), // 首轮证书未就绪，次轮就绪
    verifyRetry: { attempts: 3, intervalMs: 1 },
  };
  const r = await provisionVps(baseCreds(), baseOpts(log), log, deps);
  assert.equal(r.pwaUrl, `https://${IP}`);
  assert.equal(certCalls, 2, '证书探针应恰好被调用两次（首红次绿即停）');
});
