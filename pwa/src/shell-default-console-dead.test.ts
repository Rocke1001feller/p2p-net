import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installShellHarness } from './shell.test-harness.js';

/**
 * P1 多服务工作台（2026-09-28）：console 自述端口已死（不在服务清单内）→
 * 默认选中落空进引导页，不得 hijack 到清单里其它服务（spec §4.5）。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-dc&device=phone-dc&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1',
  services: {
    console: '/s/9999/',
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

test('console 自述 9999 不在清单 → 引导页，不 hijack 到 3000/3001', async () => {
  await h.waitFor(() => typeof win.__p2pNetConnect === 'function', 5_000, '__p2pNetConnect 导出');
  await win.__p2pNetConnect!();
  await h.waitFor(() => h.el('svcGuide').style.display === 'block', 5_000, '引导页显示');
  assert.equal(win.__p2pNetDebug!().selectedPort, null, 'console 死了不得改选其它服务');
  assert.equal(h.el('appHost').children.length, 0, '不得创建 iframe');
});

// 文件级清场：无论断言成败都断开连接，防 p2pupg 退避计时器钉住进程（2026-09-28 实锤）
after(() => { h.el('btnDisconnect').onclick?.(); });
