/**
 * pathType host 侧 conformance（机制丙1）：与 PWA 侧 pwa/src/path-parity.parity.ts 读同一份
 * 共享语料 contracts/path-type-corpus.json，逐条断言 classifyCandidateType / classifyVia /
 * selectedPairStats 输出一致。语料覆盖 werift 形状（无 selected，state==='succeeded' +
 * nominated 优先）与浏览器形状（selected===true 优先）——统一实现双形态通吃，两侧全量跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyCandidateType, classifyVia, selectedPairStats } from '../pathType.js';

const corpus = JSON.parse(readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../contracts/path-type-corpus.json'),
  'utf8',
)) as {
  candidateType: { name: string; input: string | null; expect: string }[];
  via: { name: string; input: string | null; expect: string }[];
  stats: { name: string; shape: string; rows: any[]; expect: { found: boolean; pathType: string; wireSent: number; wireRecv: number } }[];
};

for (const c of corpus.candidateType) {
  test(`corpus candidateType：${c.name}`, () => {
    assert.equal(classifyCandidateType(c.input ?? undefined), c.expect);
  });
}

for (const c of corpus.via) {
  test(`corpus via：${c.name}`, () => {
    assert.equal(classifyVia(c.input ?? undefined), c.expect);
  });
}

for (const c of corpus.stats) {
  test(`corpus stats[${c.shape}]：${c.name}`, () => {
    const r = selectedPairStats(c.rows);
    assert.equal(r.found, c.expect.found, '选定对检出');
    assert.equal(r.pathType, c.expect.pathType, 'pathType');
    assert.equal(r.wireSent, c.expect.wireSent, 'wireSent');
    assert.equal(r.wireRecv, c.expect.wireRecv, 'wireRecv');
  });
}
