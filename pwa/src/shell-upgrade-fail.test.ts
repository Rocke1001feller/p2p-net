import test from 'node:test';
import assert from 'node:assert/strict';
import { installShellHarness } from './shell.test-harness.js';

/**
 * 任务D（shell 层）：tunnel→p2p 旁路升级装配——失败退避路径。
 * installFakeRtc({autoOpen:false})：旁路 dc 永不开 → 每次尝试都在 p2pupgwait 超时后失败，
 * 控制器按连败退避重排（首拍 50ms，其后 ×2：100/200/400ms…），落点必须稳在隧道。
 * 注：失败只付 KB 级信令税（每次尝试一条 offer）——断言用 offer 计数观测退避重试。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-upf&device=phone-upf&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1&p2pupg=0.05&p2pupgwait=0.15',
});

h.installFakeRtc({ autoOpen: false }); // 旁路永远建不成
await import('./shell.js');

const win = h.window as unknown as {
  __p2pNetConnect?: (deskId?: string) => Promise<void>;
  __p2pNetDebug?: () => { desk: { id: string }; mode: string | null };
};
const offers = () => h.sentSig.filter((m) => m.msg.type === 'offer');

test('boot 就绪', async () => {
  await h.waitFor(() => win.__p2pNetDebug?.().desk.id === 'desk-1', 5_000, 'desk.id 锚定');
});

test('旁路连败退避重试：落点稳在隧道、落盘保持 tunnel', async () => {
  void win.__p2pNetConnect!();
  await h.waitFor(() => win.__p2pNetDebug!().mode === 'tunnel', 5_000, '落隧道');
  await h.waitFor(() => offers().length >= 1, 5_000, '首拍旁路 offer');
  // 连败退避 50→100→200→400ms：1s 内应见多轮重试（≥3 条 offer），但绝不热切
  await h.waitFor(() => offers().length >= 3, 5_000, '退避重试再发 offer');
  assert.equal(win.__p2pNetDebug!().mode, 'tunnel', '旁路建不成：落点必须稳在隧道');
  assert.equal(h.localStorage.getItem('p2p.lastLinkMode'), 'tunnel', '落盘保持 tunnel');
  assert.ok(h.el('log').textContent.includes('[p2pupg]'), '失败重试必须留日志（真机标定靠它数节拍）');
});

test('stopSession 终结看门狗：不再有新一轮旁路尝试', async () => {
  h.el('btnDisconnect').onclick!();
  await new Promise((r) => setTimeout(r, 300)); // 跨过在途尝试（若有）
  const frozen = offers().length;
  await new Promise((r) => setTimeout(r, 400)); // 跨过 ≥2 个退避节拍：看门狗未死必再发 offer
  assert.equal(offers().length, frozen, 'stopSession 后旁路看门狗必须停止');
});
