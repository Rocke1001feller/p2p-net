/** 服务清单快照（2026-09-28 多设备侧栏树前置）：每连上一台设备就把它的活清单落盘，
 *  侧栏树借此渲染「全部设备 × 各自服务」——未连接设备没有数据通道，快照是它唯一可知的服务面。
 *  隐私模式/写不进一律静默（沿用 hiddenServices 的 PickStorage 纪律）。 */
import { LS_SERVICE_SNAPSHOTS } from './constants.js';
import type { PickStorage } from './consolePick.js';

export interface ServiceSnapshot {
  at: number;
  services: { name: string; port: number }[];
}
type SnapshotMap = Record<string, ServiceSnapshot>;

/** 快照只作展示，上限与设备清单同口径（SavedDevice 最多 12 台）。 */
const MAX_SNAPSHOTS = 12;

export function readSnapshots(storage: PickStorage): SnapshotMap {
  try {
    const raw: unknown = JSON.parse(storage.getItem(LS_SERVICE_SNAPSHOTS) ?? '{}');
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: SnapshotMap = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== 'object' || v === null) continue;
      const sv = v as Partial<ServiceSnapshot>;
      if (!Array.isArray(sv.services)) continue;
      const services = sv.services
        .filter((s): s is { name: string; port: number } =>
          typeof s === 'object' && s !== null
          && typeof (s as { name?: unknown }).name === 'string'
          && Number.isInteger((s as { port?: unknown }).port) && (s as { port: number }).port > 0)
        .map((s) => ({ name: s.name, port: s.port }));
      if (!services.length) continue;
      out[k] = { at: typeof sv.at === 'number' ? sv.at : 0, services };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSnapshot(storage: PickStorage, deviceId: string, services: { name: string; port: number }[]): void {
  if (!deviceId || !services.length) return; // 空清单不覆盖旧快照——服务全灭时侧栏仍有上次所见
  try {
    const map = readSnapshots(storage);
    map[deviceId] = { at: Date.now(), services: services.map((s) => ({ name: s.name, port: s.port })) };
    const keys = Object.keys(map);
    if (keys.length > MAX_SNAPSHOTS) {
      keys.sort((a, b) => (map[a].at) - (map[b].at));
      for (const k of keys.slice(0, keys.length - MAX_SNAPSHOTS)) delete map[k];
    }
    storage.setItem(LS_SERVICE_SNAPSHOTS, JSON.stringify(map));
  } catch {
    /* 写不进静默：本次会话内内存模型仍生效 */
  }
}
