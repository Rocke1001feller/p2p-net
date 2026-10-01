/** serviceSnapshot 契约：活清单落盘/读回/校验/容量淘汰/坏数据兜底。 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { readSnapshots, saveSnapshot } from './serviceSnapshot.js';

function memStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
}

test('保存后读回，字段完整', () => {
  const s = memStorage();
  saveSnapshot(s, 'dev-a', [{ name: 'devanywhere-ui', port: 3001 }, { name: 'vite', port: 5173 }]);
  const m = readSnapshots(s);
  assert.equal(m['dev-a'].services.length, 2);
  assert.equal(m['dev-a'].services[0].name, 'devanywhere-ui');
  assert.ok(m['dev-a'].at > 0);
});

test('空清单不覆盖旧快照', () => {
  const s = memStorage();
  saveSnapshot(s, 'dev-a', [{ name: 'x', port: 1 }]);
  saveSnapshot(s, 'dev-a', []);
  assert.equal(readSnapshots(s)['dev-a'].services[0].name, 'x');
});

test('坏数据静默兜底为空表', () => {
  const s = memStorage();
  s.setItem('p2p-net.pwa.serviceSnapshots', '{not json');
  assert.deepEqual(readSnapshots(s), {});
  s.setItem('p2p-net.pwa.serviceSnapshots', JSON.stringify({ 'dev-b': { at: 1, services: [{ name: 'ok', port: 8 }, { bad: true }, { name: 'no-port' }] } }));
  const m = readSnapshots(s);
  assert.equal(m['dev-b'].services.length, 1);
  assert.equal(m['dev-b'].services[0].port, 8);
});

test('容量上限：超过 12 台淘汰最旧', () => {
  const s = memStorage();
  for (let i = 0; i < 14; i++) {
    saveSnapshot(s, `dev-${i}`, [{ name: 's', port: i + 1 }]);
    // 保证 at 严格递增
    const m = JSON.parse(s.getItem('p2p-net.pwa.serviceSnapshots')!);
    m[`dev-${i}`].at = i + 1;
    s.setItem('p2p-net.pwa.serviceSnapshots', JSON.stringify(m));
  }
  const m = readSnapshots(s);
  assert.equal(Object.keys(m).length, 12);
  assert.equal(m['dev-0'], undefined);
  assert.equal(m['dev-1'], undefined);
  assert.ok(m['dev-13']);
});
