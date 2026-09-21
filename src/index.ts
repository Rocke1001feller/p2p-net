/**
 * p2p-net — 自托管 WebRTC 数据面库（Node 入口 barrel）
 *
 * 双模数据面：WebRTC DataChannel 优先 + 反向隧道兜底。
 * 浏览器侧请走 `p2p-net/browser`（不含 werift 与本地桥）。
 * 端口契约见 contracts/ports.json（单一事实源）。
 */

export const P2P_NET_VERSION = '0.1.0';

export * from './signaling/protocol.js';
export * from './signaling/client.js';
export * from './frames.js';
export * from './status.js';
export * from './peer.js';
export * from './bridge/http.js';
export * from './bridge/ws.js';
export * from './bridge/guard.js';
export * from './host.js';
export * from './tunnel/client.js';
export * from './tunnel/relay.js';
