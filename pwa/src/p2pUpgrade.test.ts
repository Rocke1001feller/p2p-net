import test from 'node:test';
import assert from 'node:assert/strict';
import { P2pUpgrade } from './p2pUpgrade.js';

function fakeClock() {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    timers,
    setTimeoutFn: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeoutFn: (t: unknown) => { (t as { cleared: boolean }).cleared = true; },
    fireNext(): number | null {
      const t = timers.find((x) => !x.cleared);
      if (!t) return null;
      t.cleared = true;
      t.fn();
      return t.ms;
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

test('隧道会话 60s 后首探；成功 → adopted 终态不再排程', async () => {
  const clock = fakeClock();
  let attempts = 0;
  const up = new P2pUpgrade({
    isTunnelActive: () => true,
    attempt: async () => { attempts += 1; return true; },
    firstDelayMs: 60_000,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  up.start();
  assert.equal(up.state, 'idle');
  clock.fireNext();
  await flush(); await flush();
  assert.equal(attempts, 1);
  assert.equal(up.state, 'adopted');
  assert.equal(clock.timers.filter((t) => !t.cleared).length, 0);
  up.stop();
});

test('连败退避 60→120→240→480s 封顶；隧道切走空转；stop 幂等', async () => {
  const clock = fakeClock();
  let attempts = 0;
  let tunnelActive = true;
  const up = new P2pUpgrade({
    isTunnelActive: () => tunnelActive,
    attempt: async () => { attempts += 1; return false; },
    firstDelayMs: 60_000,
    backoffCapMs: 480_000,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  up.start();
  const gaps: (number | null)[] = [];
  for (let i = 0; i < 4; i++) { gaps.push(clock.fireNext()); await flush(); await flush(); }
  // 首拍 60s（fireNext 返回的是刚触发的定时器间隔）；后续排程间隔翻倍封顶；
  // 每拍必再排下一拍（封顶后仍 480 循环），故 4 拍后排程序列共 1+4=5 个，第 5 个 480 待触发
  assert.equal(attempts, 4);
  const scheduled = clock.timers.map((t) => t.ms);
  assert.deepEqual(scheduled, [60_000, 120_000, 240_000, 480_000, 480_000]);
  // 隧道切走（升 p2p 成功或断开）：空转不探、不再排程
  tunnelActive = false;
  clock.fireNext();
  await flush();
  const before = attempts;
  await flush();
  assert.equal(attempts, before);
  assert.equal(clock.timers.filter((t) => !t.cleared).length, 0);
  up.stop(); up.stop();
});

test('attempt 抛错 = 失败（静默）走退避，不炸控制器', async () => {
  const clock = fakeClock();
  let attempts = 0;
  const up = new P2pUpgrade({
    isTunnelActive: () => true,
    attempt: async () => { attempts += 1; throw new Error('boom'); },
    firstDelayMs: 60_000,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  up.start();
  clock.fireNext();
  await flush(); await flush();
  assert.equal(attempts, 1);
  assert.equal(up.state, 'idle'); // 未被炸到未知态
  assert.equal(clock.timers.filter((t) => !t.cleared).length, 1); // 退避排程在
  up.stop();
});
