import test from 'node:test';
import assert from 'node:assert/strict';
import { installShellHarness } from './shell.test-harness.js';

/**
 * 任务C（shell 层）：turn→tunnel 回迁看门狗装配。
 * ?transport=relay 强制 TURN + ?backcheck=0.05（50ms 节拍，真机标定旋钮同惯例）：
 * turn connected 启动看门狗 → 探隧道网关活 → onAlive 重级联（每次重级联都再发一条 offer）。
 * 注：forceTurn + 隧道恒活是 dev 组合，回迁会循环重级联——断言用 offer 增量观测，
 * 不 await 首连 promise（它会被重级联风暴拖住，属预期）。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-bc&device=phone-bc&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&transport=relay&backcheck=0.05',
});

h.installFakeRtc(); // dc 5ms 自动开：turn 段（policy relay + turn-credentials 凭据）能建成
await import('./shell.js');

const win = h.window as unknown as {
  __p2pNetConnect?: (deskId?: string) => Promise<void>;
  __p2pNetDebug?: () => { desk: { id: string }; mode: string | null };
};
const offers = () => h.sentSig.filter((m) => m.msg.type === 'offer');

test('boot 就绪', async () => {
  await h.waitFor(() => win.__p2pNetDebug?.().desk.id === 'desk-1', 5_000, 'desk.id 锚定');
});

test('turn connected → 看门狗启动；隧道探活成功 → onAlive 重级联回迁', async () => {
  void win.__p2pNetConnect!();
  await h.waitFor(() => offers().length >= 1, 5_000, 'turn 段首条 offer');
  await h.waitFor(() => win.__p2pNetDebug!().mode === 'turn', 5_000, '落中继');
  await h.waitFor(() => h.localStorage.getItem('p2p.lastLinkMode') === 'turn', 5_000, '落点落盘 turn');
  // 看门狗节拍 50ms：探活成功 → 重级联 → 新 offer（每次重级联 turn 段重发 offer）
  await h.waitFor(() => offers().length >= 3, 5_000, '回迁重级联循环再发 offer');
  assert.ok(h.el('log').textContent.includes('回迁'), '回迁必须留日志');
});

test('stopSession 终结看门狗：不再有新一轮重级联（在途节拍不得复活会话）', async () => {
  h.el('btnDisconnect').onclick!();
  await new Promise((r) => setTimeout(r, 300)); // 跨过在途重级联落点（若有）
  const frozen = offers().length;
  await new Promise((r) => setTimeout(r, 300)); // 6 个节拍窗：若看门狗未死必再发 offer
  assert.equal(offers().length, frozen, 'stopSession 后看门狗必须停止');
});
