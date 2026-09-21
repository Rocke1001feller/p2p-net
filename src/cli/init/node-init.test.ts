import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const SH = 'node-init/init-node.sh';

const DRYRUN_ENV = {
  ...process.env,
  P2PNET_DRYRUN: '1',
  TURN_SECRET: 's3cret',
  TUNNEL_SECRET: 'tun',
  P2PNET_TEST_PUBLIC_IP: '9.9.9.9',
  P2PNET_TEST_PRIVATE_IP: '10.0.0.2',
};

test('bash 语法合法', () => {
  execFileSync('bash', ['-n', SH]);
});

test('dryrun 渲染 turnserver.conf：含 use-auth-secret 与 external-ip（Review Focus #1）', () => {
  const out = execFileSync('bash', [SH], { env: DRYRUN_ENV, encoding: 'utf8' });
  assert.match(out, /use-auth-secret/);
  assert.match(out, /static-auth-secret=s3cret/);
  assert.match(out, /external-ip=9\.9\.9\.9\/10\.0\.0\.2/);
  assert.match(out, /listening-port=3478/);
});

test('dryrun 渲染 Caddyfile：default_sni + 短证书 profile + /tunnel 反代 + pwa root', () => {
  const out = execFileSync('bash', [SH], {
    env: { ...DRYRUN_ENV, TURN_SECRET: 'x', TUNNEL_SECRET: 'y' },
    encoding: 'utf8',
  });
  assert.match(out, /default_sni 9\.9\.9\.9/);
  assert.match(out, /profile shortlived/);
  assert.match(out, /reverse_proxy \/tunnel\/\* 127\.0\.0\.1:19700/);
  assert.match(out, /root \* \/opt\/p2p-net\/pwa/);
});

test('非 Ubuntu/Debian 明确拒绝', () => {
  // execFileSync 在非零退出时抛错；拒绝语义 = 退出码 1 + 人话报错（脚本约定见 init-node.sh 头部）
  assert.throws(
    () =>
      execFileSync('bash', [SH], {
        env: { ...DRYRUN_ENV, P2PNET_TEST_OS: 'centos' },
        encoding: 'utf8',
      }),
    (err: unknown) => {
      const e = err as { status: number; stdout: string; stderr: string };
      assert.equal(e.status, 1);
      assert.match(String(e.stdout) + String(e.stderr), /暂不支持|unsupported/i);
      return true;
    },
  );
});
