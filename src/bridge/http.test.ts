import test from 'node:test';
import assert from 'node:assert/strict';
import { dcSend, type DcLike } from './http.js';

function stubDc(buffered: number): DcLike & { sent: string[]; setBuffered: (n: number) => void } {
  return {
    sent: [] as string[],
    bufferedAmount: buffered,
    readyState: 'open',
    send(data: string | Buffer) { this.sent.push(String(data)); },
    setBuffered(n: number) { this.bufferedAmount = n; },
  };
}

test('背压：bufferedAmount 超 512KiB 即等待，回落后才放行（中继慢链路首帧延迟上界）', async () => {
  const dc = stubDc(600 * 1024); // 高于 512KiB、远低于旧阈值 8MiB
  let done = false;
  const p = dcSend(dc, { k: 'res-chunk', id: 1, dataB64: 'x' }).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(done, false, '600KiB 积压必须等待（旧 8MiB 阈值下会立即放行）');
  assert.equal(dc.sent.length, 0);
  dc.setBuffered(100 * 1024);
  await p;
  assert.equal(dc.sent.length, 1);
});

test('背压：512KiB 以内立即放行', async () => {
  const dc = stubDc(500 * 1024);
  await dcSend(dc, { k: 'res-chunk', id: 1, dataB64: 'x' });
  assert.equal(dc.sent.length, 1);
});

test('dcSend 每帧让出事件循环：setImmediate 回调能插入批量发送之间', async () => {
  // 2026-09-23 真机实证：host 洪泛期 werift 纯 JS DTLS/SCTP 打满事件循环，
  // ctrl pong 与上游回调被饿死（localhost 响应延迟 14-20s）→ 手机 15s 无 pong 误判拆连。
  const dc = stubDc(0);
  let ran = false;
  setImmediate(() => { ran = true; });
  await dcSend(dc, { k: 'res-chunk', id: 1, dataB64: 'x' });
  assert.equal(ran, true, 'dcSend 必须让出 macrotask，否则批量发送饿死全进程');
});
