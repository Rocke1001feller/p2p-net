import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServiceTree } from './serviceTree.js';

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
