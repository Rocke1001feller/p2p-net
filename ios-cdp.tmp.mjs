#!/usr/bin/env node
/**
 * iPhone Safari CDP 迷你驱动（双机实测战役用，经 ios-webkit-debug-proxy / pymobiledevice3）。
 * 用法：
 *   node /tmp/ios-cdp.mjs targets                      # 列出可调试页面
 *   node /tmp/ios-cdp.mjs eval '<js 表达式>'            # 在 PWA 页执行并打印 JSON 结果
 *   node /tmp/ios-cdp.mjs eval '<js>' --url 子串         # 指定目标页（默认取含 49.233.155.13 的页）
 *   node /tmp/ios-cdp.mjs nav '<url>'                  # 导航目标页
 * 依赖仓库 node_modules 的 ws（在仓库根执行）。
 */
import WebSocket from 'ws';

const [cmd, ...rest] = process.argv.slice(2);
const CDP_HTTP = process.env.IOS_CDP_HTTP ?? 'http://127.0.0.1:9222';
const urlFlag = rest.indexOf('--url');
const urlNeedle = urlFlag >= 0 ? rest[urlFlag + 1] : '49.233.155.13';
const arg = urlFlag >= 0 ? rest.filter((_, i) => i !== urlFlag && i !== urlFlag + 1).join(' ') : rest.join(' ');

async function listTargets() {
  const res = await fetch(`${CDP_HTTP}/json`);
  return res.json();
}

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  });
  const call = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, call, events };
}

async function pickPage() {
  const targets = await listTargets();
  const pages = targets.filter((t) => t.type === 'page' || t.webSocketDebuggerUrl);
  const hit = pages.find((t) => (t.url ?? '').includes(urlNeedle)) ?? pages[0];
  if (!hit) throw new Error(`无可调试页面（targets=${targets.length}）`);
  return hit;
}

if (cmd === 'targets') {
  const t = await listTargets();
  console.log(JSON.stringify(t.map((x) => ({ id: x.id, type: x.type, title: x.title, url: x.url })), null, 1));
  process.exit(0);
}

const page = await pickPage();
const { ws, call } = await attach(page.webSocketDebuggerUrl);
await call('Runtime.enable');

if (cmd === 'nav') {
  await call('Page.enable');
  await call('Page.navigate', { url: arg });
  await new Promise((r) => setTimeout(r, 3000));
  const r = await call('Runtime.evaluate', { expression: 'location.href + " | " + document.title', returnByValue: true });
  console.log(JSON.stringify(r.result.value));
} else if (cmd === 'eval') {
  const r = await call('Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) console.log(JSON.stringify({ EXCEPTION: r.exceptionDetails.text, detail: r.exceptionDetails.exception?.description }, null, 1));
  else console.log(JSON.stringify(r.result.value ?? r.result, null, 1));
} else {
  console.error('未知命令：' + cmd);
  process.exit(2);
}
ws.close();
process.exit(0);
