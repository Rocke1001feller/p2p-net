/**
 * 关闭码净化单测（2026-09-12 daemon 崩溃重启根因的回归护栏）。
 *
 * 生产事故：手机侧 WS 异常关闭上报 code=1006，经反向隧道到 daemon 后直接进
 * `ws.close(1006)` → `TypeError: First argument must be a valid error code number`
 * → 未捕获 → daemon 进程 exit 1（launchd 反复拉起，工作台白屏）。
 * 本测试锁死"任何对端关闭码都不得让 handle 抛出"这一契约。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCloseCode, WsBridge } from '../bridge/ws.js';

test('sanitizeCloseCode：合法码原样，非法码回落 1000', () => {
  assert.equal(sanitizeCloseCode(1000), 1000);
  assert.equal(sanitizeCloseCode(3005), 3005);
  assert.equal(sanitizeCloseCode(4999), 4999);
  // 事故码与规范禁止回送的码
  assert.equal(sanitizeCloseCode(1006), 1000);
  assert.equal(sanitizeCloseCode(1005), 1000);
  assert.equal(sanitizeCloseCode(1001), 1000);
  assert.equal(sanitizeCloseCode(0), 1000);
  assert.equal(sanitizeCloseCode(999), 1000);
  assert.equal(sanitizeCloseCode(5000), 1000);
  // 非数值（客户端可能传来字符串/null）
  assert.equal(sanitizeCloseCode(undefined), 1000);
  assert.equal(sanitizeCloseCode(null), 1000);
  assert.equal(sanitizeCloseCode('1006'), 1000);
  assert.equal(sanitizeCloseCode(NaN), 1000);
});

test('WsBridge.handle：收到 1006 关闭帧不得抛出（事故回归护栏）', async () => {
  const bridge = new WsBridge({ port: 1 });
  const dc = { send: () => {}, bufferedAmount: 0, readyState: 'open' };
  // 无对应 socket 时直接返回；有 socket 时走净化路径——两条都不得抛
  await bridge.handle(dc, { k: 'ws-close', wid: 12345, code: 1006, reason: 'abnormal' });
  await bridge.handle(dc, { k: 'ws-close', wid: 12345, code: '1006' });
  await bridge.handle(dc, { k: 'ws-close', wid: 12345 });
  assert.ok(true, 'handle 未抛出即通过');
});

test('WsBridge.open：非法 port（99999）回 ws-open-err 且无 unhandled rejection（回归护栏）', async () => {
  // 99999 能通过 isWsOpen 的 numeric 检查与 open() 的 truthiness 检查，
  // 但 `new WebSocket('ws://localhost:99999/...')` 同步抛错；open() 是 async，
  // host 侧 `void this.wsBridge.handle(...)` 会让其成为 unhandled rejection → Node≥20 直接 crash。
  const bridge = new WsBridge({});
  const sent: Array<{ k: string; wid?: number }> = [];
  const dc = { send: (d: string) => sent.push(JSON.parse(d)), bufferedAmount: 0, readyState: 'open' };
  const rejections: unknown[] = [];
  const onRejection = (e: unknown) => { rejections.push(e); };
  process.on('unhandledRejection', onRejection);
  try {
    void bridge.handle(dc, { k: 'ws-open', wid: 7, path: '/', port: 99999 }); // 与 host.ts 一致：void 调用
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.ok(sent.some((f) => f.k === 'ws-open-err' && f.wid === 7), '非法 port 必须回 ws-open-err，不静默');
  assert.equal(rejections.length, 0, '不得产生 unhandled rejection（Node≥20 默认 crash）');
});
