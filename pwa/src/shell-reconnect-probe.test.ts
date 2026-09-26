import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeEl, installShellHarness } from './shell.test-harness.js';

/**
 * W-B①（2026-09-27，用户裁决「②为主、①为辅」）：数据面重连后工作台**先探活再定夺**——
 * iframe DOM 仍存活（黑洞期没被 504 打死）→ 不重建，工作台现场（未发输入/路由）全保住；
 * 已死（白屏/空文档）→ 维持 2026-09-12 根治行为：强制重建清残骸。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-test&device=phone-test&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1',
  observeTextIds: ['log'],
});

await import('./shell.js');

const win = h.window as unknown as { __p2pNetConnect?: (deskId?: string) => Promise<void> };
const logText = (): string => h.textLog['log']?.at(-1) ?? '';
const workbenchIframe = (): FakeEl => h.el('appHost').children[0] as FakeEl;
const bootedDoc = (): unknown => ({
  getElementById: (id: string) => (id === 'root' ? { childElementCount: 1 } : null),
  body: { innerText: 'workbench alive' },
});
const deadDoc = (): unknown => ({
  getElementById: () => null,
  body: { innerText: '' },
});

test('boot：__p2pNetConnect 导出', async () => {
  await h.waitFor(() => typeof win.__p2pNetConnect === 'function', 5_000, '__p2pNetConnect 导出');
});

test('首连：工作台开窗（iframe 挂载 appHost）', async () => {
  await win.__p2pNetConnect!();
  await h.waitFor(() => h.el('appHost').children.length === 1, 5_000, '工作台 iframe 挂载');
});

test('重连 + 工作台 DOM 仍存活 → 不重建（W-B① 探活后决策）', async () => {
  workbenchIframe().contentDocument = bootedDoc();
  await win.__p2pNetConnect!();
  assert.match(logText(), /数据面已重连 → 工作台仍存活，不重建/);
  assert.doesNotMatch(logText(), /重建工作台（清首屏残骸）/, '存活时不得出现强制重建日志');
});

test('再重连 + 工作台已死（空文档）→ 强制重建（2026-09-12 根治行为不动）', async () => {
  workbenchIframe().contentDocument = deadDoc();
  await win.__p2pNetConnect!();
  assert.match(logText(), /数据面已重连 → 重建工作台（清首屏残骸）/);
});

test('清场：stopSession 终结看门狗', async () => {
  h.el('btnDisconnect').onclick!();
});
