/**
 * 信令守卫 PWA 侧 conformance（W2-6）：与 host 侧 src/tests/signaling-parity.parity.ts 读同一份
 * 共享语料 contracts/signaling-corpus.json。断言面即 PWA 真实消费面——'p2p-net/browser'
 * （dist 产物，需先 npm run build）。两侧断言完全一致即无双判据漂移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isSigMessage } from 'p2p-net/browser';

const corpus = JSON.parse(readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../contracts/signaling-corpus.json'),
  'utf8',
)) as {
  cases: { raw: unknown; valid: boolean; type?: string; note?: string }[];
};

test('parity: 信令守卫 PWA 侧（含 upgrade 帧）', () => {
  for (const c of corpus.cases) {
    assert.equal(isSigMessage(c.raw), c.valid, JSON.stringify(c.raw));
    if (c.valid) assert.equal((c.raw as { type: string }).type, c.type);
  }
});
