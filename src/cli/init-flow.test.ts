/** init 总编排测试（Task 13）：全部外部依赖经 deps 注入（mgmt/runnerFactory/promptFn/fetchImpl/
 *  验证探针/configDir/out/log），零真实网络、零真实 readline；只有 configDir 指向的 tmpdir
 *  是真实文件系统——config.json / init-state.json 的落盘内容正是被测对象。
 *
 *  秘密纪律断言策略：turnSecret/tunnelSecret 由实现随机生成，测试无法预知字面值，
 *  改从它们"越界"的位置截获（mgmt.setSecrets 载荷 / 远端 exec 命令串），再断言
 *  该值不出现在任何本地落盘文件、stdout 与日志里。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runInit } from './init.js';
import { InitError } from './init/supabase.js';
import { SshError, type VpsCreds } from './init/ssh.js';
import type { SshRunnerLike } from './init/vps.js';
import type { SupabaseMgmt } from './init/mgmt.js';
import type { Logger } from '../log/logger.js';
import { loadConfig } from '../server/store.js';

const TOKEN = 'mgmt-token-secret';
const EMAIL = 'a@b.c';
const ADMIN_PW = 'admin-pw-secret';
const PW1 = 'vps-one-pw 含空格';
const PW2 = 'vps-two-pw';
const SERVICE_ROLE = 'sr-jwt-secret';

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

/** promptFn 脚本化：按序消费 answers；实现若多问一个（脚本耗尽）立即爆，顺带钉死提问次数。 */
function scriptedPrompt(answers: string[], calls: string[]) {
  return async (q: string, opts?: { secret?: boolean }): Promise<string> => {
    calls.push(`prompt:${opts?.secret ? 'secret' : 'plain'}`);
    const a = answers.shift();
    if (a === undefined) throw new Error(`脚本外的额外提问: ${q}`);
    return a;
  };
}

/** mgmt 假实现：记录语义步骤名；setSecrets 载荷留存供秘密纪律断言。 */
function fakeMgmt(calls: string[]) {
  const captured: { secrets?: Record<string, string> } = {};
  const mgmt = {
    listOrgs: async () => [{ id: 'org1', name: 'Org' }],
    createProject: async () => {
      calls.push('bootstrap:createProject');
      return { id: 'newref' };
    },
    waitHealthy: async () => {
      calls.push('bootstrap:waitHealthy');
    },
    runQuery: async () => {
      calls.push('bootstrap:runQuery');
    },
    deployFunctions: async () => {
      calls.push('bootstrap:deployFunctions');
    },
    setSecrets: async (_ref: string, secrets: Record<string, string>) => {
      calls.push('bootstrap:setSecrets');
      captured.secrets = secrets;
    },
    getApiKeys: async () => {
      calls.push('bootstrap:getApiKeys');
      return { anon: 'anon-jwt', serviceRole: SERVICE_ROLE };
    },
  };
  return { mgmt: mgmt as unknown as SupabaseMgmt, captured };
}

/** 单 mock fetch 同时扮演 Supabase 数据面/认证面 与 VPS 验证探针（config.json / /）。 */
function makeFetch(calls: string[]) {
  let sigPayload: unknown = null;
  const f = (async (url: unknown, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const u = new URL(String(url));
    const method = String(init.method ?? 'GET');
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.pathname === '/auth/v1/admin/users') {
      calls.push('bootstrap:createUser');
      return json({ id: 'uid-1' });
    }
    if (u.pathname === '/auth/v1/token') {
      calls.push('bootstrap:signIn');
      return json({ access_token: 'user-jwt', user: { id: 'uid-1' } });
    }
    if (u.pathname === '/rest/v1/signaling_messages' && method === 'POST') {
      calls.push('bootstrap:probeSignaling');
      sigPayload = JSON.parse(String(init.body)).payload;
      return new Response('', { status: 201 });
    }
    if (u.pathname === '/rest/v1/signaling_messages') return json([{ id: 1, payload: sigPayload }]);
    if (u.pathname === '/functions/v1/turn-credentials') {
      calls.push('bootstrap:probeTurn');
      return json({ iceServers: [{ urls: ['stun:1.1.1.1:3478'] }] });
    }
    // provisionVps 的四层验证探针（config.json 字段齐 + / 200）
    if (u.pathname === '/config.json') {
      return json({
        supabaseUrl: 'https://newref.supabase.co',
        publishableKey: 'anon-jwt',
        relays: [{ url: `https://${u.hostname}` }],
      });
    }
    if (u.pathname === '/') return new Response('<html>pwa</html>', { status: 200 });
    throw new Error(`unexpected fetch: ${method} ${u}`);
  }) as typeof fetch;
  return f;
}

/** runnerFactory 假实现：connect 记 `vps:<host>`、end 记 `vps:end:<host>`（串行断言用）；
 *  exec 命令串留存供 tunnelSecret 截获；failHosts 命中的 host 在 connect 时抛错。 */
function fakeRunnerFactory(calls: string[], opts: { failHosts?: Record<string, () => Error> } = {}) {
  const execCommands: string[] = [];
  const factory = async (creds: VpsCreds): Promise<SshRunnerLike> => {
    calls.push(`vps:${creds.host}`);
    const fail = opts.failHosts?.[creds.host];
    if (fail) throw fail();
    return {
      exec: async (cmd: string) => {
        execCommands.push(cmd);
        return { code: 0, stdout: '', stderr: '' };
      },
      putDir: async () => {},
      end: () => {
        calls.push(`vps:end:${creds.host}`);
      },
    };
  };
  return { factory, execCommands };
}

function assertOrder(calls: string[], expected: string[]): void {
  let idx = -1;
  for (const name of expected) {
    const i = calls.indexOf(name, idx + 1);
    assert.ok(i > idx, `步骤 ${name} 缺失或顺序错误；实际顺序：${calls.join(' → ')}`);
    idx = i;
  }
}

const VPS_ANSWERS = [`root@1.1.1.1 ${PW1}`, `root@2.2.2.2 ${PW2}`, ''];
const SUPABASE_ANSWERS = [TOKEN, '', '', EMAIL, ADMIN_PW]; // projectRef/region 留空 → 自动新建/默认

test('init 编排顺序：supabase 引导 → 逐台 VPS → 落 config → 打印安全组清单', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-init-'));
  const calls: string[] = [];
  const outLines: string[] = [];
  const { log, lines } = fakeLogger();
  const answers = [...VPS_ANSWERS, ...SUPABASE_ANSWERS];
  const { mgmt, captured } = fakeMgmt(calls);
  const { factory, execCommands } = fakeRunnerFactory(calls);

  // 清单打印时刻 config.json 必须已落盘且 relays 完整（落 config → 打印清单 的顺序断言）
  let configAtChecklist: string | null = null;
  const out = (l: string) => {
    outLines.push(l);
    if (l.includes('service install')) {
      try {
        configAtChecklist = readFileSync(join(dir, 'config.json'), 'utf8');
      } catch {
        configAtChecklist = null;
      }
    }
  };

  await runInit({
    configDir: dir,
    promptFn: scriptedPrompt(answers, calls),
    mgmt,
    fetchImpl: makeFetch(calls),
    runnerFactory: factory,
    certDaysLeftProbe: async () => 30,
    tunnelStatusProbe: async () => 401,
    pwaDistDir: '/tmp/pwa-dist-fake',
    log,
    out,
  });

  // 编排顺序：bootstrap 全部完成 → vps1 → vps1 收尾 → vps2（串行）
  assertOrder(calls, ['bootstrap:waitHealthy', 'bootstrap:probeTurn', 'vps:1.1.1.1', 'vps:end:1.1.1.1', 'vps:2.2.2.2']);
  // projectRef 留空 → 走了自动新建
  assert.ok(calls.includes('bootstrap:createProject'), `缺 createProject: ${calls.join()}`);
  // 提问脚本恰好消费完（不多问、不少问）
  assert.equal(answers.length, 0, `剩余未消费答案: ${JSON.stringify(answers)}`);
  // token/密码类提问全部走 secret 模式（VPS 三行 + token + 管理员密码 = 5）
  assert.equal(calls.filter((c) => c === 'prompt:secret').length, 5);

  // config.json 落盘：只含公开字段，relays 完整
  const cfg = loadConfig(dir);
  assert.equal(cfg.supabaseUrl, 'https://newref.supabase.co');
  assert.equal(cfg.publishableKey, 'anon-jwt');
  assert.deepEqual(cfg.relays, [{ ip: '1.1.1.1' }, { ip: '2.2.2.2' }]);
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600);

  // 落 config 先于打印清单：清单出现时 config.json 已是终态
  assert.ok(configAtChecklist !== null, '打印清单时 config.json 尚未落盘');
  const cfgEarly = JSON.parse(configAtChecklist as unknown as string) as { relays: { ip: string }[] };
  assert.deepEqual(cfgEarly.relays, [{ ip: '1.1.1.1' }, { ip: '2.2.2.2' }]);

  // stdout：安全组清单端口齐 + service install 建议 + 每台 PWA URL
  const outText = outLines.join('\n');
  for (const p of ['22', '80', '443', '3478', '50000']) {
    assert.ok(outText.includes(p), `stdout 缺端口 ${p}:\n${outText}`);
  }
  assert.ok(outText.includes('service install'), `stdout 缺 service install 建议:\n${outText}`);
  assert.ok(outText.includes('https://1.1.1.1') && outText.includes('https://2.2.2.2'));

  // 秘密纪律：截获部署级 turnSecret（写进了 Supabase secrets）与 tunnelSecret（进了远端命令串）
  const turnSecret = captured.secrets?.TURN_STATIC_AUTH_SECRET;
  assert.ok(typeof turnSecret === 'string' && /^[0-9a-f]{64}$/.test(turnSecret), `turnSecret 形态异常: ${turnSecret}`);
  assert.deepEqual(JSON.parse(captured.secrets?.TURN_HOSTS ?? ''), ['1.1.1.1', '2.2.2.2']);
  const initCmd = execCommands.find((c) => c.includes('TUNNEL_SECRET='));
  const tunnelSecret = /TUNNEL_SECRET='([^']+)'/.exec(initCmd ?? '')?.[1];
  assert.ok(tunnelSecret && /^[0-9a-f]{64}$/.test(tunnelSecret), `tunnelSecret 未注入远端命令: ${initCmd}`);

  const diskText = readFileSync(join(dir, 'config.json'), 'utf8') + readFileSync(join(dir, 'init-state.json'), 'utf8');
  const logText = JSON.stringify(lines);
  for (const s of [TOKEN, ADMIN_PW, PW1, PW2, SERVICE_ROLE, turnSecret, tunnelSecret]) {
    assert.ok(!diskText.includes(s), `本地落盘泄漏秘密: ${s}`);
    assert.ok(!outText.includes(s), `stdout 泄漏秘密: ${s}`);
    assert.ok(!logText.includes(s), `日志泄漏秘密: ${s}`);
  }
});

test('单台 VPS 失败即停，提示安全组复核，已完成阶段可续跑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-init-'));
  const { log } = fakeLogger();

  // 第一次跑：vps2 SSH 拒连 → 失败即停
  const calls1: string[] = [];
  const answers1 = [...VPS_ANSWERS, ...SUPABASE_ANSWERS];
  const h1 = fakeMgmt(calls1);
  await assert.rejects(
    runInit({
      configDir: dir,
      promptFn: scriptedPrompt(answers1, calls1),
      mgmt: h1.mgmt,
      fetchImpl: makeFetch(calls1),
      runnerFactory: fakeRunnerFactory(calls1, {
        failHosts: { '2.2.2.2': () => new SshError('CONN', '2.2.2.2:22', 'mock 拒连') },
      }).factory,
      certDaysLeftProbe: async () => 30,
      tunnelStatusProbe: async () => 401,
      pwaDistDir: '/tmp/pwa-dist-fake',
      log,
      out: () => {},
    }),
    (e: unknown) => {
      assert.ok(e instanceof InitError, `应为 InitError，实际 ${e}`);
      const msg = (e as Error).message;
      assert.match(msg, /安全组/);
      for (const p of ['22', '80', '443', '3478', '50000']) {
        assert.ok(msg.includes(p), `错误文案缺端口 ${p}: ${msg}`);
      }
      for (const s of [PW1, PW2, TOKEN, ADMIN_PW]) assert.ok(!msg.includes(s), `错误文案泄漏秘密: ${msg}`);
      return true;
    },
  );
  // 失败即停：vps2 失败后流程终止（vps1 已收尾、vps2 只 connect 过一次）
  assertOrder(calls1, ['bootstrap:probeTurn', 'vps:1.1.1.1', 'vps:end:1.1.1.1', 'vps:2.2.2.2']);
  assert.equal(calls1.filter((c) => c === 'vps:2.2.2.2').length, 1);

  // state 文件记录完成阶段（且不含任何秘密）
  const stateText = readFileSync(join(dir, 'init-state.json'), 'utf8');
  assert.deepEqual(JSON.parse(stateText), { supabaseDone: true, vpsDone: ['1.1.1.1'] });
  for (const s of [PW1, PW2, TOKEN, ADMIN_PW, SERVICE_ROLE]) assert.ok(!stateText.includes(s));

  // 第二次跑（续跑）：只问 VPS 列表；supabase 不重复引导；已完成 VPS 跳过
  const calls2: string[] = [];
  const answers2 = [...VPS_ANSWERS];
  const h2 = fakeMgmt(calls2);
  const out2: string[] = [];
  await runInit({
    configDir: dir,
    promptFn: scriptedPrompt(answers2, calls2),
    mgmt: h2.mgmt,
    fetchImpl: makeFetch(calls2),
    runnerFactory: fakeRunnerFactory(calls2).factory,
    certDaysLeftProbe: async () => 30,
    tunnelStatusProbe: async () => 401,
    pwaDistDir: '/tmp/pwa-dist-fake',
    log,
    out: (l) => out2.push(l),
  });
  assert.ok(!calls2.some((c) => c.startsWith('bootstrap:')), `续跑不应重复 supabase 引导: ${calls2.join(' → ')}`);
  assert.ok(!calls2.includes('vps:1.1.1.1'), `已完成 VPS 应跳过: ${calls2.join(' → ')}`);
  assert.ok(calls2.includes('vps:2.2.2.2'), `未完成 VPS 应补跑: ${calls2.join(' → ')}`);
  assert.equal(answers2.length, 0, '续跑不应再提 token/邮箱/密码');
  assert.deepEqual(loadConfig(dir).relays, [{ ip: '1.1.1.1' }, { ip: '2.2.2.2' }]);
  assert.ok(out2.join('\n').includes('service install'));
});
