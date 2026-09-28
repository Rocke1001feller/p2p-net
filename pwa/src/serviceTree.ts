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
