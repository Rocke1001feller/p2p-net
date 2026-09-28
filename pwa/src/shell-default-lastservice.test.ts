import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEl, installShellHarness } from './shell.test-harness.js';
import { hideService } from './hiddenServices.js';
import { writeLastService } from './consolePick.js';

/**
 * P1 多服务工作台（2026-09-28）：无 console 自述时 lastService 粘性选中；
 * lastService 被隐藏 → 不选中它、落空进引导页（Review Focus 2）；
 * 全部隐藏 → 引导页「已全部隐藏」（spec §4.5）。
 * 载荷：三服务清单，无 console 字段。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-dl&device=phone-dl&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1',
  services: {
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
const guideText = (): string => h.el('svcGuideTxt').textContent;

test('boot：写入 lastService=3002 后连接 → 粘性选中 3002（不盲选清单首个 3000）', async () => {
  await h.waitFor(() => typeof win.__p2pNetConnect === 'function', 5_000, '__p2pNetConnect 导出');
  writeLastService(h.localStorage, 'desk-1', 3002);
  await win.__p2pNetConnect!();
  await h.waitFor(() => win.__p2pNetDebug!().selectedPort === 3002, 5_000, 'selectedPort=3002');
});

test('lastService 已被隐藏 → 不选中它，落空进引导页（iframe 保留不销毁）', async () => {
  hideService(h.localStorage, 'desk-1', 3002);
  await win.__p2pNetConnect!();
  await h.waitFor(() => h.el('svcGuide').style.display === 'block', 5_000, '引导页显示');
  assert.equal(win.__p2pNetDebug!().selectedPort, null);
  assert.ok(guideText().includes('侧栏'), `no-selection 文案，实际：${guideText()}`);
  const svc3002 = (h.el('appHost').children as FakeEl[]).find((f) => f.id === 'svc-3002');
  assert.ok(svc3002, 'iframe 仍挂在 appHost（未销毁）');
  assert.equal(svc3002!.style.display, 'none', '引导页显示时 iframe 隐藏');
});

test('全部服务被隐藏 → 引导页「已全部隐藏」（不弹离线条）', async () => {
  hideService(h.localStorage, 'desk-1', 3000);
  hideService(h.localStorage, 'desk-1', 3001);
  await win.__p2pNetConnect!();
  await h.waitFor(() => guideText().includes('已全部隐藏'), 5_000, 'all-hidden 文案');
  assert.equal(h.el('offlineSheet').classList.contains('show'), false, '不得弹离线条');
});

// 文件级清场：无论断言成败都断开连接，防 p2pupg 退避计时器钉住进程（2026-09-28 实锤）
after(() => { h.el('btnDisconnect').onclick?.(); });
