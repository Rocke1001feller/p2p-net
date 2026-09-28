import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEl, installShellHarness } from './shell.test-harness.js';

/**
 * P1 多服务工作台（2026-09-28）：侧栏树接线——连接后渲染全量服务；console 行无 ✕；
 * 隐藏/恢复即时生效并持久化；隐藏当前选中服务 → 回引导页且 iframe 保留（spec §4.5）。
 * 载荷：三服务 + console 自述 '/s/3001/'。
 * 注：gone 段（清单缩水）在纯函数层钉住（serviceTree.test.ts）；harness 载荷静态，
 * shell 层无法模拟「服务从清单消失」，不造重复测试。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-st&device=phone-st&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1',
  services: {
    console: '/s/3001/',
    services: [
      { name: 'vite dev', url: '/s/3000/', port: 3000 },
      { name: 'Claude 工作台', url: '/s/3001/', port: 3001 },
      { name: 'Kimi Code', url: '/s/3002/', port: 3002 },
    ],
  },
  observeTextIds: ['svcGuideTxt'],
});

await import('./shell.js');

const win = h.window as unknown as {
  __p2pNetConnect?: (deskId?: string) => Promise<void>;
  __p2pNetDebug?: () => { selectedPort: number | null };
};
const rows = (id: string): FakeEl[] => h.el(id).children as FakeEl[];
const rowOf = (id: string, port: number): FakeEl | undefined =>
  rows(id).find((r) => r.dataset.port === String(port));
const hideBtn = (r: FakeEl): FakeEl | undefined =>
  (r.children as FakeEl[]).find((c) => c.className.includes('svc-hide'));

test('连接成功：默认选中 console 3001；抽屉渲染全部 3 个服务，console 行无隐藏入口', async () => {
  await h.waitFor(() => typeof win.__p2pNetConnect === 'function', 5_000, '__p2pNetConnect 导出');
  await win.__p2pNetConnect!();
  await h.waitFor(() => win.__p2pNetDebug!().selectedPort === 3001, 5_000, 'selectedPort=3001');
  await h.waitFor(() => rows('svcTree').length === 3, 5_000, 'svcTree 渲染 3 行');
  assert.ok(rowOf('svcTree', 3001), 'console 3001 在树里');
  assert.equal(hideBtn(rowOf('svcTree', 3001)!), undefined, 'console 行不得有 ✕（不可隐藏）');
  assert.ok(hideBtn(rowOf('svcTree', 3000)!), '普通服务行有 ✕');
  assert.ok(hideBtn(rowOf('svcTree', 3002)!), '普通服务行有 ✕');
});

test('隐藏非当前服务 3002 → 进隐藏段并持久化；选中不受影响', async () => {
  hideBtn(rowOf('svcTree', 3002)!)!.onclick!();
  assert.equal(rows('svcTree').length, 2);
  assert.ok(rowOf('svcHidden', 3002), '3002 进隐藏段');
  assert.match(h.localStorage.getItem('p2p-net.pwa.hiddenServices') ?? '', /3002/);
  assert.equal(win.__p2pNetDebug!().selectedPort, 3001, '选中不受影响');
});

test('恢复 3002 → 回到可见段', async () => {
  const unhide = (rowOf('svcHidden', 3002)!.children as FakeEl[])
    .find((c) => c.className.includes('svc-unhide'));
  unhide!.onclick!();
  assert.equal(rows('svcTree').length, 3, '3002 回到可见段');
  assert.equal(rows('svcHidden').length, 0);
});

test('☰ 开合抽屉；点服务行 → 收起抽屉并选中该服务', async () => {
  h.el('btnSvcTree').onclick!();
  assert.equal(h.el('svcDrawer').classList.contains('show'), true, '☰ 打开抽屉');
  rowOf('svcTree', 3000)!.onclick!();
  await h.waitFor(() => win.__p2pNetDebug!().selectedPort === 3000, 5_000, 'selectedPort=3000');
  assert.equal(h.el('svcDrawer').classList.contains('show'), false, '点服务即收起抽屉');
  const svc3000 = (h.el('appHost').children as FakeEl[]).find((f) => f.id === 'svc-3000');
  assert.equal(svc3000!.style.display, 'block');
});

test('隐藏当前选中服务 3000 → 立即回引导页，iframe 保留不销毁', async () => {
  h.el('btnSvcTree').onclick!(); // 重新打开抽屉
  hideBtn(rowOf('svcTree', 3000)!)!.onclick!();
  await h.waitFor(() => h.el('svcGuide').style.display === 'block', 5_000, '引导页显示');
  assert.ok(h.el('svcGuideTxt').textContent.includes('侧栏'), 'no-selection 文案');
  assert.equal(win.__p2pNetDebug!().selectedPort, null);
  const svc3000 = (h.el('appHost').children as FakeEl[]).find((f) => f.id === 'svc-3000');
  assert.ok(svc3000, 'iframe 仍挂在 appHost');
  assert.equal(svc3000!.style.display, 'none', 'iframe 隐藏但不销毁');
  assert.match(h.localStorage.getItem('p2p-net.pwa.hiddenServices') ?? '', /3000/);
});

// 评审 I5（2026-09-28）：抽屉必须有关闭路径——遮罩（点外收起）+ 头部「收起」按钮
// （☰ 在抽屉打开时被抽屉盖住，没有这两个出路就只剩「点一个服务」）。
const ensureDrawer = (open: boolean): void => {
  if (h.el('svcDrawer').classList.contains('show') !== open) h.el('btnSvcTree').onclick!();
};

test('抽屉打开带遮罩；点遮罩 → 抽屉与遮罩一并收起（I5）', () => {
  ensureDrawer(true);
  assert.equal(h.el('svcDrawerMask').classList.contains('show'), true, '开抽屉必须同时亮遮罩（点抽屉外收起）');
  h.el('svcDrawerMask').onclick!();
  assert.equal(h.el('svcDrawer').classList.contains('show'), false, '点遮罩必须收起抽屉');
  assert.equal(h.el('svcDrawerMask').classList.contains('show'), false);
});

test('抽屉头部「收起」按钮 → 抽屉与遮罩收起（I5）', () => {
  ensureDrawer(true);
  h.el('svcDrawerClose').onclick!();
  assert.equal(h.el('svcDrawer').classList.contains('show'), false);
  assert.equal(h.el('svcDrawerMask').classList.contains('show'), false);
});

// 文件级清场：无论断言成败都断开连接，防 p2pupg 退避计时器钉住进程（2026-09-28 实锤）
after(() => { h.el('btnDisconnect').onclick?.(); });
