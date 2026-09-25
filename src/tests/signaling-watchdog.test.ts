import test from 'node:test';
import assert from 'node:assert/strict';
import { HostAgent } from '../host.js';
import { SignalingHttpError } from '../signaling/client.js';
import type { PollResult } from '../signaling/client.js';
import type { SigMessage } from '../signaling/protocol.js';

/** 2026-09-24 真机门禁 F4：host 信令轮询黑洞（offer 全进黑洞、/status 假正常，
 *  9min 与 20+min 两次均靠人工重启恢复）。看门狗三段楼梯：
 *  recoverAfter 起标记 recovering（状态面可见），recreateAfter 重建自有客户端，
 *  exitAfter 交常驻监管崩溃自愈（launchd KeepAlive / systemd Restart=always）。 */

async function until(fn: () => boolean, ms = 5000, what = ''): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

class FailSignaling {
  calls = 0;
  async send(_room: string, _sender: string, _msg: SigMessage): Promise<void> {}
  async poll(): Promise<PollResult> { this.calls++; throw new Error('signaling poll failed: 500'); }
  async purgeExpired(): Promise<void> {}
}

class FlakySignaling extends FailSignaling {
  constructor(private failsLeft: number) { super(); }
  override async poll(): Promise<PollResult> {
    this.calls++;
    if (this.failsLeft-- > 0) throw new Error('signaling poll failed: 503');
    return { msgs: [], cursor: 0 };
  }
}

function makeHost(over: Record<string, unknown> = {}): HostAgent {
  return new HostAgent({
    supabaseUrl: 'https://x.supabase.co',
    publishableKey: 'k',
    accessToken: () => 't',
    deviceId: 'desk-test',
    uid: 'u-test',
    turnFetcher: async () => { throw new Error('turn n/a in watchdog tests'); },
    pollMs: 5,
    ...over,
  } as ConstructorParameters<typeof HostAgent>[0]);
}

test('信令看门狗：连续失败爬楼梯，黑洞回调恰好一次（注入信令不重建）', async () => {
  const sig = new FailSignaling();
  let blackholes = 0;
  const host = makeHost({
    signaling: sig,
    signalingWatchdog: { recoverAfter: 2, recreateAfter: 3, exitAfter: 5 },
    onSignalingBlackHole: () => { blackholes++; },
  });
  host.start();
  try {
    await until(() => blackholes === 1, 5000, 'exitAfter=5 应触发黑洞回调');
    const h = host.signalingHealth();
    assert.equal(h.consecutiveFailures >= 5, true, `连续失败计数应 ≥5，实得 ${h.consecutiveFailures}`);
    assert.equal(h.recovering, true, 'recoverAfter=2 起必须标记 recovering（/status 不得再假正常）');
    assert.equal(h.recreated, false, '注入的信令实现不归看门狗重建');
    assert.equal(typeof h.firstFailureAt, 'number', '首败时间戳必须留痕');
    assert.match(h.lastError ?? '', /500/, '末次错误必须留痕');
    assert.equal(h.pollsFailed >= 5, true);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(blackholes, 1, '同一段黑洞 episode 只触发一次，不得连发');
  } finally {
    host.stop();
  }
});

test('信令看门狗：poll 恢复后计数清零、recovering 复位（假恢复不得残留黄灯）', async () => {
  const sig = new FlakySignaling(2); // 失败 2 次（达到 recoverAfter）后自愈
  const host = makeHost({
    signaling: sig,
    signalingWatchdog: { recoverAfter: 2, recreateAfter: 3, exitAfter: 1000 },
    onSignalingBlackHole: () => { throw new Error('不该走到黑洞回调'); },
  });
  host.start();
  try {
    await until(() => host.signalingHealth().recovering, 5000, '2 连败后应进入 recovering');
    await until(() => !host.signalingHealth().recovering && host.signalingHealth().consecutiveFailures === 0, 5000, '恢复后应清零复位');
    const h = host.signalingHealth();
    assert.equal(h.consecutiveFailures, 0);
    assert.equal(h.recovering, false);
    assert.equal(h.firstFailureAt, undefined, '恢复后首败时间戳应抹掉');
    assert.equal(h.pollsFailed, 2);
    assert.equal(h.pollsOk >= 1, true, '恢复后应有成功计数');
  } finally {
    host.stop();
  }
});

test('信令看门狗：自有 SignalingClient 在 recreateAfter 后重建一次（不注入信令）', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error('net down'))) as typeof fetch;
  try {
    const host = makeHost({
      signalingWatchdog: { recoverAfter: 1, recreateAfter: 2, exitAfter: 1000 },
      onSignalingBlackHole: () => { throw new Error('不该走到黑洞回调'); },
    });
    host.start();
    try {
      await until(() => host.signalingHealth().recreated, 5000, 'recreateAfter=2 应重建自有客户端');
      assert.equal(host.signalingHealth().recovering, true);
    } finally {
      host.stop();
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------- 2026-09-25 401 分类（真机事故：续期失败后 401 连败 199s 被判黑洞误杀进程） ----------
// 语义钉死：401/403 = 服务器可达、令牌被拒——不是黑洞。不撞三段楼梯（不累计 sigConsecFail、
// 不 recovering/recreated/exit），另计 authFailures 并触发节流的 onAuthFailure（即时续期）。
// 鉴权失败不重置也不垫高网络连败计数（楼梯只量网络类失败）；poll 成功一律双清零。

class AuthFailSignaling extends FailSignaling {
  override async poll(): Promise<PollResult> { this.calls++; throw new SignalingHttpError('poll', 401); }
}

/** 按序播出错的信令：每轮取队列首部（'auth401' | 'net500' | 'ok'），空则恒 ok。 */
class SeqSignaling extends FailSignaling {
  constructor(private seq: Array<'auth401' | 'net500' | 'ok'>) { super(); }
  override async poll(): Promise<PollResult> {
    this.calls++;
    const k = this.seq.shift() ?? 'ok';
    if (k === 'auth401') throw new SignalingHttpError('poll', 401);
    if (k === 'net500') throw new Error('signaling poll failed: 500');
    return { msgs: [], cursor: 0 };
  }
}

test('401 分类：连败不撞黑洞楼梯（不 recovering/不 exit），authFailures 留痕并触发续期回调', async () => {
  const sig = new AuthFailSignaling();
  let blackholes = 0;
  let authCbs = 0;
  const host = makeHost({
    signaling: sig,
    signalingWatchdog: { recoverAfter: 2, recreateAfter: 3, exitAfter: 5 },
    onSignalingBlackHole: () => { blackholes++; },
    onAuthFailure: () => { authCbs++; },
    authRetryMs: 40,
  });
  host.start();
  try {
    await until(() => sig.calls >= 8, 5000, '连败轮数应远超 exitAfter=5');
    const h = host.signalingHealth();
    assert.equal(blackholes, 0, '401 不是黑洞：exit 回调绝不得触发');
    assert.equal(h.consecutiveFailures, 0, '401 不垫网络连败楼梯');
    assert.equal(h.recovering, false, '401 不进 recovering（那是网络黑洞的语义）');
    assert.ok((h.authFailures ?? 0) >= 8, `鉴权连败必须单独留痕，实得 ${h.authFailures}`);
    assert.ok(authCbs >= 1, '必须触发 onAuthFailure 促即时续期');
    assert.match(h.lastError ?? '', /401/);
  } finally {
    host.stop();
  }
});

test('401 节流：冷却期内多次 401 只回调一次；冷却过后再回调', async () => {
  const sig = new AuthFailSignaling();
  let authCbs = 0;
  const host = makeHost({
    signaling: sig,
    onAuthFailure: () => { authCbs++; },
    authRetryMs: 120,
    signalingWatchdog: { exitAfter: 1000 },
    onSignalingBlackHole: () => { throw new Error('401 绝不得触发黑洞'); },
  });
  host.start();
  try {
    await until(() => sig.calls >= 5, 5000);
    assert.equal(authCbs, 1, '冷却期内连败只回调一次');
    await until(() => authCbs === 2, 5000, '冷却过后仍在连败应再回调一次');
  } finally {
    host.stop();
  }
});

test('401 恢复：poll 成功后 authFailures 清零', async () => {
  // 开关式 401（不用计数式：poll 5ms 一轮，连败-恢复窗口可能短于断言采样间隔，计数式有稳态竞争）
  const sig = new (class extends FailSignaling {
    up = false;
    override async poll(): Promise<PollResult> {
      this.calls++;
      if (!this.up) throw new SignalingHttpError('poll', 401);
      return { msgs: [], cursor: 0 };
    }
  })();
  const host = makeHost({
    signaling: sig,
    onAuthFailure: () => {},
    authRetryMs: 10,
    signalingWatchdog: { exitAfter: 1000 },
    onSignalingBlackHole: () => { throw new Error('401 绝不得触发黑洞'); },
  });
  host.start();
  try {
    await until(() => (host.signalingHealth().authFailures ?? 0) >= 3, 5000, '连败应留痕');
    sig.up = true;
    await until(() => host.signalingHealth().pollsOk >= 1, 5000, '随后应恢复成功');
    await until(() => host.signalingHealth().authFailures === 0, 5000, '恢复后鉴权连败清零');
    assert.equal(host.signalingHealth().consecutiveFailures, 0);
  } finally {
    host.stop();
  }
});

test('混合分类：401 不垫不拆网络楼梯——net500 ×3 → 401 ×3 → net500 ×2 仍判黑洞', async () => {
  const sig = new SeqSignaling(['net500', 'net500', 'net500', 'auth401', 'auth401', 'auth401', 'net500', 'net500']);
  let blackholes = 0;
  const host = makeHost({
    signaling: sig,
    signalingWatchdog: { recoverAfter: 2, recreateAfter: 1000, exitAfter: 5 },
    onSignalingBlackHole: () => { blackholes++; },
    onAuthFailure: () => {},
    authRetryMs: 10,
  });
  host.start();
  try {
    await until(() => blackholes === 1, 5000, '网络类累计 5 次（中段 401 不干扰计数）应判黑洞');
    const h = host.signalingHealth();
    assert.ok(h.consecutiveFailures >= 5);
    assert.ok((h.authFailures ?? 0) >= 3, '中段 401 另账留痕');
  } finally {
    host.stop();
  }
});
