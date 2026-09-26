import test from 'node:test';
import assert from 'node:assert/strict';
import { installShellHarness } from './shell.test-harness.js';

/**
 * 任务C（shell 层）：落点粘性——connected 落点写 localStorage，下次 connect 注入 lastMode。
 * 无任何 dev 强制参数：首连 p2p 失败（Node 无 RTCPeerConnection）落隧道；
 * 重连必须隧道先行（不再触达 p2p 段）。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-c&device=phone-c&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc',
  observeTextIds: ['connStageTxt'],
});

await import('./shell.js');

const win = h.window as unknown as {
  __p2pNetConnect?: (deskId?: string) => Promise<void>;
  __p2pNetDebug?: () => { desk: { id: string }; mode: string | null };
};
const stageTexts = () => h.textLog.connStageTxt ?? [];
const P2P_TEXT = '正在建立直连（NAT 穿越）…';
const TUNNEL_TEXT = '直连不可用，尝试反向隧道…';

test('boot 就绪', async () => {
  await h.waitFor(() => win.__p2pNetDebug?.().desk.id === 'desk-1', 5_000, 'desk.id 锚定');
});

test('首连：p2p 先赌失败落隧道；connected 落点写入 p2p.lastLinkMode', async () => {
  await win.__p2pNetConnect!();
  assert.equal(win.__p2pNetDebug!().mode, 'tunnel');
  assert.ok(stageTexts().includes(P2P_TEXT), '无记忆时必须先赌 p2p 段');
  assert.ok(stageTexts().includes(TUNNEL_TEXT), 'p2p 失败后进隧道段');
  assert.equal(h.localStorage.getItem('p2p.lastLinkMode'), 'tunnel', 'connected 落点必须落盘');
});

test('重连：注入 lastMode=tunnel → 隧道先行，不再触达 p2p 段', async () => {
  const before = stageTexts().length;
  await win.__p2pNetConnect!();
  assert.equal(win.__p2pNetDebug!().mode, 'tunnel');
  const fresh = stageTexts().slice(before);
  assert.ok(!fresh.includes(P2P_TEXT), '隧道记忆生效：p2p 段不得再被触达');
  assert.ok(fresh.includes(TUNNEL_TEXT), '隧道段先行尝试');
  h.el('btnDisconnect').onclick!(); // 收尾：停看门狗/断开，让进程可退出
});
