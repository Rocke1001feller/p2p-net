import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('npm pack 内容包含 dist/node-init/pwa-dist/supabase/contracts', () => {
  // 注意：npm pack --dry-run 会跑 prepack 链（build + build:pwa）——这是有意的：
  // 门禁卡的是「完整构建链跑完后 tarball 里有什么」，不是某个快照目录。
  // prepack 的 stdout（tsc/vite 构建日志）与 --json 输出同走 stdout，
  // 故定位首个行首 '[' 截取 JSON 段再解析（npm 的 --json 输出永远以行首 [ 开头）。
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
  const jsonStart = out.search(/^\[/m);
  assert.ok(jsonStart >= 0, 'npm pack --dry-run --json 输出中找不到 JSON 数组');
  const files: { path: string }[] = JSON.parse(out.slice(jsonStart))[0].files;
  const paths = files.map((f) => f.path);
  for (const need of ['dist/index.js', 'dist/browser.js', 'dist/cli/bin.js', 'node-init/init-node.sh', 'supabase/ddl/0001_core.sql', 'contracts/ports.json', 'pwa-dist/index.html', 'pwa-dist/sw.js', 'LICENSE', 'README.md']) {
    assert.ok(paths.includes(need), `tarball 缺 ${need}`);
  }
  assert.ok(!paths.some((p) => p.includes('.test.') || p.startsWith('src/') || p.startsWith('pwa/src')), '测试与源码不应进包');
});

test('README 含三件准备 + 快速开始 + 安全组端口清单', () => {
  const md = readFileSync('README.md', 'utf8');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const s of ['Supabase Access Token', `npx ${pkg.name} init`, `npx ${pkg.name} start`, '3478', '50000']) {
    assert.ok(md.includes(s), `README 缺 ${s}`);
  }
});
