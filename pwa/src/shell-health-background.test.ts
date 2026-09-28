import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEl, installShellHarness } from './shell.test-harness.js';

/**
 * 评审 I4（2026-09-28）：体检链必须后台化且覆盖全部服务。
 * 旧门 `if (port !== consolePort) return`（单服务时代写法）在多服务时代双向反噬：
 *   ① console 体检重载走前台 openService → 用户切到别的服务后，被后台重载拽回 console
 *      （选中/视图/lastService/沉浸全被改写，蜂窝黑洞期高频）；
 *   ② 非 console 服务的体检第一拍即死 → 首屏 504 黑洞（2026-09-12 根治项）对非 console 不再自愈。
 * 期望：体检重载走 background（只修数据面，不抢选中）；门改为 tabs.has(port)；
 *      giveup 离线条只在「用户正看着的服务」上弹，后台服务 giveup 只记日志。
 * 可测性：harness 新增 dataPlaneAlive 载荷位（/s/N/api/* 回 200；默认仍 503 判死 defer），
 *        shell 新增 ?healthdelay=<ms> 排障钩子（与 ?wakeidle= 同款），生产默认节奏不变。
 */
const h = installShellHarness({
  search: '?dev=1&jwt=j&uid=uid-hb&device=phone-hb&desk=desk-1&t=dummy'
    + '&u=https://gw.example.com/tunnel/s/abc&tunnel=1&healthdelay=40',
  services: {
    console: '/s/3001/',
    services: [
      { name: 'vite dev', url: '/s/3000/', port: 3000 },
      { name: 'Claude 工作台', url: '/s/3001/', port: 3001 },
    ],
  },
  dataPlaneAlive: true,
  observeTextIds: ['log'],
});

await import('./shell.js');

const win = h.window as unknown as {
  __p2pNetConnect?: (deskId?: string) => Promise<void>;
  __p2pNetDebug?: () => { selectedPort: number | null };
};
// 2026-09-28 多设备侧栏树：svcTree 下是组容器两层结构，按端口找行要下钻一层
const svcRowOf = (port: number): FakeEl | undefined => {
  for (const g of h.el('svcTree').children as FakeEl[]) {
    const r = (g.children as FakeEl[]).find((x) => x.dataset.port === String(port));
    if (r) return r;
  }
  return undefined;
};
const frameOf = (port: number): FakeEl | undefined =>
  (h.el('appHost').children as FakeEl[]).find((f) => f.id === `svc-${port}`);
const logs = (): string => (h.textLog['log'] ?? []).join('\n');
const sheetShown = (): boolean => h.el('offlineSheet').classList.contains('show');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('boot：数据面活着 → console 3001 默认选中且 src 落位（开窗成功，体检链武装）', async () => {
  await h.waitFor(() => typeof win.__p2pNetConnect === 'function', 5_000, '__p2pNetConnect 导出');
  await win.__p2pNetConnect!();
  await h.waitFor(() => win.__p2pNetDebug!().selectedPort === 3001, 5_000, 'selectedPort=3001');
  await h.waitFor(() => frameOf(3001)?.src === '/s/3001/', 5_000, 'console src 落位');
});

test('用户切到 3000 后：console 体检重载在后台进行，不抢选中/视图/记忆（I4 ①）', async () => {
  svcRowOf(3000)!.onclick!();
  await h.waitFor(() => win.__p2pNetDebug!().selectedPort === 3000, 5_000, 'selectedPort=3000');
  await h.waitFor(() => /首屏未起来（第 1 次）→ 重载/.test(logs()), 5_000, '体检重载发生');
  await sleep(200); // 让两条体检链多走几拍（console 后台重载含其中）
  assert.equal(win.__p2pNetDebug!().selectedPort, 3000, '后台体检重载不得抢选中');
  assert.equal(frameOf(3001)!.style.display, 'none', 'console 重载不得把它拽上前台');
  assert.equal(frameOf(3000)!.style.display, 'block');
  assert.match(h.localStorage.getItem('p2p-net.pwa.lastService') ?? '', /3000/, 'lastService 不得被覆写');
  assert.equal(sheetShown(), false, '重载进行阶段不得弹离线条');
});

test('非 console（当前选中 3000）体检链同样运转 → giveup 弹离线条；console 后台 giveup 只记日志（I4 ②）', async () => {
  await h.waitFor(() => sheetShown(), 8_000, '选中服务重载多次未果 → 弹离线条（旧门下此链第一拍即死）');
  assert.match(logs(), /后台服务 \d+ 重载多次仍未起来/, '非选中服务 giveup 只记日志不弹条');
  assert.equal(win.__p2pNetDebug!().selectedPort, 3000, '全程选中不被后台逻辑改写');
});

// 文件级清场：无论断言成败都断开连接，防计时器钉住进程（2026-09-28 实锤）
after(() => { h.el('btnDisconnect').onclick?.(); });
