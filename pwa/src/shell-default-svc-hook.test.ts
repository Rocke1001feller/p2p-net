import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installShellHarness } from './shell.test-harness.js';

/**
 * P1 多服务工作台（2026-09-28）：?svc=<port> 验收钩子语义不变——直开指定服务、
 * 跳过默认选中（此处压过 console 自述 3001）；且不得污染 lastService 记忆（Review Focus 5）。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-dh&device=phone-dh&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1&svc=3002',
  services: {
    console: '/s/3001/',
    services: [
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

test('?svc=3002 直开 → 选中 3002（压过 console 自述 3001），lastService 不写入', async () => {
  await h.waitFor(() => typeof win.__p2pNetConnect === 'function', 5_000, '__p2pNetConnect 导出');
  await win.__p2pNetConnect!();
  await h.waitFor(() => win.__p2pNetDebug!().selectedPort === 3002, 5_000, 'selectedPort=3002');
  assert.equal(h.localStorage.getItem('p2p-net.pwa.lastService'), null, 'svc 钩子不得污染 lastService');
});

// 文件级清场：无论断言成败都断开连接，防 p2pupg 退避计时器钉住进程（2026-09-28 实锤）
after(() => { h.el('btnDisconnect').onclick?.(); });
