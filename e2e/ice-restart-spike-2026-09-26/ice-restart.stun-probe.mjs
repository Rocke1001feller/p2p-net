/** THROWAWAY — 手机浏览器 STUN 直达探针：CDP evaluate 收集 srflx/host 候选类型 */
import WebSocket from 'ws';
const [cdpPort, stun] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
let id = 0; const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const call = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const expr = `(async () => {
  const out = { cands: [], state: null, err: null };
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: '${stun}' }] });
    pc.onicecandidate = (e) => { if (e.candidate) out.cands.push(e.candidate.candidate.match(/ typ (\\S+)/)?.[1] ?? '?'); };
    pc.oniceconnectionstatechange = () => { out.state = pc.iceConnectionState; };
    pc.createDataChannel('x');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => setTimeout(r, 12000));
    out.gatherState = pc.iceGatheringState;
    pc.close();
  } catch (e) { out.err = String(e); }
  return JSON.stringify(out);
})()`;
const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 20000 });
console.log('PROBE', r.result?.value ?? JSON.stringify(r));
ws.close();
process.exit(0);
