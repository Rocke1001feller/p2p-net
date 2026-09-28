/** 侧栏服务树纯模型（P1 多服务工作台）：把「清单 + 隐藏 + console + 选中 + 已打开」
 *  算成三段行——visible（可见可点）/ hidden（用户减法，可恢复）/ gone（曾打开现已消失，灰显）。
 *  规则（spec §4.1/§4.3）：
 *  - consolePort 在 hidden 里被忽略（console 不可隐藏）；
 *  - gone = openPorts − services 差集，不论 hidden（消失是事实展示，不是替用户做减法）；
 *  - 三段各自保持 services 原始顺序（gone 段按 openPorts 顺序）。 */
export interface ServiceRow {
  port: number;
  name: string;
  url?: string;
  isConsole: boolean;
  isSelected: boolean;
  isGone: boolean;
}

export function buildServiceTree(opts: {
  services: { name: string; port: number; url?: string }[];
  hidden: number[];
  consolePort: number | null;
  selectedPort: number | null;
  openPorts: number[];
}): { visible: ServiceRow[]; hidden: ServiceRow[]; gone: ServiceRow[] } {
  const { services, hidden, consolePort, selectedPort, openPorts } = opts;
  const row = (s: { name: string; port: number; url?: string }, isGone: boolean): ServiceRow => ({
    port: s.port,
    name: s.name,
    url: s.url,
    isConsole: s.port === consolePort,
    isSelected: s.port === selectedPort,
    isGone,
  });
  const hiddenSet = new Set(hidden.filter((p) => p !== consolePort));
  const inList = new Set(services.map((s) => s.port));
  const visible: ServiceRow[] = [];
  const hiddenRows: ServiceRow[] = [];
  for (const s of services) {
    (hiddenSet.has(s.port) ? hiddenRows : visible).push(row(s, false));
  }
  const gone = openPorts.filter((p) => !inList.has(p)).map((p) => row({ name: `端口 ${p}`, port: p }, true));
  return { visible, hidden: hiddenRows, gone };
}

/** 多设备分组（2026-09-28）：侧栏树渲染「全部设备 × 各自服务」。
 *  - 已连接组：活清单，复用 buildServiceTree 全部语义（console/selected/gone/hidden）；
 *  - 其余组：本机快照建行（isConsole/isSelected/isGone 恒 false，无 gone 段——消失语义只在活通道上有意义）；
 *  - 无快照且未连接的设备也给空组，渲染层负责提示「点我连入」；
 *  - 排序：在线组第一，其余按设备 lastAt 降序。 */
export interface DeviceGroup {
  deviceId: string;
  name: string;
  online: boolean;
  snapAt?: number;
  visible: ServiceRow[];
  hidden: ServiceRow[];
  gone: ServiceRow[];
}

export function buildDeviceGroups(opts: {
  devices: { id: string; name: string; lastAt: number }[];
  connectedId: string | null;
  live: { name: string; port: number; url?: string }[];
  snapshots: Record<string, { at: number; services: { name: string; port: number }[] }>;
  hiddenOf: (deviceId: string) => number[];
  consolePort: number | null;
  selectedPort: number | null;
  openPorts: number[];
}): DeviceGroup[] {
  const lastAtOf = new Map(opts.devices.map((d) => [d.id, d.lastAt]));
  const groups: DeviceGroup[] = opts.devices.map((d) => {
    const online = d.id === opts.connectedId;
    if (online) {
      const t = buildServiceTree({
        services: opts.live,
        hidden: opts.hiddenOf(d.id),
        consolePort: opts.consolePort,
        selectedPort: opts.selectedPort,
        openPorts: opts.openPorts,
      });
      return { deviceId: d.id, name: d.name, online, ...t };
    }
    const snap = opts.snapshots[d.id];
    const hiddenSet = new Set(opts.hiddenOf(d.id));
    const visible: ServiceRow[] = [];
    const hidden: ServiceRow[] = [];
    for (const s of snap?.services ?? []) {
      const r: ServiceRow = { port: s.port, name: s.name, isConsole: false, isSelected: false, isGone: false };
      (hiddenSet.has(s.port) ? hidden : visible).push(r);
    }
    return { deviceId: d.id, name: d.name, online, snapAt: snap?.at, visible, hidden, gone: [] };
  });
  groups.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (lastAtOf.get(b.deviceId) ?? 0) - (lastAtOf.get(a.deviceId) ?? 0);
  });
  return groups;
}
