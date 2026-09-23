/**
 * 隧道资产缓存判定（2026-09-23 蜂窝浸泡事故整改）。
 *
 * 事故：中继模式每次会话重建（蜂窝 RTT 尖峰属常态）都整页重下 ~5.5MB 资产，
 * 1 Mbps 链路上 40s+ 白屏；重连越频繁→洪泛越频繁→链路越差，构成死亡螺旋。
 *
 * 修复口径：严格遵循上游 Cache-Control 语义——immutable 或 max-age ≥ 86400 的
 * 响应才可缓存（内容哈希资产天然 immutable）；no-store/no-cache（HTML、API）
 * 一律穿透。判定是纯函数，SW 里的 CacheStorage 接线保持最薄。
 */

/** SW 内 CacheStorage 的桶名（改名即全量作废旧缓存）。 */
export const ASSET_CACHE_NAME = 'p2p-net-assets-v1';

/** 该 Cache-Control 头对应的响应是否允许进隧道资产缓存。 */
export function shouldCacheResponse(cacheControl: string | null): boolean {
  if (!cacheControl) return false;
  const cc = cacheControl.toLowerCase();
  if (cc.includes('no-store') || cc.includes('no-cache')) return false;
  if (cc.includes('immutable')) return true;
  const m = cc.match(/max-age\s*=\s*(\d+)/);
  if (!m) return false;
  return Number(m[1]) >= 86_400;
}
