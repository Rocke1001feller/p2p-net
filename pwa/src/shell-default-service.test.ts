import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEl, installShellHarness } from './shell.test-harness.js';
import { hideService } from './hiddenServices.js';

/**
 * P1 多服务工作台（2026-09-28）：默认选中链——console 自述优先（无视清单位置），
 * 且 console 服务被隐藏时仍可选中（console 不可隐藏，spec §4.1 裁决）。
 * 载荷：三服务清单 + console 自述 '/s/3001/'（3001 故意不在清单首位）。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-ds&device=phone-ds&desk=desk-1&t=dummy'
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

test('boot：__p2pNetConnect 导出', async () => {
  await h.waitFor(() => typeof win.__p2pNetConnect === 'function', 5_000, '__p2pNetConnect 导出');
});

test('console 自述在清单内 → 默认选中 3001（无视它不在清单首位）', async () => {
  await win.__p2pNetConnect!();
  await h.waitFor(() => win.__p2pNetDebug!().selectedPort === 3001, 5_000, 'selectedPort=3001');
  const iframes = h.el('appHost').children as FakeEl[];
  const svc3001 = iframes.find((f) => f.id === 'svc-3001');
  assert.ok(svc3001, 'svc-3001 iframe 已建');
  assert.equal(svc3001!.style.display, 'block');
  assert.notEqual(h.el('svcGuide').style.display, 'block', '有选中时引导页不显示');
});

test('默认选中打开后 → lastService 已写入该端口', async () => {
  await h.waitFor(
    () => h.localStorage.getItem('p2p-net.pwa.lastService') === JSON.stringify({ 'desk-1': 3001 }),
    5_000, 'lastService 落盘 3001',
  );
});

test('console 服务被隐藏 → 重连仍选中它（console 不可隐藏，隐藏记录被无视）', async () => {
  hideService(h.localStorage, 'desk-1', 3001);
  await win.__p2pNetConnect!();
  await h.waitFor(() => win.__p2pNetDebug!().selectedPort === 3001, 5_000, '重连仍选中 console 3001');
});

// 文件级清场：无论断言成败都断开连接，防 p2pupg 退避计时器钉住进程（2026-09-28 实锤）
after(() => { h.el('btnDisconnect').onclick?.(); });
