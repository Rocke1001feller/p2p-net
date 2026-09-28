import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installShellHarness } from './shell.test-harness.js';

/**
 * P1 多服务工作台（2026-09-28）：服务清单为空 → 引导页「未发现服务」，
 * 替换旧的「桌面未自述工作台端口」offlineSheet（spec §4.3：不弹 sheet）。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-de&device=phone-de&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1',
  services: { services: [] },
  observeTextIds: ['svcGuideTxt'],
});

await import('./shell.js');

const win = h.window as unknown as {
  __p2pNetConnect?: (deskId?: string) => Promise<void>;
  __p2pNetDebug?: () => { selectedPort: number | null };
};

test('空清单 → 引导页 empty 文案，不弹离线条', async () => {
  await h.waitFor(() => typeof win.__p2pNetConnect === 'function', 5_000, '__p2pNetConnect 导出');
  await win.__p2pNetConnect!();
  await h.waitFor(() => h.el('svcGuide').style.display === 'block', 5_000, '引导页显示');
  assert.ok(h.el('svcGuideTxt').textContent.includes('未发现服务'), 'empty 文案');
  assert.equal(win.__p2pNetDebug!().selectedPort, null);
  assert.equal(h.el('offlineSheet').classList.contains('show'), false, '不得弹离线条');
});

// 文件级清场：无论断言成败都断开连接，防 p2pupg 退避计时器钉住进程（2026-09-28 实锤）
after(() => { h.el('btnDisconnect').onclick?.(); });
