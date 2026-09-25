/**
 * 丙2 孪生复活门禁（scripts/twin-guard.mjs）自测。
 *
 * 关键约束：全部用临时 fixture 目录，绝不扫真树——真树在甲1/甲2（结构消灭副本）
 * 合入前仍含孪生，扫真树会让本分支 npm test 必红；真树检出由人工直跑脚本验收。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanContent, scanTree, collectTargetFiles, TWIN_REGISTRY } from '../../scripts/twin-guard.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const scriptPath = join(repoRoot, 'scripts/twin-guard.mjs');

/** 2026-09-23 pwa/src/frameLedger.ts 孪生副本的逐字形态（git show b5303e0 前版本可考）。 */
const TWIN_PATH_TYPE = `
export type PathType = 'direct' | 'relay' | 'tunnel' | 'unknown';

function classifyCandidateType(ct: string | undefined): PathType {
  if (ct === 'relay') return 'relay';
  if (ct === 'host' || ct === 'srflx' || ct === 'prflx') return 'direct';
  return 'unknown';
}
`;

const TWIN_PORTS = `
export const DISCOVERY_PORT = 19728;
/** 自建 coturn 的 STUN 端口。 */
export const STUN_PORT = 3478;
`;

/** 合法形态：经 canonical 复用；pathType 结果值比较不是分类孪生。 */
const LEGIT = `
import { classifyCandidateType } from 'p2p-net/browser';
export function badge(pathType: string): string {
  if (pathType === 'relay') return '中继';
  if (pathType === 'direct') return '直连';
  return '未知';
}
export const describe = (ct?: string) => classifyCandidateType(ct);
`;

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'twin-guard-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

test('登记表形态：每条目 name/pattern/canonical/note 齐备且 pattern 为 RegExp', () => {
  assert.ok(TWIN_REGISTRY.length >= 2, '首批至少登记 pathType 孪生与端口字面量两条');
  for (const e of TWIN_REGISTRY) {
    assert.equal(typeof e.name, 'string'); assert.ok(e.name.length > 0);
    assert.ok(e.pattern instanceof RegExp, `${e.name}: pattern 必须是 RegExp`);
    assert.equal(typeof e.canonical, 'string'); assert.ok(e.canonical.length > 0);
    assert.equal(typeof e.note, 'string'); assert.ok(e.note.length > 0);
  }
});

test('正例：pathType 分类孪生（srflx/prflx 分支判定）被检出，行号指向分支行', () => {
  const hits = scanContent('pwa/src/frameLedger.ts', TWIN_PATH_TYPE);
  const pt = hits.filter((h) => h.name === 'pathType 分类孪生');
  assert.ok(pt.length >= 1, 'srflx/prflx 相等比较必须命中');
  assert.equal(pt[0].line, 6, '第一个命中在 `=== \'srflx\'` 分支行');
  assert.ok(pt[0].canonical.includes('src/pathType.ts'), '提示指向单一事实源');
});

test('正例：端口字面量副本逐行检出（19728 与 3478 各一条）', () => {
  const hits = scanContent('pwa/src/constants.ts', TWIN_PORTS).filter((h) => h.name === '端口字面量副本');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.line), [2, 4]);
});

test('负例：经 canonical 复用 + pathType 结果值比较，零命中（不误伤合法代码）', () => {
  assert.deepEqual(scanContent('pwa/src/ui.ts', LEGIT), []);
});

test('scanTree：fixture 正例检出两登记项；排除 .test.ts 与非 .ts；递归子目录', () => {
  const dir = fixture({
    'pwa/src/frameLedger.ts': TWIN_PATH_TYPE,
    'pwa/src/nested/constants.ts': TWIN_PORTS,
    'pwa/src/ui.ts': LEGIT,
    'pwa/src/evil.test.ts': TWIN_PATH_TYPE + TWIN_PORTS, // 测试文件豁免
    'pwa/src/notes.md': '19728 3478',                     // 非 .ts 豁免
  });
  try {
    const hits = scanTree(dir);
    const names = new Set(hits.map((h) => h.name));
    assert.ok(names.has('pathType 分类孪生') && names.has('端口字面量副本'));
    assert.ok(hits.every((h) => !h.file.endsWith('.test.ts') && h.file.endsWith('.ts')));
    assert.ok(hits.some((h) => h.file.includes('nested')), '子目录文件也要扫到');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectTargetFiles：只收 .ts 且排除 .test.ts', () => {
  const dir = fixture({
    'pwa/src/a.ts': '',
    'pwa/src/a.test.ts': '',
    'pwa/src/b/shim.js': '',
    'pwa/src/b/c.ts': '',
  });
  try {
    const files = collectTargetFiles(join(dir, 'pwa/src'));
    assert.deepEqual(files.map((f) => f.split('/pwa/src/')[1]).sort(), ['a.ts', 'b/c.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI 契约：fixture 含孪生 → 退出码非零，stderr 带位置与单一事实源指向', () => {
  const dir = fixture({ 'pwa/src/frameLedger.ts': TWIN_PATH_TYPE });
  try {
    const r = spawnSync(process.execPath, [scriptPath, dir], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, '检出孪生必须非零退出（门禁语义）');
    assert.match(r.stderr, /frameLedger\.ts:6/);
    assert.match(r.stderr, /pathType 分类孪生/);
    assert.match(r.stderr, /src\/pathType\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI 契约：fixture 干净 → 退出码 0', () => {
  const dir = fixture({ 'pwa/src/ui.ts': LEGIT });
  try {
    const r = spawnSync(process.execPath, [scriptPath, dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
