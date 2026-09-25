#!/usr/bin/env node
/**
 * W2-3 隧道饱和压测 driver（本机侧）。
 *
 * 用法：
 *   node scripts/bench/tunnel-saturation.mjs <wss-url> <token> <total> <ratePerSec> [选项]
 *
 *   <wss-url>    隧道网关入口（生产真值形态 wss://<relay>/tunnel/s/<deviceId>）；
 *                可含 {i} 占位符（按连接序号替换）；URL 绝不进日志/采样文件。
 *   <token>      鉴权 token，拼 ?token= 上车；传 '-' 表示不带。token 绝不进日志。
 *   <total>      总连接数；<ratePerSec> 爬坡速率（生产档 200/s）。
 *
 * 选项（默认值即生产口径）：
 *   --tick-ms 100            爬坡拍长
 *   --steady-ms 300000       爬满后稳态保持时长
 *   --hb-interval-ms 5000    每连接心跳间隔（1KB ping 带时间戳测 RTT）
 *   --hb-timeout-ms 10000    心跳超时（超时记失败样本）
 *   --hb-bytes 1024          心跳帧大小
 *   --big-interval-ms 30000  大响应轮次间隔
 *   --big-ratio 0.05         每轮抽 5% 连接请大响应（0 关闭）
 *   --big-bytes 1048576      大响应字节数
 *   --sample-interval-ms 5000 采样落盘间隔（driver 侧水位）
 *   --sat-window-ms 30000    饱和判据滑窗
 *   --conn-timeout-ms 10000  单连接建连超时
 *   --out <path>             采样文件（默认 ./bench-samples-<时间戳>.jsonl）
 *
 * 真值口径（v3 方法论铁律：不信 driver 自报并发）：
 *   driver 每 5s 采样自身水位（open/失败/RTT 分布/fd/RSS/ELU）落盘；
 *   操作员必须另开终端采集 VPS 侧（vnstat / caddy 指标 / p2p-net status），
 *   报告双瓶颈分列——禁止只引 driver 自报。判据语义单一事实源在 ./ramp.mjs。
 *
 * 对端协议（echo 契约，本机自检与真 VPS 同一套）：
 *   → {"t":"ping","seq":N,"ts":<ms>,"pad":"…"}  对端原文回弹 → driver 计 RTT
 *   → {"t":"big","bytes":N}                       对端回 N 字节 → driver 计大响应完成
 *
 * 实现注记：perMessageDeflate 关闭——隧道流量是已压缩帧，且压缩 CPU 税会污染
 * 饱和读数；fd 水位用 lsof -p <pid>（macOS/Linux 的 /dev/fd 是调用进程视图，
 * `ls /dev/fd` 量到的是 ls 自己，不是 driver）。
 */
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { benchRamp, summarize, checkSaturated } from './ramp.mjs';

// ---- 参数 ----

function parseArgs(argv) {
  const [url, token, total, ratePerSec, ...rest] = argv;
  if (!url || !token || !total || !ratePerSec) {
    console.error('用法: node scripts/bench/tunnel-saturation.mjs <wss-url> <token|-> <total> <ratePerSec> [--key value …]');
    process.exit(2);
  }
  const opt = {
    tickMs: 100, steadyMs: 300000, hbIntervalMs: 5000, hbTimeoutMs: 10000, hbBytes: 1024,
    bigIntervalMs: 30000, bigRatio: 0.05, bigBytes: 1048576,
    sampleIntervalMs: 5000, satWindowMs: 30000, connTimeoutMs: 10000, out: null,
  };
  const keyMap = {
    '--tick-ms': 'tickMs', '--steady-ms': 'steadyMs', '--hb-interval-ms': 'hbIntervalMs',
    '--hb-timeout-ms': 'hbTimeoutMs', '--hb-bytes': 'hbBytes', '--big-interval-ms': 'bigIntervalMs',
    '--big-ratio': 'bigRatio', '--big-bytes': 'bigBytes', '--sample-interval-ms': 'sampleIntervalMs',
    '--sat-window-ms': 'satWindowMs', '--conn-timeout-ms': 'connTimeoutMs',
  };
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if (k === '--out') { opt.out = rest[i + 1]; continue; }
    const field = keyMap[k];
    if (!field) { console.error(`未知选项 ${k}`); process.exit(2); }
    opt[field] = Number(rest[i + 1]);
    if (!Number.isFinite(opt[field])) { console.error(`选项 ${k} 需数值`); process.exit(2); }
  }
  const nTotal = Number(total); const nRate = Number(ratePerSec);
  try {
    benchRamp({ total: nTotal, ratePerSec: nRate, tickMs: opt.tickMs }); // 借 benchRamp 校验正数
  } catch (e) {
    console.error(`参数非法: ${e.message}`); process.exit(2);
  }
  if (!/^wss?:\/\//.test(url)) { console.error('url 须 ws:// 或 wss:// 开头'); process.exit(2); }
  return { url, token, total: nTotal, ratePerSec: nRate, opt };
}

const { url, token, total, ratePerSec, opt } = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
const stamp = new Date(startedAt).toISOString().replace(/[-:T]/g, '').slice(0, 14);
const outPath = opt.out ?? `bench-samples-${stamp}.jsonl`;
const out = createWriteStream(outPath, { flags: 'w' });

/** 建连 URL（{i} 占位 + token 上车）；返回值绝不进日志。 */
function connUrl(i) {
  let u = url.replaceAll('{i}', String(i));
  if (token !== '-') u += (u.includes('?') ? '&' : '?') + `token=${encodeURIComponent(token)}`;
  return u;
}

// ---- 状态：累计计数与窗口样本分离（窗口数组可裁剪，计数永不回退） ----

const conns = new Set();
const connSamples = [];           // {t, ok, rttMs}——总量 ≤ total，不裁剪
const hbSamples = [];             // {t, ok, rttMs}——裁剪到 2×滑窗
const count = { connOk: 0, connFail: 0, hbOk: 0, hbFail: 0 };
let connAttempted = 0;
let bigReq = 0; let bigDone = 0;
let baselineP95Ms = null;
let verdict = null; let verdictReasons = null;
let stopping = false;
let rampDone = false; let rampEndedAt = 0;
let fdMax = 0; let rssMaxMb = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function recordConn(ok, rttMs) {
  connSamples.push({ t: Date.now(), ok, rttMs });
  if (ok) count.connOk++; else count.connFail++;
}
function recordHb(ok, rttMs) {
  hbSamples.push({ t: Date.now(), ok, rttMs });
  if (ok) count.hbOk++; else count.hbFail++;
}

/** 错误归类：只取 code，绝不透传 message（可能带地址/URL）。 */
function errTag(err) {
  if (err && typeof err.code === 'string' && err.code) return err.code;
  return 'error';
}

function percentile(sorted, q) {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(q * sorted.length) - 1];
}

function windowOf(samples, sinceMs) {
  const cut = Date.now() - sinceMs;
  return samples.filter((s) => s.t >= cut);
}

function pruneHbSamples() {
  const keep = Date.now() - 2 * opt.satWindowMs;
  let i = 0;
  while (i < hbSamples.length && hbSamples[i].t < keep) i++;
  if (i > 0) hbSamples.splice(0, i);
}

function fdCount() {
  try {
    const n = Number(execFileSync('sh', ['-c', `lsof -p ${process.pid} | wc -l`], { encoding: 'utf8' }).trim());
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// ---- 连接生命周期 ----

function openConn(id) {
  connAttempted++;
  const rec = {
    id, ws: null, open: false, gaveUp: false,
    pendingPing: new Map(), pendingBig: 0,
    hbTimer: null, openTimer: null, seq: 0,
  };
  const t0 = Date.now();
  let ws;
  try {
    ws = new WebSocket(connUrl(id), { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  } catch {
    recordConn(false, 0);
    return;
  }
  rec.ws = ws;
  conns.add(rec);

  rec.openTimer = setTimeout(() => {
    if (!rec.open) { rec.gaveUp = true; recordConn(false, 0); ws.terminate(); }
  }, opt.connTimeoutMs);

  ws.on('open', () => {
    clearTimeout(rec.openTimer);
    rec.open = true;
    recordConn(true, Date.now() - t0);
    const beat = () => {
      if (!rec.open || stopping) return;
      const now = Date.now();
      for (const [seq, ts] of rec.pendingPing) {
        if (now - ts > opt.hbTimeoutMs) { rec.pendingPing.delete(seq); recordHb(false, 0); }
      }
      const seq = ++rec.seq;
      const base = JSON.stringify({ t: 'ping', seq, ts: now, pad: '' });
      const pad = 'x'.repeat(Math.max(0, opt.hbBytes - base.length));
      rec.pendingPing.set(seq, now);
      ws.send(JSON.stringify({ t: 'ping', seq, ts: now, pad }), (err) => {
        if (err && rec.pendingPing.delete(seq)) recordHb(false, 0);
      });
      rec.hbTimer = setTimeout(beat, opt.hbIntervalMs);
    };
    rec.hbTimer = setTimeout(beat, opt.hbIntervalMs);
  });

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch { /* 非 JSON 按大响应计 */ }
      if (msg && msg.t === 'ping') {
        // 迟到回弹（已超时记失败）只忽略，绝不得计入大响应字节
        if (rec.pendingPing.has(msg.seq)) {
          rec.pendingPing.delete(msg.seq);
          recordHb(true, Date.now() - msg.ts);
        }
        return;
      }
    }
    if (rec.pendingBig > 0) {
      rec.pendingBig -= data.length;
      if (rec.pendingBig <= 0) { rec.pendingBig = 0; bigDone++; }
    }
  });

  ws.on('close', () => {
    clearTimeout(rec.openTimer); clearTimeout(rec.hbTimer);
    if (!rec.open && !rec.gaveUp) recordConn(false, 0);
    rec.open = false;
    conns.delete(rec);
  });

  ws.on('error', () => { /* 统一由 close/unexpected-response 记账；message 可能带地址，不透传 */ });
  ws.on('unexpected-response', () => {
    clearTimeout(rec.openTimer);
    if (!rec.open && !rec.gaveUp) { rec.gaveUp = true; recordConn(false, 0); }
    ws.terminate();
  });
}

// ---- 大响应轮 ----

function bigRound() {
  if (stopping || opt.bigRatio <= 0) return;
  const open = [...conns].filter((c) => c.open && c.pendingBig === 0);
  const n = Math.ceil(open.length * opt.bigRatio);
  for (let i = 0; i < n; i++) {
    const rec = open[Math.floor(Math.random() * open.length)];
    if (!rec || rec.pendingBig > 0) continue;
    bigReq++;
    rec.pendingBig = opt.bigBytes;
    rec.ws.send(JSON.stringify({ t: 'big', bytes: opt.bigBytes }), (err) => {
      if (err && rec.pendingBig > 0) rec.pendingBig = 0;
    });
  }
}

// ---- 采样与饱和判据 ----

function sampleTick() {
  pruneHbSamples();
  const hbWin = windowOf(hbSamples, opt.satWindowMs);
  const connWin = windowOf(connSamples, opt.satWindowMs);
  const hbSum = summarize(hbWin);
  const connOkRate = connWin.length > 0 ? summarize(connWin).okRate : 1;
  const okRtts = hbWin.filter((s) => s.ok).map((s) => s.rttMs).sort((a, b) => a - b);
  // 基线口径：爬坡完成后第一个完整滑窗的 p95——此时混合工况（心跳+大响应轮）
  // 已全量展开，基线代表「目标并发下健康混合工况」。早于此（稀疏心跳期）建基线
  // 会把大响应突发当成退化，误报饱和。RTT 判据只在基线建立后激活；
  // 稳态短于一个滑窗时基线不建立，仅新建成功率判据生效。
  if (baselineP95Ms === null && rampDone && Date.now() - rampEndedAt >= opt.satWindowMs && okRtts.length >= 20) {
    baselineP95Ms = hbSum.p95Ms;
  }

  const usage = process.resourceUsage();
  const elu = performance.eventLoopUtilization().utilization;
  const fd = fdCount();
  const rssMb = Math.round(process.memoryUsage().rss / 104857.6) / 10;
  if (fd !== null) fdMax = Math.max(fdMax, fd);
  rssMaxMb = Math.max(rssMaxMb, rssMb);

  const line = {
    t: new Date().toISOString(), elapsedMs: Date.now() - startedAt,
    open: [...conns].filter((c) => c.open).length,
    conn: { attempted: connAttempted, ok: count.connOk, fail: count.connFail },
    connWinOkRate: Math.round(connOkRate * 1000) / 1000,
    hb: { ok: count.hbOk, fail: count.hbFail },
    hbP50Ms: percentile(okRtts, 0.5), hbP95Ms: hbSum.p95Ms, hbP99Ms: percentile(okRtts, 0.99),
    baselineP95Ms,
    big: { req: bigReq, done: bigDone },
    fd, rssMb, cpuUserMs: Math.round(usage.userCPUTime / 1000), cpuSysMs: Math.round(usage.systemCPUTime / 1000),
    elu: Math.round(elu * 1000) / 1000,
  };
  out.write(JSON.stringify(line) + '\n');

  if (!stopping) {
    const reasons = checkSaturated({ connOkRate, hbP95Ms: hbSum.p95Ms, baselineP95Ms });
    if (reasons) void stop('saturated', reasons);
  }
}

// ---- 收尾 ----

async function stop(v, reasons = []) {
  if (stopping) return;
  stopping = true;
  verdict = v; verdictReasons = reasons;
  clearInterval(rampTimer); clearInterval(sampleTimer); clearInterval(bigTimer);
  clearTimeout(stopTimer);
  for (const rec of conns) { clearTimeout(rec.hbTimer); clearTimeout(rec.openTimer); }

  // 静默期：等在途心跳回弹与大响应收尾，让 driver 与服务端计数可对账（上限 2s）。
  const quiesceDeadline = Date.now() + 2000;
  while (Date.now() < quiesceDeadline) {
    const pending = [...conns].reduce((a, c) => a + c.pendingPing.size + (c.pendingBig > 0 ? 1 : 0), 0);
    if (pending === 0) break;
    await sleep(50);
  }

  const closeDeadline = Date.now() + 2000;
  for (const rec of conns) { try { rec.open ? rec.ws.close() : rec.ws.terminate(); } catch { /* 忽略 */ } }
  while (conns.size > 0 && Date.now() < closeDeadline) await sleep(50);

  sampleTick(); // 末拍
  await new Promise((r) => out.end(r));
  printReport();
  process.exit(0);
}

function printReport() {
  const connSum = summarize(connSamples);
  const hbSum = summarize(hbSamples);
  const result = {
    verdict, reasons: verdictReasons, elapsedMs: Date.now() - startedAt,
    conn: { attempted: connAttempted, openOk: count.connOk, openFail: count.connFail, openRttP95Ms: connSum.p95Ms },
    hb: { ok: count.hbOk, fail: count.hbFail, p95Ms: hbSum.p95Ms, baselineP95Ms },
    big: { req: bigReq, done: bigDone },
    driver: { fdMax, rssMaxMb },
    samplesFile: outPath,
  };
  const scheme = url.startsWith('wss') ? 'wss' : 'ws';
  console.log('');
  console.log('==== 饱和压测结果（driver 侧自报，仅供对账，不得单独引用）====');
  console.log(`目标 scheme: ${scheme}（URL/token 按纪律不落日志）`);
  console.log(`判定: ${verdict}${verdictReasons.length ? ' —— ' + verdictReasons.join('；') : ''}`);
  console.log(`建连: attempted=${result.conn.attempted} ok=${result.conn.openOk} fail=${result.conn.openFail} openP95=${result.conn.openRttP95Ms}ms`);
  console.log(`心跳: ok=${result.hb.ok} fail=${result.hb.fail} p95=${result.hb.p95Ms}ms 基线=${result.hb.baselineP95Ms}ms`);
  console.log(`大响应: req=${result.big.req} done=${result.big.done}`);
  console.log('');
  console.log('---- 瓶颈水位 A：driver 侧（本机）----');
  console.log(`fd 峰值=${result.driver.fdMax}（ulimit -n 对照） rss 峰值=${result.driver.rssMaxMb}MB`);
  console.log('');
  console.log('---- 瓶颈水位 B：VPS 侧（操作员另采，禁止只引 driver 自报）----');
  console.log('另开终端执行并誊抄到报告：');
  console.log("  ssh <vps> 'vnstat -l'   # 或 vnstat --oneline / sar -n DEV 1");
  console.log("  ssh <vps> 'top -b -n1 | head -15'   # caddy/coturn CPU·MEM");
  console.log('  p2p-net status             # dataPlane.tunnelLinks 在线腿数（服务端采样真值）');
  console.log(`BENCH_RESULT ${JSON.stringify(result)}`);
}

// ---- 主流程 ----

console.log(`driver 启动: total=${total} rate=${ratePerSec}/s tick=${opt.tickMs}ms steady=${opt.steadyMs}ms 采样→${outPath}`);
const ticks = benchRamp({ total, ratePerSec, tickMs: opt.tickMs });
let tickIdx = 0;
let connSeq = 0;
let stopTimer = null;
const rampTimer = setInterval(() => {
  if (tickIdx >= ticks.length) {
    clearInterval(rampTimer);
    if (!rampDone) {
      rampDone = true; rampEndedAt = Date.now();
      console.log(`爬坡完成（${ticks.length} 拍），稳态 ${opt.steadyMs}ms…`);
      stopTimer = setTimeout(() => void stop('completed'), opt.steadyMs);
    }
    return;
  }
  const n = ticks[tickIdx++];
  for (let k = 0; k < n; k++) openConn(connSeq++);
}, opt.tickMs);
const sampleTimer = setInterval(sampleTick, opt.sampleIntervalMs);
const bigTimer = setInterval(bigRound, opt.bigIntervalMs);

process.on('SIGINT', () => { void stop('interrupted'); });
process.on('uncaughtException', (e) => {
  console.error(`driver 内部错误: ${errTag(e)}`);
  process.exit(1);
});
