import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('browser 入口源码图不 import werift（barrel 只含 signaling/frames/status）', () => {
  const sources = [
    'src/browser.ts',
    'src/signaling/protocol.ts',
    'src/signaling/client.ts',
    'src/frames.ts',
    'src/status.ts',
  ];
  for (const rel of sources) {
    const text = readFileSync(path.join(root, rel), 'utf8');
    assert.doesNotMatch(text, /from\s+['"]werift['"]/, `${rel} 不得引入 werift`);
    assert.doesNotMatch(text, /from\s+['"]\.\/bridge\/|from\s+['"]\.\/peer\.js|from\s+['"]\.\/host\.js/, `${rel} 不得引入 Node 桥/peer`);
  }
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
});

test('package.json exports 映射：. / ./browser / ./package.json', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['.'].default, './dist/index.js');
  assert.equal(pkg.exports['./browser'].default, './dist/browser.js');
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.equal(pkg.scripts.test, 'tsx --test "src/**/*.test.ts"');
});
