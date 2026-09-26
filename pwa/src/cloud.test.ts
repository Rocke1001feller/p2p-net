import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBindResponse, ensureHostLabel } from './cloud.js';

// 2026-09-22 真机实锤：DDL returns uuid → PostgREST 直返裸字符串，
// 旧实现只认 {device_id} 对象形态 → 手机端绑定即抛错、永远连不上。
test('parseBindResponse：裸 uuid 字符串（DDL returns uuid 真实形态）', () => {
  assert.equal(parseBindResponse('bc0a0566-3f63-450c-a95c-5a27d26933ee'), 'bc0a0566-3f63-450c-a95c-5a27d26933ee');
});

test('parseBindResponse：jsonb 对象形态兜底（D-M1-3 历史形态）', () => {
  assert.equal(parseBindResponse({ device_id: 'x-y-z' }), 'x-y-z');
});

test('parseBindResponse：垃圾输入一律 null（调用方抛人话）', () => {
  for (const junk of [null, undefined, '', {}, { device_id: '' }, { device_id: 42 }, 0, false]) {
    assert.equal(parseBindResponse(junk), null, `junk=${JSON.stringify(junk)}`);
  }
});

// 2026-09-26 双机撞车实锤：bindPhone 用常量 hostname 'p2p-net-pwa'，bind_device_auth 幂等键
// (user_id, role, hostname) → 同账号两台手机绑到同一行 device → 同 deviceId 双活乒乓换绑。
// 修复：每安装生成一次稳定 hostLabel（localStorage 持久），bind/login 设备标签一律用它。
test('ensureHostLabel：空存储 → 生成 p2p-net-pwa-<rand8> 并落盘，二次调用幂等', () => {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  const rand = () => 'deadbeef-1234-4000-8000-000000000000';
  const label = ensureHostLabel(storage, rand);
  assert.equal(label, 'p2p-net-pwa-deadbeef');
  assert.equal(mem.get('p2p-net.pwa.hostLabel'), label);
  // 幂等：换不同的 rand 源也不变
  assert.equal(ensureHostLabel(storage, () => 'cafecafe-0000-4000-8000-000000000000'), label);
});

test('ensureHostLabel：已有值原样返回不覆盖；缺省 rand 源产出合法字符集', () => {
  const mem = new Map<string, string>([['p2p-net.pwa.hostLabel', 'p2p-net-pwa-existing']]);
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  assert.equal(ensureHostLabel(storage, () => 'deadbeef-dead-dead-dead-deaddeaddead'), 'p2p-net-pwa-existing');
  assert.equal(mem.size, 1);
  // 缺省 rand（crypto.randomUUID）：字符集 [a-z0-9-]，长度有界（≤64 幂等键截断内）
  const auto = ensureHostLabel({ getItem: () => null, setItem: () => {} });
  assert.match(auto, /^p2p-net-pwa-[0-9a-f]{8}$/);
});
