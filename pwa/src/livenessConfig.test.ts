import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIVENESS, livenessFromQuery } from './livenessConfig.js';

test('默认值钉死（spec D7）：ping 5s / liveness 15s(3拍) / wedge 60s', () => {
  assert.deepEqual({ ...DEFAULT_LIVENESS }, { pingMs: 5_000, livenessMs: 15_000, wedgeMs: 60_000 });
});

test('URL 标定：?ping=&liveness=&wedge=（秒）覆盖；非法/缺省回落默认', () => {
  assert.deepEqual(livenessFromQuery(new URLSearchParams('liveness=45')), { pingMs: 5_000, livenessMs: 45_000, wedgeMs: 60_000 });
  assert.deepEqual(livenessFromQuery(new URLSearchParams('ping=2&wedge=30')), { pingMs: 2_000, livenessMs: 15_000, wedgeMs: 30_000 });
  assert.deepEqual(livenessFromQuery(new URLSearchParams('liveness=-3&ping=abc')), { ...DEFAULT_LIVENESS });
  assert.deepEqual(livenessFromQuery(new URLSearchParams('')), { ...DEFAULT_LIVENESS });
});
