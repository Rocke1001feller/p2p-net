/**
 * pathType PWA 侧 conformance（机制丙1）：与 host 侧 src/tests/path-parity.parity.ts 读同一份
 * 共享语料 contracts/path-type-corpus.json。断言面即 PWA 真实消费面——'p2p-net/browser'
 * （dist 产物，需先 npm run build）+ FrameLedger 集成路径。两侧断言完全一致即无双判据漂移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyCandidateType, classifyVia, selectedPairStats } from 'p2p-net/browser';
import { FrameLedger } from './frameLedger.js';

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
  test(`corpus stats[${c.shape}]：${c.name}（browser 入口直测）`, () => {
    const r = selectedPairStats(c.rows);
    assert.equal(r.found, c.expect.found, '选定对检出');
    assert.equal(r.pathType, c.expect.pathType, 'pathType');
    assert.equal(r.wireSent, c.expect.wireSent, 'wireSent');
    assert.equal(r.wireRecv, c.expect.wireRecv, 'wireRecv');
  });

  test(`corpus stats[${c.shape}]：${c.name}（FrameLedger 集成）`, () => {
    const l = new FrameLedger();
    l.sampleWireStats(c.rows);
    assert.equal(l.pathType, c.expect.pathType, '账本 pathType（unknown 不污染语义：未选中时保持初始 unknown）');
    assert.equal(l.wireBytesSent, 0, '首拍只建基线不计增量');
    assert.equal(l.wireBytesRecv, 0, '首拍只建基线不计增量');
  });
}
