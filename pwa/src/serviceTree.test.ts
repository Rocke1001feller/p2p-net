import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServiceTree, buildDeviceGroups } from './serviceTree.js';

const svc = (port: number, name = `svc${port}`) => ({ port, name, url: `/s/${port}/` });

test('默认全部可见：无 hidden 时 visible=全量，顺序保持', () => {
  const m = buildServiceTree({
    services: [svc(3000), svc(3001), svc(3002)],
    hidden: [], consolePort: 3001, selectedPort: null, openPorts: [],
  });
  assert.deepEqual(m.visible.map((r) => r.port), [3000, 3001, 3002]);
  assert.deepEqual(m.hidden, []);
  assert.deepEqual(m.gone, []);
});

test('隐藏进 hidden 段；consolePort 在 hidden 里被忽略（console 不可隐藏）', () => {
  const m = buildServiceTree({
    services: [svc(3000), svc(3001), svc(3002)],
    hidden: [3001, 3002], consolePort: 3001, selectedPort: null, openPorts: [],
  });
  assert.deepEqual(m.visible.map((r) => r.port), [3000, 3001], 'console 3001 仍在 visible');
  assert.equal(m.visible[1].isConsole, true);
  assert.deepEqual(m.hidden.map((r) => r.port), [3002]);
});

test('gone：openPorts 有而 services 没有的端口进 gone 段（灰显「已离线」）', () => {
  const m = buildServiceTree({
    services: [svc(3000), svc(3001)],
    hidden: [], consolePort: 3001, selectedPort: 3000,
    openPorts: [3000, 3001, 3002],
  });
  assert.deepEqual(m.gone.map((r) => r.port), [3002]);
  assert.equal(m.gone[0].isGone, true);
  // gone 段不得重复出现在 visible
  assert.deepEqual(m.visible.map((r) => r.port), [3000, 3001]);
});

test('isSelected 标记与 selectedPort 一致', () => {
  const m = buildServiceTree({
    services: [svc(3000), svc(3001)],
    hidden: [], consolePort: null, selectedPort: 3000, openPorts: [3000],
  });
  assert.equal(m.visible[0].isSelected, true);
  assert.equal(m.visible[1].isSelected, false);
});

test('hidden 段与 gone 段保持各自原始顺序；已隐藏又消失的进 gone 而非 hidden', () => {
  const m = buildServiceTree({
    services: [svc(3003), svc(3001), svc(3002)],
    hidden: [3002, 3004], consolePort: null, selectedPort: null,
    openPorts: [3004],
  });
  assert.deepEqual(m.hidden.map((r) => r.port), [3002]);
  assert.deepEqual(m.gone.map((r) => r.port), [3004], '消失的服务进 gone（不替用户做减法）');
});

// ---- buildDeviceGroups（2026-09-28 多设备侧栏树）----

const dev = (id: string, name = id, lastAt = 0) => ({ id, name, lastAt });
const NO_HIDDEN = () => [];

test('多设备分组：在线组用活清单（console/selected/gone 语义生效），离线组用快照建行', () => {
  const groups = buildDeviceGroups({
    devices: [dev('mac', 'MacBook Pro', 200), dev('win', 'Windows 台式机', 100)],
    connectedId: 'mac',
    live: [svc(3000), svc(3001, 'console')],
    snapshots: { win: { at: 50, services: [{ name: 'Win A', port: 3000 }, { name: 'Win B', port: 8888 }] } },
    hiddenOf: NO_HIDDEN,
    consolePort: 3001, selectedPort: 3000, openPorts: [3000, 3001, 9999],
  });
  assert.equal(groups.length, 2);
  const mac = groups.find((g) => g.deviceId === 'mac')!;
  assert.equal(mac.online, true);
  assert.deepEqual(mac.visible.map((r) => r.port), [3000, 3001]);
  assert.equal(mac.visible[1].isConsole, true);
  assert.equal(mac.visible[0].isSelected, true);
  assert.deepEqual(mac.gone.map((r) => r.port), [9999]);
  const win = groups.find((g) => g.deviceId === 'win')!;
  assert.equal(win.online, false);
  assert.equal(win.snapAt, 50);
  assert.deepEqual(win.visible.map((r) => [r.port, r.name]), [[3000, 'Win A'], [8888, 'Win B']]);
  assert.ok(win.visible.every((r) => !r.isConsole && !r.isSelected && !r.isGone), '离线组行不得带活语义');
  assert.deepEqual(win.gone, [], '离线组没有 gone 段');
});

test('多设备分组：隐藏按设备隔离，互不影响', () => {
  const groups = buildDeviceGroups({
    devices: [dev('mac'), dev('win')],
    connectedId: 'win',
    live: [svc(3000)],
    snapshots: { mac: { at: 1, services: [{ name: 'M1', port: 3000 }, { name: 'M2', port: 3001 }] } },
    hiddenOf: (id) => (id === 'mac' ? [3001] : []),
    consolePort: null, selectedPort: null, openPorts: [3000],
  });
  const mac = groups.find((g) => g.deviceId === 'mac')!;
  assert.deepEqual(mac.visible.map((r) => r.port), [3000]);
  assert.deepEqual(mac.hidden.map((r) => r.port), [3001]);
  const win = groups.find((g) => g.deviceId === 'win')!;
  assert.deepEqual(win.visible.map((r) => r.port), [3000]);
  assert.deepEqual(win.hidden, []);
});

test('多设备分组：排序在线组第一，其余按 lastAt 降序', () => {
  const groups = buildDeviceGroups({
    devices: [dev('a', 'A', 100), dev('b', 'B', 300), dev('c', 'C', 200)],
    connectedId: 'a',
    live: [svc(3000)],
    snapshots: {},
    hiddenOf: NO_HIDDEN,
    consolePort: null, selectedPort: null, openPorts: [],
  });
  assert.deepEqual(groups.map((g) => g.deviceId), ['a', 'b', 'c']);
  // 无在线时纯按 lastAt 降序
  const none = buildDeviceGroups({
    devices: [dev('a', 'A', 100), dev('b', 'B', 300), dev('c', 'C', 200)],
    connectedId: null,
    live: [],
    snapshots: {},
    hiddenOf: NO_HIDDEN,
    consolePort: null, selectedPort: null, openPorts: [],
  });
  assert.deepEqual(none.map((g) => g.deviceId), ['b', 'c', 'a']);
});

test('多设备分组：无快照且未连接的设备给空组（渲染提示行用）', () => {
  const groups = buildDeviceGroups({
    devices: [dev('new')],
    connectedId: null,
    live: [],
    snapshots: {},
    hiddenOf: NO_HIDDEN,
    consolePort: null, selectedPort: null, openPorts: [],
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].online, false);
  assert.equal(groups[0].snapAt, undefined);
  assert.deepEqual(groups[0].visible, []);
  assert.deepEqual(groups[0].hidden, []);
  assert.deepEqual(groups[0].gone, []);
});
