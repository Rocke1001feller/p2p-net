#!/usr/bin/env node
/**
 * 丙2 孪生复活门禁：递归扫描 pwa/src 下全部 .ts（排除 *.test.ts），命中
 * TWIN_REGISTRY 已登记的孪生模式即非零退出，打印命中位置 + 单一事实源指向。
 *
 * 背景：审计结论「孪生副本是误判复发根源」。副本被结构消灭（甲波次）后，任何
 * 复活尝试必须在本门禁机械失败，不依赖人记得。登记即永久：新发现的孪生在结构
 * 消灭后把指纹补进 TWIN_REGISTRY。
 *
 * 零依赖纯 Node（Node 20+）；可单跑：`node scripts/twin-guard.mjs [仓库根]`。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 孪生登记表（唯一新增入口）。
 * - name:      孪生名（报告标题）
 * - pattern:   命中正则（按子串扫全文；只许匹配分类/契约本体，勿匹配合法引用）
 * - canonical: 单一事实源指向
 * - note:      说明——该模式为何只许存在于 canonical
 */
export const TWIN_REGISTRY = [
  {
    name: 'pathType 分类孪生',
    // 指纹取 srflx/prflx 相等比较：PathType 取值域为 direct/relay/tunnel/unknown，
    // 合法 PWA 代码不会与 srflx/prflx 做 === 比较，出现即 candidateType 分类判据。
    pattern: /===\s*['"](?:srflx|prflx)['"]/,
    canonical: 'src/pathType.ts classifyCandidateType（PWA 应经根包 ./browser 导出复用）',
    note: '2026-09-23 pwa/src/frameLedger.ts 曾内联同源副本（relay/host/srflx/prflx 分支判定），双侧规则修订时两侧漂移即 F8 级误判温床。',
  },
  {
    name: '端口字面量副本',
    pattern: /(?<!\d)(?:19728|3478)(?!\d)/,
    canonical: 'contracts/ports.json（DISCOVERY_PORT=19728 / STUN_PORT=3478）',
    note: '端口契约字面量（含注释中的）不许出现在 PWA 源码；改由契约单一事实源生成/注入。',
  },
];

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

/** 扫单文件内容，返回命中列表 [{ file, line, name, canonical, note }]。 */
export function scanContent(filePath, content, registry = TWIN_REGISTRY) {
  const hits = [];
  for (const entry of registry) {
    const flags = entry.pattern.flags.includes('g') ? entry.pattern.flags : entry.pattern.flags + 'g';
    const re = new RegExp(entry.pattern.source, flags);
    let m;
    while ((m = re.exec(content)) !== null) {
      if (m[0].length === 0) re.lastIndex++; // 防御零宽匹配死循环
      hits.push({ file: filePath, line: lineOf(content, m.index), name: entry.name, canonical: entry.canonical, note: entry.note });
    }
  }
  return hits;
}

/** 收集扫描对象：pwa/src 下递归全部 .ts，排除 *.test.ts。 */
export function collectTargetFiles(srcDir) {
  if (!existsSync(srcDir)) throw new Error(`未找到扫描目录 ${srcDir}（应在仓库根运行，或传入仓库根路径参数）`);
  const out = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith('.ts') && !d.name.endsWith('.test.ts')) out.push(p);
    }
  };
  walk(srcDir);
  return out.sort();
}

/** 扫仓库根的 pwa/src 树，返回全部命中。 */
export function scanTree(rootDir, registry = TWIN_REGISTRY) {
  const srcDir = join(rootDir, 'pwa', 'src');
  const hits = [];
  for (const f of collectTargetFiles(srcDir)) {
    hits.push(...scanContent(f, readFileSync(f, 'utf8'), registry));
  }
  return hits;
}

export function formatReport(hits, rootDir) {
  const lines = [`twin-guard: 检出 ${hits.length} 处已登记孪生模式（违背单一事实源，门禁失败）:`];
  for (const h of hits) {
    lines.push(`  ${relative(rootDir, h.file)}:${h.line}  [${h.name}]`);
    lines.push(`      单一事实源 → ${h.canonical}`);
    lines.push(`      ${h.note}`);
  }
  return lines.join('\n');
}

const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const rootDir = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
  try {
    const hits = scanTree(rootDir);
    if (hits.length === 0) {
      console.log('twin-guard: pwa/src 未检出已登记孪生模式 ✓');
    } else {
      console.error(formatReport(hits, rootDir));
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`twin-guard: ${err.message}`);
    process.exitCode = 2;
  }
}
