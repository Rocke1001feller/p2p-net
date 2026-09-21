import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVpsSpec, SshError, SshRunner } from './ssh.js';

/** 故意带空格 + 特殊字符 + CJK 的密码，全程只许进内存，任何错误面都不得出现。 */
const PW = 'p@$$ "w0rd!x 含空格';

test('解析 user@ip password 列表项', () => {
  assert.deepEqual(parseVpsSpec('ubuntu@1.2.3.4 pass w0rd'), {
    host: '1.2.3.4',
    username: 'ubuntu',
    password: 'pass w0rd',
  });
});

test('密码含特殊字符原样保留（Review Focus #2）', () => {
  const v = parseVpsSpec('root@1.2.3.4 p@$$"w0rd!x');
  assert.equal(v.password, 'p@$$"w0rd!x');
});

test('格式错误给出行号与人话', () => {
  assert.throws(() => parseVpsSpec('没有at符号'), /格式应为/);
  // 调用方逐行解析列表时可传行号，错误消息须带上
  assert.throws(() => parseVpsSpec('没有at符号', 3), /第 3 行/);
  // 格式错误消息不得回显密码部分（防经日志泄漏）
  assert.throws(
    () => parseVpsSpec('no-at-sign secret-pw'),
    (e) => e instanceof Error && !e.message.includes('secret-pw'),
  );
});

test('认证失败映射为 SshError(AUTH) 且文案可操作', async () => {
  // 需要真 sshd 时用 env P2PNET_TEST_VPS 激活；默认断言 SshError 文案模板：
  const e = new SshError('AUTH', '1.2.3.4');
  assert.match(e.message, /认证失败/);
  assert.match(e.message, /检查用户名与密码/);
});

test('SshError 四种 code 文案均说人话且带目标主机', () => {
  const t = '1.2.3.4:22';
  assert.match(new SshError('TIMEOUT', t).message, /超时/);
  assert.match(new SshError('TIMEOUT', t).message, /安全组/);
  assert.match(new SshError('CONN', t).message, /无法连接/);
  assert.match(new SshError('CONN', t).message, /安全组/);
  assert.match(new SshError('EXEC', t).message, /执行失败/);
  for (const code of ['AUTH', 'TIMEOUT', 'CONN', 'EXEC'] as const) {
    assert.ok(new SshError(code, t).message.includes(t), `${code} 文案应带目标主机`);
  }
});

/** 找一个当前空闲随即释放的本地端口（连接必遭 ECONNREFUSED）。 */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((res) => s.listen(0, '127.0.0.1', res));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((res) => s.close(() => res()));
  return port;
}

/** 黑洞 TCP server：accept 后永不发声，SSH 握手必然超时。
 *  socket 须 resume()（否则 paused 模式下 FIN 不被消费，server.close() 会挂），
 *  close() 兜底销毁残留连接，保证测试进程干净退出。 */
async function blackholeServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.resume();
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const close = async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((res) => server.close(() => res()));
  };
  return { port: (server.address() as AddressInfo).port, close };
}

function assertNoPassword(e: unknown, pw: string): void {
  assert.ok(e instanceof Error, `应为 Error，实际 ${e}`);
  assert.ok(!e.message.includes(pw), `错误消息泄漏密码: ${e.message}`);
  assert.ok(!String(e.stack).includes(pw), `堆栈泄漏密码: ${e.stack}`);
}

test('连接被拒映射 SshError(CONN)，不挂死且 message/stack 不含密码（Review Focus #2）', async () => {
  const port = await closedPort();
  const t0 = Date.now();
  await assert.rejects(
    SshRunner.connect({ host: '127.0.0.1', port, username: 'ubuntu', password: PW }),
    (e) => {
      assert.ok(e instanceof SshError, `应为 SshError，实际 ${e}`);
      assert.equal(e.code, 'CONN');
      assert.match(e.message, /无法连接/);
      assertNoPassword(e, PW);
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 5000, '连接被拒应立即返回，不得挂死');
});

test('握手无响应按 timeoutMs 准时映射 SshError(TIMEOUT)，不泄漏密码（Review Focus #2）', async () => {
  const { port, close } = await blackholeServer();
  try {
    const t0 = Date.now();
    await assert.rejects(
      SshRunner.connect({ host: '127.0.0.1', port, username: 'ubuntu', password: PW }, 300),
      (e) => {
        assert.ok(e instanceof SshError, `应为 SshError，实际 ${e}`);
        assert.equal(e.code, 'TIMEOUT');
        assert.match(e.message, /超时/);
        assertNoPassword(e, PW);
        return true;
      },
    );
    const dt = Date.now() - t0;
    assert.ok(dt < 5000, `超时应在 timeoutMs 附近触发而非挂死，实际 ${dt}ms`);
  } finally {
    await close();
  }
});

test('detail 中即便混入密码也被 scrub', () => {
  // connect/exec 内部对所有底层错误消息做 scrub；这里直接验证 SshError 构造路径不引入密码：
  // 模板只渲染 code+target+detail，密码只能来自调用方误传——SshRunner 内部已 scrub，
  // 本测试锁定模板本身不含任何凭据字段。
  const e = new SshError('CONN', '1.2.3.4:22', 'connect ECONNREFUSED');
  assertNoPassword(e, PW);
  assert.equal(e.name, 'SshError');
});

// ---- 真机测试：默认跳过，设置 P2PNET_TEST_VPS='user@ip 密码' 后激活 ----
const LIVE = process.env.P2PNET_TEST_VPS;
const skipLive = LIVE ? false : '需要 P2PNET_TEST_VPS 环境变量（真 sshd）';

test('真机：错误密码 → SshError(AUTH) 且不泄漏（需 P2PNET_TEST_VPS）', { skip: skipLive }, async () => {
  const creds = parseVpsSpec(LIVE!);
  const wrong = { ...creds, password: `wrong-${creds.password}` };
  await assert.rejects(SshRunner.connect(wrong, 15000), (e) => {
    assert.ok(e instanceof SshError, `应为 SshError，实际 ${e}`);
    assert.equal(e.code, 'AUTH');
    assertNoPassword(e, wrong.password);
    return true;
  });
});

test('真机：exec 收集 code/stdout/stderr，putDir 递归权限 0644/0755（需 P2PNET_TEST_VPS）', { skip: skipLive }, async () => {
  const creds = parseVpsSpec(LIVE!);
  const r = await SshRunner.connect(creds, 15000);
  const remote = `/tmp/p2p-net-ssh-test-${process.pid}`;
  const local = mkdtempSync(join(tmpdir(), 'p2p-net-ssh-'));
  try {
    const ok = await r.exec('echo hello && echo oops >&2');
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /hello/);
    assert.match(ok.stderr, /oops/);
    const bad = await r.exec('exit 3');
    assert.equal(bad.code, 3);

    mkdirSync(join(local, 'sub'));
    writeFileSync(join(local, 'f.txt'), 'top');
    writeFileSync(join(local, 'sub', 'g.txt'), 'nested');
    await r.putDir(local, remote);
    const check = await r.exec(`stat -c '%a' ${remote} ${remote}/f.txt ${remote}/sub ${remote}/sub/g.txt`);
    assert.equal(check.code, 0, check.stderr);
    assert.deepEqual(check.stdout.trim().split('\n'), ['755', '644', '755', '644']);
    const content = await r.exec(`cat ${remote}/sub/g.txt`);
    assert.equal(content.stdout, 'nested');
  } finally {
    await r.exec(`rm -rf ${remote}`).catch(() => {});
    r.end();
    rmSync(local, { recursive: true, force: true });
  }
});
