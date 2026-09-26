/**
 * 静态产品常量（非后端配置——后端配置一律走 config.ts 的 loadRuntimeConfig）。
 *
 * 端口契约无副本：DISCOVERY_PORT / STUN_PORT 的值经包内 browser 入口直取
 * contracts/ports.json（单一事实源，vite 构建期内联，tsx 测试期直读）。
 * 禁止在此回填端口字面量——parity 门禁见本目录 constants.test.ts
 * 「端口契约 parity」测试（回填即红）。
 */
import { PORTS } from 'p2p-net/browser';

/** 桌面 daemon 服务发现端口（contracts/ports.json: DISCOVERY_PORT）。 */
export const DISCOVERY_PORT = PORTS.DISCOVERY_PORT;

/** 自建 coturn 的 STUN 端口（contracts/ports.json: STUN_PORT；VPS 安全组需放行该端口 tcp+udp）。 */
export const STUN_PORT = PORTS.STUN_PORT;

/** 本端持久化键（uid / 本机 deviceId / 上次连接的桌面 deviceId）。 */
export const LS_UID = 'p2p-net.pwa.uid';
export const LS_DEVICE_ID = 'p2p-net.pwa.deviceId';
export const LS_DESK_ID = 'p2p-net.pwa.deskId';

/** 记住的桌面设备列表键（本机记忆；服务器侧设备心跳表为后续增强）。 */
export const LS_DEVICES = 'p2p-net.pwa.devices';

/** 接入类型手动标注键（Wave 2 W2-1）：「我的」tab select 写入；offer meta.access 优先取它。 */
export const LS_ACCESS = 'p2p-net.pwa.access';

/** 本机设备标签键（2026-09-26 双机撞车根修）：ensureHostLabel 首调生成后持久；
 *  bind_device_auth 幂等键 (user_id, role, hostname) 靠它区分同账号多台手机。 */
export const LS_HOST_LABEL = 'p2p-net.pwa.hostLabel';

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
