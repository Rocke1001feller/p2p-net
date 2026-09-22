/** service 命令测试（Task 18）：渲染器是纯函数（钉死 launchd/systemd 模板形态）；
 *  install/uninstall/status 全走注入的 fake exec，断言 argv 数组（绝不真碰 launchctl/systemctl）。
 *  日志路径钉死 <configDir>/logs/service.log（两平台一致，T20 doctor 复用 serviceStatus）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installService,
  renderLaunchdPlist,
  renderSystemdUnit,
  runService,
  serviceStatus,
  uninstallService,
  warnIfVolatileNodePath,
  type ExecFn,
  type ExecResult,
} from './service.js';

// ---------- 渲染器（plan 钉死的三条） ----------

test('launchd plist 钉死 node 绝对路径与日志路径', () => {
  const p = renderLaunchdPlist({ nodePath: '/usr/local/bin/node', entry: '/x/dist/cli/bin.js', configDir: '/u/.p2p-net' });
  assert.match(p, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(p, /KeepAlive/);
  assert.match(p, /\/u\/\.p2p-net\/logs\/service\.log/);
});

test('systemd user unit 含 Restart 与钉死路径', () => {
  const u = renderSystemdUnit({ nodePath: '/home/u/.nvm/versions/node/v22.1.0/bin/node', entry: '/x/dist/cli/bin.js', configDir: '/home/u/.p2p-net' });
  assert.match(u, /Restart=always/);
  assert.match(u, /ExecStart=\/home\/u\/\.nvm\/versions\/node\/v22\.1\.0\/bin\/node \/x\/dist\/cli\/bin\.js start --foreground/);
});

test('nvm 路径给出警告文案', () => {
  const w = warnIfVolatileNodePath('/home/u/.nvm/versions/node/v22.1.0/bin/node');
  assert.match(w ?? '', /nvm/);
});

test('非易变路径不警告（系统 node / Homebrew）', () => {
  assert.equal(warnIfVolatileNodePath('/usr/local/bin/node'), null);
  assert.equal(warnIfVolatileNodePath('/opt/homebrew/bin/node'), null);
});

test('plist 对插值做 XML 转义（路径含 & < 不会破坏文档）', () => {
  const p = renderLaunchdPlist({ nodePath: '/opt/a&b/node', entry: '/x/<bin>.js', configDir: '/u/.p2p-net' });
  assert.ok(p.includes('<string>/opt/a&amp;b/node</string>'), 'nodePath 中的 & 必须转义');
  assert.ok(p.includes('<string>/x/&lt;bin&gt;.js</string>'), 'entry 中的 < > 必须转义');
  assert.ok(!p.includes('/opt/a&b/node'), '原文不得残留未转义的 &');
});

// ---------- install / uninstall / status（fake exec） ----------

type ExecCall = { cmd: string; args: string[] };

function fakeExec(handler?: (cmd: string, args: string[]) => ExecResult): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    return handler ? handler(cmd, args) : { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

const DEPS_BASE = { nodePath: '/usr/local/bin/node', uid: 501, out: () => {}, err: () => {} };

/** install 预检（I2）要求的 config.json + auth.json 落盘——真预检在所有 install 用例里保持激活，不走注入绕过。 */
function writeFakeConfig(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ supabaseUrl: 'https://x.supabase.co', publishableKey: 'pk', tunnelSecret: 'ts', relays: [{ ip: '1.1.1.1' }] }),
  );
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, uid: 'u', email: 'a@b.c' }),
  );
}

test('darwin install：写 LaunchAgents plist，bootout（容忍失败）后 bootstrap，幂等可重跑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const home = mkdtempSync(join(tmpdir(), 'p2p-net-home-'));
  const { exec, calls } = fakeExec((cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'bootout') return { code: 1, stdout: '', stderr: 'not loaded' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const opts = { configDir: dir };
  const deps = { ...DEPS_BASE, platform: 'darwin' as const, homeDir: home, exec };
  writeFakeConfig(dir);

  const r1 = await installService(opts, deps);
  const unitPath = join(home, 'Library', 'LaunchAgents', 'net.p2p-net.server.plist');
  assert.equal(r1.unitPath, unitPath);
  assert.ok(existsSync(unitPath), 'plist 必须落盘');
  assert.ok(existsSync(join(dir, 'logs')), 'logs 目录必须先建好（StandardOutPath 需要）');
  const plist = readFileSync(unitPath, 'utf8');
  assert.match(plist, /net\.p2p-net\.server/);
  assert.match(plist, /<key>ProgramArguments<\/key>/);
  assert.match(plist, /start<\/string>/);
  assert.match(plist, /--foreground<\/string>/);

  assert.deepEqual(
    calls.map((c) => [c.cmd, ...c.args].join(' ')),
    ['launchctl bootout gui/501/net.p2p-net.server', `launchctl bootstrap gui/501 ${unitPath}`],
    'bootout（忽略失败）→ bootstrap，argv 数组无 shell',
  );

  // 幂等：重跑覆盖同一文件、同样的调用序列，不报错
  const r2 = await installService(opts, deps);
  assert.equal(r2.unitPath, unitPath);
  assert.equal(calls.length, 4);
});

test('darwin install：nvm 路径打印警告但不阻断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const home = mkdtempSync(join(tmpdir(), 'p2p-net-home-'));
  const { exec } = fakeExec();
  const out: string[] = [];
  writeFakeConfig(dir);
  await installService(
    { configDir: dir },
    { ...DEPS_BASE, nodePath: '/Users/u/.nvm/versions/node/v22.1.0/bin/node', platform: 'darwin', homeDir: home, exec, out: (l) => out.push(l) },
  );
  assert.ok(out.some((l) => /nvm/.test(l)), 'nvm 路径必须给出警告文案');
});

test('linux install：写 systemd user unit，daemon-reload + enable --now，提示 enable-linger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const home = mkdtempSync(join(tmpdir(), 'p2p-net-home-'));
  const { exec, calls } = fakeExec();
  const out: string[] = [];
  writeFakeConfig(dir);
  const r = await installService(
    { configDir: dir },
    { ...DEPS_BASE, platform: 'linux', homeDir: home, exec, out: (l) => out.push(l) },
  );
  const unitPath = join(home, '.config', 'systemd', 'user', 'p2p-net.service');
  assert.equal(r.unitPath, unitPath);
  const unit = readFileSync(unitPath, 'utf8');
  assert.match(unit, /Restart=always/);
  assert.match(unit, /start --foreground/);
  assert.match(unit, /append:.*logs\/service\.log/);
  assert.deepEqual(
    calls.map((c) => [c.cmd, ...c.args].join(' ')),
    ['systemctl --user daemon-reload', 'systemctl --user enable --now p2p-net'],
  );
  assert.ok(out.some((l) => /loginctl enable-linger/.test(l)), '必须提示 enable-linger（断 ssh 后存活，只提示不代跑）');
});

test('不支持的平台（win32）报人话错误：暂不支持，Phase 2 规划', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const { exec, calls } = fakeExec();
  await assert.rejects(
    installService({ configDir: dir }, { ...DEPS_BASE, platform: 'win32', homeDir: dir, exec }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /暂不支持/);
      assert.match(e.message, /Phase 2/);
      return true;
    },
  );
  assert.equal(calls.length, 0, '不支持的平台不得发起任何进程调用');
});

// ---------- install 预检（I2：缺 config/auth 装上即 crash-loop，必须挡在安装这一刻） ----------

test('install 预检：缺 config.json → 人话引导 init，不写 unit、零进程调用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const home = mkdtempSync(join(tmpdir(), 'p2p-net-home-'));
  const { exec, calls } = fakeExec();
  await assert.rejects(
    installService({ configDir: dir }, { ...DEPS_BASE, platform: 'darwin', homeDir: home, exec }),
    /无法安装常驻服务[\s\S]*p2p-net init/,
  );
  assert.equal(calls.length, 0, '预检失败不得发起任何进程调用');
  assert.ok(!existsSync(join(home, 'Library', 'LaunchAgents', 'net.p2p-net.server.plist')), '预检失败不得写 unit');
});

test('install 预检：缺 auth.json → 人话引导 login + start 前台验证，不写 unit、零进程调用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const home = mkdtempSync(join(tmpdir(), 'p2p-net-home-'));
  const { exec, calls } = fakeExec();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ supabaseUrl: 'https://x.supabase.co', publishableKey: 'pk', tunnelSecret: 'ts', relays: [{ ip: '1.1.1.1' }] }),
  );
  await assert.rejects(
    installService({ configDir: dir }, { ...DEPS_BASE, platform: 'darwin', homeDir: home, exec }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /无法安装常驻服务/);
      assert.match(e.message, /p2p-net login/);
      assert.match(e.message, /p2p-net start 前台验证/, '文案必须给出前台验证这一步（I2 onboarding 顺序）');
      return true;
    },
  );
  assert.equal(calls.length, 0);
  assert.ok(!existsSync(join(home, 'Library', 'LaunchAgents', 'net.p2p-net.server.plist')), '预检失败不得写 unit');
});

test('install 预检：auth.json 坏 JSON → 人话引导重登，不写 unit、零进程调用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const home = mkdtempSync(join(tmpdir(), 'p2p-net-home-'));
  const { exec, calls } = fakeExec();
  writeFakeConfig(dir);
  writeFileSync(join(dir, 'auth.json'), '{broken');
  await assert.rejects(
    installService({ configDir: dir }, { ...DEPS_BASE, platform: 'linux', homeDir: home, exec }),
    /无法安装常驻服务[\s\S]*p2p-net login/,
  );
  assert.equal(calls.length, 0);
  assert.ok(!existsSync(join(home, '.config', 'systemd', 'user', 'p2p-net.service')), '预检失败不得写 unit');
});

test('bootstrap 失败：人话错误上抛（含 stderr 与下一步指引）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const home = mkdtempSync(join(tmpdir(), 'p2p-net-home-'));
  const { exec } = fakeExec((cmd, args) =>
    args[0] === 'bootstrap' ? { code: 5, stdout: '', stderr: 'Input/output error' } : { code: 0, stdout: '', stderr: '' },
  );
  writeFakeConfig(dir);
  await assert.rejects(
    installService({ configDir: dir }, { ...DEPS_BASE, platform: 'darwin', homeDir: home, exec }),
    /launchctl bootstrap 失败[\s\S]*Input\/output error[\s\S]*service uninstall/,
  );
});

test('darwin uninstall：bootout（未加载也容忍）+ 删 plist，幂等', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const home = mkdtempSync(join(tmpdir(), 'p2p-net-home-'));
  const { exec, calls } = fakeExec((cmd, args) =>
    args[0] === 'bootout' ? { code: 1, stdout: '', stderr: 'Could not find service' } : { code: 0, stdout: '', stderr: '' },
  );
  const deps = { ...DEPS_BASE, platform: 'darwin' as const, homeDir: home, exec };
  writeFakeConfig(dir);
  await installService({ configDir: dir }, deps);
  const unitPath = join(home, 'Library', 'LaunchAgents', 'net.p2p-net.server.plist');
  calls.length = 0;

  await uninstallService(deps);
  assert.deepEqual(calls.map((c) => [c.cmd, ...c.args].join(' ')), ['launchctl bootout gui/501/net.p2p-net.server']);
  assert.ok(!existsSync(unitPath), 'plist 必须删除');

  await uninstallService(deps); // 重复卸载不报错
});

test('linux uninstall：disable --now + daemon-reload + 删 unit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const home = mkdtempSync(join(tmpdir(), 'p2p-net-home-'));
  const { exec, calls } = fakeExec();
  const deps = { ...DEPS_BASE, platform: 'linux' as const, homeDir: home, exec };
  writeFakeConfig(dir);
  await installService({ configDir: dir }, deps);
  calls.length = 0;

  await uninstallService(deps);
  assert.deepEqual(
    calls.map((c) => [c.cmd, ...c.args].join(' ')),
    ['systemctl --user disable --now p2p-net', 'systemctl --user daemon-reload'],
  );
  assert.ok(!existsSync(join(home, '.config', 'systemd', 'user', 'p2p-net.service')));
});

// ---------- serviceStatus（T20 doctor 复用的精确形态） ----------

test('status：未安装 → installed/running 皆 false，nodePath 在场', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const home = mkdtempSync(join(tmpdir(), 'p2p-net-home-'));
  const { exec } = fakeExec();
  const s = await serviceStatus({ configDir: dir }, { ...DEPS_BASE, platform: 'darwin', homeDir: home, exec });
  assert.equal(s.installed, false);
  assert.equal(s.running, false);
  assert.equal(s.nodePath, '/usr/local/bin/node');
  assert.equal(s.lastCrashTail, undefined);
});

test('status：已安装且 launchctl print 成功 → running；日志尾行随 lastCrashTail 返回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const home = mkdtempSync(join(tmpdir(), 'p2p-net-home-'));
  const { exec } = fakeExec((cmd, args) =>
    args[0] === 'print' ? { code: 0, stdout: 'gui/501/net.p2p-net.server = {...}', stderr: '' } : { code: 0, stdout: '', stderr: '' },
  );
  const deps = { ...DEPS_BASE, platform: 'darwin' as const, homeDir: home, exec };
  writeFakeConfig(dir);
  await installService({ configDir: dir }, deps);

  mkdirSync(join(dir, 'logs'), { recursive: true });
  const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
  writeFileSync(join(dir, 'logs', 'service.log'), lines.join('\n') + '\n');

  const s = await serviceStatus({ configDir: dir }, deps);
  assert.equal(s.installed, true);
  assert.equal(s.running, true);
  assert.ok(s.lastCrashTail !== undefined);
  assert.ok(s.lastCrashTail.includes('line-39'), '尾行必须是最新内容');
  assert.ok(!s.lastCrashTail.includes('line-0\n'), '尾行必须截断（不整文件返回）');
});

test('status：launchctl print 未找到服务 → running=false 而非抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const home = mkdtempSync(join(tmpdir(), 'p2p-net-home-'));
  const { exec } = fakeExec((cmd, args) =>
    args[0] === 'print' ? { code: 113, stdout: '', stderr: 'Could not find service' } : { code: 0, stdout: '', stderr: '' },
  );
  const deps = { ...DEPS_BASE, platform: 'darwin' as const, homeDir: home, exec };
  writeFakeConfig(dir);
  await installService({ configDir: dir }, deps);
  const s = await serviceStatus({ configDir: dir }, deps);
  assert.equal(s.installed, true);
  assert.equal(s.running, false);
});

test('status：linux 以 is-active 判定 running（active → true，其他 → false）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const home = mkdtempSync(join(tmpdir(), 'p2p-net-home-'));
  const { exec, calls } = fakeExec((cmd, args) =>
    args.includes('is-active') ? { code: 0, stdout: 'active\n', stderr: '' } : { code: 0, stdout: '', stderr: '' },
  );
  const deps = { ...DEPS_BASE, platform: 'linux' as const, homeDir: home, exec };
  writeFakeConfig(dir);
  await installService({ configDir: dir }, deps);
  calls.length = 0;

  const s = await serviceStatus({ configDir: dir }, deps);
  assert.equal(s.running, true);
  assert.deepEqual(calls.map((c) => [c.cmd, ...c.args].join(' ')), ['systemctl --user is-active p2p-net']);
});

// ---------- runService CLI 子命令分发 ----------

test('runService：未知/缺失子命令 → 用法错误（含四子命令清单）', async () => {
  await assert.rejects(runService([], { out: () => {}, err: () => {} }), /install\|uninstall\|status\|logs/);
  await assert.rejects(runService(['bogus'], { out: () => {}, err: () => {} }), /未知 service 子命令/);
});

test('runService logs：默认打印日志尾行；-f 走注入 tailFn 跟随', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'logs', 'service.log'), 'a\nb\nc\n');
  const out: string[] = [];
  const tailCalls: { logPath: string; follow: boolean }[] = [];

  const code = await runService(['logs'], {
    configDir: dir,
    out: (l) => out.push(l),
    err: () => {},
    tailFn: async (logPath, follow) => {
      tailCalls.push({ logPath, follow });
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.equal(out.join('\n'), 'a\nb\nc');
  assert.equal(tailCalls.length, 0, '无 -f 不得 spawn tail');

  const code2 = await runService(['logs', '-f'], {
    configDir: dir,
    out: (l) => out.push(l),
    err: () => {},
    tailFn: async (logPath, follow) => {
      tailCalls.push({ logPath, follow });
      return 0;
    },
  });
  assert.equal(code2, 0);
  assert.deepEqual(tailCalls, [{ logPath: join(dir, 'logs', 'service.log'), follow: true }]);
});

test('runService status：未安装时输出引导 install 的提示，退出码 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-svc-'));
  const home = mkdtempSync(join(tmpdir(), 'p2p-net-home-'));
  const { exec } = fakeExec();
  const out: string[] = [];
  const code = await runService(['status'], {
    ...DEPS_BASE,
    platform: 'darwin',
    homeDir: home,
    exec,
    configDir: dir,
    out: (l) => out.push(l),
  });
  assert.equal(code, 0);
  assert.ok(out.some((l) => /未安装/.test(l) && /service install/.test(l)), '未安装必须引导 p2p-net service install');
});
