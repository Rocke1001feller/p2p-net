import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEl, installShellHarness } from './shell.test-harness.js';

/**
 * P1 启动台（2026-09-28）：连接成功后设备页重渲染——已连接设备卡片带服务网格；
 * 点网格图标 → 切到工作台并打开该服务（进沉浸）。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-lp&device=phone-lp&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1',
  services: {
    console: '/s/3001/',
    services: [
      { name: 'vite dev', url: '/s/3000/', port: 3000 },
      { name: 'Claude 工作台', url: '/s/3001/', port: 3001 },
    ],
  },
});

await import('./shell.js');
const { currentTab } = await import('./ui.js');

const win = h.window as unknown as {
  __p2pNetConnect?: (deskId?: string) => Promise<void>;
  __p2pNetDebug?: () => { selectedPort: number | null; immersive: boolean };
};
const cardOf = (id: string): FakeEl | undefined =>
  (h.el('devList').children as FakeEl[]).find((c) => c.dataset?.devId === id);
const gridOf = (card: FakeEl): FakeEl | undefined =>
  (card.children as FakeEl[]).find((c) => c.className.includes('launch-grid'));

test('连接成功后：已连接设备卡片带服务网格；点图标直达该服务并沉浸', async () => {
  await h.waitFor(() => typeof win.__p2pNetConnect === 'function', 5_000, '__p2pNetConnect 导出');
  await win.__p2pNetConnect!();
  await h.waitFor(() => win.__p2pNetDebug!().selectedPort === 3001, 5_000, '默认选中 3001');
  await h.waitFor(() => {
    const card = cardOf('desk-1');
    return !!card && !!gridOf(card);
  }, 5_000, 'desk-1 卡片出现服务网格');
  const grid = gridOf(cardOf('desk-1')!)!;
  assert.equal(grid.children.length, 2, '网格渲染全部 2 个服务');
  const item3000 = (grid.children as FakeEl[]).find((i) => i.dataset.port === '3000')!;
  item3000.onclick!();
  await h.waitFor(() => win.__p2pNetDebug!().selectedPort === 3000, 5_000, '直达 3000');
  assert.equal(currentTab(), 'workspace', '点图标切到工作台');
  assert.equal(win.__p2pNetDebug!().immersive, true, '直达即沉浸');
});

// 文件级清场：无论断言成败都断开连接，防 p2pupg 退避计时器钉住进程（2026-09-28 实锤）
after(() => { h.el('btnDisconnect').onclick?.(); });
