#!/usr/bin/env node
/**
 * docs-guard 文档防漂移门禁：把「契约单一事实源」机制从端口推广到文档层。
 *
 * 硬门禁（命中 exit 1）：
 *   1. 版本一致：package.json.version === CHANGELOG.md 最新一条非 Unreleased 标题版本号。
 *   2. Markdown 死链：git 跟踪的 .md 中 `](相对路径)` 链接解析后必须存在。
 * 警告（打印到 stderr，exit 0）：
 *   3. ROADMAP 对账：CHANGELOG 每个 release 版本号应在 ROADMAP.md 或 git tag 中有对应。
 *   4. 活文档行号引用：活文档中出现 `xxx.ts:123` 形态（漂移之源，应改符号引用）。
 *
 * 零依赖纯 Node（Node 20+）；可单跑：`node scripts/docs-guard.mjs [仓库根]`。
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 活文档清单：行号引用检查的扫描对象。 */
export const LIVING_DOCS = [
  'README.md',
  'ROADMAP.md',
  'CHANGELOG.md',
  'docs/cost-model.md',
  'docs/concepts-direct-relay-tunnel.md',
];

/** 检查 1：版本一致。返回错误列表（空 = 通过）。 */
export function checkVersion(rootDir) {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const changelog = readFileSync(join(rootDir, 'CHANGELOG.md'), 'utf8');
  const m = changelog.match(/^## (\d+\.\d+\.\d+)（/m);
  if (!m) return [`CHANGELOG.md 未找到形如 '## x.y.z（日期）' 的版本标题`];
  if (m[1] !== pkg.version) {
    return [`版本脱节：package.json=${pkg.version} 而 CHANGELOG 最新条目=${m[1]}`];
  }
  return [];
}

/** 去掉围栏代码块与行内代码段（文档中的示例文本不应参与链接/引用检查）。 */
export function stripCode(content) {
  return content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

/** 提取 md 内容中的相对链接目标（排除 http/mailto/# 锚）。 */
export function extractLinks(content) {
  const out = [];
  const re = /\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const raw = m[1];
    if (/^(https?:|mailto:|#)/.test(raw)) continue;
    out.push(raw.split('#')[0]);
  }
  return out.filter((p) => p.length > 0);
}

/** 检查 2：Markdown 死链。返回 [{ file, link }]。 */
export function checkLinks(rootDir) {
  const files = execSync('git ls-files "*.md"', { cwd: rootDir, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const broken = [];
  for (const file of files) {
    const content = stripCode(readFileSync(join(rootDir, file), 'utf8'));
    for (const link of extractLinks(content)) {
      if (!existsSync(join(rootDir, dirname(file), link))) broken.push({ file, link });
    }
  }
  return broken;
}

/** 检查 3：ROADMAP 对账（警告）。返回警告字符串列表。 */
export function checkRoadmap(rootDir) {
  const changelog = readFileSync(join(rootDir, 'CHANGELOG.md'), 'utf8');
  const roadmap = readFileSync(join(rootDir, 'ROADMAP.md'), 'utf8');
  const versions = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)（/gm)].map((m) => m[1]);
  const tags = new Set(
    execSync('git tag --list', { cwd: rootDir, encoding: 'utf8' }).split('\n').filter(Boolean),
  );
  const warnings = [];
  for (const v of versions) {
    if (!roadmap.includes(v) && !tags.has(`v${v}`)) {
      warnings.push(`CHANGELOG 版本 ${v} 在 ROADMAP.md 与 git tag 中均无对应（请登记或核对）`);
    }
  }
  return warnings;
}

/** 检查 4：活文档行号引用（警告）。返回 [{ file, line, hit }]。跳过围栏代码块与行内代码段。 */
export function checkLineRefs(rootDir) {
  const hits = [];
  for (const file of LIVING_DOCS) {
    const path = join(rootDir, file);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    let inFence = false;
    lines.forEach((text, i) => {
      if (text.trimStart().startsWith('```')) { inFence = !inFence; return; }
      if (inFence) return;
      const m = text.replace(/`[^`]*`/g, '').match(/[\w./-]+\.ts:\d+/);
      if (m) hits.push({ file, line: i + 1, hit: m[0] });
    });
  }
  return hits;
}

export function run(rootDir) {
  const errors = [];
  const warnings = [];

  errors.push(...checkVersion(rootDir));

  for (const b of checkLinks(rootDir)) {
    errors.push(`死链：${b.file} → ${b.link}`);
  }

  warnings.push(...checkRoadmap(rootDir));
  for (const h of checkLineRefs(rootDir)) {
    warnings.push(`行号引用（建议改符号引用）：${h.file}:${h.line} 含 ${h.hit}`);
  }

  return { errors, warnings };
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === new URL(`file://${process.argv[1]}`).pathname;
if (invokedAsScript) {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url));
  try {
    const { errors, warnings } = run(rootDir);
    for (const w of warnings) console.error(`docs-guard [警告] ${w}`);
    if (errors.length === 0) {
      console.log(`docs-guard: 版本一致 ✓ 死链 0 ✓（警告 ${warnings.length} 条）`);
    } else {
      console.error(`docs-guard: ${errors.length} 处硬门禁失败：`);
      for (const e of errors) console.error(`  ${e}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`docs-guard: ${err.message}`);
    process.exitCode = 2;
  }
}
