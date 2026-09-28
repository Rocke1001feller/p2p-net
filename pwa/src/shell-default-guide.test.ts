import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installShellHarness } from './shell.test-harness.js';

/**
 * P1 多服务工作台（2026-09-28）：无 console 自述且无 lastService → 引导页，
 * 不再「清单首个」盲选（spec §4.3：首屏无选中显示引导页，不弹 sheet）。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-dg&device=phone-dg&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1',
  services: {
    services: [
      { name: 'vite dev', url: '/s/3000/', port: 3000 },
      { name: 'Claude 工作台', url: '/s/3001/', port: 3001 },
    ],
  },
  observeTextIds: ['svcGuideTxt'],
});

await import('./shell.js');

const win = h.window as unknown as {
  __p2pNetConnect?: (deskId?: string) => Promise<void>;
  __p2pNetDebug?: () => { selectedPort: number | null };
};

test('无 console 无 lastService → 引导页 no-selection，不盲选清单首个、不弹离线条', async () => {
  await h.waitFor(() => typeof win.__p2pNetConnect === 'function', 5_000, '__p2pNetConnect 导出');
  await win.__p2pNetConnect!();
  await h.waitFor(() => h.el('svcGuide').style.display === 'block', 5_000, '引导页显示');
  assert.equal(win.__p2pNetDebug!().selectedPort, null, '无选中');
  assert.equal(h.el('appHost').children.length, 0, '不得创建任何 iframe（不盲选）');
  assert.ok(h.el('svcGuideTxt').textContent.includes('侧栏'), 'no-selection 文案');
  assert.equal(h.el('offlineSheet').classList.contains('show'), false, '不得弹离线条');
});

// 文件级清场：无论断言成败都断开连接，防 p2pupg 退避计时器钉住进程（2026-09-28 实锤）
after(() => { h.el('btnDisconnect').onclick?.(); });
