/**
 * 信令守卫 host 侧 conformance（W2-6）：与 PWA 侧 pwa/src/signaling-parity.parity.ts 读同一份
 * 共享语料 contracts/signaling-corpus.json，逐条断言 isSigMessage 判定一致。
 * 覆盖 'upgrade' 帧（host→PWA 请求发起 ICE restart）、缺 sid 拒绝、未知类型拒绝与既有类型兼容。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isSigMessage } from '../signaling/protocol.js';

const corpus = JSON.parse(readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../contracts/signaling-corpus.json'),
  'utf8',
)) as {
  cases: { raw: unknown; valid: boolean; type?: string; note?: string }[];
};

test('parity: 信令守卫 host 侧（含 upgrade 帧）', () => {
  for (const c of corpus.cases) {
    assert.equal(isSigMessage(c.raw), c.valid, JSON.stringify(c.raw));
    if (c.valid) assert.equal((c.raw as { type: string }).type, c.type);
  }
});
