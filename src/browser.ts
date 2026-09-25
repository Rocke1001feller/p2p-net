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
// pathType（spec D9）：PathType 类型 + classifyCandidateType/classifyVia/selectedPairStats。
// selectedPairStats 为双形态判据（werift state/nominated；浏览器 selected===true 优先），
// PWA 帧账本（pwa/src/frameLedger.ts）直接复用——孪生副本已于 2026-09-25 消灭（机制甲1）。
export {
  classifyCandidateType,
  classifyVia,
  selectedPairStats,
  type PathType,
} from './pathType.js';
// NAT facts（Wave 2 W2-2）：schema/判定表/紧凑串单一事实源（natfacts.ts 纯模块零 Node 依赖）。
// 具名导出，不得 export *——host 采集器在 natfactsHost.ts（node:dgram），严禁进本 barrel
// （dgram 进不了浏览器 bundle；browser-entry 门禁已加 natfactsHost 断言）。
export {
  formatNatFacts,
  judgeMappingConsistency,
  type MappingConsistency,
  type NatFacts,
  type SrflxObservation,
} from './natfacts.js';
