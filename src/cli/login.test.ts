/** login 命令测试（Task 17 / Controller 裁决 #1）：交互提问（密码 secret 不回显）→
 *  loginWithPassword → saveAuth（真实 0600 落盘在 tmpdir 验证）。失败路径不落盘、不泄密码。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthError, type AuthState } from '../server/auth.js';
import { loadAuth, saveConfig, type AppConfig } from '../server/store.js';
import { runLogin } from './login.js';

const CFG: AppConfig = { supabaseUrl: 'https://x.supabase.co', publishableKey: 'pk', tunnelSecret: 'ts', relays: [] };

test('login 成功：密码 secret 提问，凭据 0600 落 auth.json，输出只含邮箱', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-login-'));
  saveConfig(dir, CFG);
  const prompts: string[] = [];
  const out: string[] = [];
  const answers = ['a@b.c', 's3cret-pass'];
  const auth: AuthState = { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000, uid: 'u-1', email: 'a@b.c' };
  const seenLogin: { email?: string; password?: string } = {};

  await runLogin({
    configDir: dir,
    promptFn: async (_q, o) => {
      prompts.push(o?.secret ? 'secret' : 'plain');
      const a = answers.shift();
      assert.ok(a !== undefined, '脚本外的额外提问');
      return a;
    },
    loginFn: async (_cfg, email, password) => {
      seenLogin.email = email;
      seenLogin.password = password;
      return auth;
    },
    out: (l) => out.push(l),
  });

  assert.deepEqual(prompts, ['plain', 'secret'], '邮箱明文提问、密码 secret 提问');
  assert.deepEqual(seenLogin, { email: 'a@b.c', password: 's3cret-pass' });
  assert.deepEqual(loadAuth(dir), auth, 'auth.json 内容必须与登录结果一致');
  assert.equal(statSync(join(dir, 'auth.json')).mode & 0o777, 0o600, 'auth.json 必须 0600');
  assert.ok(out.some((l) => l.includes('a@b.c')), '成功输出应含邮箱');
  const surfaced = out.join('\n');
  for (const s of ['s3cret-pass', 'at-1', 'rt-1']) {
    assert.ok(!surfaced.includes(s), `stdout 泄漏秘密: ${s}`);
  }
});

test('login 失败：AuthError 人话上抛（含 p2p-net login），不落盘、不泄密码', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-login-'));
  saveConfig(dir, CFG);
  const answers = ['a@b.c', 'wrong-pass'];
  await assert.rejects(
    runLogin({
      configDir: dir,
      promptFn: async () => answers.shift()!,
      loginFn: async () => {
        throw new AuthError('登录失败：Invalid login credentials。请确认邮箱与密码无误后重试 p2p-net login');
      },
      out: () => {},
    }),
    (e: unknown) => {
      assert.ok(e instanceof AuthError, `应为 AuthError，实际 ${e}`);
      assert.match(e.message, /p2p-net login/);
      assert.ok(!e.message.includes('wrong-pass'), '错误文案不得含密码');
      return true;
    },
  );
  assert.equal(loadAuth(dir), null, '失败不得落 auth.json');
});

test('未 init：ConfigError 引导先跑 p2p-net init，不提问', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-login-'));
  await assert.rejects(
    runLogin({
      configDir: dir,
      promptFn: async () => {
        throw new Error('不应提问');
      },
      out: () => {},
    }),
    /p2p-net init/,
  );
});
