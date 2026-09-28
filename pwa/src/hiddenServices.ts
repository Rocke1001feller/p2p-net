/** 隐藏服务清单（P1 减法模型）：按 deviceId 分键持久化，换机不串。
 *  隐私模式/写不进一律静默，沿用 consolePick 的 PickStorage 风格。 */
import { LS_HIDDEN_SERVICES } from './constants.js';
import type { PickStorage } from './consolePick.js';

type HiddenMap = Record<string, number[]>;

function readMap(storage: PickStorage): HiddenMap {
  try {
    const raw: unknown = JSON.parse(storage.getItem(LS_HIDDEN_SERVICES) ?? '{}');
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: HiddenMap = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!Array.isArray(v)) continue;
      const ports = v.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (ports.length) out[k] = ports;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(storage: PickStorage, map: HiddenMap): void {
  try {
    storage.setItem(LS_HIDDEN_SERVICES, JSON.stringify(map));
  } catch {
    /* 写不进（隐私模式等）静默：本次会话内仍生效于调用方内存，不落盘 */
  }
}

export function readHidden(storage: PickStorage, deviceId: string): number[] {
  return readMap(storage)[deviceId] ?? [];
}

export function hideService(storage: PickStorage, deviceId: string, port: number): void {
  const map = readMap(storage);
  const list = map[deviceId] ?? [];
  if (!list.includes(port)) list.push(port);
  map[deviceId] = list;
  writeMap(storage, map);
}

export function unhideService(storage: PickStorage, deviceId: string, port: number): void {
  const map = readMap(storage);
  const list = map[deviceId];
  if (!list) return;
  const next = list.filter((p) => p !== port);
  if (next.length) map[deviceId] = next;
  else delete map[deviceId];
  writeMap(storage, map);
}
