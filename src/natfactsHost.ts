/**
 * host 侧 NAT facts 采集器（Wave 2 W2-2）：node:dgram 直发 RFC 5389 Binding Request，
 * 解析 XOR-MAPPED-ADDRESS（0x0020）提取 srflx 映射 ip:port。仅 Node 使用，不进 browser
 * barrel（dgram 进不了 vite 构建，靠模块拆分拦截；schema/判定在 natfacts.ts 单源）。
 * 帧模式复用 doctor.ts defaultStunProbe 的 RFC 5389 最小帧（类型/cookie/txnId 严格校验），
 * 在其基础上新增 XOR-MAPPED-ADDRESS 属性解析——defaultStunProbe 只验响应存在性，不取 srflx。
 *
 * 探测节奏：同一 socket 对每台服务器发 2 次 binding（第 2 轮间隔 intervalMs，默认 200ms）。
 * 同 socket 跨服务器的首轮观测满足判定口径（同本地端点 → 跨目标映射一致性）；同服务器
 * 两轮观测判 srflx 端口时域稳定性。全部超时/出错 → hasSrflx:false、servers:0，绝不抛。
 */

import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';

import { judgeMappingConsistency, type NatFacts, type SrflxObservation } from './natfacts.js';

const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_RESPONSE = 0x0101;
const STUN_MAGIC_COOKIE = 0x2112a442;
const STUN_HEADER_LEN = 20;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_INTERVAL_MS = 200;

export interface StunServer {
  host: string;
  port: number;
}

/** 采集器 socket 最小面（测试注入假 socket 的缝；生产 = dgram udp4）。
 *  cb 签名对齐 dgram（Error | null），使 dgram.Socket 直接满足本结构面。 */
export interface StunSocketLike {
  send(msg: Uint8Array, port: number, host: string, cb: (err: Error | null) => void): void;
  on(event: 'message', cb: (msg: Uint8Array) => void): void;
  once(event: 'error', cb: (err: Error) => void): void;
  close(): void;
}

export interface CollectNatFactsHostOpts {
  /** 单轮应答等待（默认 3000ms；第 2 轮发出后再等这么久封顶）。 */
  timeoutMs?: number;
  /** 两轮 binding 间隔（默认 200ms，计划钉死）。 */
  intervalMs?: number;
  socketFactory?: () => StunSocketLike;
}

const u16 = (b: Uint8Array, o: number): number => ((b[o]! << 8) | b[o + 1]!) >>> 0;
const u32 = (b: Uint8Array, o: number): number => (((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0);

/** RFC 5389 §15.2：XOR-MAPPED-ADDRESS 值解码——port/ip 与 magic cookie 异或还原。 */
export function parseXorMappedAddress(value: Uint8Array, txnId: Uint8Array): SrflxObservation | null {
  if (value.length < 4) return null;
  const family = value[1];
  const port = u16(value, 2) ^ (STUN_MAGIC_COOKIE >>> 16);
  if (family === 0x01) {
    if (value.length < 8) return null;
    const addr = u32(value, 4) ^ STUN_MAGIC_COOKIE;
    return { ip: `${(addr >>> 24) & 0xff}.${(addr >>> 16) & 0xff}.${(addr >>> 8) & 0xff}.${addr & 0xff}`, port };
  }
  if (family === 0x02) {
    if (value.length < 20) return null;
    const mask = new Uint8Array(16);
    mask[0] = (STUN_MAGIC_COOKIE >>> 24) & 0xff;
    mask[1] = (STUN_MAGIC_COOKIE >>> 16) & 0xff;
    mask[2] = (STUN_MAGIC_COOKIE >>> 8) & 0xff;
    mask[3] = STUN_MAGIC_COOKIE & 0xff;
    for (let i = 0; i < 12; i++) mask[4 + i] = txnId[i]!;
    const groups: string[] = [];
    for (let i = 0; i < 8; i++) {
      const hi = value[4 + i * 2]! ^ mask[i * 2]!;
      const lo = value[5 + i * 2]! ^ mask[i * 2 + 1]!;
      groups.push(((hi << 8) | lo).toString(16));
    }
    return { ip: groups.join(':'), port };
  }
  return null;
}

/** Binding Response 严格校验（类型/cookie/txnId 全匹配）+ 属性遍历提取 XOR-MAPPED-ADDRESS。 */
export function parseBindingResponse(msg: Uint8Array, txnId: Uint8Array): SrflxObservation | null {
  if (msg.length < STUN_HEADER_LEN) return null;
  if (u16(msg, 0) !== STUN_BINDING_RESPONSE) return null;
  if (u32(msg, 4) !== STUN_MAGIC_COOKIE) return null;
  for (let i = 0; i < 12; i++) if (msg[8 + i] !== txnId[i]) return null;
  const bodyLen = Math.min(u16(msg, 2), msg.length - STUN_HEADER_LEN);
  const end = STUN_HEADER_LEN + bodyLen;
  let off = STUN_HEADER_LEN;
  while (off + 4 <= end) {
    const type = u16(msg, off);
    const len = u16(msg, off + 2);
    const voff = off + 4;
    if (voff + len > end) break;
    if (type === ATTR_XOR_MAPPED_ADDRESS) return parseXorMappedAddress(msg.subarray(voff, voff + len), txnId);
    off = voff + len + ((4 - (len % 4)) % 4); // 属性按 32 位对齐填充
  }
  return null;
}

const DEGENERATE: NatFacts = { hasSrflx: false, srflxPortStable: null, mappingConsistency: 'unknown', servers: 0 };

/**
 * 对每台 STUN 服务器发 2 次 binding（间隔 intervalMs），汇总为 NatFacts。绝不抛：
 * 超时/socket 错误/畸形响应一律退化为缺失观测（Review Focus #2：coturn 不可达或只配
 * 1 台 relay 时 facts 退化但调用方其余流程照常）。
 */
export function collectNatFactsHost(stunServers: StunServer[], opts: CollectNatFactsHostOpts = {}): Promise<NatFacts> {
  if (stunServers.length === 0) return Promise.resolve(DEGENERATE);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const factory = opts.socketFactory ?? (() => dgram.createSocket('udp4'));
  return new Promise((resolve) => {
    let socket: StunSocketLike;
    try {
      socket = factory();
    } catch {
      resolve(DEGENERATE);
      return;
    }
    const obs: (SrflxObservation | undefined)[][] = stunServers.map(() => [undefined, undefined]);
    const pending = new Map<string, { serverIdx: number; round: number; txnId: Uint8Array }>();
    let settled = false;
    let round2Sent = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(round2Timer);
      clearTimeout(deadlineTimer);
      try {
        socket.close();
      } catch { /* best-effort */ }
      const firsts: SrflxObservation[] = [];
      let responsive = 0;
      let stable: boolean | null = null;
      for (const per of obs) {
        const first = per[0] ?? per[1];
        if (!first) continue;
        responsive += 1;
        firsts.push(first);
        if (per[0] && per[1]) {
          const same = per[0].ip === per[1].ip && per[0].port === per[1].port;
          stable = stable === null ? same : stable && same;
        }
      }
      resolve({
        hasSrflx: responsive > 0,
        srflxPortStable: stable,
        mappingConsistency: judgeMappingConsistency(firsts),
        servers: responsive,
      });
    };
    const maybeFinish = (): void => {
      if (round2Sent && pending.size === 0) finish();
    };

    socket.on('message', (msg) => {
      if (settled || msg.length < STUN_HEADER_LEN) return;
      const key = Buffer.from(msg.subarray(8, STUN_HEADER_LEN)).toString('hex');
      const req = pending.get(key);
      if (!req) return; // 陌生人/迟到包：忽略
      pending.delete(key);
      const srflx = parseBindingResponse(msg, req.txnId);
      if (srflx) obs[req.serverIdx]![req.round] = srflx;
      maybeFinish();
    });
    socket.once('error', () => finish()); // socket 出错：以已有观测退化收尾，不抛

    const sendRound = (round: number): void => {
      stunServers.forEach((srv, serverIdx) => {
        const txnId = randomBytes(12);
        const req = Buffer.alloc(STUN_HEADER_LEN);
        req.writeUInt16BE(STUN_BINDING_REQUEST, 0);
        req.writeUInt16BE(0, 2); // message length：无属性
        req.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
        txnId.copy(req, 8);
        const key = txnId.toString('hex');
        pending.set(key, { serverIdx, round, txnId });
        try {
          socket.send(req, srv.port, srv.host, (err: Error | null) => {
            if (err) {
              pending.delete(key);
              maybeFinish();
            }
          });
        } catch {
          pending.delete(key);
        }
      });
    };

    const round2Timer = setTimeout(() => {
      round2Sent = true;
      if (!settled) sendRound(1);
      maybeFinish(); // 防御：round1 全失败后 round2 发送也可能全同步失败
    }, intervalMs);
    const deadlineTimer = setTimeout(finish, intervalMs + timeoutMs);
    sendRound(0);
    maybeFinish();
  });
}
