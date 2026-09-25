/**
 * W2-3 单机饱和压测 driver（scripts/bench/）测试。
 *
 * 覆盖两层：
 * 1. ramp 数学与统计纯函数（ramp.mjs）：benchRamp 爬坡序列、summarize 成功率/p95、
 *    checkSaturated 饱和判据（30s 滑窗 okRate<0.95 或 p95>3×基线）。
 * 2. 本机自检（Step 4）：本地 echo WS（listen(0) 动态端口）跑 200 连接冒烟，
 *    断言 driver 自报统计与 echo 服务端计数一致（偏差 <1%），不一致即 driver 有 bug。
 *
 * 真 VPS 爬坡（计划 Step 5）不在此——由主会话执行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { benchRamp, summarize, checkSaturated } from '../../scripts/bench/ramp.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const driverPath = join(repoRoot, 'scripts/bench/tunnel-saturation.mjs');

// ---- ramp 数学：benchRamp ----

test('benchRamp: 200/s 爬坡，tick=100ms 每拍 20 个', () => {
  const ticks = benchRamp({ total: 1000, ratePerSec: 200, tickMs: 100 });
  assert.equal(ticks.length, 50);
  assert.equal(ticks[0], 20);
  assert.equal(ticks.reduce((a, b) => a + b, 0), 1000);
});

test('benchRamp: 非整数速率余数平铺，总和严格等于 total，末拍收零头', () => {
  // 205/s × 100ms = 每拍 20.5 → 20,21,20,21… 交替；48 拍建 984，末拍补 16。
  const ticks = benchRamp({ total: 1000, ratePerSec: 205, tickMs: 100 });
  assert.ok(ticks.every((n) => Number.isInteger(n) && n >= 0));
  assert.equal(ticks.reduce((a, b) => a + b, 0), 1000);
  assert.equal(ticks.length, 49);
  assert.equal(ticks.at(-1), 16);
});

test('benchRamp: 低速率（每拍 <1）累加器平铺，不出负数或漏建', () => {
  // 5/s × 100ms = 每拍 0.5 → 0,1,0,1…；10 个连接 20 拍建完。
  const ticks = benchRamp({ total: 10, ratePerSec: 5, tickMs: 100 });
  assert.equal(ticks.reduce((a, b) => a + b, 0), 10);
  assert.equal(ticks.length, 20);
  assert.ok(ticks.every((n) => n === 0 || n === 1));
});

test('benchRamp: 非法参数（total/rate/tick 非正）一律抛错', () => {
  assert.throws(() => benchRamp({ total: 0, ratePerSec: 200, tickMs: 100 }));
  assert.throws(() => benchRamp({ total: -1, ratePerSec: 200, tickMs: 100 }));
  assert.throws(() => benchRamp({ total: 100, ratePerSec: 0, tickMs: 100 }));
  assert.throws(() => benchRamp({ total: 100, ratePerSec: 200, tickMs: 0 }));
});

// ---- 统计：summarize ----

test('summarize: 成功率/p95 计算（失败样本不进 p95）', () => {
  const s = summarize([{ ok: true, rttMs: 10 }, { ok: true, rttMs: 20 }, { ok: false, rttMs: 0 }]);
  assert.equal(s.okRate, 2 / 3);
  assert.equal(s.p95Ms, 20);
});

test('summarize: p95 最近秩法；空样本 → okRate 0 / p95Ms null；全失败 → p95Ms null', () => {
  const rtts = Array.from({ length: 100 }, (_, i) => ({ ok: true, rttMs: i + 1 }));
  assert.equal(summarize(rtts).p95Ms, 95, '1..100 的 p95 最近秩 = 第 95 名');
  assert.deepEqual(summarize([]), { okRate: 0, p95Ms: null });
  assert.deepEqual(summarize([{ ok: false, rttMs: 0 }]), { okRate: 0, p95Ms: null });
});

// ---- 饱和判据：checkSaturated ----

test('checkSaturated: 新建成功率 <95% 触发；健康窗口不触发', () => {
  assert.deepEqual(
    checkSaturated({ connOkRate: 0.9, hbP95Ms: 100, baselineP95Ms: 50 }),
    ['新建成功率 0.900 < 0.95'],
  );
  assert.equal(
    checkSaturated({ connOkRate: 0.99, hbP95Ms: 100, baselineP95Ms: 50 }),
    null,
  );
});

test('checkSaturated: p95 > 3×基线触发；基线未建立（null）或为 0 时跳过 RTT 判据', () => {
  const reasons = checkSaturated({ connOkRate: 1, hbP95Ms: 400, baselineP95Ms: 100 });
  assert.ok(reasons && reasons.some((r) => r.includes('p95') && r.includes('400')));
  assert.equal(
    checkSaturated({ connOkRate: 1, hbP95Ms: 99999, baselineP95Ms: null }),
    null,
    '基线未建立不得因 RTT 误报饱和',
  );
  assert.equal(
    checkSaturated({ connOkRate: 1, hbP95Ms: 99999, baselineP95Ms: 0 }),
    null,
    '基线 0ms（本机 loopback 亚毫秒）时 3×0=0 是退化阈值，必须跳过',
  );
});

// ---- Step 4 本机自检：driver vs echo 服务端计数一致性 <1% ----

test('本机自检：200 连接冒烟，driver 统计与 echo 服务端计数偏差 <1%', { timeout: 60000 }, async () => {
  // echo 服务端：ping 帧原文回弹（driver 测 RTT）；big 帧回指定字节数二进制。
  const serverCounts = { accepted: 0, pingEchoed: 0, bigServed: 0 };
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    serverCounts.accepted++;
    ws.on('message', (data: Buffer) => {
      let msg: any = null;
      try { msg = JSON.parse(data.toString()); } catch { /* 非 JSON 忽略 */ }
      if (msg?.t === 'ping') { serverCounts.pingEchoed++; ws.send(data.toString()); }
      else if (msg?.t === 'big') { serverCounts.bigServed++; ws.send(Buffer.alloc(msg.bytes)); }
    });
  });
  await new Promise<void>((r) => wss.once('listening', r));
  const port = (wss.address() as { port: number }).port;

  const outDir = mkdtempSync(join(tmpdir(), 'bench-selfcheck-'));
  const outFile = join(outDir, 'samples.jsonl');
  const args = [
    driverPath,
    `ws://127.0.0.1:${port}/echo`, '-', '200', '2000',
    '--tick-ms', '50', '--steady-ms', '2000',
    '--hb-interval-ms', '300', '--hb-timeout-ms', '5000',
    '--big-interval-ms', '1000', '--big-ratio', '0.05', '--big-bytes', '65536',
    '--sample-interval-ms', '500', '--out', outFile,
  ];
  try {
    const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(code, 0, `driver 应干净退出\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.ok(!stdout.includes(`:${port}`), '日志不得带目标 URL（端口字面量也不许）');
    assert.ok(!stderr.includes(`:${port}`), 'stderr 同样不得带 URL');

    const resultLine = stdout.split('\n').find((l) => l.startsWith('BENCH_RESULT '));
    assert.ok(resultLine, `stdout 应有 BENCH_RESULT 行\n${stdout}`);
    const result = JSON.parse(resultLine.slice('BENCH_RESULT '.length));
    assert.equal(result.verdict, 'completed', `本机 200 连接不应触发饱和判据: ${JSON.stringify(result)}`);

    // 一致性铁律（v3 方法论：不信 driver 自报——两侧对账，偏差 >1% 即 driver 有 bug）。
    const dev = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 1);
    assert.ok(dev(result.conn.openOk, serverCounts.accepted) < 0.01,
      `openOk driver=${result.conn.openOk} vs server=${serverCounts.accepted}`);
    assert.ok(dev(result.hb.ok, serverCounts.pingEchoed) < 0.01,
      `hbOk driver=${result.hb.ok} vs server=${serverCounts.pingEchoed}`);
    assert.ok(dev(result.big.done, serverCounts.bigServed) < 0.01,
      `bigDone driver=${result.big.done} vs server=${serverCounts.bigServed}`);
    assert.ok(result.hb.ok > 0 && result.big.done > 0, '冒烟必须真实产生心跳与大响应');

    // 采样落盘：每拍一行 JSON，且绝不含 URL/token。
    const lines = readFileSync(outFile, 'utf8').trim().split('\n');
    assert.ok(lines.length >= 3, '2000ms 稳态 + 500ms 采样至少 3 行');
    for (const l of lines) {
      const s = JSON.parse(l);
      assert.ok(typeof s.open === 'number' && typeof s.hbP95Ms !== 'undefined');
      assert.ok(!l.includes('token') && !l.includes(`:${port}`), '采样行不得带 token/URL');
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    await new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); });
  }
});
