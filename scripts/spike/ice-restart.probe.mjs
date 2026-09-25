/**
 * THROWAWAY — Wave 2 / W2-6 spike Step 1：werift 0.24.4 ICE restart 能力探针
 * 非生产代码，不进 dist/、不进测试链；证据归档 e2e/wave2-upgrade-wheel-spike-2026-09-26.md
 *
 * 运行：在仓库根执行 `node scripts/spike/ice-restart.probe.mjs`（node>=20）
 * 输出：stdout 人类可读日志 + scripts/spike/ice-restart.probe.out.jsonl（每步一行 JSON，落盘）
 *
 * 实验设计（loopback 双 werift RTCPeerConnection，同进程直连 signaling）：
 *   E0 API 表面：restartIce / createOffer({iceRestart}) 是否存在
 *   E1 relay-only 抑制：iceTransportPolicy:'relay' + 配置 TURN 时 gather 是否 0 个 host/srflx 候选。
 *      注意 werift 的 relay-only 语义（forceTurn→gatherRelayOnly）要求 TURN 已配置才生效
 *      （werift/lib/ice/src/ice.js:852），故此处指向一个死 TURN（127.0.0.1 TCP，秒拒），
 *      既满足 forceTurn 生效条件，又不依赖真实 TURN 服务；forceTurn 映射见
 *      node_modules/werift/lib/webrtc/src/secureTransportManager.js:121。
 *   E2 重启与迁移：首建经候选过滤屏蔽 ::1（模拟 relay-only 首建——loopback 无 TURN，
 *      用地址过滤替代类型过滤，ICE restart 语义与候选类型无关）；restartIce 后过滤翻转为
 *      只放 ::1，验证：重新 gathering、ufrag/pwd 轮换、对端自动对称重启、nominated 对
 *      迁移到新地址对、datachannel 在重启后仍通、数据面中断时长。
 *      （不选 127.0.0.2：实测本机 macOS 无 127/8 整段 loopback 路由，不可 bind 不可投递。）
 *   E3 setConfiguration 边界：建 PC 后把 iceTransportPolicy 从 relay 改 all，restart 后是否
 *      开始产出 host 候选（决定路线 a 实现时「放开直连」能否靠配置翻转，还是必须信令层过滤）。
 *   E4 workaround 取证：已建连（DTLS connected）PC 上 werift 原生 connect() 因
 *      checkDtlsConnected 早退不跑 checks（peerConnection.js:780-792）——E4a 只手动驱动
 *      发起方 iceTransport.start()（模拟浏览器控制端跑 checks 的生产拓扑），验证受控应答方
 *      无需补丁即可完成 nominated 重建/迁移/数据恢复；E4b 双侧驱动作对照。
 */

import { writeFileSync } from 'node:fs';
import { RTCPeerConnection } from 'werift';

const OUT = new URL('./ice-restart.probe.out.jsonl', import.meta.url).pathname;
const t0 = Date.now();
const lines = [];
function log(step, data = {}) {
  const rec = { ms: Date.now() - t0, step, ...data };
  lines.push(JSON.stringify(rec));
  const { ms, step: _s, ...rest } = rec;
  console.log(`[+${String(ms).padStart(6)}ms] ${step}${Object.keys(rest).length ? ' ' + JSON.stringify(rest) : ''}`);
}
function flush() {
  writeFileSync(OUT, lines.join('\n') + '\n');
}
process.on('exit', flush);
process.on('unhandledRejection', (err) => {
  log('UNHANDLED_REJECTION', { err: String(err?.stack ?? err) });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms)),
  ]);
}

function ufragOf(sdp) {
  return sdp?.match(/^a=ice-ufrag:(.+)$/m)?.[1]?.trim() ?? null;
}
function pwdOf(sdp) {
  return sdp?.match(/^a=ice-pwd:(.+)$/m)?.[1]?.trim() ?? null;
}

/** 解析 "candidate:foundation component protocol priority ip port typ type ..." 字符串。 */
function parseCandidateSdp(s) {
  const m = s?.match(/^candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)/);
  return m
    ? { foundation: m[1], component: +m[2], protocol: m[3], priority: +m[4], ip: m[5], port: +m[6], type: m[7] }
    : null;
}

/** SDP munge：只保留 allow(ip) 为真的 a=candidate 行（模拟信令层候选过滤，与生产路线 a 同源手法）。 */
function filterSdpCandidates(sdp, allow) {
  return sdp
    .split('\r\n')
    .filter((line) => {
      if (!line.startsWith('a=candidate:')) return true;
      return allow(parseCandidateSdp(line.slice(2))?.ip);
    })
    .join('\r\n');
}

/** 解析 getStats() 的 nominated candidate-pair → {local, remote} 候选地址。 */
async function nominatedPair(pc) {
  const report = await pc.getStats();
  const stats = [...report.values()];
  const pair = stats.find((s) => s.type === 'candidate-pair' && s.nominated);
  if (!pair) return { found: false, types: stats.map((s) => s.type) };
  const byId = new Map(stats.map((s) => [s.id, s]));
  const local = byId.get(pair.localCandidateId);
  const remote = byId.get(pair.remoteCandidateId);
  return {
    found: true,
    state: pair.state,
    local: local ? `${local.candidateType} ${local.address}:${local.port}` : pair.localCandidateId,
    remote: remote ? `${remote.candidateType} ${remote.address}:${remote.port}` : pair.remoteCandidateId,
    localUfrag: local?.usernameFragment ?? null,
    remoteUfrag: remote?.usernameFragment ?? null,
  };
}

/** 挂候选收集 + 按 allow(ip) 过滤转发到对端；返回 {cands, markRemoteSet}。 */
function wireCandidates(pc, getPeer, getAllow, tag) {
  const cands = [];
  const queue = [];
  let remoteSet = false;
  pc.onicecandidate = (e) => {
    const c = e?.candidate ?? null;
    if (!c) {
      log(`${tag}.icecandidate.end`);
      return;
    }
    const parsed = parseCandidateSdp(c.candidate);
    cands.push(parsed ?? { raw: c.candidate });
    log(`${tag}.icecandidate`, parsed ?? { raw: c.candidate });
    if (!getAllow(parsed?.ip)) return; // 信令层过滤：只放当前放行的地址
    const peer = getPeer();
    if (!peer || !remoteSet) {
      queue.push(c);
      return;
    }
    peer.addIceCandidate(c).catch((err) => log(`${tag}.addIceCandidate.err`, { err: String(err) }));
  };
  return {
    cands,
    /** 新的一轮 negotiation 前重新关闸：候选先入队，等对端 setRemoteDescription 后再放（防 ufrag 错位竞态）。 */
    reset() {
      remoteSet = false;
    },
    markRemoteSet() {
      remoteSet = true;
      const peer = getPeer();
      for (const c of queue.splice(0)) {
        peer?.addIceCandidate(c).catch((err) => log(`${tag}.addIceCandidate.err`, { err: String(err) }));
      }
    },
  };
}

function waitIceConnected(pc, tag) {
  return withTimeout(
    new Promise((res) => {
      if (['connected', 'completed'].includes(pc.iceConnectionState)) return res(pc.iceConnectionState);
      pc.addEventListener?.('iceconnectionstatechange', () => {
        if (['connected', 'completed'].includes(pc.iceConnectionState)) res(pc.iceConnectionState);
      });
      // werift 同时支持 onX 回调；轮询兜底，避免事件形态差异漏接
      const iv = setInterval(() => {
        if (['connected', 'completed'].includes(pc.iceConnectionState)) {
          clearInterval(iv);
          res(pc.iceConnectionState);
        }
      }, 50);
    }),
    10000,
    `${tag} ice connected`,
  );
}

function trackIceState(pc, tag) {
  let last = pc.iceConnectionState;
  const iv = setInterval(() => {
    if (pc.iceConnectionState !== last) {
      log(`${tag}.iceConnectionState`, { from: last, to: pc.iceConnectionState });
      last = pc.iceConnectionState;
    }
  }, 25);
  return () => clearInterval(iv);
}

async function main() {
  // ---------- E0: API 表面 ----------
  {
    const pc = new RTCPeerConnection({ iceServers: [] });
    log('E0.api', {
      'typeof pc.restartIce': typeof pc.restartIce,
      'restartIce in pc': 'restartIce' in pc,
      'typeof pc.createOffer': typeof pc.createOffer,
      'typeof pc.setConfiguration': typeof pc.setConfiguration,
    });
    pc.close();
  }

  // ---------- E1: relay-only 抑制 ----------
  let e1Suppressed = null;
  {
    const deadTurn = {
      iceTransportPolicy: 'relay',
      iceServers: [{ urls: 'turn:127.0.0.1:3478', username: 'probe', credential: 'probe' }],
      turnTransport: 'tcp', // 死 TURN 走 TCP 立即 ECONNREFUSED，避免 UDP 重传拖慢探针
    };
    const pc = new RTCPeerConnection(deadTurn);
    pc.createDataChannel('x');
    let hostSrflx = 0;
    let relay = 0;
    pc.onicecandidate = (e) => {
      const c = e?.candidate;
      if (!c) return;
      const parsed = parseCandidateSdp(c.candidate);
      if (parsed?.type === 'relay') relay++;
      else hostSrflx++;
      log('E1.icecandidate', parsed ?? { raw: c.candidate });
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const done = withTimeout(
      new Promise((res) => {
        const iv = setInterval(() => {
          if (pc.iceGatheringState === 'complete') {
            clearInterval(iv);
            res();
          }
        }, 50);
      }),
      10000,
      'E1 gather complete',
    );
    await done.catch((e) => log('E1.gather.timeout', { err: String(e) }));
    e1Suppressed = hostSrflx === 0;
    log('E1.relay-only.gather', {
      hostSrflxEmitted: hostSrflx,
      relayEmitted: relay,
      gatheringState: pc.iceGatheringState,
      suppressedHostSrflx: e1Suppressed,
    });
    pc.close();
  }

  // ---------- E2: 首建（屏蔽 ::1）→ restartIce → 只放 ::1，验证 nominated 迁移 ----------
  // werift 的 Connection 在未配置 STUN 时默认回落 stun.l.google.com（ice.js:598），
  // 故显式指向死 STUN（127.0.0.1:9）保证探针无外网依赖；代价是每次 gather 多 ~5s srflx 超时。
  // 「升级目标」地址用 ::1：werift 不 gather loopback 接口地址（selectAddressesFromInterfaces
  // 过滤 internal），由 iceAdditionalHostAddresses 注入。不选 127.0.0.2：实测本机（macOS）
  // 无 127/8 整段 loopback 路由，127.0.0.2 即不能 bind 也不能作为目的地址投递（dgram 探针
  // EADDRNOTAVAIL / 投递不到 0.0.0.0 socket）；::1 投递正常。
  // Phase 1 屏蔽 ::1（模拟 relay-only 首建——loopback 无 TURN，以地址过滤替代类型过滤，
  // ICE restart 语义与候选类型无关）；Phase 2 只放 ::1。
  const e2 = { ok: false };
  {
    const cfg = () => ({
      iceServers: [{ urls: 'stun:127.0.0.1:9' }],
      iceUseIpv6: true,
      iceAdditionalHostAddresses: ['::1'],
    });
    const A = new RTCPeerConnection(cfg());
    const B = new RTCPeerConnection(cfg());
    const stopA = trackIceState(A, 'E2.A');
    const stopB = trackIceState(B, 'E2.B');

    const UPGRADE_IP = '::1';
    let phase = 1;
    const allow = (ip) => (phase === 1 ? ip !== UPGRADE_IP : ip === UPGRADE_IP);
    const aWired = wireCandidates(A, () => B, allow, 'E2.A');
    const bWired = wireCandidates(B, () => A, allow, 'E2.B');

    // datachannel echo：B 回显
    let dcA = null;
    B.ondatachannel = (e) => {
      const ch = e.channel ?? e;
      ch.onmessage = (m) => ch.send(m.data ?? m);
    };
    dcA = A.createDataChannel('echo');
    const dcOpen = withTimeout(
      new Promise((res) => {
        if (dcA.readyState === 'open') return res();
        dcA.onopen = () => res();
      }),
      15000,
      'dc open',
    );
    dcOpen.catch(() => {}); // 防 unhandled rejection 在 await 之前崩进程

    // —— Phase 1：首建（屏蔽升级地址 127.0.0.2，模拟 relay-only 下只能用「非目标」候选）——
    // 纪律：先双向 setRemoteDescription，再放行 trickle 队列——werift 在已有（旧）远端描述时
    // 对 ufrag 不匹配的新候选直接 OperationError 拒绝（无描述时才内部排队），顺序不能反。
    log('E2.phase1.offer', { blockedIp: UPGRADE_IP });
    const offer1 = await A.createOffer();
    await A.setLocalDescription(offer1);
    await B.setRemoteDescription({ type: 'offer', sdp: filterSdpCandidates(A.localDescription.sdp, allow) });
    const answer1 = await B.createAnswer();
    await B.setLocalDescription(answer1);
    await A.setRemoteDescription({ type: 'answer', sdp: filterSdpCandidates(B.localDescription.sdp, allow) });
    bWired.markRemoteSet();
    aWired.markRemoteSet();
    await waitIceConnected(A, 'E2.A.p1');
    await waitIceConnected(B, 'E2.B.p1');
    await dcOpen;
    await sleep(300);

    const echo = (label) =>
      withTimeout(
        new Promise((res, rej) => {
          const t = Date.now();
          dcA.onmessage = () => res(Date.now() - t);
          dcA.send(`ping-${label}-${t}`);
          setTimeout(() => rej(new Error(`echo timeout ${label}`)), 5000);
        }),
        6000,
        `echo ${label}`,
      );

    const baselineRtt = await echo('baseline');
    const pair1A = await nominatedPair(A);
    const pair1B = await nominatedPair(B);
    const sdp1 = { ufrag: ufragOf(A.localDescription.sdp), pwd: pwdOf(A.localDescription.sdp) };
    const sdp1B = { ufrag: ufragOf(B.localDescription.sdp) };
    log('E2.phase1.connected', { baselineRttMs: baselineRtt, pairA: pair1A, pairB: pair1B, ufragA: sdp1.ufrag, ufragB: sdp1B.ufrag });

    // —— Phase 2：restartIce + 过滤翻转（只放 127.0.0.2 候选互通）——
    phase = 2;
    aWired.reset(); // 重新关闸：phase-2 候选等 B/A 收完新 offer/answer 再放行
    bWired.reset();
    aWired.cands.length = 0;
    bWired.cands.length = 0;
    const tRestart = Date.now();
    log('E2.phase2.restartIce.call', { onlyIp: UPGRADE_IP });
    A.restartIce();
    log('E2.phase2.needRestart', { needRestart: A.needRestart });
    const offer2 = await A.createOffer(); // needRestart 路径（等价 createOffer({iceRestart:true})）
    const sdp2 = { ufrag: ufragOf(offer2.sdp), pwd: pwdOf(offer2.sdp) };
    const ufragRotated = sdp2.ufrag !== sdp1.ufrag && sdp2.pwd !== sdp1.pwd;
    log('E2.phase2.offer', { ufragRotated, oldUfrag: sdp1.ufrag, newUfrag: sdp2.ufrag });

    await A.setLocalDescription(offer2);
    await B.setRemoteDescription({ type: 'offer', sdp: filterSdpCandidates(A.localDescription.sdp, allow) }); // B 见 ufrag 变化应自动对称 restart
    const answer2 = await B.createAnswer();
    await B.setLocalDescription(answer2);
    const answer2Ufrag = ufragOf(answer2.sdp);
    log('E2.phase2.answer', { bSymmetricRestart: answer2Ufrag !== sdp1B.ufrag, oldUfragB: sdp1B.ufrag, newUfragB: answer2Ufrag });
    await A.setRemoteDescription({ type: 'answer', sdp: filterSdpCandidates(B.localDescription.sdp, allow) });
    bWired.markRemoteSet();
    aWired.markRemoteSet();

    await waitIceConnected(A, 'E2.A.p2');
    await waitIceConnected(B, 'E2.B.p2');
    let migratedEcho = null;
    try {
      migratedEcho = await echo('post-restart');
    } catch (err) {
      log('E2.phase2.echo.fail', { err: String(err) });
    }
    const interruptionMs = migratedEcho == null ? null : Date.now() - tRestart;
    const pair2A = await nominatedPair(A);
    const pair2B = await nominatedPair(B);
    const regatheredA = aWired.cands.length > 0;
    const regatheredB = bWired.cands.length > 0;
    const migrated =
      pair2A.found &&
      pair2B.found &&
      pair1A.found &&
      !pair1A.local.includes(UPGRADE_IP) &&
      pair2A.local.includes(UPGRADE_IP) &&
      pair2B.local.includes(UPGRADE_IP);
    log('E2.phase2.connected', {
      regatheredA,
      regatheredB,
      regatheredACands: aWired.cands,
      regatheredBCands: bWired.cands,
      pairA: pair2A,
      pairB: pair2B,
      nominatedMigrated: migrated,
      postRestartEchoRttMs: migratedEcho,
      dataPlaneInterruptionMs: interruptionMs,
    });

    // —— E4 workaround 取证：绕过 peerConnection.connect() 的 checkDtlsConnected 早退 ——
    // E4a：只手动驱动发起方 A 的 iceTransport.start()——等价于「控制端跑 checks」，
    //      对应生产中浏览器发起 restart 的场景（浏览器控制端会自己跑 checks，
    //      werift host 作为受控应答方只需响应+被提名）。若 E4a 成立，说明 host 侧
    //      无需任何补丁，路线 a 可行（前提是升级轮由 PWA 侧发起）。
    // E4b：若 E4a 不成立，再驱动 B（双侧手动）作为对照。
    // 注意：此手法依赖 werift 0.24.4 私有结构（pc.secureManager.iceTransports），仅作裁决证据，
    // 不代表生产实现可以这么写。
    let workaround = { attempted: true, initiatorOnlyEchoMs: null, initiatorOnlyNominated: false };
    const startIce = async (pc, tag) => {
      const transports = pc.secureManager?.iceTransports ?? [];
      log(`${tag}.workaround.transports`, { count: transports.length, states: transports.map((t) => t.state) });
      await Promise.allSettled(
        transports.map((t) => withTimeout(Promise.resolve().then(() => t.start()), 8000, `${tag}.iceTransport.start`)),
      );
    };
    await startIce(A, 'E4a.A');
    await sleep(1000);
    try {
      workaround.initiatorOnlyEchoMs = await echo('workaround-initiator-only');
    } catch (err) {
      log('E4a.echo.fail', { err: String(err) });
    }
    let pair3A = await nominatedPair(A);
    let pair3B = await nominatedPair(B);
    workaround.initiatorOnlyNominated = pair3A.found && pair3B.found;
    workaround.initiatorOnlyPairA = pair3A;
    workaround.initiatorOnlyPairB = pair3B;
    log('E4a.initiator-only.result', workaround);
    if (workaround.initiatorOnlyEchoMs == null) {
      await startIce(B, 'E4b.B');
      await sleep(1000);
      try {
        workaround.bothEchoMs = await echo('workaround-both');
      } catch (err) {
        log('E4b.echo.fail', { err: String(err) });
      }
      pair3A = await nominatedPair(A);
      pair3B = await nominatedPair(B);
      workaround.bothNominated = pair3A.found && pair3B.found;
      workaround.bothPairA = pair3A;
      workaround.bothPairB = pair3B;
      log('E4b.both.result', workaround);
    }
    const anyPair = [pair3A, pair3B];
    workaround.nominated = anyPair.every((p) => p.found);
    workaround.migratedToUpgradeIp =
      workaround.nominated &&
      anyPair.some((p) => p.local?.includes(UPGRADE_IP) || p.remote?.includes(UPGRADE_IP));

    // getStats 的 iceRestarts 计数（transport 级）
    const statsA = [...(await A.getStats()).values()];
    const transportStats = statsA.filter((s) => s.type === 'transport');
    log('E2.stats', { transport: transportStats.map((s) => ({ iceRestarts: s.iceRestarts, dtlsState: s.dtlsState, iceState: s.iceState })) });

    e2.ok = true;
    e2.ufragRotated = ufragRotated;
    e2.regathered = regatheredA && regatheredB;
    e2.bSymmetricRestart = answer2Ufrag !== sdp1B.ufrag;
    e2.migrated = migrated;
    e2.dcSurvived = migratedEcho != null;
    e2.interruptionMs = interruptionMs;
    e2.workaround = workaround;
    stopA();
    stopB();
    A.close();
    B.close();
  }

  // ---------- E3: setConfiguration 翻转 iceTransportPolicy 是否对已建 transport 生效 ----------
  let e3ConfigFlipEffective = null;
  {
    const turnServers = [{ urls: 'turn:127.0.0.1:3478', username: 'probe', credential: 'probe' }];
    const pc = new RTCPeerConnection({
      iceTransportPolicy: 'relay',
      iceServers: turnServers,
      turnTransport: 'tcp',
      iceUseIpv6: false,
    });
    pc.createDataChannel('x');
    let count1 = 0;
    let count2 = 0;
    let phase = 1;
    pc.onicecandidate = (e) => {
      const c = e?.candidate;
      if (!c) return;
      const parsed = parseCandidateSdp(c.candidate);
      const n = parsed?.type === 'relay' ? 0 : 1; // 只数 host/srflx
      if (phase === 1) count1 += n;
      else count2 += n;
    };
    await pc.setLocalDescription(await pc.createOffer());
    await sleep(2000);
    log('E3.gather.relay', { hostSrflxEmitted: count1 });
    pc.setConfiguration({ iceTransportPolicy: 'all', iceServers: turnServers });
    pc.restartIce();
    phase = 2;
    await pc.setLocalDescription(await pc.createOffer());
    await sleep(2500);
    log('E3.gather.after-flip-to-all', { hostSrflxEmitted: count2, configFlipEffective: count2 > 0 });
    e3ConfigFlipEffective = count2 > 0;
    pc.close();
  }

  // ---------- 裁决 ----------
  log('VERDICT', {
    restartIceApiExists: true, // E0 未抛即存在；证据见 grep 与 E2 调用成功
    relayOnlySuppressionWorks: e1Suppressed,
    restartRegathers: e2.regathered ?? false,
    ufragPwdRotated: e2.ufragRotated ?? false,
    remoteAutoSymmetricRestart: e2.bSymmetricRestart ?? false,
    nominatedPairMigrates: e2.migrated ?? false,
    datachannelSurvivesRestart: e2.dcSurvived ?? false,
    dataPlaneInterruptionMs: e2.interruptionMs ?? null,
    setConfigurationFlipEffective: e3ConfigFlipEffective,
    workaroundInitiatorOnlyNominates: e2.workaround?.initiatorOnlyNominated ?? null,
    workaroundInitiatorOnlyEchoMs: e2.workaround?.initiatorOnlyEchoMs ?? null,
    workaroundInternalStartMigrates: e2.workaround?.migratedToUpgradeIp ?? null,
  });
  flush();
}

const watchdog = setTimeout(() => {
  log('WATCHDOG.abort', { reason: 'overall 60s timeout' });
  flush();
  process.exit(2);
}, 60000);

main()
  .then(() => {
    clearTimeout(watchdog);
    flush();
    setTimeout(() => process.exit(0), 300);
  })
  .catch((err) => {
    log('FATAL', { err: String(err?.stack ?? err) });
    clearTimeout(watchdog);
    flush();
    setTimeout(() => process.exit(1), 300);
  });
