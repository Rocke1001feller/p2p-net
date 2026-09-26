import test from 'node:test';
import assert from 'node:assert/strict';
import { installShellHarness } from './shell.test-harness.js';

/**
 * 任务D 采纳门禁（W-A 根因修复，2026-09-26）：旁路建成但落中继（host 侧 TURN 的「假 p2p」）
 * → 不采纳、保持隧道、留日志；旁路实例由 finally 拆净（TURN 配额即放），控制器退避后照常重试。
 * 相对隧道，中继 p2p 零优势（同走 VPS、UDP 更脆、徽章说谎），且会被 host 升级轮
 * ICE restart 打死（werift 应答侧 nominated 清空 → 静默黑洞 → ~40s 死亡循环）。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-upr&device=phone-upr&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1&p2pupg=0.05&p2pupgwait=0.5',
});

h.installFakeRtc({ stats: 'relay' }); // dc 5ms 自动开，但候选对远端 relay → 门禁必须拦下
await import('./shell.js');

const win = h.window as unknown as {
  __p2pNetConnect?: (deskId?: string) => Promise<void>;
  __p2pNetDebug?: () => { desk: { id: string }; mode: string | null };
};
const offers = () => h.sentSig.filter((m) => m.msg.type === 'offer');

test('boot 就绪', async () => {
  await h.waitFor(() => win.__p2pNetDebug?.().desk.id === 'desk-1', 5_000, 'desk.id 锚定');
});

test('旁路落中继 → 不采纳：落点恒隧道、日志留证、退避后照常重试', async () => {
  void win.__p2pNetConnect!();
  await h.waitFor(() => win.__p2pNetDebug!().mode === 'tunnel', 5_000, '先落隧道');
  await h.waitFor(() => offers().length >= 1, 5_000, '旁路尝试发出 offer');
  await h.waitFor(() => h.el('log').textContent.includes('[p2pupg] 旁路落中继（非直连）→ 不采纳，保持隧道'), 5_000,
    '门禁必须拦下并留日志');
  assert.equal(win.__p2pNetDebug!().mode, 'tunnel', '中继旁路不得被采纳（落点恒隧道）');
  assert.notEqual(h.localStorage.getItem('p2p.lastLinkMode'), 'p2p', '落盘不得记 p2p');
  // 门禁拒绝 = 一次失败尝试：控制器退避重排后必须继续发 offer（升级机会不死）
  await h.waitFor(() => offers().length >= 2, 5_000, '退避后仍有下一拍旁路尝试');
  await new Promise((r) => setTimeout(r, 500)); // 跨过 ≥1 个退避节拍：落点仍不得热切
  assert.equal(win.__p2pNetDebug!().mode, 'tunnel', '多拍之后落点仍恒隧道');
});

test('stopSession 终结看门狗：不再有新一轮旁路尝试', async () => {
  h.el('btnDisconnect').onclick!();
  await new Promise((r) => setTimeout(r, 300)); // 跨过在途尝试（若有）
  const frozen = offers().length;
  await new Promise((r) => setTimeout(r, 400)); // 跨过 ≥2 个退避节拍：看门狗未死必再发 offer
  assert.equal(offers().length, frozen, 'stopSession 后旁路看门狗必须停止');
});
