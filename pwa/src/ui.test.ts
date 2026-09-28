import test from 'node:test';
import assert from 'node:assert/strict';
import { setExperimentMode, setProbeDown, setStatus } from './ui.js';

/**
 * ui.ts 的最小 DOM 桩：只覆盖 setStatus 触达的面
 * （connDot/connTitle/connRtt/btnDisconnect + document.createElement('span')）。
 */
class FakeEl {
  className = '';
  textContent = '';
  style: Record<string, string> & { setProperty(k: string, v: string): void } = Object.assign(
    {} as Record<string, string>,
    { setProperty: (k: string, v: string) => { this.style[k] = v; } },
  );
  dataset: Record<string, string> = {};
  children: unknown[] = [];
  onclick: ((e?: { stopPropagation(): void }) => void) | null = null;
  private classSet = new Set<string>();
  classList = {
    add: (...cs: string[]) => cs.forEach((c) => this.classSet.add(c)),
    remove: (...cs: string[]) => cs.forEach((c) => this.classSet.delete(c)),
    contains: (c: string) => this.classSet.has(c),
  };
  set innerHTML(v: string) { if (v === '') this.children = []; }
  get innerHTML(): string { return ''; }
  append(...nodes: unknown[]): void { this.children.push(...nodes); }
  appendChild<T>(n: T): T { this.children.push(n); return n; }
}

const els = new Map<string, FakeEl>();
function el(id: string): FakeEl {
  let e = els.get(id);
  if (!e) { e = new FakeEl(); els.set(id, e); }
  return e;
}

(globalThis as { document?: unknown }).document = {
  getElementById: (id: string) => el(id),
  createElement: () => new FakeEl(),
};

/** 最近一次 setStatus connected 画出的徽章（connTitle 里 className 含 badge 的 span）。 */
function lastBadge(): FakeEl {
  const badge = el('connTitle').children.find(
    (c): c is FakeEl => c instanceof FakeEl && c.className.includes('badge'),
  );
  assert.ok(badge, 'connected 分支必须画出徽章');
  return badge;
}

test('实验徽章：relay/tunnel 强制模式下徽章带「（实验）」标注', () => {
  setExperimentMode('relay');
  setStatus({ state: 'connected', pairType: 'relay', mode: 'turn' }, '桌面A');
  assert.equal(lastBadge().textContent, '中继（实验）');

  setExperimentMode('tunnel');
  setStatus({ state: 'connected', pairType: null, mode: 'tunnel' }, '桌面A');
  assert.equal(lastBadge().textContent, '隧道（实验）');
});

test('非实验（null）：徽章保持现状（诚实落点，无标注）', () => {
  setExperimentMode(null);
  setStatus({ state: 'connected', pairType: 'relay', mode: 'turn' }, '桌面A');
  assert.equal(lastBadge().textContent, '中继');
  setStatus({ state: 'connected', pairType: null, mode: 'tunnel' }, '桌面A');
  assert.equal(lastBadge().textContent, '隧道');
  setStatus({ state: 'connected', pairType: 'p2p', mode: 'p2p' }, '桌面A');
  assert.equal(lastBadge().textContent, '直连');
});

test('生产链路锁定：setExperimentMode 后经过 connecting 再 connected，实验标注不得被抹掉', () => {
  // 评审 Critical（2026-09-26）：生产时序是 setExperimentMode → setStatus(connecting)（startConnect
  // 顶部刚写入的 lastStatus 全权重绘 + 级联阶段 connecting 帧）→ setStatus(connected)。
  // 复位条件若写成「非 connected 即复位」，实验标注在建连期被两处叠加清零，徽章恒为裸落点。
  setExperimentMode('tunnel');
  setStatus({ state: 'connecting', pairType: null, stage: 'tunnel' }, '桌面A'); // 建连期帧（两处叠加路径的代表）
  setStatus({ state: 'connecting', pairType: null, stage: 'tunnel' }, '桌面A'); // 级联阶段帧再来一拍，确保不是单次侥幸
  setStatus({ state: 'connected', pairType: null, mode: 'tunnel' }, '桌面A');
  assert.equal(lastBadge().textContent, '隧道（实验）', 'connecting 不得复位实验标注（仅 off/failed 可复位）');
  setStatus({ state: 'off', pairType: null }, '桌面A'); // 收尾复位，别污染后续用例
});

test('disconnected 复位实验模式为 null：断开后重连不再带实验标注', () => {
  setExperimentMode('relay');
  setStatus({ state: 'connected', pairType: 'relay', mode: 'turn' }, '桌面A');
  assert.equal(lastBadge().textContent, '中继（实验）');
  setStatus({ state: 'off', pairType: null }, '桌面A'); // 断开 → 复位
  setStatus({ state: 'connected', pairType: 'relay', mode: 'turn' }, '桌面A');
  assert.equal(lastBadge().textContent, '中继', '断开后实验标注必须已复位');
});

test('探活黄灯优先级高于实验徽章（probeDown 覆盖文案不变）', () => {
  setExperimentMode('tunnel');
  setStatus({ state: 'connected', pairType: null, mode: 'tunnel' }, '桌面A');
  setProbeDown(true);
  assert.equal(lastBadge().textContent, '连接待恢复，点我重试');
  setProbeDown(false);
  setStatus({ state: 'off', pairType: null }, '桌面A'); // 收尾复位，别污染后续用例
});

// ---- P1 启动台：renderDevices 服务网格（2026-09-28）----
import { renderDevices } from './ui.js';

const gridOf = (card: FakeEl): FakeEl | undefined =>
  (card.children as FakeEl[]).find((c) => c.className.includes('launch-grid'));

test('renderDevices：connectedId 命中的卡片渲染服务网格，其余卡片无网格', () => {
  renderDevices([{ id: 'd1', name: 'MacBook Pro' }, { id: 'd2', name: 'Windows 台式机' }], () => {}, {
    connectedId: 'd1',
    services: [{ name: 'Claude 工作台', port: 3001 }, { name: 'vite dev', port: 3000 }],
    onOpenService: () => {},
  });
  const cards = el('devList').children as FakeEl[];
  assert.equal(cards.length, 2);
  const grid = gridOf(cards[0]);
  assert.ok(grid, 'd1（已连接）卡片内必须有服务网格');
  assert.deepEqual((grid!.children as FakeEl[]).map((i) => i.dataset.port), ['3001', '3000']);
  assert.equal(gridOf(cards[1]), undefined, 'd2（未连接）无服务清单，不渲染网格');
});

test('网格图标点击触发 onOpenService(对应端口) 且不透传到卡片 onConnect', () => {
  const conns: string[] = [];
  const opened: number[] = [];
  renderDevices([{ id: 'd1' }], (d) => conns.push(d.id), {
    connectedId: 'd1',
    services: [{ name: 'Kimi Code', port: 57255 }],
    onOpenService: (p) => opened.push(p),
  });
  const card = (el('devList').children as FakeEl[])[0];
  const item = (gridOf(card)!.children as FakeEl[])[0];
  item.onclick!({ stopPropagation: () => {} });
  assert.deepEqual(opened, [57255]);
  assert.deepEqual(conns, [], '点服务图标不得触发卡片连接（真实 DOM 靠 stopPropagation 保证）');
  card.onclick!();
  assert.deepEqual(conns, ['d1'], '点卡片本体仍是连接入口');
});

test('opts 缺省 → 全部卡片旧行为（纯连接入口），不报错（Review Focus 3）', () => {
  const conns: string[] = [];
  renderDevices([{ id: 'd9' }], (d) => conns.push(d.id));
  const card = (el('devList').children as FakeEl[])[0];
  assert.equal(gridOf(card), undefined, '无 opts 不得渲染网格');
  card.onclick!();
  assert.deepEqual(conns, ['d9']);
});

// ---- 评审修复 C1（2026-09-28）：抽屉 ✕ 必须断冒泡 ----
// 2026-09-28 多设备侧栏树：模型改为 {groups: DeviceGroup[]}，handlers 带 deviceId。
import { renderServiceTree } from './ui.js';
import type { DeviceGroup } from './serviceTree.js';

const grp = (over: Partial<DeviceGroup>): DeviceGroup => ({
  deviceId: 'mac', name: 'MacBook Pro', online: true, visible: [], hidden: [], gone: [], ...over,
});
const srow = (port: number, name = `svc${port}`) =>
  ({ port, name, isConsole: false, isSelected: false, isGone: false });

/** 在 svcTree 里按 deviceId + port 找到服务行（组容器 → 行两级结构）。 */
function findRow(deviceId: string, port: number): FakeEl {
  for (const g of el('svcTree').children as FakeEl[]) {
    if (g.dataset.deviceId !== deviceId) continue;
    const row = (g.children as FakeEl[]).find((r) => r.dataset.port === String(port));
    if (row) return row;
  }
  throw new Error(`row not found: ${deviceId}:${port}`);
}

test('服务树 ✕ 按钮断冒泡：点 ✕ 只触发 onHide，不得触发行 onPick', () => {
  const picked: unknown[] = [];
  const hidden: [string, number][] = [];
  renderServiceTree(
    { groups: [grp({ visible: [srow(3000, 'vite dev')] })] },
    { onPick: (d, p) => picked.push([d, p]), onHide: (d, p) => hidden.push([d, p]), onUnhide: () => {} },
  );
  const row = findRow('mac', 3000);
  const x = (row.children as FakeEl[]).find((c) => c.className.includes('svc-hide'))!;
  assert.ok(x, '普通服务行必须有 ✕');
  let stopped = false;
  x.onclick!({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true,
    '✕ 必须 stopPropagation——真机上不阻断则冒泡到 row.onclick=onPick，把用户刚隐藏的服务当场打开（harness 无冒泡模型，此断言钉的是契约）');
  assert.deepEqual(hidden, [['mac', 3000]]);
  assert.deepEqual(picked, []);
});

test('多设备分组：组头渲染名称与在线态；离线组行可点，onPick 带 deviceId', () => {
  const picked: [string, number | null][] = [];
  renderServiceTree(
    {
      groups: [
        grp({ deviceId: 'mac', name: 'MacBook Pro', online: true, visible: [srow(3001)] }),
        grp({ deviceId: 'win', name: 'Windows 台式机', online: false, snapAt: 1, visible: [srow(8888, 'Win 报表')] }),
      ],
    },
    { onPick: (d, p) => picked.push([d, p]), onHide: () => {}, onUnhide: () => {} },
  );
  const groups = el('svcTree').children as FakeEl[];
  assert.equal(groups.length, 2);
  const headText = (g: FakeEl) => (g.children as FakeEl[])[0].children.map((c) => (c as FakeEl).textContent).join('|');
  assert.ok(headText(groups[0]).includes('MacBook Pro') && headText(groups[0]).includes('在线'));
  assert.ok(headText(groups[1]).includes('Windows 台式机') && headText(groups[1]).includes('离线'));
  assert.ok(groups[1].className.includes('off'), '离线组必须带 off 类（灰显）');
  findRow('win', 8888).onclick!();
  assert.deepEqual(picked, [['win', 8888]], '点离线组服务 = 切机直达该服务');
});

test('多设备分组：无快照空组渲染「点我连入」提示行，点击 onPick(deviceId, null)', () => {
  const picked: [string, number | null][] = [];
  renderServiceTree(
    { groups: [grp({ deviceId: 'mini', name: 'Mac mini（家里）', online: false })] },
    { onPick: (d, p) => picked.push([d, p]), onHide: () => {}, onUnhide: () => {} },
  );
  const g = (el('svcTree').children as FakeEl[])[0];
  const hint = (g.children as FakeEl[]).find((c) => c.className.includes('svc-empty'))!;
  assert.ok(hint, '空组必须有提示行');
  assert.ok(hint.textContent.includes('点我连入'));
  hint.onclick!();
  assert.deepEqual(picked, [['mini', null]], '点提示行 = 连入该设备（不指定服务）');
});

test('多设备分组：隐藏小节在组内渲染，恢复按钮触发 onUnhide(deviceId, port)', () => {
  const unhidden: [string, number][] = [];
  renderServiceTree(
    { groups: [grp({ hidden: [srow(3002)] })] },
    { onPick: () => {}, onHide: () => {}, onUnhide: (d, p) => unhidden.push([d, p]) },
  );
  const g = (el('svcTree').children as FakeEl[])[0];
  const row = (g.children as FakeEl[]).find((r) => r.dataset.port === '3002')!;
  const un = (row.children as FakeEl[]).find((c) => c.className.includes('svc-unhide'))!;
  un.onclick!();
  assert.deepEqual(unhidden, [['mac', 3002]]);
});

test('多设备分组：组容器注入分组色 --grp/--grpSoft；抽屉名单组显示设备名、多组显示「全部服务」', () => {
  renderServiceTree(
    {
      groups: [
        grp({ deviceId: 'mac' }),
        grp({ deviceId: 'win', name: 'Windows 台式机', online: false }),
      ],
    },
    { onPick: () => {}, onHide: () => {}, onUnhide: () => {} },
  );
  const groups = el('svcTree').children as FakeEl[];
  assert.ok(groups[0].style['--grp'], '组容器必须注入 --grp');
  assert.ok(groups[0].style['--grpSoft'], '组容器必须注入 --grpSoft');
  assert.notEqual(groups[0].style['--grp'], groups[1].style['--grp'], '不同设备分组色应不同（mac/win 实测不撞色）');
  assert.equal(el('svcDrawerName').textContent, '全部服务');
  renderServiceTree({ groups: [grp({})] }, { onPick: () => {}, onHide: () => {}, onUnhide: () => {} });
  assert.equal(el('svcDrawerName').textContent, 'MacBook Pro', '单组时抽屉头回退设备名');
});
