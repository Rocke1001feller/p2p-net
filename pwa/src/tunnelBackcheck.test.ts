import test from 'node:test';
import assert from 'node:assert/strict';
import { TunnelBackcheck } from './tunnelBackcheck.js';

/** 假时钟：手动推进，记录排程。 */
function fakeClock() {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    timers,
    setTimeoutFn: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeoutFn: (t: unknown) => { (t as { cleared: boolean }).cleared = true; },
    /** 推进到下一个未清除定时器并触发（清掉已触发的，模拟一次性）。 */
    fireNext(): number | null {
      const t = timers.find((x) => !x.cleared);
      if (!t) return null;
      t.cleared = true;
      t.fn();
      return t.ms;
    },
  };
}

test('turn 会话期间按节拍探活；隧道活 → onAlive 触发并自停', async () => {
  const clock = fakeClock();
  const probes: number[] = [];
  let turnActive = true;
  let alive = 0;
  const bc = new TunnelBackcheck({
    isTurnActive: () => turnActive,
    probe: async () => { probes.push(Date.now()); return true; },
    onAlive: () => { alive += 1; },
    intervalMs: 60_000,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  bc.start();
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].ms, 60_000);
  clock.fireNext();
  await new Promise((r) => setImmediate(r));
  assert.equal(probes.length, 1);
  assert.equal(alive, 1);
  // 触发后自停：不再排程
  assert.equal(clock.timers.filter((t) => !t.cleared).length, 0);
  bc.stop();
});

test('隧道未活 → 继续排下一拍；非 turn 会话 → 空转不探', async () => {
  const clock = fakeClock();
  let probeCalls = 0;
  let turnActive = true;
  const bc = new TunnelBackcheck({
    isTurnActive: () => turnActive,
    probe: async () => { probeCalls += 1; return false; },
    onAlive: () => {},
    intervalMs: 60_000,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  bc.start();
  clock.fireNext();
  await new Promise((r) => setImmediate(r));
  assert.equal(probeCalls, 1);
  assert.equal(clock.timers.filter((t) => !t.cleared).length, 1); // 已排下一拍
  // 模式切走（非 turn）：下一拍空转，不探活、不再排程
  turnActive = false;
  clock.fireNext();
  await new Promise((r) => setImmediate(r));
  assert.equal(probeCalls, 1);
  assert.equal(clock.timers.filter((t) => !t.cleared).length, 0);
  bc.stop();
});

test('探活抛错 = 未活（静默），节拍不断；stop 后不再排程', async () => {
  const clock = fakeClock();
  let probeCalls = 0;
  const bc = new TunnelBackcheck({
    isTurnActive: () => true,
    probe: async () => { probeCalls += 1; throw new Error('boom'); },
    onAlive: () => {},
    intervalMs: 60_000,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  bc.start();
  clock.fireNext();
  await new Promise((r) => setImmediate(r));
  assert.equal(probeCalls, 1);
  assert.equal(clock.timers.filter((t) => !t.cleared).length, 1);
  bc.stop();
  assert.equal(clock.timers.filter((t) => !t.cleared).length, 0);
  bc.stop(); // 幂等
});
