/** NAT facts 探针（Wave 2 W2-2）单测。
 *  - 判定表 judgeMappingConsistency / 紧凑串 formatNatFacts：纯函数表驱动。
 *  - host 采集器 collectNatFactsHost：注入假 socket（不打真实外网）+ 本地 UDP 回环
 *    （手工协议帧必须真发真收，同 doctor defaultStunProbe 既有纪律）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';

import { formatNatFacts, judgeMappingConsistency, type NatFacts } from '../natfacts.js';
import { collectNatFactsHost, type StunSocketLike } from '../natfactsHost.js';

// ---------- 判定表（纯函数） ----------

test('同 ip:port 跨两服务器 → endpoint-independent', () => {
  assert.equal(judgeMappingConsistency([
    { ip: '1.2.3.4', port: 4000 }, { ip: '1.2.3.4', port: 4000 },
  ]), 'endpoint-independent');
});

test('port 变 → endpoint-dependent；单观测 → unknown；空 → unknown', () => {
  assert.equal(judgeMappingConsistency([
    { ip: '1.2.3.4', port: 4000 }, { ip: '1.2.3.4', port: 4001 },
  ]), 'endpoint-dependent');
  assert.equal(judgeMappingConsistency([{ ip: '1.2.3.4', port: 4000 }]), 'unknown');
  assert.equal(judgeMappingConsistency([]), 'unknown');
});

test('ip 变（多宿主/运营商级 NAT）→ endpoint-dependent', () => {
  assert.equal(judgeMappingConsistency([
    { ip: '1.2.3.4', port: 4000 }, { ip: '9.9.9.9', port: 4000 },
  ]), 'endpoint-dependent');
});

// ---------- 紧凑串（事件纪律：只带聚合语义，绝无 ip） ----------

test('formatNatFacts：紧凑串 m:<mapping>,servers:<n>，不含 ip/port', () => {
  const f: NatFacts = { hasSrflx: true, srflxPortStable: true, mappingConsistency: 'endpoint-independent', servers: 2 };
  assert.equal(formatNatFacts(f), 'm:ep-ind,servers:2');
  assert.equal(formatNatFacts({ ...f, mappingConsistency: 'endpoint-dependent', srflxPortStable: false }), 'm:ep-dep,servers:2');
  assert.equal(formatNatFacts({ hasSrflx: false, srflxPortStable: null, mappingConsistency: 'unknown', servers: 0 }), 'm:unknown,servers:0');
});

// ---------- host 采集器（假 socket，不打外网） ----------

const MAGIC = 0x2112a442;

/** 构造带 XOR-MAPPED-ADDRESS 的 Binding Response（RFC 5389 §15.2 编码——与解码器互为对偶）。 */
function buildXorResponse(txnId: Uint8Array, ip: string, port: number): Buffer {
  const buf = Buffer.alloc(20 + 4 + 8);
  buf.writeUInt16BE(0x0101, 0); // Binding Success Response
  buf.writeUInt16BE(12, 2); // message length：1 个属性（4 头 + 8 值）
  buf.writeUInt32BE(MAGIC, 4);
  Buffer.from(txnId).copy(buf, 8);
  buf.writeUInt16BE(0x0020, 20); // XOR-MAPPED-ADDRESS
  buf.writeUInt16BE(8, 22);
  buf.writeUInt8(0, 24);
  buf.writeUInt8(0x01, 25); // family IPv4
  buf.writeUInt16BE(port ^ (MAGIC >>> 16), 26);
  const p = ip.split('.').map(Number);
  buf.writeUInt32BE((((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0) ^ MAGIC, 28);
  return buf;
}

/** 假 socket：按脚本应答（script[host] = 两轮各自要回的 srflx；null = 该轮沉默）。 */
function fakeSocketFactory(script: Record<string, ({ ip: string; port: number } | null)[]>, sent: string[]): () => StunSocketLike {
  return () => {
    const rounds: Record<string, number> = {}; // 每台服务器独立计轮（采集器单 socket 多目标）
    let msgCb: ((msg: Uint8Array) => void) | null = null;
    return {
      send(msg: Uint8Array, port: number, host: string, cb: (err: Error | null) => void): void {
        const txnId = Buffer.from(msg).subarray(8, 20);
        const myRound = (rounds[host] ?? 0);
        rounds[host] = myRound + 1;
        sent.push(`${host}:${port}#${myRound}`);
        cb(null);
        const obs = script[host]?.[myRound];
        if (obs) setTimeout(() => msgCb?.(buildXorResponse(txnId, obs.ip, obs.port)), 5);
      },
      on(_event: 'message', cb: (msg: Uint8Array) => void): void { msgCb = cb; },
      once(_event: 'error', _cb: (err: Error) => void): void {},
      close(): void {},
    };
  };
}

test('collectNatFactsHost：两台服务器同映射 → endpoint-independent，servers=2，portStable=true', async () => {
  const sent: string[] = [];
  const facts = await collectNatFactsHost(
    [{ host: '10.0.0.1', port: 3478 }, { host: '10.0.0.2', port: 3478 }],
    {
      timeoutMs: 200, intervalMs: 20,
      socketFactory: fakeSocketFactory({
        '10.0.0.1': [{ ip: '1.2.3.4', port: 5000 }, { ip: '1.2.3.4', port: 5000 }],
        '10.0.0.2': [{ ip: '1.2.3.4', port: 5000 }, { ip: '1.2.3.4', port: 5000 }],
      }, sent),
    },
  );
  assert.deepEqual(facts, { hasSrflx: true, srflxPortStable: true, mappingConsistency: 'endpoint-independent', servers: 2 });
  // 每台服务器恰好 2 次 binding（计划：间隔 200ms 两轮）
  assert.equal(sent.filter((s) => s.startsWith('10.0.0.1')).length, 2);
  assert.equal(sent.filter((s) => s.startsWith('10.0.0.2')).length, 2);
});

test('collectNatFactsHost：跨服务器 port 变 → endpoint-dependent；单台应答 → unknown + servers=1（Review Focus #2）', async () => {
  const f1 = await collectNatFactsHost(
    [{ host: '10.0.0.1', port: 3478 }, { host: '10.0.0.2', port: 3478 }],
    {
      timeoutMs: 200, intervalMs: 20,
      socketFactory: fakeSocketFactory({
        '10.0.0.1': [{ ip: '1.2.3.4', port: 5000 }, null],
        '10.0.0.2': [{ ip: '1.2.3.4', port: 5001 }, null],
      }, []),
    },
  );
  assert.equal(f1.mappingConsistency, 'endpoint-dependent');
  assert.equal(f1.servers, 2);
  assert.equal(f1.srflxPortStable, null, '两轮各只有 1 次观测，无可比对的稳定性');

  const f2 = await collectNatFactsHost(
    [{ host: '10.0.0.1', port: 3478 }, { host: '10.0.0.2', port: 3478 }],
    {
      timeoutMs: 200, intervalMs: 20,
      socketFactory: fakeSocketFactory({
        '10.0.0.1': [{ ip: '1.2.3.4', port: 5000 }, { ip: '1.2.3.4', port: 5000 }],
        '10.0.0.2': [null, null], // coturn 不可达
      }, []),
    },
  );
  assert.deepEqual(f2, { hasSrflx: true, srflxPortStable: true, mappingConsistency: 'unknown', servers: 1 });
});

test('collectNatFactsHost：全部超时 → hasSrflx=false/servers=0，不抛（Review Focus #2 退化）', async () => {
  const facts = await collectNatFactsHost(
    [{ host: '10.0.0.1', port: 3478 }],
    { timeoutMs: 60, intervalMs: 10, socketFactory: fakeSocketFactory({}, []) },
  );
  assert.deepEqual(facts, { hasSrflx: false, srflxPortStable: null, mappingConsistency: 'unknown', servers: 0 });
});

test('collectNatFactsHost：同服务器两轮 port 漂移 → srflxPortStable=false', async () => {
  const facts = await collectNatFactsHost(
    [{ host: '10.0.0.1', port: 3478 }],
    {
      timeoutMs: 200, intervalMs: 20,
      socketFactory: fakeSocketFactory({
        '10.0.0.1': [{ ip: '1.2.3.4', port: 5000 }, { ip: '1.2.3.4', port: 5009 }],
      }, []),
    },
  );
  assert.equal(facts.srflxPortStable, false);
  assert.equal(facts.servers, 1);
});

test('collectNatFactsHost：空服务器清单 → 立即退化，不发包不抛', async () => {
  const sent: string[] = [];
  const facts = await collectNatFactsHost([], { timeoutMs: 50, socketFactory: fakeSocketFactory({}, sent) });
  assert.deepEqual(facts, { hasSrflx: false, srflxPortStable: null, mappingConsistency: 'unknown', servers: 0 });
  assert.equal(sent.length, 0);
});

// ---------- host 采集器（真实 UDP 回环：XOR 编解码真发真收） ----------

/** 本地回环 STUN 服务器：从请求头取 txnId，以 rinfo 为映射地址回 XOR-MAPPED-ADDRESS。 */
function xorStunServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.on('message', (msg, rinfo) => {
      if (msg.length < 20) return;
      if (msg.readUInt16BE(0) !== 0x0001 || msg.readUInt32BE(4) !== MAGIC) return;
      const res = buildXorResponse(msg.subarray(8, 20), rinfo.address, rinfo.port);
      socket.send(res, rinfo.port, rinfo.address, () => {});
    });
    socket.bind(0, '127.0.0.1', () => {
      const addr = socket.address() as AddressInfo;
      resolve({ port: addr.port, close: () => socket.close() });
    });
  });
}

test('collectNatFactsHost：真实回环两台服务器 → endpoint-independent（同 socket 同映射）', async () => {
  const s1 = await xorStunServer();
  const s2 = await xorStunServer();
  try {
    const facts = await collectNatFactsHost(
      [{ host: '127.0.0.1', port: s1.port }, { host: '127.0.0.1', port: s2.port }],
      { timeoutMs: 1000, intervalMs: 50 },
    );
    assert.equal(facts.hasSrflx, true);
    assert.equal(facts.servers, 2);
    assert.equal(facts.mappingConsistency, 'endpoint-independent', '同一 socket 对两目标应见同一映射');
    assert.equal(facts.srflxPortStable, true);
  } finally {
    s1.close();
    s2.close();
  }
});
