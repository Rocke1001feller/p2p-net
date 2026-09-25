/**
 * NAT facts（Wave 2 W2-2）单一事实源：schema + 判定表 + 紧凑串序列化。
 * 纯模块，零 Node 依赖——浏览器经 ./browser 具名导出复用（PWA 采集器产出原始观测，
 * 判定调同一个 judgeMappingConsistency，机制甲纪律：跨端共享语义不建孪生）。
 * host 采集器在 natfactsHost.ts（node:dgram，仅 Node，不进 browser barrel）；
 * web 采集器在 pwa/src/natfacts-web.ts（RTCPeerConnection）。两侧采集器不同属正当边界
 * （浏览器无法 raw STUN），但 facts 语义相同。
 *
 * 事件纪律：formatNatFacts 只输出聚合语义（mapping/servers），srflx 的 ip/port 绝不进串
 * （隐私与 events.ts:15 同款纪律——token/secret/URL/探测到的公网地址不进事件）。
 */

/** 跨服务器映射一致性：同本地端点对不同目标得到同一映射 = endpoint-independent（RFC 5780 语义）。 */
export type MappingConsistency = 'endpoint-independent' | 'endpoint-dependent' | 'unknown';

export interface NatFacts {
  /** 任一服务器拿到 srflx 映射 = true；全阻/对称到无响应 = false。 */
  hasSrflx: boolean;
  /** 同服务器两轮 binding 的映射端口时域稳定性；无可比对观测 = null。 */
  srflxPortStable: boolean | null;
  /** 跨服务器映射一致性；有效观测 <2 台服务器 = 'unknown'（如只配 1 台 relay）。 */
  mappingConsistency: MappingConsistency;
  /** 成功应答（给出 srflx 观测）的服务器数；0 = 全部超时/不可达。 */
  servers: number;
}

/** srflx 观测（NAT 映射出的公网 ip:port）。仅采集期内存使用，禁止进事件/日志。 */
export interface SrflxObservation {
  ip: string;
  port: number;
}

/**
 * 判定表：观测须为同本地端点跨不同服务器的 srflx 映射（采集器保证口径）。
 * <2 观测 → unknown；全部相同 → endpoint-independent；任一不同（port 或 ip 变）→ endpoint-dependent。
 */
export function judgeMappingConsistency(obs: SrflxObservation[]): MappingConsistency {
  if (obs.length < 2) return 'unknown';
  const first = obs[0]!;
  return obs.every((o) => o.ip === first.ip && o.port === first.port) ? 'endpoint-independent' : 'endpoint-dependent';
}

const MAPPING_SHORT: Record<MappingConsistency, string> = {
  'endpoint-independent': 'ep-ind',
  'endpoint-dependent': 'ep-dep',
  unknown: 'unknown',
};

/** 事件流用紧凑串（如 `m:ep-ind,servers:2`）：只带聚合语义，绝无 ip/port。 */
export function formatNatFacts(f: NatFacts): string {
  return `m:${MAPPING_SHORT[f.mappingConsistency]},servers:${f.servers}`;
}
