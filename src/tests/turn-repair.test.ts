import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Message, TurnProtocol, classes, methods } from 'werift';
import { installTurn438Repair, type Turn438RepairEvent } from '../turn-repair.js';

// werift 真实 TurnProtocol 实例 + 实例级 request stub（网络边界）——
// 与 peer.test.ts 的 pcFactory 同哲学：stub 只替换网络面，被测逻辑全真。
// 修复背景：e2e/n3-turn-transport-and-coturn-forensics.md §2.5（438 洪水实证）。
//
// 夹具诚实声明（评审 MAJOR 2 整改）：TransactionFailed 未从 werift 根导出
// （exports map 封锁深路径），夹具只能用普通 Error 伪造 438——原实现的
// instanceof 守卫对假错误立即重抛，其内部单次重试在本套件中不生效，
// 故此处链路为 1（原始透传）+≤4（恢复循环）。生产真实链路是
// 1+1+≤4（原实现先消耗它的单次重试），该序列由 e2e §2.5 取证覆盖。

const SERVER: [string, number] = ['49.233.155.13', 3478];

function make438(nonce: string) {
  const response = new Message(methods.REFRESH, classes.ERROR);
  response.setAttribute('ERROR-CODE', [438, 'Stale nonce']);
  response.setAttribute('NONCE', nonce);
  const err = new Error('Transaction failed: 438') as Error & {
    response: Message;
    addr: [string, number];
  };
  err.response = response;
  err.addr = SERVER;
  return err;
}

function makeStunError(code: number, reason: string) {
  const response = new Message(methods.REFRESH, classes.ERROR);
  response.setAttribute('ERROR-CODE', [code, reason]);
  const err = new Error(`Transaction failed: ${code}`) as Error & { response: Message };
  err.response = response;
  return err;
}

type RequestCall = { transactionIdHex: string };

function makeProto(behavior: (callIndex: number) => Promise<[Message, [string, number]]>) {
  const transport = { send: async () => {}, closed: false, onData: null };
  const proto = new TurnProtocol(SERVER, 'user', 'pass', 600, transport as never);
  const calls: RequestCall[] = [];
  proto.request = (async (request: Message) => {
    calls.push({ transactionIdHex: request.transactionIdHex });
    return behavior(calls.length);
  }) as never;
  return { proto, calls };
}

function makeRefreshRequest() {
  const request = new Message(methods.REFRESH, classes.REQUEST);
  request.setAttribute('LIFETIME', 600);
  request.transactionId = randomBytes(12);
  return request;
}

const events: Turn438RepairEvent[] = [];

test.before(() => {
  events.length = 0;
  const installed = installTurn438Repair({ onEvent: (e) => events.push(e) });
  assert.equal(installed, true);
});

test('438 连续两次后成功：恢复循环止血，nonce 取最新，事务 ID 逐次换新', async () => {
  events.length = 0;
  const success = new Message(methods.REFRESH, classes.RESPONSE);
  success.setAttribute('LIFETIME', 600);
  const { proto, calls } = makeProto(async (i) => {
    if (i === 1) throw make438('N2');
    if (i === 2) throw make438('N3');
    return [success, SERVER];
  });
  const [message, addr] = await proto.requestWithRetry(makeRefreshRequest(), SERVER);
  assert.equal(message, success);
  assert.deepEqual(addr, SERVER);
  assert.equal(calls.length, 3, '夹具链路：原始透传 1 次 + 恢复循环 2 次（生产多一段原实现的内部重试，见文件头声明）');
  assert.equal((proto as unknown as { nonce: string }).nonce, 'N3', '必须应用最近一次 438 携带的 nonce');
  const ids = calls.map((c) => c.transactionIdHex);
  assert.equal(new Set(ids).size, ids.length, '每次重试必须更换事务 ID，否则撞 transactions[hex] 重复检查');
  assert.equal(events.filter((e) => e.outcome === 'recovered').length, 1);
  const rec = events.find((e) => e.outcome === 'recovered');
  assert.equal(rec?.attempts, 2, '恢复循环实际用了 2 次重试');
  assert.equal(rec?.method, methods.REFRESH, '事件必须带触发请求的 STUN method');
  assert.equal(typeof rec?.ms, 'number');
});

test('438 永不缓解：有界重试（默认 4 次）后抛出最后一次错误', async () => {
  events.length = 0;
  let n = 0;
  const { proto, calls } = makeProto(async () => {
    n += 1;
    throw make438(`N${n}`);
  });
  await assert.rejects(() => proto.requestWithRetry(makeRefreshRequest(), SERVER), /438/);
  assert.equal(calls.length, 1 + 4, '原始 1 次 + 循环 4 次后必须放弃（不可无限重试）');
  assert.equal((proto as unknown as { nonce: string }).nonce, 'N4', '最后一次应用的 nonce 来自第 4 个 438（第 5 个不再有重试跟随）');
  assert.equal(events.filter((e) => e.outcome === 'exhausted').length, 1);
  assert.equal(events.find((e) => e.outcome === 'exhausted')?.attempts, 4);
});

test('非 438 错误原样抛出：403 不进入恢复循环，无 .response 的网络错误亦然', async () => {
  const a = makeProto(async () => {
    throw makeStunError(403, 'Forbidden');
  });
  await assert.rejects(() => a.proto.requestWithRetry(makeRefreshRequest(), SERVER), /403/);
  assert.equal(a.calls.length, 1);

  const b = makeProto(async () => {
    throw new Error('socket hangup');
  });
  await assert.rejects(() => b.proto.requestWithRetry(makeRefreshRequest(), SERVER), /hangup/);
  assert.equal(b.calls.length, 1);
});

test('438 响应缺 NONCE：无法恢复，直接抛出不重试', async () => {
  const response = new Message(methods.REFRESH, classes.ERROR);
  response.setAttribute('ERROR-CODE', [438, 'Stale nonce']);
  const err = new Error('Transaction failed: 438') as Error & { response: Message };
  err.response = response;
  const { proto, calls } = makeProto(async () => {
    throw err;
  });
  await assert.rejects(() => proto.requestWithRetry(makeRefreshRequest(), SERVER), /438/);
  assert.equal(calls.length, 1);
});

test('幂等安装：重复 install 原型引用不变、行为不叠加', async () => {
  const ref = (TurnProtocol.prototype as never as Record<string, unknown>).requestWithRetry;
  assert.equal(installTurn438Repair({}), true);
  assert.equal(installTurn438Repair({}), true);
  assert.equal(
    (TurnProtocol.prototype as never as Record<string, unknown>).requestWithRetry,
    ref,
    '重复安装不得替换/再包裹原型方法',
  );
  // 行为钉死：always-438 下单层包装恰为 1+4 次调用；叠加包装会爬到 1+4+4（评审探针实证）
  let n = 0;
  const { proto, calls } = makeProto(async () => {
    n += 1;
    throw make438(`N${n}`);
  });
  await assert.rejects(() => proto.requestWithRetry(makeRefreshRequest(), SERVER), /438/);
  assert.equal(calls.length, 5);
});

test('401 原样透传：不进恢复循环、零事件（401 语义归原实现管）', async () => {
  events.length = 0;
  const response = new Message(methods.ALLOCATE, classes.ERROR);
  response.setAttribute('ERROR-CODE', [401, 'Unauthorized']);
  response.setAttribute('NONCE', 'fresh');
  response.setAttribute('REALM', 'p2p-net');
  const err = new Error('Transaction failed: 401') as Error & { response: Message };
  err.response = response;
  const { proto, calls } = makeProto(async () => {
    throw err;
  });
  await assert.rejects(() => proto.requestWithRetry(makeRefreshRequest(), SERVER), /401/);
  assert.equal(calls.length, 1);
  assert.equal(events.length, 0);
});

test('438 后撞非 438：立即抛出该错误并发 aborted 事件（服务器变卦必须可观测）', async () => {
  events.length = 0;
  const { proto, calls } = makeProto(async (i) => {
    if (i === 1) throw make438('N2');
    throw makeStunError(403, 'Forbidden');
  });
  await assert.rejects(() => proto.requestWithRetry(makeRefreshRequest(), SERVER), /403/);
  assert.equal(calls.length, 2);
  assert.equal(events.filter((e) => e.outcome === 'aborted').length, 1);
  assert.equal(events.find((e) => e.outcome === 'aborted')?.attempts, 1);
  assert.equal(events.filter((e) => e.outcome === 'recovered' || e.outcome === 'exhausted').length, 0);
});

test('形状守卫：安装的 werift 为 0.24.x 且 TurnProtocol 原型方法齐全', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../node_modules/werift/package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  assert.match(pkg.version, /^0\.24\./, 'werift 跨 minor 升级时必须人工复核本补丁（原型形状可能变化）');
  assert.equal(typeof (TurnProtocol.prototype as never as Record<string, unknown>).requestWithRetry, 'function');
  assert.equal(typeof (TurnProtocol.prototype as never as Record<string, unknown>).request, 'function');
});
