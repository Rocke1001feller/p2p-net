#!/usr/bin/env node
/**
 * scrub-results.mjs —— W2-7 REFRESH#2 实验产物入库前脱敏
 *
 * 输入：客户端原始 NDJSON（--client，含公网地址/username）+ VPS coturn journal 原始窗口
 * （--coturn）。输出到 --outdir：client-<tag>.jsonl 与 coturn-<tag>.txt，全部占位符化：
 *   TURN username → <TURN_USER>   VPS 地址 → <VPS_IP>   家庭公网地址 → <HOME_IP>
 *   局域网地址 → <LAN_IP>        supabase host → <SUPABASE_HOST>
 * 端口/txid 前缀/时间戳保留（关联分析需要）。
 *
 * 硬断言（任一命中即非零退出，阻止带病入库）：accessToken / refreshToken / TURN credential /
 * publishableKey / tunnelSecret 的原文绝不允许出现在输出里。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const CLIENT = argOf('client', '/tmp/w27-refresh-repro-client.jsonl');
const COTURN = argOf('coturn', '/tmp/w27-refresh-repro-coturn.txt');
const OUTDIR = argOf('outdir', 'e2e/w27-refresh-repro/results');
const TAG = argOf('tag', 'run1');

const clientRaw = readFileSync(CLIENT, 'utf8');
const coturnRaw = readFileSync(COTURN, 'utf8');

// 从客户端 meta/allocated 记录提取需脱敏的运行时值
const repl = new Map();
for (const line of clientRaw.split('\n')) {
  if (!line) continue;
  let rec;
  try { rec = JSON.parse(line); } catch { continue; }
  if (rec.scrub?.username) repl.set(rec.scrub.username, '<TURN_USER>');
  if (rec.scrub?.turnHost) repl.set(rec.scrub.turnHost, '<VPS_IP>');
  if (rec.scrubMore?.mappedIp) repl.set(rec.scrubMore.mappedIp, '<HOME_IP>');
  if (rec.scrubMore?.localIp && rec.scrubMore.localIp !== '0.0.0.0') repl.set(rec.scrubMore.localIp, '<LAN_IP>');
}
if (![...repl.values()].includes('<VPS_IP>')) {
  console.error('未在客户端日志找到 meta.scrub.turnHost——原始档不完整，拒绝产出');
  process.exit(1);
}

// supabase host 一并脱敏（防御：正常不该出现）
try {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.p2p-net/config.json'), 'utf8'));
  const host = new URL(cfg.supabaseUrl).host;
  repl.set(host, '<SUPABASE_HOST>');
} catch { /* 取不到也不阻断 */ }

function scrub(text) {
  let out = text;
  // 长串优先，避免子串抢先
  for (const [from, to] of [...repl.entries()].sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(from).join(to);
  }
  // coturn journal 里会有本机 host 服务自己的其他 allocation（同 uid 后缀不同时间戳），
  // TURN username 统一形态 <epoch>:<uid8> 正则兜底全量脱敏
  out = out.replace(/\b\d{10}:[0-9a-f]{8}\b/g, '<TURN_USER>');
  // VPS 内网地址一并占位（纪律与公网同款，端口保留供关联）
  out = out.replace(/\b10\.2\.0\.10\b/g, '<VPS_LAN>');
  return out;
}

// 硬断言：秘密原文零命中才允许写出
const dir = join(homedir(), '.p2p-net');
const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
const auth = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
const forbidden = [
  ['accessToken', auth.accessToken],
  ['refreshToken', auth.refreshToken],
  ['publishableKey', cfg.publishableKey],
  ['tunnelSecret', cfg.tunnelSecret],
];

mkdirSync(OUTDIR, { recursive: true });
const clientOut = scrub(clientRaw);
const coturnOut = scrub(coturnRaw);
for (const [name, text] of [['client', clientOut], ['coturn', coturnOut]]) {
  for (const [label, secret] of forbidden) {
    if (secret && text.includes(secret)) {
      console.error(`硬断言失败：${name} 输出含 ${label} 原文——已阻断`);
      process.exit(1);
    }
  }
}

const clientPath = join(OUTDIR, `client-${TAG}.jsonl`);
const coturnPath = join(OUTDIR, `coturn-${TAG}.txt`);
writeFileSync(clientPath, clientOut);
writeFileSync(coturnPath, coturnOut);
console.log(`已产出 ${clientPath}（${clientOut.split('\n').length - 1} 行）`);
console.log(`已产出 ${coturnPath}（${coturnOut.split('\n').length - 1} 行）`);
