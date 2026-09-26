#!/usr/bin/env node
/**
 * turn-refresh-repro.mjs —— W2-7 REFRESH#2 缺席判别实验（去掉 Android 变量）
 *
 * 背景：W2-7 浸泡（Android 真机强制 relay）+1190s 死于 reason=failed；coturn 窗口零 438、
 * host 侧 turn_438_repair 零触发；allocation 死于 allocation timeout——REFRESH#1(+497s) 成功，
 * REFRESH#2(~+997s) 从未到达 VPS。三候选：① Android 页面后台冻结停发；② UDP 丢包；
 * ③ werift TURN 客户端 REFRESH 链缺陷。
 *
 * 本脚本：在本机（Mac，与 host 同一家庭出口）用仓库 node_modules 里的 werift 0.24.4
 * 直驱生产 coturn，手工构造 TurnProtocol（与 ICE gather 路径同参数：默认 lifetime=600、
 * transport=udp、临时高位本地端口），让 werift 自带 refresh 循环按 (5/6)×600=500s 节奏
 * 发 REFRESH——与真机客户端同一节奏、同一段 werift 代码路径。每个进出 TURN 报文与
 * 每次 refresh 尝试都打单调时钟（performance.now）+ 墙钟（UTC ISO）时间戳落 NDJSON。
 *
 * 判别问题：REFRESH#2 缺席在去掉 Android 后是否复现？
 *   - 复现 → 候选③（werift 链缺陷）证实；不复现（≥3 次 REFRESH 全成功）→ ③ 在本配置排除。
 *
 * 用法（仓库根目录）：
 *   node e2e/w27-refresh-repro/turn-refresh-repro.mjs --out /tmp/w27-client.jsonl [--duration-ms 1800000]
 * 凭据运行时从 ~/.p2p-net/ 读取（config.json + auth.json，access token 临期自动内存刷新，
 * 不落盘）。秘密纪律：TURN username/credential、token 绝不进 stdout/日志；公网地址只进
 * --out 原始档（默认 /tmp），入库前必须经 scrub-results.mjs 脱敏。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { classes, Message, methods, TurnProtocol, UdpTransport } from 'werift';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const OUT = argOf('out', '/tmp/w27-refresh-repro-client.jsonl');
const DURATION_MS = Number(argOf('duration-ms', String(30 * 60 * 1000)));
const HB_MS = Number(argOf('hb-ms', '20000'));

const T0 = performance.now();
const mono = () => (performance.now() - T0) / 1000;
const wall = () => new Date().toISOString();

function emit(rec) {
  const line = JSON.stringify({ t: wall(), mono: Number(mono().toFixed(3)), ...rec });
  appendFileSync(OUT, line + '\n');
  // 控制台摘要只放无敏感字段的事件（公网地址/relayed 只进 --out 原始档）
  const quietPhases = new Set(['start', 'token_refreshed', 'teardown', 'allocation_deleted', 'delete_failed', 'done', 'fatal', 'sigint']);
  const echo = ['req', 'req_ok', 'req_err', 'hb_mark'].includes(rec.ev) || (rec.ev === 'phase' && quietPhases.has(rec.phase));
  if (echo) {
    const { ev, ...rest } = rec;
    delete rest.txid;
    console.log(`[${wall()} +${mono().toFixed(1)}s] ${ev}`, JSON.stringify(rest));
  }
}

/** STUN/ChannelData 报文类型解码（RFC 5389 method/class 位拆 + RFC 5766 channel 范围）。 */
const METHODS = { 0x001: 'BINDING', 0x003: 'ALLOCATE', 0x004: 'REFRESH', 0x006: 'SEND', 0x007: 'DATA', 0x008: 'CREATE_PERMISSION', 0x009: 'CHANNEL_BIND' };
const CLASSES = ['req', 'ind', 'success', 'err'];
function decodeFrame(data) {
  if (data.length < 4) return { kind: 'short' };
  const w = data.readUInt16BE(0);
  if ((w & 0xc000) === 0x4000) {
    return { kind: 'channelData', channel: w & 0x3fff, bytes: data.length };
  }
  if ((w & 0xc000) !== 0) return { kind: 'unknown', bytes: data.length };
  const method = (w & 0x000f) | ((w & 0x00e0) >> 1) | ((w & 0x3e00) >> 2);
  const cls = (w & 0x0010) >> 4 | (w & 0x0100) >> 7;
  return {
    kind: 'stun',
    method: METHODS[method] ?? `0x${method.toString(16)}`,
    cls: CLASSES[cls],
    txid: data.subarray(8, 20).toString('hex').slice(0, 12),
    bytes: data.length,
  };
}

const redactAddr = (a) => (Array.isArray(a) ? `${a[0]}:${a[1]}` : String(a));
const hash8 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

/** ~/.p2p-net 读配置与登录态；access token 临期（<10min）走 supabase refresh 内存刷新。 */
async function loadAuth() {
  const dir = join(homedir(), '.p2p-net');
  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  const auth = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
  let accessToken = auth.accessToken;
  if (typeof auth.expiresAt === 'number' && auth.expiresAt - Date.now() < 10 * 60 * 1000) {
    const res = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { apikey: cfg.publishableKey, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: auth.refreshToken }),
    });
    if (!res.ok) throw new Error(`access token 刷新失败（HTTP ${res.status}）——请重新 p2p-net login`);
    const j = await res.json();
    accessToken = j.access_token;
    emit({ ev: 'phase', phase: 'token_refreshed' });
  }
  return { cfg, accessToken };
}

/** POST /functions/v1/turn-credentials → 第一条 turn:?transport=udp 凭据（与 host turnFetcher 同调用）。 */
async function fetchTurn(cfg, accessToken) {
  const res = await fetch(`${cfg.supabaseUrl}/functions/v1/turn-credentials`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { apikey: cfg.publishableKey, Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`turn-credentials HTTP ${res.status}`);
  const j = await res.json();
  for (const srv of j.iceServers ?? []) {
    const urls = Array.isArray(srv.urls) ? srv.urls : [srv.urls];
    for (const u of urls) {
      const m = /^turn:([^:?]+)(?::(\d+))?\?transport=udp$/i.exec(String(u).trim());
      if (m) return { host: m[1], port: Number(m[2] ?? 3478), username: srv.username, credential: srv.credential, ttlSeconds: j.ttlSeconds };
    }
  }
  throw new Error('turn-credentials 响应无 turn udp 条目');
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, '');
  emit({ ev: 'phase', phase: 'start', durationMs: DURATION_MS, node: process.version });

  const { cfg, accessToken } = await loadAuth();
  const cred = await fetchTurn(cfg, accessToken);
  // meta 记录含公网地址与 username，仅供 VPS 侧关联与 scrub 定位——原始档不入库
  emit({
    ev: 'meta',
    turnServer: `${cred.host}:${cred.port}`,
    usernameHash: hash8(cred.username),
    usernameLen: cred.username.length,
    scrub: { username: cred.username, turnHost: cred.host },
    ttlSeconds: cred.ttlSeconds,
  });

  const transport = await UdpTransport.init('udp4', {});
  const turn = new TurnProtocol([cred.host, cred.port], cred.username, cred.credential, 600, transport);

  // 出向报文地面真值（transport.send 是进程内最后一棒）
  const origSend = transport.send.bind(transport);
  transport.send = async (data, addr) => {
    emit({ ev: 'send', ...decodeFrame(data), to: addr ? redactAddr(addr) : undefined });
    return origSend(data, addr);
  };
  // 入向报文地面真值
  const origRecv = turn.dataReceived.bind(turn);
  turn.dataReceived = (data, addr) => {
    emit({ ev: 'recv', ...decodeFrame(data), from: redactAddr(addr) });
    return origRecv(data, addr);
  };
  // TURN 请求生命周期（refresh 循环与 438 重试都经此漏斗）
  let reqSeq = 0;
  const origRequest = turn.request.bind(turn);
  turn.request = async (request, addr, ...rest) => {
    const seq = ++reqSeq;
    const tag = { ev: 'req', seq, method: METHODS[request.messageMethod] ?? `0x${request.messageMethod.toString(16)}`, txid: request.transactionIdHex.slice(0, 12) };
    emit(tag);
    const sentAt = mono();
    try {
      const [msg] = await origRequest(request, addr, ...rest);
      const lifetime = safeAttr(msg, 'LIFETIME');
      emit({ ev: 'req_ok', seq, method: tag.method, rttMs: Math.round((mono() - sentAt) * 1000), ...(lifetime !== undefined ? { lifetime } : {}) });
      return [msg, addr];
    } catch (e) {
      const code = e?.response ? safeAttr(e.response, 'ERROR-CODE')?.[0] : undefined;
      const errText = String(e?.message ?? e) || (e?.name ?? 'unknown'); // TransactionTimeout 等无 message 时落类名
      emit({ ev: 'req_err', seq, method: tag.method, rttMs: Math.round((mono() - sentAt) * 1000), err: errText, ...(code !== undefined ? { errorCode: code } : {}) });
      throw e;
    }
  };
  function safeAttr(msg, name) {
    try { return msg.getAttributeValue(name); } catch { return undefined; }
  }

  await turn.connectionMade(); // ALLOCATE（含 401→nonce 重试），并启动 werift 自带 refresh 循环
  emit({
    ev: 'phase', phase: 'allocated',
    local: redactAddr([transport.socket.address().address, transport.socket.address().port]),
    relayed: redactAddr(turn.relayedAddress),
    mapped: redactAddr(turn.mappedAddress),
    scrubMore: { mappedIp: turn.mappedAddress?.[0], localIp: transport.socket.address().address },
  });

  const hb = setInterval(() => emit({ ev: 'hb' }), HB_MS);
  emit({ ev: 'hb_mark', note: `心跳每 ${HB_MS / 1000}s 一条；REFRESH 预期节奏 (5/6)*600=500s` });

  await new Promise((r) => setTimeout(r, DURATION_MS));

  // 收尾：REFRESH LIFETIME=0 主动注销 allocation（生产 coturn 端口池仅 20，礼貌释放）
  emit({ ev: 'phase', phase: 'teardown' });
  clearInterval(hb);
  try {
    const m = new Message(methods.REFRESH, classes.REQUEST);
    m.setAttribute('LIFETIME', 0);
    await turn.requestWithRetry(m, turn.server);
    emit({ ev: 'phase', phase: 'allocation_deleted' });
  } catch (e) {
    emit({ ev: 'phase', phase: 'delete_failed', err: String(e?.message ?? e) || (e?.name ?? 'unknown') });
  }
  await turn.close();
  emit({ ev: 'phase', phase: 'done' });
  process.exit(0);
}

process.on('SIGINT', () => { emit({ ev: 'phase', phase: 'sigint' }); process.exit(130); });

main().catch((e) => {
  emit({ ev: 'phase', phase: 'fatal', err: String(e?.message ?? e) });
  console.error(e);
  process.exit(1);
});
