import test from 'node:test';
import assert from 'node:assert/strict';
import { installShellHarness } from './shell.test-harness.js';

/**
 * 任务B：PWA 隧道会话埋点（tunnel-session start/end）。
 * 全链路驱动真实 shell.ts：dev 钩子 + ?tunnel=1 强制隧道，fetch 桩抓信令 POST。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-test&device=phone-test&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1',
});

await import('./shell.js');

interface P2pNetWindow {
  __p2pNetConnect?: (deskId?: string) => Promise<void>;
  __p2pNetFlap?: (reason?: string) => void;
  __p2pNetDebug?: () => { desk: { id: string }; mode: string | null; connected: boolean };
}
const win = h.window as unknown as P2pNetWindow;

const tunnelSessionMsgs = () => h.sentSig.filter((m) => m.msg.type === 'tunnel-session');

test('boot 就绪：dev 钩子导出 + desk 锚定', async () => {
  await h.waitFor(() => typeof win.__p2pNetConnect === 'function', 5_000, '__p2pNetConnect 导出');
  await h.waitFor(() => win.__p2pNetDebug?.().desk.id === 'desk-1', 5_000, 'desk.id 锚定 desk-1');
});

test('隧道 connected → start 埋点（消息体钉死：room/sender/sid/phase/access/from）', async () => {
  h.localStorage.setItem('p2p-net.pwa.access', 'wifi-office'); // W2-1 手动标注键
  await win.__p2pNetConnect!();
  assert.equal(win.__p2pNetDebug!().mode, 'tunnel', '?tunnel=1 必须落隧道');
  const msgs = tunnelSessionMsgs();
  assert.equal(msgs.length, 1, '首次 tunnel connected 只发一条 start');
  const m = msgs[0]!;
  assert.equal(m.room, 'sig:uid-test:desk-1', '发往 host 房间 roomFor(uid, desk.id)');
  assert.equal(m.sender, 'phone-test');
  assert.equal(m.msg.phase, 'start');
  assert.equal(m.msg.access, 'wifi-office', 'access 读 LS 键 p2p-net.pwa.access');
  assert.equal(m.msg.from, 'phone-test');
  assert.match(String(m.msg.sid), /^tun_/, 'sid 形如 tun_<uuid>');
});

test('重连（startConnect 重建旧实例前）→ 先 end 旧 sid 再 start 新 sid', async () => {
  const sid1 = String(tunnelSessionMsgs()[0]!.msg.sid);
  await win.__p2pNetConnect!();
  const msgs = tunnelSessionMsgs();
  assert.deepEqual(msgs.map((m) => m.msg.phase), ['start', 'end', 'start'], '重连时序：start→end→start');
  assert.equal(msgs[1]!.msg.sid, sid1, 'end 必须携带旧 sid');
  assert.notEqual(msgs[2]!.msg.sid, sid1, '新会话必须换新 sid');
  assert.equal(msgs[2]!.msg.phase, 'start');
});

test('链路 off（flap 拆连）→ end；自动重连落隧道 → 再次 start', async () => {
  const sid2 = String(tunnelSessionMsgs().at(-1)!.msg.sid);
  win.__p2pNetFlap!('test');
  await h.waitFor(() => tunnelSessionMsgs().some((m) => m.msg.phase === 'end' && m.msg.sid === sid2), 5_000, 'off 触发 end');
  // off 之后 wasConnected 仍 true → 500ms 自动重连 → 新 start
  await h.waitFor(() => tunnelSessionMsgs().filter((m) => m.msg.phase === 'start').length === 3, 5_000, '自动重连后新 start');
});

test('stopSession → end；无活跃会话时 end 空转（重复断开不增量）', async () => {
  const sid3 = String(tunnelSessionMsgs().at(-1)!.msg.sid);
  h.el('btnDisconnect').onclick!(); // = stopSession
  await h.waitFor(() => tunnelSessionMsgs().some((m) => m.msg.phase === 'end' && m.msg.sid === sid3), 5_000, 'stopSession 触发 end');
  const total = tunnelSessionMsgs().length;
  h.el('btnDisconnect').onclick!(); // 再断一次：无活跃会话，end 必须空转
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(tunnelSessionMsgs().length, total, '重复 stopSession 不得再发任何 tunnel-session');
});

test('双桌切换：end 发往开账桌面 A 的房间，B 房间零 end-without-start 噪声（终审 Important）', async () => {
  // 上个用例收尾于手动断开（无活跃会话）。先连回 desk-1 隧道开账：
  await win.__p2pNetConnect!();
  const roomA = 'sig:uid-test:desk-1';
  const roomB = 'sig:uid-test:desk-B';
  await h.waitFor(() => tunnelSessionMsgs().some((m) => m.msg.phase === 'start' && m.room === roomA), 5_000, 'A 房间开账 start');
  const sidA = String(tunnelSessionMsgs().filter((m) => m.room === roomA).at(-1)!.msg.sid);
  try {
    // 设备列表点选桌面 B 的等价路径：__p2pNetConnect 直达 startConnect，不经 stopSession。
    // startConnect 顶部即把 desk.id 改写成 B——end 若按发送时刻 desk.id 组房间就会错发进 B。
    await win.__p2pNetConnect!('desk-B');
    await h.waitFor(() => tunnelSessionMsgs().some((m) => m.msg.phase === 'end' && m.msg.sid === sidA), 5_000, '切换触发 sidA 的 end');
    const endA = tunnelSessionMsgs().find((m) => m.msg.phase === 'end' && m.msg.sid === sidA)!;
    assert.equal(endA.room, roomA, 'end 必须发回开账桌面 A 的房间（host A 才收得到终结）');
    assert.ok(
      !tunnelSessionMsgs().some((m) => m.room === roomB && m.msg.sid === sidA),
      'B 房间不得出现 sidA 的任何帧（end-without-start 噪声）',
    );
    // 新会话在 B 正常开账（新 sid 的 start 落 B 房间）
    await h.waitFor(() => tunnelSessionMsgs().some((m) => m.msg.phase === 'start' && m.room === roomB), 5_000, 'B 房间新会话 start');
    assert.notEqual(String(tunnelSessionMsgs().find((m) => m.room === roomB)!.msg.sid), sidA, 'B 会话必须换新 sid');
  } finally {
    // 断言变红也必须终结 B 会话——否则 P2pUpgrade 看门狗的退避定时器把测试进程钉死
    h.el('btnDisconnect').onclick!();
  }
});
