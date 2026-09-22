/**
 * 静态产品常量（非后端配置——后端配置一律走 config.ts 的 loadRuntimeConfig）。
 *
 * 端口契约对齐根仓 contracts/ports.json（DISCOVERY_PORT=19728）；PWA 由 vite 独立构建、
 * 跑在浏览器里，无法 import 根仓 src/contracts.ts（它 readFileSync，非浏览器安全），
 * 故此处保留一份副本——改根仓 ports.json 时必须同步本文件。
 */

/** 桌面 daemon 服务发现端口（contracts/ports.json: DISCOVERY_PORT）。 */
export const DISCOVERY_PORT = 19728;

/** 自建 coturn 的 STUN 端口（VPS init 侧契约；安全组放行 3478 tcp+udp）。 */
export const STUN_PORT = 3478;

/** 本端持久化键（uid / 本机 deviceId / 上次连接的桌面 deviceId）。 */
export const LS_UID = 'p2p-net.pwa.uid';
export const LS_DEVICE_ID = 'p2p-net.pwa.deviceId';
export const LS_DESK_ID = 'p2p-net.pwa.deskId';

/** 记住的桌面设备列表键（本机记忆；服务器侧设备心跳表为后续增强）。 */
export const LS_DEVICES = 'p2p-net.pwa.devices';

/** 级联超时（顺序：P2P 直连 → 反向隧道 → TURN；relay 仅兜底控成本）。 */
export const CASCADE_TIMEOUT_MS = { p2p: 10_000, p2pFull: 15_000, tunnel: 6_000, turn: 15_000 } as const;

/**
 * 由运行时配置的 relays 推导 STUN 服务器（仅用于 P2P 直连尝试段；TURN 凭据段由
 * turn-credentials 下发）。relays[].url 是 relay 的 HTTPS 入口（如 https://1.2.3.4），
 * STUN 打同一台机器的 coturn 端口。谷歌公共 STUN 在国内不可靠，故只用自建 relay。
 */
export function stunServersFromRelays(relays: { url: string }[]): RTCIceServer[] {
  const urls: string[] = [];
  for (const r of relays) {
    try {
      urls.push(`stun:${new URL(r.url).hostname}:${STUN_PORT}`);
    } catch { /* 非法 relay url 由 loadRuntimeConfig 校验拦截；此处防御性跳过 */ }
  }
  return urls.length ? [{ urls }] : [];
}

/**
 * tunnelUrl 形态闸门：`https?://<host>/tunnel/s/<sid>`。配对数据在扫码/粘贴/投递链路可能被
 * 截断或损坏（2026-09-22 真机实锤：localStorage 存进含 U+FFFD 的脏串，隧道探针打到 SPA 回退页，
 * 报出误导性 JSON 错误且静默丧失兜底能力）。入口只认此形态，脏值一律拒绝并由上层提示重新配对。
 */
export function isPlausibleTunnelUrl(u: string): boolean {
  return /^https?:\/\/[^\s/]+\/tunnel\/s\/[^\s/]+\/?$/.test(u);
}
