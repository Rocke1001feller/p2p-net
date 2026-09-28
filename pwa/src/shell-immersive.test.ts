import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installShellHarness } from './shell.test-harness.js';

/**
 * P1 多服务工作台（2026-09-28）：沉浸模式状态机——openService 后 header/tabbar/侧栏全收起，
 * 底部「∧ 唤起」pill 召回；4s（测试 ?wakeidle=50）无交互自动回沉浸；切 tab 退沉浸不自动回。
 * harness 的 document.addEventListener 是空桩，交互重置走生产同源内部缝 __p2pNetPoke()
 * （生产环境由 document capture 的 click/touchstart/keydown 调用同一函数）。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-im&device=phone-im&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1&p2pupg=0.05&p2pupgwait=0.3&wakeidle=50',
  services: {
    console: '/s/3001/',
    services: [
      { name: 'vite dev', url: '/s/3000/', port: 3000 },
      { name: 'Claude 工作台', url: '/s/3001/', port: 3001 },
    ],
  },
});

h.installFakeRtc({ stats: 'direct' }); // 隧道落成后旁路 p2p 可建成（Review Focus 4 用）
await import('./shell.js');
const { showTab } = await import('./ui.js');

const win = h.window as unknown as {
  __p2pNetConnect?: (deskId?: string) => Promise<void>;
  __p2pNetDebug?: () => { selectedPort: number | null; immersive: boolean; mode: string | null };
  __p2pNetPoke?: () => void;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const disp = (id: string) => h.el(id).style.display;

test('连接并打开服务后进入沉浸：connbar/tabbar 隐藏，wakePill 可见，immersive=true', async () => {
  await h.waitFor(() => typeof win.__p2pNetConnect === 'function', 5_000, '__p2pNetConnect 导出');
  await win.__p2pNetConnect!();
  await h.waitFor(() => win.__p2pNetDebug!().selectedPort === 3001, 5_000, 'selectedPort=3001');
  await h.waitFor(() => win.__p2pNetDebug!().immersive === true, 5_000, 'immersive=true');
  assert.equal(disp('connBar'), 'none');
  assert.equal(disp('tabbar'), 'none');
  assert.equal(h.el('svcDrawer').classList.contains('show'), false, '抽屉收起');
  assert.notEqual(disp('wakePill'), 'none', '唤起 pill 可见');
});

test('沉浸中 tunnel→p2p 升级建成 → immersive 保持 true，chrome 无显隐变化（Review Focus 4）', async () => {
  await h.waitFor(() => win.__p2pNetDebug!().mode === 'p2p', 5_000, '旁路升级建成');
  assert.equal(win.__p2pNetDebug!().immersive, true, '升级不得打破沉浸');
  assert.equal(disp('connBar'), 'none');
  assert.equal(disp('tabbar'), 'none');
});

test('点 wakePill → 退出沉浸（chrome 恢复，pill 隐藏）', async () => {
  h.el('wakePill').onclick!();
  assert.equal(win.__p2pNetDebug!().immersive, false);
  assert.equal(disp('connBar'), 'flex');
  assert.equal(disp('tabbar'), 'flex');
  assert.equal(disp('wakePill'), 'none');
});

test('退出后 50ms 无交互 → 自动回沉浸（仍有选中服务）', async () => {
  await h.waitFor(() => win.__p2pNetDebug!().immersive === true, 2_000, '50ms 后自动回沉浸');
});

test('交互重置计时：退出→30ms 后 poke→再过 40ms 仍未回；等到 >50ms 无交互才回', async () => {
  h.el('wakePill').onclick!(); // 退出沉浸，重新排 50ms
  assert.equal(win.__p2pNetDebug!().immersive, false);
  await sleep(30);
  win.__p2pNetPoke!(); // 交互：重置计时（新的 50ms 从此刻起算）
  await sleep(40); // 距 poke 40ms < 50ms
  assert.equal(win.__p2pNetDebug!().immersive, false, 'poke 重置后未到点不得回沉浸');
  await h.waitFor(() => win.__p2pNetDebug!().immersive === true, 2_000, 'poke 后 50ms 无交互回沉浸');
});

test('切到 devices tab → 退出沉浸且不再自动回', async () => {
  h.el('wakePill').onclick!(); // 先退出（排上 50ms 计时）
  showTab('devices');
  assert.equal(win.__p2pNetDebug!().immersive, false);
  await sleep(150); // 远超 50ms
  assert.equal(win.__p2pNetDebug!().immersive, false, '切 tab 后不得自动回沉浸');
});

test('切回 workspace tab（仍有选中服务）→ 重新进入沉浸', async () => {
  showTab('workspace');
  assert.equal(win.__p2pNetDebug!().immersive, true);
});

// 评审 C3（2026-09-28）：手动断开必须复位沉浸状态机——断开按钮在 connBar（沉浸中不可见），
// 用户必先点 ∧ 唤起 → 排上 50ms（生产 4s）回程计时 → 窗口内点断开；若 stopSession 不清计时器，
// 到点后在已断开的会话上进沉浸（chrome 躲猫猫死循环，唯一出路是 4s 窗口内抢 tabbar）。
test('手动断开 → chrome 恢复、回程计时作废、selectedPort 清空，不再自动回沉浸（C3）', async () => {
  assert.equal(win.__p2pNetDebug!().immersive, true, '前置：上一用例切回工作台后处于沉浸');
  h.el('wakePill').onclick!(); // 唤起：退沉浸并排上 50ms 回程
  assert.equal(win.__p2pNetDebug!().immersive, false);
  h.el('btnDisconnect').onclick!(); // 回程窗口内手动断开
  assert.equal(disp('connBar'), 'flex', '断连后 chrome 必须可见');
  assert.equal(disp('tabbar'), 'flex');
  assert.equal(disp('wakePill'), 'none');
  assert.equal(win.__p2pNetDebug!().selectedPort, null, '断连后选中清空（防下次重连闪出死 iframe）');
  await sleep(150); // 远超 50ms 回程点
  assert.equal(win.__p2pNetDebug!().immersive, false, '断连后不得自动回沉浸');
});

// 文件级清场：无论断言成败都断开连接，防 p2pupg 退避计时器钉住进程（2026-09-28 实锤）
after(() => { h.el('btnDisconnect').onclick?.(); });
