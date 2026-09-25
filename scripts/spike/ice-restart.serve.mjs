/**
 * THROWAWAY — W2-6 spike ②③ 一体伺服：静态页 + WS 信令(/sig) + werift 应答方。
 *   node scripts/spike/ice-restart.serve.mjs [port]
 * TURN 临时凭据从 /tmp/w26-turn-cred.txt 读（"username credential" 一行，1h TTL；
 * 凭据只经 /tmp 0600 文件与内存流转，不进 argv/日志/落盘工件）。
 *
 * 信令协议（JSON over ws /sig，完整 gather 后整 SDP 交换，不 trickle）：
 *   浏览器 → {offer, sdp}  → 服务端 werift peer setRemote → createAnswer → {answer, sdp}
 *   每次新 ws 连接重置一个全新 peer（支持多次重跑）。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { RTCPeerConnection } from 'werift';

const port = Number(process.argv[2] ?? 8888);
const [turnUser, turnCred] = readFileSync('/tmp/w26-turn-cred.txt', 'utf8').trim().split(/\s+/);
if (!turnUser || !turnCred) throw new Error('missing /tmp/w26-turn-cred.txt');

const TURN_HOST = '49.233.155.13:3478';
const peerIce = [
  { urls: `turn:${TURN_HOST}`, username: turnUser, credential: turnCred },
  { urls: `stun:${TURN_HOST}` },
];
// 注入页面的 ICE（turn 凭据只在运行时内存/被服页面，不写入任何落盘工件）
const pageIceJson = JSON.stringify({
  turn: { urls: [`turn:${TURN_HOST}`], username: turnUser, credential: turnCred },
  stun: { urls: `stun:${TURN_HOST}` },
});

const htmlTemplate = readFileSync(new URL('./ice-restart.browser.html', import.meta.url), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitGatherComplete(pc, ms = 15000) {
  const t0 = Date.now();
  while (pc.iceGatheringState !== 'complete' && Date.now() - t0 < ms) await sleep(100);
}

const server = createServer((req, res) => {
  const html = htmlTemplate.replace('"__ICE__"', pageIceJson);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.endsWith('/sig')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wirePeer(ws));
});

async function wirePeer(ws) {
  const tag = `[peer ${new Date().toISOString().slice(11, 19)}]`;
  const pc = new RTCPeerConnection({ iceServers: peerIce });
  pc.ondatachannel = (ev) => {
    ev.channel.onmessage = (m) => ev.channel.send(m.data);
  };
  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.offer) {
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: m.offer });
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        await waitGatherComplete(pc);
        ws.send(JSON.stringify({ answer: pc.localDescription.sdp }));
        console.log(`${tag} answered (ufrag=${pc.localDescription.sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1]})`);
      } catch (err) {
        console.error(`${tag} offer handling error`, err);
        try { ws.send(JSON.stringify({ error: String(err) })); } catch { /* closed */ }
      }
    }
  });
  ws.on('close', () => { try { pc.close(); } catch { /* noop */ } });
  console.log(`${tag} browser attached, peer ready`);
}

server.listen(port, '0.0.0.0', () => console.log(`spike server on :${port} (page=/ sig=/sig)`));
