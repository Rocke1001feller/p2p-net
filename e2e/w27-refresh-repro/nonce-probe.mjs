#!/usr/bin/env node
/**
 * nonce-probe.mjs —— 钉死「幽灵 session 438 响应是否带 MESSAGE-INTEGRITY」（W2-7 REFRESH 实验补充臂）
 *
 * 主跑观测【实测】：NAT 重映射后 REFRESH 从新 5 元组到达 coturn，被记进幽灵 session 并回
 * 438；werift 侧 debug「TURN STUN response failed MESSAGE-INTEGRITY check」→ 响应被丢、
 * 重传 7 次后 TransactionTimeout。本探针字节级验证：同一份签名 REFRESH，
 *   A 臂（原 5 元组，经 TurnProtocol.requestWithRetry）→ 预期成功（对照）；
 *   B 臂（新 socket = 新 5 元组，raw dgram）→ 预期 438，dump 响应属性表并分别用
 *   「无 key 解析」与「integrityKey 重校验」复现 werift 的丢弃点。
 * 凭据同样运行时从 ~/.p2p-net 读取，秘密不进日志；输出 NDJSON 到 --out（原始档，入库前 scrub）。
 */
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { classes, makeIntegrityKey, Message, methods, parseMessage, TurnProtocol, UdpTransport } from 'werift';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const OUT = argOf('out', '/tmp/w27-nonce-probe.jsonl');
const T0 = performance.now();
const mono = () => (performance.now() - T0) / 1000;
const emit = (rec) => {
  const line = JSON.stringify({ t: new Date().toISOString(), mono: Number(mono().toFixed(3)), ...rec });
  appendFileSync(OUT, line + '\n');
  console.log(line.replace(/"(username|credential)":"[^"]*"/g, '"$1":"<redacted>"'));
};

async function fetchTurn() {
  const dir = join(homedir(), '.p2p-net');
  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  const auth = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
  const res = await fetch(`${cfg.supabaseUrl}/functions/v1/turn-credentials`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { apikey: cfg.publishableKey, Authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`turn-credentials HTTP ${res.status}`);
  const j = await res.json();
  for (const srv of j.iceServers ?? []) {
    for (const u of Array.isArray(srv.urls) ? srv.urls : [srv.urls]) {
      const m = /^turn:([^:?]+)(?::(\d+))?\?transport=udp$/i.exec(String(u).trim());
      if (m) return { host: m[1], port: Number(m[2] ?? 3478), username: srv.username, credential: srv.credential };
    }
  }
  throw new Error('无 turn udp 条目');
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, '');
  const cred = await fetchTurn();
  emit({ ev: 'meta', scrub: { username: cred.username, turnHost: cred.host }, usernameHash: createHash('sha256').update(cred.username).digest('hex').slice(0, 8) });

  // A：正常 TurnProtocol，ALLOCATE 建会话
  const transportA = await UdpTransport.init('udp4', {});
  const turnA = new TurnProtocol([cred.host, cred.port], cred.username, cred.credential, 600, transportA);
  await turnA.connectionMade();
  const key = makeIntegrityKey(cred.username, turnA.realm, cred.credential);
  emit({
    ev: 'allocated',
    relayed: turnA.relayedAddress?.join(':'),
    mapped: turnA.mappedAddress?.join(':'),
    nonceLen: turnA.nonce?.length,
    realm: turnA.realm,
    scrubMore: { mappedIp: turnA.mappedAddress?.[0] },
  });

  // A 臂（对照）：同 5 元组上手造 REFRESH（LIFETIME=600）→ 预期成功
  const reqA = new Message(methods.REFRESH, classes.REQUEST).setAttribute('LIFETIME', 600);
  try {
    const [rsp] = await turnA.requestWithRetry(reqA, turnA.server);
    emit({ ev: 'armA_same_tuple', outcome: 'success', lifetime: rsp.getAttributeValue('LIFETIME') });
  } catch (e) {
    emit({ ev: 'armA_same_tuple', outcome: 'error', err: String(e?.message ?? e) });
  }

  // B 臂：新 socket（新 5 元组）raw 发同签名 REFRESH → 预期 438；dump 字节级属性
  const reqB = new Message(methods.REFRESH, classes.REQUEST)
    .setAttribute('LIFETIME', 600)
    .setAttribute('USERNAME', cred.username)
    .setAttribute('REALM', turnA.realm)
    .setAttribute('NONCE', turnA.nonce);
  reqB.addMessageIntegrity(key);
  reqB.addFingerprint();
  const raw = reqB.bytes;
  const sockB = dgram.createSocket('udp4');
  await new Promise((r) => sockB.bind(0, r));
  const rspB = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 4000);
    sockB.once('message', (data, rinfo) => { clearTimeout(timer); resolve({ data, rinfo }); });
    sockB.send(raw, cred.port, cred.host, () => {});
  });
  if (!rspB) {
    emit({ ev: 'armB_new_tuple', outcome: 'no_response' });
  } else {
    const unsigned = parseMessage(rspB.data); // 无 key 解析：能读到属性表
    const verified = parseMessage(rspB.data, key); // werift 交易路径的重校验
    let errCode, newNonce;
    try { errCode = unsigned?.getAttributeValue('ERROR-CODE')?.[0]; } catch { /* 无 */ }
    try { newNonce = unsigned?.getAttributeValue('NONCE'); } catch { /* 无 */ }
    emit({
      ev: 'armB_new_tuple',
      outcome: 'response',
      from: `${rspB.rinfo.address}:${rspB.rinfo.port}`,
      bytes: rspB.data.length,
      errorCode: errCode,
      attrs: unsigned?.attributesKeys ?? null,
      hasMessageIntegrity: unsigned ? unsigned.attributesKeys.includes('MESSAGE-INTEGRITY') : null,
      hasNewNonce: unsigned ? unsigned.attributesKeys.includes('NONCE') : null,
      // parseMessage 失败返回 undefined（非 null）——werift handleSTUNMessage 正是在此丢弃
      verifiedWithIntegrityKey: verified !== undefined && verified !== null,
    });

    // C 臂：取 438 携带的新 nonce 重签重发（同 B 的 5 元组）——验证「即使 438 重试成功换新
    // nonce，幽灵 session 上无 allocation，REFRESH 是否仍不可自愈」（预期 437 Allocation Mismatch）
    if (Buffer.isBuffer(newNonce) && newNonce.length > 0) {
      const reqC = new Message(methods.REFRESH, classes.REQUEST)
        .setAttribute('LIFETIME', 600)
        .setAttribute('USERNAME', cred.username)
        .setAttribute('REALM', turnA.realm)
        .setAttribute('NONCE', newNonce);
      reqC.addMessageIntegrity(key);
      reqC.addFingerprint();
      const rspC = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 4000);
        sockB.once('message', (data, rinfo) => { clearTimeout(timer); resolve({ data, rinfo }); });
        sockB.send(reqC.bytes, cred.port, cred.host, () => {});
      });
      if (!rspC) {
        emit({ ev: 'armC_new_nonce_retry', outcome: 'no_response' });
      } else {
        const parsedC = parseMessage(rspC.data);
        let errC, lifetimeC;
        try { errC = parsedC?.getAttributeValue('ERROR-CODE')?.[0]; } catch { /* 无 */ }
        try { lifetimeC = parsedC?.getAttributeValue('LIFETIME'); } catch { /* 无 */ }
        emit({
          ev: 'armC_new_nonce_retry',
          outcome: 'response',
          bytes: rspC.data.length,
          errorCode: errC,
          lifetime: lifetimeC,
          attrs: parsedC?.attributesKeys ?? null,
          hasMessageIntegrity: parsedC ? parsedC.attributesKeys.includes('MESSAGE-INTEGRITY') : null,
        });
      }
    }
  }
  sockB.close();

  // 收尾：A 上 REFRESH LIFETIME=0 注销
  try {
    const del = new Message(methods.REFRESH, classes.REQUEST).setAttribute('LIFETIME', 0);
    await turnA.requestWithRetry(del, turnA.server);
    emit({ ev: 'teardown', outcome: 'deleted' });
  } catch (e) {
    emit({ ev: 'teardown', outcome: 'delete_failed', err: String(e?.message ?? e) });
  }
  await turnA.close();
  emit({ ev: 'done' });
  process.exit(0);
}

main().catch((e) => { emit({ ev: 'fatal', err: String(e?.message ?? e) }); process.exit(1); });
