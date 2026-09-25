/**
 * 浏览器入口 barrel：只含信令/帧协议/状态灯映射（纯 JS，无 werift / 无 Node 桥）。
 * PWA shell（offerer）用原生 RTCPeerConnection + 本 barrel 的信令与协议模块。
 * 集成断言：dist/browser.js 文本不得包含 'werift'（src/tests/browser-entry.test.ts）。
 */
export * from './signaling/protocol.js';
export {
  SignalingClient,
  type SignalingClientOptions,
  type SigRow,
  type PollResult,
  type FetchLike,
} from './signaling/client.js';
export * from './frames.js';
export * from './pool.js';
export * from './status.js';
export { PORTS, type PortContract } from './ports.js';
