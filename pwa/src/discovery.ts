/**
 * 服务发现端口的选择逻辑（纯函数，单测友好，无 DOM/网络）。
 *
 * 设计立场（历史教训平移）：端口**不靠猜**，而是两级事实来源：
 *   ① 本次 URL 的 `?dsc=`（配对二维码刚给的新鲜事实，最可信）/ 该设备上次成功的端口记忆
 *   ② 契约端口（contracts/ports.json: DISCOVERY_PORT=19728，见 constants.ts）
 *   顺序之外的任何"硬编码假设"都是 bug。
 */
import { DISCOVERY_PORT } from './constants.js';

/** 去重 + 合法性过滤（端口必须是 1..65535 的整数）。 */
function normalize(list: (number | string | null | undefined)[]): number[] {
  const out: number[] = [];
  for (const raw of list) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * 探测候选（按可信度降序）：
 *   preferred（URL dsc / 设备记忆） → 契约 19728
 */
export function discoveryCandidates(preferred?: number | string | null): number[] {
  return normalize([preferred, DISCOVERY_PORT]);
}

/**
 * 选定"首选探测端口"（不存在则回落到契约端口）。
 * 真正的多端口兜底在 fetchServices 里按 discoveryCandidates 逐个试。
 */
export function pickDiscoveryPort(
  fromUrl: string | null | undefined,
  fromDevice?: number | null,
): number {
  return normalize([fromUrl, fromDevice, DISCOVERY_PORT])[0] ?? DISCOVERY_PORT;
}
