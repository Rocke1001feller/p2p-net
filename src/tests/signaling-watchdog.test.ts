import test from 'node:test';
import assert from 'node:assert/strict';
import { HostAgent } from '../host.js';
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
