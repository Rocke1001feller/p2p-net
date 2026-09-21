// p2p-net 隧道中继 VPS 入口：Caddy 终结 TLS 后把 /tunnel/* 反代到 127.0.0.1:19700。
// 由 node-init/init-node.sh 安装到 /opt/p2p-net/，TUNNEL_SECRET 由 systemd Environment 注入。
import http from 'node:http';
import { createTunnelRelay } from 'p2p-net';

if (!process.env.TUNNEL_SECRET) {
  console.error('tunnel-relay: 错误：TUNNEL_SECRET 未设置（应由 systemd Environment 注入）');
  process.exit(1);
}

const server = http.createServer();
const relay = createTunnelRelay({ secret: process.env.TUNNEL_SECRET, server });
// createTunnelRelay 只在工厂内挂 upgrade；HTTP 请求处理须由入口接线（见 src/tunnel/relay.ts 头注）
server.on('request', relay.httpHandler);
server.listen(19700, '127.0.0.1', () => console.log('tunnel relay on 127.0.0.1:19700'));
