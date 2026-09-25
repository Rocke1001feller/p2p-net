import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('browser 入口源码图不 import werift（barrel 只含 signaling/frames/status/pathType/natfacts）', () => {
  const sources = [
    'src/browser.ts',
    'src/signaling/protocol.ts',
    'src/signaling/client.ts',
    'src/frames.ts',
    'src/status.ts',
    'src/ports.ts',
    'src/pathType.ts',
    'src/natfacts.ts',
  ];
  for (const rel of sources) {
    const text = readFileSync(path.join(root, rel), 'utf8');
    assert.doesNotMatch(text, /from\s+['"]werift['"]/, `${rel} 不得引入 werift`);
    assert.doesNotMatch(text, /from\s+['"]\.\/bridge\/|from\s+['"]\.\/peer\.js|from\s+['"]\.\/host\.js/, `${rel} 不得引入 Node 桥/peer`);
  }
  // natfacts 必须保持纯模块零 Node 依赖（schema 单源经 barrel 进浏览器）；
  // dgram 采集器在 natfactsHost.ts，严禁进 barrel——browser-entry 门禁只拦 werift，
  // dgram 靠这条模块拆分断言拦截。
  const natfacts = readFileSync(path.join(root, 'src/natfacts.ts'), 'utf8');
  assert.doesNotMatch(natfacts, /from\s+['"]node:/, 'src/natfacts.ts 不得引入 Node 内建模块');
  assert.doesNotMatch(
    readFileSync(path.join(root, 'src/browser.ts'), 'utf8'),
    /from\s+['"]\.\/natfactsHost/,
    'browser barrel 不得导出 dgram 采集器',
  );
});

test('dist/browser.js 构建产物不含 werift 引用（需先 npm run build）', () => {
  const dist = path.join(root, 'dist/browser.js');
  assert.equal(existsSync(dist), true, 'dist/browser.js 不存在——请先运行 npm run build');
  const text = readFileSync(dist, 'utf8');
  // 断言的是 werift 模块引用（import/require 字符串），注释文本中的"werift"字样不算
  assert.doesNotMatch(text, /from\s+['"]werift['"]/, 'browser 入口 bundle 引入了 werift');
  assert.doesNotMatch(text, /import\(\s*['"]werift['"]/, 'browser 入口 bundle 动态引入了 werift');
  assert.doesNotMatch(text, /require\(\s*['"]werift['"]/, 'browser 入口 bundle require 了 werift');
  assert.ok(text.includes('SignalingClient'), 'browser 入口应导出信令客户端');
  assert.ok(text.includes('judgeMappingConsistency'), 'browser 入口应导出 NAT facts 判定表（W2-2 schema 单源）');
});

test('dist/ports.js 直读 contracts/ports.json（端口契约浏览器侧无副本的机制锚点，需先 npm run build）', () => {
  const dist = path.join(root, 'dist/ports.js');
  assert.equal(existsSync(dist), true, 'dist/ports.js 不存在——请先运行 npm run build');
  const text = readFileSync(dist, 'utf8');
  // 机制要求：emit 保留对 ports.json 的 JSON import（值由 bundler/运行时从同一物理文件取），
  // 一旦有人把端口值内联成字面量（重新制造副本），本断言立刻红。
  assert.ok(
    text.includes("'../contracts/ports.json'"),
    'dist/ports.js 应保留对 contracts/ports.json 的 import（单一事实源），不得内联字面量',
  );
});

test('package.json exports 映射：. / ./browser / ./package.json', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['.'].default, './dist/index.js');
  assert.equal(pkg.exports['./browser'].default, './dist/browser.js');
  assert.equal(pkg.exports['./package.json'], './package.json');
  // 主套件同时覆盖 src/ 与 pwa/src/（2026-09-22 起：pwa 测试此前不在主 glob 里，bind 解析 bug 漏网）
  // 2026-09-24 起拆两段：并行套件（本 pin 守护的覆盖范围不变）+ 串行 HOL 门禁（CPU 竞争敏感，隔离单跑以保预注册判定口径——≥10 窗口探测/增量公式/粘滞断言——在常态负载下有效；阈值数值修订史见 hol-gate.serial.ts 头注释）
  // 2026-09-25 起接第三段 test:parity（机制丙1）：pathType 双侧 conformance，host/PWA 读同一语料
  // contracts/path-type-corpus.json 断言一致；*.parity.ts 不匹配 *.test.ts glob，仅由本脚本运行。
  assert.equal(pkg.scripts['test:parallel'], 'tsx --test "src/**/*.test.ts" "pwa/src/**/*.test.ts"');
  // 2026-09-25 起 test 链最前接入 lint:twins（丙2 孪生复活门禁）：检出已登记孪生即短路失败
  assert.equal(pkg.scripts['lint:twins'], 'node scripts/twin-guard.mjs');
  assert.equal(pkg.scripts['test:parity'], 'tsx --test "src/**/*.parity.ts" "pwa/src/**/*.parity.ts"');
  assert.equal(pkg.scripts.test, 'npm run lint:twins && npm run test:parallel && npm run test:serial && npm run test:parity');
});
