/**
 * THROWAWAY — W2-6 spike ②③ CDP 收割驱动：
 *   node scripts/spike/ice-restart.cdp-run.cjs <cdpPort> <url> <timeoutS> <out.jsonl> [new]
 * 连 CDP（http://127.0.0.1:<cdpPort>/json），取第一个 page 目标（传 "new" 则 /json/new 开新页），
 * Page.navigate → 轮询 window.__done → 收割 window.__log 落盘。
 * 依赖仓库 node_modules 的 ws（在仓库根执行）。
 */
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const [cdpPort, url, timeoutS, out, mode] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jsonFetch(path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${cdpPort}${path}`, { method });
  return res.json();
}

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const call = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, call };
}

const targets = await jsonFetch('/json');
let page = targets.find((t) => t.type === 'page');
if (mode === 'new' || !page) {
  try { page = await jsonFetch(`/json/new?${encodeURIComponent(url)}`, 'PUT'); }
  catch { page = await jsonFetch(`/json/new?${encodeURIComponent(url)}`); }
}
if (!page) throw new Error('no page target');

const { ws, call } = await attach(page.webSocketDebuggerUrl);
await call('Runtime.enable');
await call('Page.enable');
if (mode !== 'new' || !page.url?.includes(url)) await call('Page.navigate', { url });

const deadline = Date.now() + Number(timeoutS) * 1000;
let done = false; let logLen = 0;
const harvested = [];
while (Date.now() < deadline && !done) {
  await sleep(500);
  const r = await call('Runtime.evaluate', {
    expression: 'JSON.stringify({done: !!window.__done, len: (window.__log||[]).length})',
    returnByValue: true,
  }).catch(() => null);
  const v = r?.result?.value ? JSON.parse(r.result.value) : null;
  if (!v) continue;
  if (v.len > logLen) {
    const part = await call('Runtime.evaluate', {
      expression: `JSON.stringify(window.__log.slice(${logLen}))`, returnByValue: true,
    });
    for (const line of JSON.parse(part?.result?.value ?? '[]')) harvested.push(line);
    logLen = v.len;
  }
  done = v.done;
}
const finalPart = await call('Runtime.evaluate', {
  expression: `JSON.stringify((window.__log||[]).slice(${logLen}))`, returnByValue: true,
}).catch(() => null);
for (const line of JSON.parse(finalPart?.result?.value ?? '[]')) harvested.push(line);

writeFileSync(out, harvested.join('\n') + '\n');
console.log(`HARVEST done=${done} lines=${harvested.length} -> ${out}`);
for (const line of harvested) console.log(line);
ws.close();
process.exit(done ? 0 : 2);
