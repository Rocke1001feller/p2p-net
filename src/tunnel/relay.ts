/**
 * 反向隧道中继（Node only，依赖 `ws` 包）—— 兜底数据面的 relay-bj 侧常驻进程核心。
 *
 * 部署形态（plan Task 11；部署动作归主会话，此处给足复用信息）：
 * - relay 只做纯转发不解析 body：桌面主动出站 `wss://<host>/tunnel/desktop?sid=<uuid>&token=<hex>`
 *   （token = HMAC-SHA256(secret, sid) hex，secret 由 systemd Environment=TUNNEL_SECRET 注入，
 *   不进仓库、Caddy 不感知）；relay 为每个 sid 暴露公网入口 `https://<host>/tunnel/s/<sid>/*`。
 * - Caddy 终结 TLS 后把 `/tunnel/*` 反代到本进程（127.0.0.1:19700，http+ws 均走同一端口）：
 *     example.com {
 *       handle /tunnel/* { reverse_proxy 127.0.0.1:19700 }
 *       # …其余站点（PWA 静态等）
 *     }
 * - systemd 常驻（片段）：
 *     [Unit]
 *     Description=p2p-net tunnel relay
 *     After=network.target
 *     [Service]
 *     ExecStart=/usr/bin/node /opt/p2p-net/tunnel-relay.mjs
 *     Environment=TUNNEL_SECRET=<openssl rand -hex 32>
 *     Restart=always
 *     RestartSec=2
 *     User=p2pnet
 *     NoNewPrivileges=true
 *     [Install]
 *     WantedBy=multi-user.target
 *   启动器（tunnel-relay.mjs）极薄：http.createServer(relay.httpHandler) + createTunnelRelay({secret, server})
 *   + server.listen(19700, '127.0.0.1')——本模块自身不带 listen，便于集成测与部署复用。
 *
 * 语义（plan Task 11 Interfaces，逐条对齐）：
 * - 桌面侧入站 upgrade `/tunnel/desktop?sid=&token=`：token 时序安全比对；通过 → 记入内存
 *   `desktops: Map<sid, WebSocket>`；重复 sid 顶旧（旧连接关闭、其在途请求 502、其代理 WS 全关）。
 * - PWA/公网侧普通 HTTP `/tunnel/s/<sid>/<path…>` → `req` 帧
 *   `{k:'req', id, port:0, method, path:'/'+path+search, headers, bodyB64, via:'tunnel'}`
 *   发往该 sid 的桌面 WS；`res-head` 按 status/headers 起响应、`res-chunk` 顺序回写、done 帧终结；
 *   30s 未收到任何响应（res-head）→ 504（超时起点为请求派发；头到达即计时结束，
 *   长流式响应如 SSE 不受 30s 限制——隧道模式绕过 PWA SW，relay 是唯一超时持有者）。
 * - PWA 侧 WS upgrade `/tunnel/s/<sid>/<path>?<search>` → 分配 relay 内部 wid → `ws-open` 帧代理到桌面
 *   （path = sid 前缀之后的部分 + search）；PWA→桌面的 ws-msg 在 ws-open-ok 到达前先缓冲再冲刷
 *   （保证 ws-open 先于 ws-msg 到达桌面，消除 101 与桌面本地连接建立的竞态）；reply 反向按 wid 路由。
 * - 桌面断开 → 其全部在途 HTTP 回 502、代理 WS 全关（1011）；同 sid 重新上线自动恢复后续请求
 *   （不重放在途请求——PWA 侧重试语义归浏览器）。
 */
import crypto from 'node:crypto';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  decodeFrame,
  isResChunk,
  isResHead,
  isWsClose,
  isWsMsg,
  isWsOpenErr,
  isWsOpenOk,
  type ReqFrame,
} from '../frames.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface TunnelRelayOptions {
  secret: string;
  /** 既有 http.Server：提供即在工厂内挂 `server.on('upgrade', relay.handleUpgrade)`。 */
  server: http.Server;
  /** 请求派发后未收到 res-head 的超时；默认 30_000ms（504）。 */
  requestTimeoutMs?: number;
}

export interface TunnelRelay {
  /** 挂到 http.createServer 的请求处理函数：只认 /tunnel/s/<sid>/*，其余 404。 */
  httpHandler(req: http.IncomingMessage, res: http.ServerResponse): void;
  /** 挂到 server.on('upgrade') 的升级处理（工厂已自动挂，导出仅为复用/测试便利）。 */
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void;
  /** sid → 桌面出站 WebSocket（运维/测试观测面）。 */
  desktops: Map<string, WebSocket>;
  /** 终止全部桌面连接与代理 WS（测试收尾/systemd 重启前调用；不等 close 握手）。 */
  close(): void;
}

interface PendingRes {
  res: http.ServerResponse;
  headSent: boolean;
  timer: NodeJS.Timeout;
}

interface WsProxy {
  ws: WebSocket;
  /** ws-open-ok 到达前 PWA→桌面的消息在此缓冲（见文件头竞态说明）。 */
  open: boolean;
  buffer: { text?: string; dataB64?: string }[];
}

interface Session {
  ws: WebSocket;
  pend: Map<number, PendingRes>;
  wsProxies: Map<number, WsProxy>;
}

export function createTunnelRelay(opts: TunnelRelayOptions): TunnelRelay {
  const { secret } = opts;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const wss = new WebSocketServer({ noServer: true });
  const desktops = new Map<string, WebSocket>();
  const sessions = new Map<string, Session>();
  let reqSeq = 0;
  let wsSeq = 0;

  const tokenOk = (sid: string, token: string): boolean => {
    const expect = crypto.createHmac('sha256', secret).update(sid).digest('hex');
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(expect, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const sendToDesktop = (session: Session, frame: object): void => {
    if (session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(frame));
  };

  /** 在途请求清场：头未发出 → 502/504 状态兜底；头已发出 → 干净截断。 */
  const failPend = (session: Session, status: number): void => {
    for (const [, p] of session.pend) {
      clearTimeout(p.timer);
      if (!p.headSent) {
        p.res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
        p.res.end(status === 504 ? 'tunnel timeout' : 'desktop offline');
      } else {
        p.res.end();
      }
    }
    session.pend.clear();
  };

  const closeWsProxies = (session: Session): void => {
    for (const [, proxy] of session.wsProxies) {
      try { proxy.ws.close(1011, 'tunnel: desktop offline'); } catch { /* 已关闭 */ }
    }
    session.wsProxies.clear();
  };

  const teardown = (session: Session): void => {
    failPend(session, 502);
    closeWsProxies(session);
    try { session.ws.terminate(); } catch { /* 已关闭 */ }
  };

  const registerDesktop = (sid: string, ws: WebSocket): void => {
    const prev = sessions.get(sid);
    if (prev) {
      // 重复 sid 顶旧：旧连接清场（502 在途、关代理 WS、断旧 socket）
      teardown(prev);
      desktops.delete(sid);
    }
    const session: Session = { ws, pend: new Map(), wsProxies: new Map() };
    sessions.set(sid, session);
    desktops.set(sid, ws);

    ws.on('message', (data: Buffer) => {
      const frame = decodeFrame(data);
      if (!frame || typeof frame !== 'object') return;

      if (isResHead(frame)) {
        const p = session.pend.get(frame.id);
        if (!p || p.headSent) return;
        clearTimeout(p.timer);
        // enc 帧字段 → HTTP content-encoding：gzip 字节过 HTTP 的协议义务。缺了它浏览器不自动解压，
        // 应用层 JSON.parse 乱码（2026-09-25 iPhone 隧道腿 Chats/Files 空返回根因）。
        p.res.writeHead(frame.status, frame.enc ? { ...frame.headers, 'content-encoding': frame.enc } : frame.headers);
        p.headSent = true;
        return;
      }
      if (isResChunk(frame)) {
        const p = session.pend.get(frame.id);
        if (!p || !p.headSent) return; // 头前到块（协议违序）：丢弃
        if (frame.dataB64 !== undefined) p.res.write(Buffer.from(frame.dataB64, 'base64'));
        if (frame.done) {
          session.pend.delete(frame.id);
          p.res.end();
        }
        return;
      }
      if (isWsOpenOk(frame) || isWsOpenErr(frame)) {
        const proxy = session.wsProxies.get(frame.wid);
        if (!proxy) return;
        if (isWsOpenOk(frame)) {
          proxy.open = true;
          for (const msg of proxy.buffer.splice(0)) sendToDesktop(session, { k: 'ws-msg', wid: frame.wid, ...msg });
        } else {
          session.wsProxies.delete(frame.wid);
          try { proxy.ws.close(1011, 'tunnel: desktop ws-open-err'); } catch { /* 已关闭 */ }
        }
        return;
      }
      if (isWsMsg(frame)) {
        const proxy = session.wsProxies.get(frame.wid);
        if (!proxy) return;
        if (frame.text !== undefined) proxy.ws.send(frame.text);
        else if (frame.dataB64 !== undefined) proxy.ws.send(Buffer.from(frame.dataB64, 'base64'));
        return;
      }
      if (isWsClose(frame)) {
        const proxy = session.wsProxies.get(frame.wid);
        if (!proxy) return;
        session.wsProxies.delete(frame.wid);
        try { proxy.ws.close(frame.code, frame.reason); } catch { /* 已关闭 */ }
        return;
      }
      // ping/pong 帧与其余未知帧：relay 纯转发不消费
    });
    ws.on('close', () => {
      if (desktops.get(sid) !== ws) return; // 已被新连接顶旧，清场归顶旧者
      sessions.delete(sid);
      desktops.delete(sid);
      failPend(session, 502);
      closeWsProxies(session);
    });
    ws.on('error', () => { /* close 事件随后必到，统一在 close 清场 */ });
  };

  const proxyWs = (session: Session, ws: WebSocket, pathWithQuery: string): void => {
    const wid = ++wsSeq;
    const proxy: WsProxy = { ws, open: false, buffer: [] };
    session.wsProxies.set(wid, proxy);
    sendToDesktop(session, { k: 'ws-open', wid, path: pathWithQuery });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const msg = isBinary ? { dataB64: data.toString('base64') } : { text: data.toString('utf8') };
      if (!proxy.open) { proxy.buffer.push(msg); return; }
      sendToDesktop(session, { k: 'ws-msg', wid, ...msg });
    });
    ws.on('close', (code: number, reason: Buffer) => {
      if (session.wsProxies.get(wid) !== proxy) return;
      session.wsProxies.delete(wid);
      sendToDesktop(session, { k: 'ws-close', wid, code, reason: reason.toString('utf8') });
    });
    ws.on('error', () => { /* close 事件随后必到 */ });
  };

  const handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    let u: URL;
    try {
      u = new URL(req.url ?? '', 'http://relay.invalid');
    } catch {
      socket.destroy();
      return;
    }
    if (u.pathname === '/tunnel/desktop') {
      const sid = u.searchParams.get('sid') ?? '';
      const token = u.searchParams.get('token') ?? '';
      if (sid && tokenOk(sid, token)) {
        wss.handleUpgrade(req, socket, head, (ws) => registerDesktop(sid, ws));
      } else {
        socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      }
      return;
    }
    const m = u.pathname.match(/^\/tunnel\/s\/([^/]+)(\/.*)?$/);
    if (m) {
      const session = sessions.get(m[1]);
      if (!session || session.ws.readyState !== WebSocket.OPEN) {
        socket.destroy();
        return;
      }
      const rest = m[2] ?? '/';
      wss.handleUpgrade(req, socket, head, (ws) => proxyWs(session, ws, rest + u.search));
      return;
    }
    socket.destroy();
  };

  const httpHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    let u: URL;
    try {
      u = new URL(req.url ?? '', 'http://relay.invalid');
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const m = u.pathname.match(/^\/tunnel\/s\/([^/]+)(\/.*)?$/);
    if (!m) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const sid = m[1];
    const path = (m[2] ?? '/') + u.search;
    const session = sessions.get(sid);
    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('desktop offline');
      return;
    }
    const id = ++reqSeq;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const pend: PendingRes = {
        res,
        headSent: false,
        timer: setTimeout(() => {
          session.pend.delete(id);
          if (!pend.headSent) {
            res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('tunnel timeout');
          } else {
            res.end();
          }
        }, requestTimeoutMs),
      };
      pend.timer.unref?.();
      session.pend.set(id, pend);
      const frame: ReqFrame = {
        k: 'req',
        id,
        port: 0,
        method: req.method ?? 'GET',
        path,
        headers,
        bodyB64: Buffer.concat(chunks).toString('base64'),
        via: 'tunnel',
      };
      sendToDesktop(session, frame);
    });
  };

  // 挂到既有 server：upgrade 在工厂内注册，请求处理经 httpHandler 由调用方在 createServer 时接线
  opts.server.on('upgrade', handleUpgrade);

  return {
    httpHandler,
    handleUpgrade,
    desktops,
    close(): void {
      for (const [, session] of sessions) teardown(session);
      sessions.clear();
      desktops.clear();
      for (const ws of wss.clients) ws.terminate();
    },
  };
}
