import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEl, installShellHarness } from './shell.test-harness.js';

/**
 * 评审 C2（2026-09-28）：重连不得抢走用户正在看的服务。
 * 旧行为：每次重连 fetchServices 成功都无条件重跑 openWorkbench 默认选中链
 * → console 恒自述的设备上，蜂窝闪断一次就把用户从当前服务拽回 console 首页
 * （视图切换 + selectedPort 改写 + lastService 覆写）——撞「选中丢失不可接受」红线；
 * 且探活块在 openWorkbench 之后才读 selectedPort，Ruling「探活对象=用户当前看的服务」被抵消。
 * 新行为：重连且 selectedPort 非 null → 只更新 consolePort 簿记，选中/视图/记忆/沉浸不动。
 * 载荷：console 自述 '/s/3001/' + 两服务。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-rk&device=phone-rk&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1',
  services: {
    console: '/s/3001/',
    services: [
      { name: 'vite dev', url: '/s/3000/', port: 3000 },
      { name: 'Claude 工作台', url: '/s/3001/', port: 3001 },
    ],
  },
  observeTextIds: ['log'],
});

await import('./shell.js');

const win = h.window as unknown as {
  __p2pNetConnect?: (deskId?: string) => Promise<void>;
  __p2pNetDebug?: () => { selectedPort: number | null; consolePort: number | null };
};
const rows = (id: string): FakeEl[] => h.el(id).children as FakeEl[];
const frameOf = (port: number): FakeEl | undefined =>
  (h.el('appHost').children as FakeEl[]).find((f) => f.id === `svc-${port}`);
const logText = (): string => h.textLog['log']?.at(-1) ?? '';
const bootedDoc = (): unknown => ({
  getElementById: (id: string) => (id === 'root' ? { childElementCount: 1 } : null),
  body: { innerText: 'service alive' },
});

test('连接：默认选中 console 3001', async () => {
  await h.waitFor(() => typeof win.__p2pNetConnect === 'function', 5_000, '__p2pNetConnect 导出');
  await win.__p2pNetConnect!();
  await h.waitFor(() => win.__p2pNetDebug!().selectedPort === 3001, 5_000, 'selectedPort=3001');
});

test('用户从侧栏切到 vite dev 3000（lastService 写入 3000）', async () => {
  const row = rows('svcTree').find((r) => r.dataset.port === '3000')!;
  row.onclick!();
  await h.waitFor(() => win.__p2pNetDebug!().selectedPort === 3000, 5_000, 'selectedPort=3000');
  assert.match(h.localStorage.getItem('p2p-net.pwa.lastService') ?? '', /3000/);
});

test('重连（蜂窝闪断恢复）→ 选中仍是 3000：视图/记忆不动，探活命中 3000，consolePort 簿记正确（C2）', async () => {
  frameOf(3000)!.contentDocument = bootedDoc(); // 探活坐实存活 → 走「不重建」路径
  await win.__p2pNetConnect!();
  await h.waitFor(() => /数据面已重连 → 工作台仍存活，不重建/.test(logText()), 5_000,
    `探活须命中用户当前服务 3000（而非 console），日志：${logText()}`);
  assert.equal(win.__p2pNetDebug!().selectedPort, 3000, '重连不得改写选中');
  assert.equal(frameOf(3000)!.style.display, 'block', '当前服务视图保持');
  assert.equal(frameOf(3001)!.style.display, 'none', '不得把 console 拽上前台');
  assert.match(h.localStorage.getItem('p2p-net.pwa.lastService') ?? '', /3000/,
    'lastService 不得被覆写成 console');
  assert.equal(win.__p2pNetDebug!().consolePort, 3001, 'consolePort 簿记仍须正确（服务树豁免标记用）');
});

// 文件级清场：无论断言成败都断开连接，防 p2pupg 退避计时器钉住进程（2026-09-28 实锤）
after(() => { h.el('btnDisconnect').onclick?.(); });
