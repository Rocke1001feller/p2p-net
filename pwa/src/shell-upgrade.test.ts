import test from 'node:test';
import assert from 'node:assert/strict';
import { installShellHarness } from './shell.test-harness.js';

/**
 * 任务D（shell 层）：tunnel→p2p 旁路升级装配——成功路径。
 * ?tunnel=1 强制隧道 + ?p2pupg=0.05（首拍 50ms）+ ?p2pupgwait=0.3（尝试超时 0.3s）：
 * 落隧道后看门狗旁路建 WebRtcSession（FakePc dc 5ms 自开）→ 建成 → adopt 热切 p2p。
 * make-before-break：旁路建成前隧道状态条不得被旁路的 connecting 污染。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-up&device=phone-up&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1&p2pupg=0.05&p2pupgwait=0.3',
  observeTextIds: ['connStageTxt'],
});

h.installFakeRtc({ stats: 'direct' }); // dc 5ms 自动开 + 直连候选对：旁路 p2p 段能建成且过采纳门禁
await import('./shell.js');

const win = h.window as unknown as {
  __p2pNetConnect?: (deskId?: string) => Promise<void>;
  __p2pNetDebug?: () => { desk: { id: string }; mode: string | null };
};
const offers = () => h.sentSig.filter((m) => m.msg.type === 'offer');

test('boot 就绪', async () => {
  await h.waitFor(() => win.__p2pNetDebug?.().desk.id === 'desk-1', 5_000, 'desk.id 锚定');
});

test('隧道 connected → 旁路 p2p 建成 → adopt 热切：落点 p2p + 落盘 p2p', async () => {
  void win.__p2pNetConnect!();
  await h.waitFor(() => win.__p2pNetDebug!().mode === 'tunnel', 5_000, '先落隧道');
  await h.waitFor(() => offers().length >= 1, 5_000, '旁路尝试发出 offer');
  await h.waitFor(() => win.__p2pNetDebug!().mode === 'p2p', 5_000, '建成后热切 p2p');
  await h.waitFor(() => h.localStorage.getItem('p2p.lastLinkMode') === 'p2p', 5_000, '落点落盘 p2p');
  assert.ok(h.el('log').textContent.includes('[p2pupg]'), '升级必须留日志');
  // make-before-break：adopt 前旁路的 connecting 不得顶掉状态条的「隧道」——
  // 观察缝序列里 connected(隧道（实验）) 之后不得出现裸 connecting 段标
  const seq = h.textLog.connStageTxt!;
  const tunnelIdx = seq.findIndex((v) => v.includes('隧道'));
  assert.ok(tunnelIdx >= 0, '状态条必须先亮过隧道');
  assert.ok(!seq.slice(tunnelIdx).some((v) => /直连中|连接中/.test(v) && !v.includes('隧道')),
    'adopt 前不得被旁路 connecting 污染状态条');
});

test('stopSession 终结：手动断开后旁路不再复活（adopted 终态不再动作）', async () => {
  h.el('btnDisconnect').onclick!();
  await new Promise((r) => setTimeout(r, 300));
  const frozen = offers().length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(offers().length, frozen, '断开后不得再有旁路 offer');
});
