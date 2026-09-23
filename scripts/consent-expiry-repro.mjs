#!/usr/bin/env node
/**
 * consent-expiry-repro.mjs —— werift RFC 7675 consent 到期「静默黑洞」复现（spec D3 前置取证）
 * 逐字移植自 v3 scripts/werift-consent-expiry-repro.mjs（2026-09-16 三轮实录），适配本仓路径。
 *
 * 预注册（开跑前固定）：
 *   假设 H5：【consent 到期 → ICE 静默丢包 → DataChannel 假健康永久黑洞】
 *   唯一变量：responder 侧 iceFilterStunResponse 是否丢弃入站 STUN Binding 请求
 *     - 阶段 A（基线，5s）：正常转发
 *     - 阶段 B（注入，40s）：responder 丢弃全部入站 STUN → initiator 的 consent 请求无响应
 *     - 阶段 C（恢复，40s）：responder 恢复响应 → 观察是否自愈
 *   判定阈值：
 *     - 阶段 B 末：initiator ice.state==='failed' 且 consentFresh===false，
 *       且 A→B 交付停止增长，且 dcA.readyState==='open'（假健康）→ 起因链成立【实测-注入】
 *     - 阶段 C 末：应用数据仍不恢复 → 「不可自愈」成立【实测-注入】
 *   装置：本机 loopback 两枚 RTCPeerConnection（无公网/netem/VPN 依赖）；逐 500ms NDJSON 到 --out
 *   控制：--inject-ms / --recover-ms / --base-ms / --out；--field-shape 加现场形状上传臂
 *   --watchdog：A 侧挂 src/consent-watchdog（Task 8 实现后验证复活；此前报「未实现」并继续）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RTCPeerConnection } from 'werift';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const OUT = argOf('out', 'e2e/consent-expiry-baseline.jsonl');
const INJECT_MS = Number(argOf('inject-ms', '40000'));
const RECOVER_MS = Number(argOf('recover-ms', '40000'));
const BASE_MS = Number(argOf('base-ms', '5000'));
const WATCHDOG = process.argv.includes('--watchdog');
const FIELD_SHAPE = process.argv.includes('--field-shape');
const FIELD_MB = Number(argOf('field-mib', '32'));
const FIELD_DEADLINE_MS = Number(argOf('field-ms', '60000'));
const FIELD_CHUNK = 16 * 1024;
const FIELD_GATE = 256 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const gate = { allow: true, phase: 'setup' };

function iceOf(pc) {
  try { return pc.iceTransports?.[0]?.connection ?? null; } catch { return null; }
}

function snapshot(pc, tag, counters) {
  const ice = iceOf(pc);
  const pair = ice?.nominated;
  return {
    t: Date.now(), tag, phase: gate.phase,
    iceState: ice?.state ?? null,
    consentFresh: ice?.consentFresh ?? null,
    hasConsentLoop: !!ice?.queryConsentHandle,
    gen: ice?.generation ?? null,
    pair: pair ? {
      sent: pair.packetsSent, recv: pair.packetsReceived,
      reqSent: pair.requestsSent, rspRecv: pair.responsesReceived,
      consentSent: pair.consentRequestsSent,
      rttMs: Math.round((pair.rtt ?? 0) * 1000),
    } : null,
    dc: counters.dc,
    recv: counters.recv,
  };
}

async function main() {
  const log = [];
  const counters = { dc: {}, recv: {} };

  const pcA = new RTCPeerConnection({ iceServers: [] });
  const pcB = new RTCPeerConnection({ iceServers: [], iceFilterStunResponse: () => gate.allow });

  const dcA = pcA.createDataChannel('ordered', { ordered: true });
  const dcsB = [];
  pcA.onicecandidate = (e) => { if (e.candidate) void pcB.addIceCandidate(e.candidate).catch(() => {}); };
  pcB.onicecandidate = (e) => { if (e.candidate) void pcA.addIceCandidate(e.candidate).catch(() => {}); };
  pcB.ondatachannel = (ev) => { dcsB.push(ev.channel); };

  const stats = { aSent: 0, aToB: 0, bSent: 0, bToA: 0 };

  const offer = await pcA.createOffer();
  await pcA.setLocalDescription(offer);
  await pcB.setRemoteDescription(offer);
  const answer = await pcB.createAnswer();
  await pcB.setLocalDescription(answer);
  await pcA.setRemoteDescription(answer);

  await new Promise((r, j) => {
    const t = setTimeout(() => j(new Error(`连接 15s 未建（A=${pcA.connectionState} B=${pcB.connectionState}）`)), 15_000);
    const done = () => { if (pcA.connectionState === 'connected' && pcB.connectionState === 'connected') { clearTimeout(t); r(); } };
    pcA.onconnectionstatechange = done;
    pcB.onconnectionstatechange = done;
    done();
  });
  await sleep(500);

  const dcB = dcsB[0];
  if (!dcB) throw new Error('B 侧未收到 datachannel');
  dcB.onmessage = () => { stats.aToB += 1; };
  dcA.onmessage = () => { stats.bToA += 1; };

  const timer = setInterval(() => {
    try { dcA.send('A'.repeat(200)); stats.aSent += 1; } catch { /* closed */ }
    try { dcB.send('B'.repeat(200)); stats.bSent += 1; } catch { /* closed */ }
  }, 50);

  const sample = () => {
    for (const [pc, tag] of [[pcA, 'A'], [pcB, 'B']]) {
      log.push(snapshot(pc, tag, {
        dc: { A: { readyState: dcA.readyState, buffered: dcA.bufferedAmount }, B: { readyState: dcB.readyState, buffered: dcB.bufferedAmount } },
        recv: { ...stats },
      }));
    }
  };

  let detachWatchdog;
  if (WATCHDOG) {
    try {
      const { attachConsentWatchdog } = await import('../src/consent-watchdog.js');
      detachWatchdog = attachConsentWatchdog(pcA, {
        intervalMs: 3000,
        onEvent: (e) => console.log(`[watchdog] ${e.kind} 第 ${e.revives} 次（iceState=${e.iceState} consentFresh=${e.consentFresh}）`),
      });
      console.log('[watchdog] 已挂（interval 3000ms）');
    } catch (e) {
      console.log(`[watchdog] src/consent-watchdog 尚未实现（Task 8 前属预期）：${e.message}——继续跑无看门狗臂`);
    }
  }
  const sampler = setInterval(sample, 500);
  sample();
  console.log(`[setup] A↔B connected=${pcA.connectionState} dcA=${dcA.readyState} dcB=${dcB.readyState}`);

  gate.phase = 'A';
  await sleep(BASE_MS);
  const aBase = { ...stats };
  console.log(`[phase A 结束] A→B：发 ${aBase.aSent} 帧 / 达 ${aBase.aToB} 帧；B→A：发 ${aBase.bSent} 帧 / 达 ${aBase.bToA} 帧`);

  gate.phase = 'B';
  gate.allow = false;
  console.log(`[phase B 开始] responder 丢弃入站 STUN（${INJECT_MS}ms）；consent 预期在 ~30s 后到期`);
  await sleep(INJECT_MS);
  const iceA = iceOf(pcA);
  const bEnd = { ...stats };
  console.log(`[phase B 结束] A.ice.state=${iceA?.state} A.consentFresh=${iceA?.consentFresh} ` +
    `dcA.readyState=${dcA.readyState} buffered=${dcA.bufferedAmount}\n` +
    `             阶段 B 期间：A→B 发 ${bEnd.aSent - aBase.aSent} 帧 / 达 ${bEnd.aToB - aBase.aToB} 帧；` +
    `B→A 发 ${bEnd.bSent - aBase.bSent} 帧 / 达 ${bEnd.bToA - aBase.bToA} 帧`);

  gate.phase = 'C';
  gate.allow = true;
  console.log(`[phase C 开始] 恢复 STUN 响应（${RECOVER_MS}ms）；观察是否自愈`);
  await sleep(RECOVER_MS);
  const iceA2 = iceOf(pcA);
  const cEnd = { ...stats };
  console.log(`[phase C 结束] A.ice.state=${iceA2?.state} A.consentFresh=${iceA2?.consentFresh}\n` +
    `             阶段 C 期间：A→B 发 ${cEnd.aSent - bEnd.aSent} 帧 / 达 ${cEnd.aToB - bEnd.aToB} 帧；` +
    `B→A 发 ${cEnd.bSent - aBase.bSent} 帧 / 达 ${cEnd.bToA - bEnd.bToA} 帧`);

  detachWatchdog?.();

  let fieldResult = null;
  if (FIELD_SHAPE) {
    gate.phase = 'E';
    const total = FIELD_MB * 1024 * 1024;
    const startAt = Date.now();
    const deadline = startAt + FIELD_DEADLINE_MS;
    const before = stats.aToB;
    let sentBytes = 0;
    let wedgedAt = null;
    console.log(`[phase E 开始] 现场形状上传：${FIELD_MB}MiB / 16KiB 帧 / 背压门 256KiB / 上限 ${FIELD_DEADLINE_MS}ms`);
    while (sentBytes < total) {
      while (dcA.bufferedAmount > FIELD_GATE) {
        if (Date.now() > deadline) { wedgedAt = Date.now(); break; }
        await sleep(20);
      }
      if (wedgedAt) break;
      try { dcA.send('x'.repeat(FIELD_CHUNK)); stats.aSent += 1; } catch { break; }
      sentBytes += FIELD_CHUNK;
    }
    await sleep(5000);
    fieldResult = {
      payloadTarget: total, payloadSent: sentBytes,
      deliveredFrames: stats.aToB - before,
      bufferedFinal: dcA.bufferedAmount,
      wedged: wedgedAt !== null,
      elapsedMs: Date.now() - startAt,
      iceState: iceOf(pcA)?.state ?? null,
      consentFresh: iceOf(pcA)?.consentFresh ?? null,
    };
    console.log(`[phase E 结束] ${JSON.stringify(fieldResult)}`);
  }

  clearInterval(sampler);
  clearInterval(timer);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, log.map((l) => JSON.stringify(l)).join('\n') + '\n');
  console.log(`[落盘] ${OUT}（${log.length} 拍）`);

  const verdict = {
    at: nowIso(),
    watchdog: WATCHDOG,
    fieldShape: fieldResult,
    phaseB_iceState: iceA?.state ?? null,
    phaseB_consentFresh: iceA?.consentFresh ?? null,
    phaseB_dcOpen: dcA.readyState === 'open',
    phaseB_aToB_delivered: bEnd.aToB - aBase.aToB,
    phaseB_aToB_sent: bEnd.aSent - aBase.aSent,
    phaseC_iceState: iceA2?.state ?? null,
    phaseC_aToB_delivered: cEnd.aToB - bEnd.aToB,
    phaseC_aToB_sent: cEnd.aSent - bEnd.aSent,
  };
  console.log('[判定] ' + JSON.stringify(verdict));
  await pcA.close();
  await pcB.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
