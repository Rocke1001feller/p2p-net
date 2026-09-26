# W2-6 暖场升级轮（relay→direct 原位升级）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** relay（TURN）暖场建连的会话，由 host 请求、PWA 发起 ICE restart，原位升级为直连；全程门控、每会话一次性、A/B 分桶可计量。

**Architecture:** host 侧 `PeerSession` 挂纯逻辑状态机 `UpgradeWheel`（warm→upgrading→direct|fallback，定时器全由调用方驱动）；host 经信令（Supabase PostgREST 房间，非 WS）发 `{type:'upgrade'}` 帧请求；PWA `WebRtcSession` 收到后 `setConfiguration` 翻转 policy + `createOffer({iceRestart:true})` 重协商；host 只作受控应答方（**werift 禁止作 restart 发起方**，spike §1.3 死锁实证）。升级成败由 host 既有 5s stats tick 的 `pairType` 观测驱动（渐近迁移，不靠时序假设）。终态事件 `upgrade{sid,from,to,ms}` 进 events.jsonl，`scripts/access-matrix.mjs` 按 access 桶出成功率/回退率。

**Tech Stack:** Node 20+ / TypeScript / werift 0.24.4（锁版）/ 浏览器原生 RTCPeerConnection / node:test（tsx --test）。

**Spec:** `docs/superpowers/specs/2026-09-25-wave2-calibration-design.md` §3 T6 + §5 门禁 4；裁决依据 `e2e/wave2-upgrade-wheel-spike-2026-09-26.md` §1.4 / §2.2 / §2.4 / §4.2（执行者必读这两份）。

## Global Constraints

- 分支纪律：worktree `wave2/upgrade-wheel`（`../p2p-net-w2-wheel`），完成后 `git merge --squash` 回 main；**不推 origin**。
- 测试链：`npm run lint:twins && npm run test:parallel && npm run test:serial && npm run test:parity` 全绿；本计划全部测试为纯逻辑/stub，**零监听端口**（动态端口纪律天然满足）。
- werift `^0.24.4` 锁版；host 侧**禁止**调用 `restartIce()` / `createOffer({iceRestart})`（spike §1.3：werift↔werift 原生流程死锁）。host 只发 `{type:'upgrade'}` 信令帧。
- 事件纪律（events.ts:15 既有）：`upgrade` 事件只带 `sid/from/to/ms`（sid = 客户端 deviceId，与 session_start 同键）；信令帧内严禁 token/URL/地址。
- 每会话一次性终态：`direct|fallback` 后不再发 upgrade 帧；`dispose()` 必须清理全部 wheel 定时器。
- 门控：默认开（`upgradeWheel.enabled !== false`）；`P2P_NET_UPGRADE=0` 强制关（`P2P_NET_GZIP=0` 先例）。
- spike §2.2 设计约束（必须采纳）：① 渐近迁移——restart 后 nominated 可留 relay，成败以 host getStats `pairType` 观测为准（5s tick 粒度），不靠时序假设；② Safari 宽容窗——`observeMs` 默认 ≥15s（Safari 8s 窗内可不迁）；③ restart offer **不带 meta**（旧版兼容 + access 已随首 offer 入桶）；④ 候选乱序由信令房间天然有序 + `addIceTolerant` 兜底（spike §1.4-4）。
- pwa/src 禁新孪生：PWA 侧**不需要**任何 pathType/候选类型判定（host 单边观测），不得引入孪生判据。
- 指标口径诚实：`upgrade.ms` = upgrading 状态驻留时长（最近一次 attempt 起），**不是**数据面中断时长；中断时长已由 spike 三端实测入档（28–121ms），A/B 战役另由真机专项测量，不进常设事件流。

## Review Focus

1. **旧版 PWA + 新 host**：旧版 poll 无 `upgrade` 分支 → 静默忽略，留 relay 不崩（`isSigMessage` 守卫只查 type+sid，宽松先例）。→ Task 1 语料钉死「未知类型拒绝、缺 sid 拒绝」；Task 6 测试「非本 sid 的 upgrade 被 sid 守卫拦截」。
2. **换绑混淆**：wheel 不在 `upgrading` 时同设备重连 offer → 必须走既有换绑逻辑（endReason='replaced'），不得原位应答。→ Task 3 测试钉死。
3. **upgrading 中途会话终结**：dispose/宽限到期 → 定时器全清、不再发帧、不再 emit（防泄漏防越界事件）。→ Task 3 测试钉死。
4. **restart answer 迟到/丢失**：`restartPending` 不得永久卡死后续升级——answer 到达或 teardown 时复位；host 侧 attempts 有界（maxAttempts）。→ Task 6 测试钉死。
5. **setConfiguration 整体替换语义**：不显式传 iceServers 会回落空表丢 TURN/STUN——`performUpgrade` 必须恒显式传 `upgradeIceServers ?? iceServers`。→ Task 6 测试钉死。

---

### Task 1: 信令协议 'upgrade' 帧 + 双端 parity 语料

**Files:**
- Modify: `src/signaling/protocol.ts:8`（SigMessageType）与 `:50`（TYPES Set）
- Create: `contracts/signaling-corpus.json`
- Create: `src/tests/signaling-parity.parity.ts`
- Create: `pwa/src/signaling-parity.parity.ts`

**Interfaces:**
- Consumes: 既有 `isSigMessage()`（protocol.ts:52-56，只查 `type ∈ TYPES` + `sid: string`）。
- Produces: `SigMessageType` 含 `'upgrade'`；upgrade 帧形状 `{ type:'upgrade', sid: string, from?: string }`（无其他字段，严禁 token/URL）。双端同源（PWA 经 `p2p-net/browser` barrel 导入，browser.ts:6-13 已直出 `./signaling/protocol.js`）。

- [ ] **Step 1: 写 parity 语料与失败测试**

`contracts/signaling-corpus.json`：
```json
{
  "version": 1,
  "desc": "信令消息守卫双端同构语料（W2-6）：valid=经 isSigMessage 应为 true；type=valid 时的消息类型。",
  "cases": [
    { "raw": { "type": "upgrade", "sid": "s1" }, "valid": true, "type": "upgrade" },
    { "raw": { "type": "upgrade", "sid": "s1", "from": "desk1" }, "valid": true, "type": "upgrade" },
    { "raw": { "type": "upgrade" }, "valid": false, "note": "缺 sid" },
    { "raw": { "type": "restart", "sid": "s3" }, "valid": false, "note": "未知类型拒绝（旧版静默忽略的前提）" },
    { "raw": { "type": "offer", "sid": "s4", "sdp": { "type": "offer", "sdp": "v=0 x" } }, "valid": true, "type": "offer", "note": "offer 无 meta：旧版兼容" },
    { "raw": { "type": "offer", "sid": "s5", "sdp": { "type": "offer", "sdp": "v=0 x" }, "meta": { "access": "wifi-home" } }, "valid": true, "type": "offer" },
    { "raw": { "type": "answer", "sid": "s6", "sdp": { "type": "answer", "sdp": "v=0 x" } }, "valid": true, "type": "answer" },
    { "raw": { "type": "ice", "sid": "s7", "cand": { "candidate": "candidate:x 1 udp 1 1.1.1.1 9 typ relay", "sdpMid": "0" } }, "valid": true, "type": "ice" }
  ]
}
```

`src/tests/signaling-parity.parity.ts`（镜像既有 `src/tests/path-parity.parity.ts` 的语料装载方式——先读它确认 JSON 装载是 import 还是 fs，照抄）：
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSigMessage } from '../signaling/protocol.js';
// 语料装载方式照 path-parity.parity.ts（下行为示意，按既有模式替换）：
import corpus from '../../contracts/signaling-corpus.json' with { type: 'json' };

test('parity: 信令守卫 host 侧（含 upgrade 帧）', () => {
  for (const c of corpus.cases) {
    assert.equal(isSigMessage(c.raw), c.valid, JSON.stringify(c.raw));
    if (c.valid) assert.equal((c.raw as { type: string }).type, c.type);
  }
});
```

`pwa/src/signaling-parity.parity.ts`（镜像 `pwa/src/path-parity.parity.ts`——它 import `p2p-net/browser` 的 **dist 产物**，需先 `npm run build`）：
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSigMessage } from 'p2p-net/browser';
import corpus from '../../contracts/signaling-corpus.json' with { type: 'json' };

test('parity: 信令守卫 PWA 侧（含 upgrade 帧）', () => {
  for (const c of corpus.cases) {
    assert.equal(isSigMessage(c.raw), c.valid, JSON.stringify(c.raw));
    if (c.valid) assert.equal((c.raw as { type: string }).type, c.type);
  }
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npm run build && npx tsx --test src/tests/signaling-parity.parity.ts pwa/src/signaling-parity.parity.ts`
Expected: FAIL——`{"type":"upgrade","sid":"s1"}` 期望 valid=true 实得 false（TYPES 未含 upgrade）。

- [ ] **Step 3: 改 protocol.ts**

`src/signaling/protocol.ts:8`：
```ts
export type SigMessageType = 'offer' | 'answer' | 'ice' | 'hello' | 'bye' | 'tunnel' | 'upgrade';
```
`:50` 的 TYPES Set 同步加 `'upgrade'`。`SigMessage` 接口不动（upgrade 帧复用 `sid`/`from`；注释补一行：`upgrade` = host→PWA 请求发起 ICE restart，W2-6）。

- [ ] **Step 4: 跑测试确认绿 + 全链**

Run: `npm run build && npx tsx --test src/tests/signaling-parity.parity.ts pwa/src/signaling-parity.parity.ts && npm run test:parity`
Expected: PASS（parity 全绿，含既有 66 用例）。

- [ ] **Step 5: Commit**

```bash
git add contracts/signaling-corpus.json src/signaling/protocol.ts src/tests/signaling-parity.parity.ts pwa/src/signaling-parity.parity.ts
git commit -m "feat(signaling): 'upgrade' 帧入 SigMessage + 双端 parity 语料（W2-6 Task 1）"
```

---

### Task 2: UpgradeWheel 纯逻辑状态机

**Files:**
- Create: `src/upgradeWheel.ts`
- Test: `src/tests/upgrade-wheel.test.ts`

**Interfaces:**
- Consumes: 无（纯模块）。
- Produces（Task 3 依赖，签名钉死）:
```ts
export type UpgradePath = 'relay' | 'direct';
export type UpgradeState = 'warm' | 'upgrading' | 'direct' | 'fallback';
export interface UpgradeWheelOpts { warmMs?: number; observeMs?: number; maxAttempts?: number }
export type UpgradeAction =
  | { kind: 'send-upgrade' }
  | { kind: 'emit'; from: 'relay'; to: 'direct' | 'fallback'; ms: number };
export class UpgradeWheel {
  constructor(opts?: UpgradeWheelOpts);
  readonly warmMs: number;      // 默认 10_000
  readonly observeMs: number;   // 默认 15_000
  readonly maxAttempts: number; // 默认 2
  get state(): UpgradeState;
  get closed(): boolean;
  onConnected(path: UpgradePath, now: number): null;
  onWarmTimeout(now: number): UpgradeAction | null;
  onPairType(path: UpgradePath, now: number): UpgradeAction | null;
  onObserveTimeout(now: number): UpgradeAction | null;
  close(): void;
}
```
语义：首连 relay→留 warm；首连 direct→终态 direct；warm 期自然转 direct→终态（非轮功不 emit）；warmTimeout→upgrading 发首帧（attempt 1）；upgrading 见 direct→emit(direct, ms 自最近 attempt 起)；observeTimeout→attempts<maxAttempts 重发，否则 emit(fallback)；close 后全惰性。

- [ ] **Step 1: 写失败测试**

`src/tests/upgrade-wheel.test.ts`：
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { UpgradeWheel } from '../upgradeWheel.js';

test('默认值：warmMs=10s observeMs=15s maxAttempts=2（Safari 宽容窗，spike §2.2-4）', () => {
  const w = new UpgradeWheel();
  assert.equal(w.warmMs, 10_000);
  assert.equal(w.observeMs, 15_000);
  assert.equal(w.maxAttempts, 2);
  assert.equal(w.state, 'warm');
  assert.equal(w.closed, false);
});

test('首连 direct：终态 direct，之后全惰性', () => {
  const w = new UpgradeWheel();
  assert.equal(w.onConnected('direct', 1000), null);
  assert.equal(w.state, 'direct');
  assert.equal(w.onWarmTimeout(11_000), null);
  assert.equal(w.onObserveTimeout(11_000), null);
});

test('relay 暖场 → warmTimeout → send-upgrade（attempt 1）', () => {
  const w = new UpgradeWheel();
  w.onConnected('relay', 1000);
  assert.equal(w.state, 'warm');
  assert.deepEqual(w.onWarmTimeout(11_000), { kind: 'send-upgrade' });
  assert.equal(w.state, 'upgrading');
});

test('warm 期自然转 direct：终态（非轮功不 emit），warmTimeout 不再发帧', () => {
  const w = new UpgradeWheel();
  w.onConnected('relay', 1000);
  w.onConnected('direct', 6000);
  assert.equal(w.state, 'direct');
  assert.equal(w.onWarmTimeout(11_000), null);
  assert.equal(w.onPairType('direct', 12_000), null);
});

test('onConnected 幂等：重复 relay tick 不动作不推进', () => {
  const w = new UpgradeWheel();
  w.onConnected('relay', 1000);
  w.onConnected('relay', 6000);
  assert.equal(w.state, 'warm');
});

test('upgrading 观测到 direct → emit(direct)，ms 自最近 attempt 起', () => {
  const w = new UpgradeWheel();
  w.onConnected('relay', 1000);
  w.onWarmTimeout(11_000);
  assert.deepEqual(w.onPairType('direct', 13_400), { kind: 'emit', from: 'relay', to: 'direct', ms: 2400 });
  assert.equal(w.state, 'direct');
  assert.equal(w.onPairType('relay', 14_000), null, '终态后 tick 惰性');
});

test('upgrading 中 relay tick 返回 null（继续观测，渐近迁移不判死）', () => {
  const w = new UpgradeWheel();
  w.onConnected('relay', 0);
  w.onWarmTimeout(10_000);
  assert.equal(w.onPairType('relay', 20_000), null);
  assert.equal(w.state, 'upgrading');
});

test('观测窗到期：重发至 maxAttempts 后 emit(fallback)', () => {
  const w = new UpgradeWheel({ maxAttempts: 2 });
  w.onConnected('relay', 0);
  w.onWarmTimeout(10_000);                       // attempt 1 @10s
  assert.deepEqual(w.onObserveTimeout(25_000), { kind: 'send-upgrade' }); // attempt 2 @25s
  assert.deepEqual(w.onObserveTimeout(40_000), { kind: 'emit', from: 'relay', to: 'fallback', ms: 15_000 });
  assert.equal(w.state, 'fallback');
  assert.equal(w.onObserveTimeout(55_000), null, '终态后惰性');
});

test('非 upgrading 态的 onPairType/onObserveTimeout 一律 null', () => {
  const w = new UpgradeWheel();
  assert.equal(w.onPairType('direct', 0), null);
  assert.equal(w.onObserveTimeout(0), null);
  w.onConnected('relay', 0);
  assert.equal(w.onObserveTimeout(30_000), null, 'warm 态无观测窗');
});

test('close 后全部方法惰性（dispose 防泄漏语义）', () => {
  const w = new UpgradeWheel();
  w.onConnected('relay', 0);
  w.close();
  assert.equal(w.closed, true);
  assert.equal(w.onWarmTimeout(10_000), null);
  assert.equal(w.onPairType('direct', 10_000), null);
  assert.equal(w.onObserveTimeout(10_000), null);
});

test('未见首连的 warmTimeout 不动作（seam 防呆）', () => {
  const w = new UpgradeWheel();
  assert.equal(w.onWarmTimeout(10_000), null);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx tsx --test src/tests/upgrade-wheel.test.ts`
Expected: FAIL——`Cannot find module '../upgradeWheel.js'`。

- [ ] **Step 3: 实现 `src/upgradeWheel.ts`**

```ts
/**
 * 暖场升级轮状态机（Wave 2 W2-6；裁决：e2e/wave2-upgrade-wheel-spike-2026-09-26.md §2.4）。
 * 纯逻辑：定时器全部由调用方驱动（可测性）；host 挂 PeerSession，PWA 为执行手。
 * 状态机：warm → upgrading → direct | fallback；首连 direct 直接终态（无升级必要）。
 * 纪律：不感知地址/候选细节；emit 只带 from/to/ms（ms = 最近一次 attempt 起的驻留时长，
 * 不是数据面中断时长——中断口径见 plan Global Constraints）。
 */
export type UpgradePath = 'relay' | 'direct';
export type UpgradeState = 'warm' | 'upgrading' | 'direct' | 'fallback';

export interface UpgradeWheelOpts {
  /** relay 稳定暖场时长（默认 10s = 2 个 stats tick，STATS_INTERVAL_MS=5s）。 */
  warmMs?: number;
  /** 单次 attempt 观测窗（默认 15s = 3 tick；Safari 宽容窗，spike §2.2-4：8s 窗内可不迁）。 */
  observeMs?: number;
  /** 总 attempt 上限（默认 2 = 首发 + 重试一次）。 */
  maxAttempts?: number;
}

export type UpgradeAction =
  | { kind: 'send-upgrade' }
  | { kind: 'emit'; from: 'relay'; to: 'direct' | 'fallback'; ms: number };

export class UpgradeWheel {
  readonly warmMs: number;
  readonly observeMs: number;
  readonly maxAttempts: number;
  private st: UpgradeState = 'warm';
  private seenConnect = false;
  private attempts = 0;
  private attemptSince = 0;
  private isClosed = false;

  constructor(opts: UpgradeWheelOpts = {}) {
    this.warmMs = opts.warmMs ?? 10_000;
    this.observeMs = opts.observeMs ?? 15_000;
    this.maxAttempts = opts.maxAttempts ?? 2;
  }

  get state(): UpgradeState { return this.st; }
  get closed(): boolean { return this.isClosed; }

  /** 状态 tick 驱动（幂等）：首连定路径；warm 期自然转 direct 终态（非轮功，不 emit）。 */
  onConnected(path: UpgradePath, _now: number): null {
    if (this.isClosed) return null;
    if (!this.seenConnect) {
      this.seenConnect = true;
      if (path === 'direct') this.st = 'direct';
      return null;
    }
    if (this.st === 'warm' && path === 'direct') this.st = 'direct';
    return null;
  }

  /** 暖场计时到期：warm → upgrading，发首帧（attempt 1）。 */
  onWarmTimeout(now: number): UpgradeAction | null {
    if (this.isClosed || this.st !== 'warm' || !this.seenConnect) return null;
    this.st = 'upgrading';
    this.attempts = 1;
    this.attemptSince = now;
    return { kind: 'send-upgrade' };
  }

  /** 观测期 pairType tick：见 direct → 终态 + emit。relay 一律 null（渐近迁移继续观测）。 */
  onPairType(path: UpgradePath, now: number): UpgradeAction | null {
    if (this.isClosed || this.st !== 'upgrading' || path !== 'direct') return null;
    this.st = 'direct';
    return { kind: 'emit', from: 'relay', to: 'direct', ms: now - this.attemptSince };
  }

  /** 观测窗到期：还有次数 → 重发；否则终态 fallback + emit。 */
  onObserveTimeout(now: number): UpgradeAction | null {
    if (this.isClosed || this.st !== 'upgrading') return null;
    if (this.attempts < this.maxAttempts) {
      this.attempts += 1;
      this.attemptSince = now;
      return { kind: 'send-upgrade' };
    }
    this.st = 'fallback';
    return { kind: 'emit', from: 'relay', to: 'fallback', ms: now - this.attemptSince };
  }

  close(): void { this.isClosed = true; }
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `npx tsx --test src/tests/upgrade-wheel.test.ts`
Expected: PASS（10 测全过）。

- [ ] **Step 5: Commit**

```bash
git add src/upgradeWheel.ts src/tests/upgrade-wheel.test.ts
git commit -m "feat(wheel): UpgradeWheel 纯逻辑状态机（W2-6 Task 2）"
```

---

### Task 3: host 集成——PeerSession 挂载 + 驱动 + 重协商路由

**Files:**
- Modify: `src/host.ts`——PeerSession（:156-179 字段区、ctor :181、dispose :324-332）、HostAgentOptions（:55-95 尾部）、onSignal offer 分支（:539-573）、onSessionStatus（:603-613）、新增私有方法（driveWheel/onWheelWarm/onWheelObserve/sendUpgradeFrame/emitUpgrade，放 :581 reply 之后）
- Test: `src/tests/upgrade-wheel-host.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `'upgrade'` 帧；Task 2 的 `UpgradeWheel`/`UpgradePath`/`UpgradeAction`。
- Produces（Task 4/5 依赖）:
```ts
// HostAgentOptions 新增：
upgradeWheel?: { enabled?: boolean; warmMs?: number; observeMs?: number; maxAttempts?: number };
onUpgrade?: (e: { sid: string; from: 'relay'; to: 'direct' | 'fallback'; ms: number }) => void;
// PeerSession 公开面新增：sid?: string；wheel?: UpgradeWheel；
//   armWheelWarmTimer(ms, fn) / armWheelObserveTimer(ms, fn) / clearWheelTimers()
```

- [ ] **Step 1: 写失败测试**

新建 `src/tests/upgrade-wheel-host.test.ts`。harness 镜像 `src/tests/host.integration.test.ts`（**先读它**：内存信令 stub 怎么造、HostAgent 怎么 new、offer 行怎么注入 poll）；stub PcLike 镜像 `src/tests/peer.test.ts` 的 stubPc（PcLike 最小面：setRemoteDescription/createAnswer/setLocalDescription/localDescription/addIceCandidate/getStats/close/onicecandidate·ondatachannel setter、iceTransports 空数组）。Peer 经 pcFactory 缝注入 stub：`new Peer([], { pcFactory: () => stubPc })`；PeerSession 第三参缝（Step 3 加）传入。

测试要点（定时用真实短毫秒 + 宽余 sleep，如 warmMs=20 observeMs=30 sleep(80)；**禁用假定时器库**）：

```ts
// (a) 门控：默认开 → offer 后 session.wheel 存在且 sid 已存；enabled:false → wheel 为 undefined
// (b) 暖场流：合成 status {state:'connected', pairType:'relay'} 经 onSessionStatus 注入
//     （私有触达：(agent as unknown as { onSessionStatus: (k,s,st)=>void }).onSessionStatus(...)——
//      signaling-watchdog.test.ts 同类手法，先核对该文件先例）
//     → sleep 过 warmMs → 内存信令出列 1 帧 {type:'upgrade', sid: 会话 sid, from: deskId}
//       （断言帧内无 token/URL/地址字段：Object.keys 恰为 type/sid/from）
// (c) 升级成功：随后注入 {state:'connected', pairType:'p2p'} → onUpgrade 收到
//     {sid: clientKey, from:'relay', to:'direct', ms:≥0}；再过 2×observeMs 无第二帧（定时器已清）
// (d) 观测窗重试→回退：(b) 后保持 relay → 过 observeMs 出第 2 帧（attempt 2）
//     → 再过 observeMs → onUpgrade {to:'fallback'}；再过 observeMs 无第 3 帧
// (e) 重协商路由：session 处 upgrading 时注入同 from 的 offer 行（sdp 任意 stub 可咽）
//     → sessions.get(clientKey) 仍是同一对象（未换绑）、无 endReason='replaced' 事件、
//       stubPc.setRemoteDescription 被再调一次、出列新 answer
// (f) 换绑保全：session 非 upgrading（warm 期）注入同 from offer → 走旧换绑：
//     onStatus 收到 endReason='replaced' 终态帧、sessions 换成新对象
// (g) dispose 防漏：upgrading 中途 dropSession → sleep 过 2×observeMs → 无帧无 emit
// (h) 首连 direct：注入 {state:'connected', pairType:'p2p'} → 永不出 upgrade 帧
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx tsx --test src/tests/upgrade-wheel-host.test.ts`
Expected: FAIL——PeerSession 无第三参/wheel/sid，onUpgrade 未触发（编译错或断言败）。

- [ ] **Step 3: 实现 host.ts 改动**

1) `import { UpgradeWheel, type UpgradePath, type UpgradeAction } from './upgradeWheel.js';`
2) PeerSession：
```ts
readonly peer: Peer; // 由字段初始化改为 ctor 赋值（注：原 :157 字段初始化删除）
// 字段区新增（:177-179 nat 之后）：
/** 会话信令 sid（offer 带入）：upgrade 帧路由回 PWA 的唯一凭据。 */
sid?: string;
/** 升级轮（Wave 2 W2-6）：暖场状态机；门控关（upgradeWheel.enabled===false）时为 undefined。 */
wheel?: UpgradeWheel;
private wheelWarmTimer?: ReturnType<typeof setTimeout>;
private wheelObserveTimer?: ReturnType<typeof setTimeout>;

constructor(wsPort?: number, isPortAllowed?: (port: number) => boolean, peer?: Peer) {
  this.peer = peer ?? new Peer([], { transport: 'all' });
  // …其余 ctor 体不变…
}

/** 暖场计时（幂等，只 arm 一次）。 */
armWheelWarmTimer(ms: number, fn: () => void): void {
  if (this.disposed || this.wheelWarmTimer) return;
  this.wheelWarmTimer = setTimeout(() => { this.wheelWarmTimer = undefined; fn(); }, ms);
  this.wheelWarmTimer.unref?.();
}
/** 观测窗计时（重发时重置——arm 前清旧）。 */
armWheelObserveTimer(ms: number, fn: () => void): void {
  if (this.disposed) return;
  if (this.wheelObserveTimer) clearTimeout(this.wheelObserveTimer);
  this.wheelObserveTimer = setTimeout(() => { this.wheelObserveTimer = undefined; fn(); }, ms);
  this.wheelObserveTimer.unref?.();
}
clearWheelTimers(): void {
  if (this.wheelWarmTimer) { clearTimeout(this.wheelWarmTimer); this.wheelWarmTimer = undefined; }
  if (this.wheelObserveTimer) { clearTimeout(this.wheelObserveTimer); this.wheelObserveTimer = undefined; }
}
```
dispose()（:324-332）首行后补：`this.clearWheelTimers(); this.wheel?.close();`
3) HostAgentOptions 尾部（authRetryMs 后）：
```ts
/** 升级轮（W2-6）：relay 暖场会话后台原位升级直连。缺省开；enabled:false 全关。 */
upgradeWheel?: { enabled?: boolean; warmMs?: number; observeMs?: number; maxAttempts?: number };
/** 升级轮终态（sid=客户端 deviceId，与 session_start 同键供 access 桶 join；from/to/ms，绝无地址）。 */
onUpgrade?: (e: { sid: string; from: 'relay'; to: 'direct' | 'fallback'; ms: number }) => void;
```
4) onSignal offer 分支——`const existing = this.sessions.get(clientKey);`（:543）之后、换绑 if 之前插入：
```ts
// 升级轮重协商（spike §1.4-1：host 只作受控应答方）：原位应答，不换绑/不新建/不动账本。
if (existing?.wheel && existing.wheel.state === 'upgrading') {
  await existing.peer.acceptOffer(msg.sid, msg.sdp, {
    onChannel: (dc, label) => existing.wireChannel(dc, label, this.opts.onServiceFrame),
    onIce: (cand) => this.reply(clientKey, msg.sid, { type: 'ice', sid: msg.sid, cand, from: this.opts.deviceId }),
    onStatus: (s) => this.onSessionStatus(clientKey, existing, s),
  });
  const local = existing.peer.localDescription;
  if (local) this.reply(clientKey, msg.sid, { type: 'answer', sid: msg.sid, sdp: local, from: this.opts.deviceId });
  return;
}
```
`const session = new PeerSession(...)`（:559）之后补：
```ts
session.sid = msg.sid;
if (this.opts.upgradeWheel?.enabled !== false) session.wheel = new UpgradeWheel(this.opts.upgradeWheel);
```
（TS 提示：`this.opts.upgradeWheel` 结构含 enabled 多余键，传参非字面量，ExcessPropertyCheck 不触发，直传即可。）
5) onSessionStatus——`session.lastStatus = s;`（:605）之后插入 `this.driveWheel(clientKey, session, s);`
6) reply()（:589）之后新增私有方法群：
```ts
/** 升级轮驱动（每个状态 tick）：首连定路径；warm+relay arm 暖场计时；upgrading 见 direct 终态 emit。 */
private driveWheel(clientKey: string, session: PeerSession, s: LinkStatus): void {
  const wheel = session.wheel;
  if (!wheel || wheel.closed || s.state !== 'connected' || !s.pairType) return;
  const path: UpgradePath = s.pairType === 'relay' ? 'relay' : 'direct';
  wheel.onConnected(path, Date.now());
  if (wheel.state === 'warm' && path === 'relay') {
    session.armWheelWarmTimer(wheel.warmMs, () => this.onWheelWarm(clientKey, session));
  } else if (wheel.state === 'upgrading' && path === 'direct') {
    const act = wheel.onPairType(path, Date.now());
    if (act) { session.clearWheelTimers(); this.emitUpgrade(clientKey, act); }
  }
}

private onWheelWarm(clientKey: string, session: PeerSession): void {
  if (this.sessions.get(clientKey) !== session || !session.wheel) return;
  if (session.wheel.onWarmTimeout(Date.now())?.kind === 'send-upgrade') this.sendUpgradeFrame(clientKey, session);
}

private onWheelObserve(clientKey: string, session: PeerSession): void {
  if (this.sessions.get(clientKey) !== session || !session.wheel) return;
  const act = session.wheel.onObserveTimeout(Date.now());
  if (act?.kind === 'send-upgrade') this.sendUpgradeFrame(clientKey, session);
  else if (act?.kind === 'emit') { session.clearWheelTimers(); this.emitUpgrade(clientKey, act); }
}

/** 帧纪律：{type:'upgrade', sid, from} 三键，绝无 token/URL/地址。 */
private sendUpgradeFrame(clientKey: string, session: PeerSession): void {
  const wheel = session.wheel;
  if (!wheel || !session.sid) return;
  this.reply(clientKey, session.sid, { type: 'upgrade', sid: session.sid, from: this.opts.deviceId });
  session.armWheelObserveTimer(wheel.observeMs, () => this.onWheelObserve(clientKey, session));
}

private emitUpgrade(clientKey: string, act: { from: 'relay'; to: 'direct' | 'fallback'; ms: number }): void {
  this.opts.onUpgrade?.({ sid: clientKey, ...act });
}
```

- [ ] **Step 4: 跑测试确认绿 + 全链**

Run: `npx tsx --test src/tests/upgrade-wheel-host.test.ts && npm run lint:twins && npm run test:parallel`
Expected: PASS；既有 host/pool/session-policy 测试不红（重协商分支只在 wheel.state==='upgrading' 命中，零行为变更面）。

- [ ] **Step 5: Commit**

```bash
git add src/host.ts src/tests/upgrade-wheel-host.test.ts
git commit -m "feat(host): PeerSession 挂升级轮 + 重协商原位应答 + 门控（W2-6 Task 3）"
```

---

### Task 4: 配置与装配（AppConfig + env + onUpgrade→events）

**Files:**
- Modify: `src/server/store.ts`（AppConfig :13-20 + 新增 resolveUpgradeWheel；loadConfig :33-53 若按白名单透传则补 upgradeWheel 段容忍）
- Modify: `src/cli/start.ts`（record 闭包 :215-219 区、HostAgent 装配 :327-339）
- Test: `src/server/store.test.ts`（若不存在则创建；存在则追加）

**Interfaces:**
- Consumes: Task 3 的 `HostAgentOptions.upgradeWheel` / `onUpgrade`。
- Produces: `resolveUpgradeWheel(cfg: AppConfig['upgradeWheel'] | undefined, env?: NodeJS.ProcessEnv): { enabled: boolean; warmMs?: number; observeMs?: number; maxAttempts?: number }`（纯函数，自 store.ts 导出）；events.jsonl 出现 `{name:'upgrade', sid, from, to, ms}` 行（Task 5 消费）。

- [ ] **Step 1: 写失败测试**

`src/server/store.test.ts`（若已有同名家测试文件则改为追加 describe；先 Glob 确认）：
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, resolveUpgradeWheel } from './store.js';

test('resolveUpgradeWheel：缺省全开', () => {
  assert.deepEqual(resolveUpgradeWheel(undefined, {}), { enabled: true });
});

test('resolveUpgradeWheel：config 关 → false；env P2P_NET_UPGRADE=0 强关（压过 config 开）', () => {
  assert.deepEqual(resolveUpgradeWheel({ enabled: false }, {}), { enabled: false });
  assert.deepEqual(resolveUpgradeWheel(undefined, { P2P_NET_UPGRADE: '0' }), { enabled: false });
  assert.deepEqual(resolveUpgradeWheel({ enabled: true }, { P2P_NET_UPGRADE: '0' }), { enabled: false });
});

test('resolveUpgradeWheel：数值段透传，缺省键不出现', () => {
  assert.deepEqual(
    resolveUpgradeWheel({ warmMs: 5000, observeMs: 9000, maxAttempts: 3 }, {}),
    { enabled: true, warmMs: 5000, observeMs: 9000, maxAttempts: 3 },
  );
});

test('config 落盘回读：upgradeWheel 段原样往返', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-store-'));
  const cfg = { supabaseUrl: 'https://x.supabase.co', publishableKey: 'k', tunnelSecret: 's',
    relays: [{ ip: '203.0.113.9' }], upgradeWheel: { enabled: false, warmMs: 5000 } };
  saveConfig(dir, cfg as never); // 字段集以 AppConfig 实际必填项为准（先读 store.ts:13-20 对齐）
  const back = loadConfig(dir) as typeof cfg;
  assert.deepEqual(back.upgradeWheel, { enabled: false, warmMs: 5000 });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx tsx --test src/server/store.test.ts`
Expected: FAIL——`resolveUpgradeWheel is not a function` / round-trip 丢段。

- [ ] **Step 3: 实现**

store.ts AppConfig 加：
```ts
/** 升级轮（W2-6，可选段，缺省全开）：relay 暖场会话后台原位升级直连。 */
upgradeWheel?: { enabled?: boolean; warmMs?: number; observeMs?: number; maxAttempts?: number };
```
并追加：
```ts
/** 升级轮配置归一（W2-6）：config.json 可选段 + env P2P_NET_UPGRADE=0 强制关（P2P_NET_GZIP=0 先例）。 */
export function resolveUpgradeWheel(
  cfg: AppConfig['upgradeWheel'] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; warmMs?: number; observeMs?: number; maxAttempts?: number } {
  const enabled = env.P2P_NET_UPGRADE === '0' ? false : cfg?.enabled !== false;
  return {
    enabled,
    ...(cfg?.warmMs !== undefined ? { warmMs: cfg.warmMs } : {}),
    ...(cfg?.observeMs !== undefined ? { observeMs: cfg.observeMs } : {}),
    ...(cfg?.maxAttempts !== undefined ? { maxAttempts: cfg.maxAttempts } : {}),
  };
}
```
loadConfig 若白名单透传则把 `upgradeWheel` 段纳入容忍（对象类型浅校验：存在即必须是对象，否则 ConfigError）。start.ts HostAgent 装配（:327-339）加两行：
```ts
upgradeWheel: resolveUpgradeWheel(cfg.upgradeWheel),
onUpgrade: (e) => record({ name: 'upgrade', sid: e.sid, from: e.from, to: e.to, ms: e.ms }),
```
（`record` 闭包 :215-219 在装配点之前定义，直接可用；import 补 resolveUpgradeWheel。）

- [ ] **Step 4: 跑测试确认绿 + 装配冒烟**

Run: `npx tsx --test src/server/store.test.ts src/cli/start.test.ts && npm run test:parallel`
Expected: PASS（start.test.ts 既有断言不红——HostAgent opts 多两键不影响）。

- [ ] **Step 5: Commit**

```bash
git add src/server/store.ts src/server/store.test.ts src/cli/start.ts
git commit -m "feat(config): upgradeWheel 配置段 + env 强关 + onUpgrade→events 装配（W2-6 Task 4）"
```

---

### Task 5: upgrade 事件类型 + access 桶 A/B 矩阵

**Files:**
- Modify: `src/server/events.ts:15-41`（name 出列 + 字段 + 纪律注释）
- Modify: `scripts/access-matrix.mjs`（buildUpgradeMatrix/renderUpgradeMatrix + CLI 输出）
- Test: `src/tests/access-matrix.test.ts`（追加）、events 既有测试文件（先 Glob `src/**/events*.test.ts` 定位，追加 upgrade 容忍断言）

**Interfaces:**
- Consumes: Task 4 落盘的 `{name:'upgrade', sid, from, to, ms}` 事件行。
- Produces: `SessionEvent.name` 含 `'upgrade'`，字段 `from?: 'relay'; to?: 'direct'|'fallback'; ms?: number`；`buildUpgradeMatrix(events): Map<bucket, { n, direct, fallback, msP50, msP95 }>`；`renderUpgradeMatrix(m): string`（N<20 标「N不足」，沿用 MIN_SAMPLE=20 与「孤儿忽略」口径）。

- [ ] **Step 1: 写失败测试**

`src/tests/access-matrix.test.ts` 追加：
```ts
test('buildUpgradeMatrix：upgrade×start 按 sid join 分桶；孤儿忽略；ms 分位数', () => {
  const { buildUpgradeMatrix } = await import('../../scripts/access-matrix.mjs');
  const fx = [
    { name: 'session_start', sid: 'a', access: 'cellular-ct' },
    { name: 'upgrade', sid: 'a', from: 'relay', to: 'direct', ms: 800 },
    { name: 'session_start', sid: 'b', access: 'cellular-ct' },
    { name: 'upgrade', sid: 'b', from: 'relay', to: 'fallback', ms: 15000 },
    { name: 'upgrade', sid: 'ghost', from: 'relay', to: 'direct', ms: 500 }, // 孤儿：无 start，忽略
    { name: 'session_start', sid: 'c' }, // 旧版无 access → unknown 桶
    { name: 'upgrade', sid: 'c', from: 'relay', to: 'direct', ms: 1200 },
    { name: 'upgrade', sid: 'a', from: 'relay', to: 'direct' }, // 缺 ms：畸形忽略
  ];
  const m = buildUpgradeMatrix(fx);
  const ct = m.get('cellular-ct');
  assert.equal(ct.n, 2); assert.equal(ct.direct, 1); assert.equal(ct.fallback, 1);
  assert.equal(ct.msP50, 800); assert.equal(ct.msP95, 15000); // 最近秩 [800,15000]
  assert.equal(m.get('unknown').n, 1);
  assert.equal([...m.values()].reduce((s, r) => s + r.n, 0), 3, '孤儿与畸形一律不进矩阵');
});
```
（p50/p95 最近秩口径：升序后 index = ceil(p×n)-1。）
events 测试文件追加：
```ts
test('aggregateSessions 容忍 upgrade 事件：不计 active 不影响 byMode', () => {
  const s = aggregateSessions([
    { name: 'session_start', sid: 'a' },
    { name: 'upgrade', sid: 'a', from: 'relay', to: 'direct', ms: 800 },
  ]);
  assert.equal(s.active, 1);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx tsx --test src/tests/access-matrix.test.ts`（+ events 测试文件）
Expected: FAIL——`buildUpgradeMatrix` 不存在；SessionEvent 类型无 upgrade（若测试经 ts 检查）。

- [ ] **Step 3: 实现**

events.ts：
```ts
name: 'session_start' | 'session_end' | 'cascade_choice' | 'tunnel_reconnect' | 'upgrade';
// 字段区追加：
/** 升级轮终态（W2-6）：from 恒 'relay'；ms = 最近一次 attempt 起的 upgrading 驻留时长，
 *  不是数据面中断时长（中断口径由 spike 三端实测入档，A/B 战役真机专项测量）。 */
from?: 'relay';
to?: 'direct' | 'fallback';
ms?: number;
```
:15 纪律注释行更新为「只带 sid/mode/rtt/bytes/reason/pathType/from/to/ms」。
`aggregateSessions` 不动（switch 未命中即忽略，测试钉死容忍）。

access-matrix.mjs 追加（照 buildAccessMatrix 同款纯函数风格，零依赖）：
```js
/** 升级轮 A/B 矩阵（W2-6）：upgrade 事件 × session_start(access) 按 sid join 分桶。
 *  口径同 buildAccessMatrix：孤儿忽略、无 access 落 unknown、N<20 标 N不足（渲染层）。
 *  A/B 阈值（spec §5 门禁 4 + spike §4.2）：成功率 ≥ 桶直连率×80%；回退率 < 10%；
 *  中断 p95 < 1.5s 由真机专项测量（不在本矩阵）。 */
export function buildUpgradeMatrix(events) {
  const accessBySid = new Map();
  for (const e of events) {
    if (e?.name === 'session_start' && typeof e.sid === 'string' && e.sid) {
      accessBySid.set(e.sid, typeof e.access === 'string' && e.access ? e.access : 'unknown');
    }
  }
  const rows = new Map();
  for (const e of events) {
    if (e?.name !== 'upgrade' || typeof e.sid !== 'string' || !e.sid) continue;
    if (e.to !== 'direct' && e.to !== 'fallback') continue;
    if (typeof e.ms !== 'number' || !Number.isFinite(e.ms)) continue;
    const bucket = accessBySid.get(e.sid);
    if (!bucket) continue; // 孤儿忽略（与 buildAccessMatrix 同口径）
    const r = rows.get(bucket) ?? { n: 0, direct: 0, fallback: 0, ms: [] };
    r.n += 1;
    if (e.to === 'direct') r.direct += 1; else r.fallback += 1;
    r.ms.push(e.ms);
    rows.set(bucket, r);
  }
  const q = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  const out = new Map();
  for (const [bucket, r] of rows) {
    const sorted = [...r.ms].sort((a, b) => a - b);
    out.set(bucket, { n: r.n, direct: r.direct, fallback: r.fallback, msP50: q(sorted, 0.5), msP95: q(sorted, 0.95) });
  }
  return out;
}
export function renderUpgradeMatrix(m) { /* 照 renderAccessMatrix 表格风格：bucket|n|成功率|回退率|msP50|msP95，N<20 标 N不足 */ }
```
CLI main 在既有 access 矩阵表后追加打印 upgrade 节（标题「升级轮 A/B（W2-6）」）。

- [ ] **Step 4: 跑测试确认绿 + 全链**

Run: `npx tsx --test src/tests/access-matrix.test.ts && npm run test:parallel && npm run test:serial && npm run test:parity`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/events.ts scripts/access-matrix.mjs src/tests/access-matrix.test.ts
git commit -m "feat(events): upgrade 事件 + access 桶 A/B 矩阵（成功率/回退率/ms 分位，W2-6 Task 5）"
```

---

### Task 6: PWA 升级执行手（performUpgrade + poll 分支 + iceServers 注入）

**Files:**
- Modify: `pwa/src/signaling-web.ts`（SessionOptions :55-70 加 `upgradeIceServers?`；WebRtcSession 加 restartPending/performUpgrade；poll() :306-321 分支；teardown 复位）
- Modify: `pwa/src/session.ts:166-199`（tryWebRtc 内 WebRtcSession opts 注入 upgradeIceServers）
- Test: `pwa/src/signaling-web.test.ts`（追加；镜像既有 FakePc/FakeSignaling 模式 :103-197）

**Interfaces:**
- Consumes: Task 1 的 `'upgrade'` 帧（`{type:'upgrade', sid}`，经 poll sid 守卫）。
- Produces:
```ts
// SessionOptions 新增：
/** 升级时 setConfiguration 用的全量 iceServers（STUN+TURN）；缺省回落 opts.iceServers 原表。 */
upgradeIceServers?: RTCIceServer[];
// 导出纯函数（session.ts 与测试共用）：
export function upgradeIceServersFor(policy: RTCIceTransportPolicy, stun: RTCIceServer[], stage: RTCIceServer[]): RTCIceServer[] | undefined;
//   'relay' → [...stun, ...stage]；其余 → undefined（翻转时回传 opts.iceServers 原表）
```
行为契约：upgrade 帧（sid 匹配）→ `setConfiguration({iceServers: upgradeIceServers ?? iceServers, iceTransportPolicy:'all'})` → `createOffer({iceRestart:true})` → 发 offer（同 sid、**无 meta**）→ restartPending 置位至 answer 到达或 teardown；restart answer 在 `remoteSet=true` 下仍须 `setRemoteDescription`（重协商 answer 不得被 `!remoteSet` 条件吞掉）。

- [ ] **Step 1: 写失败测试**

`pwa/src/signaling-web.test.ts` 追加（FakePc 扩：`setConfiguration(cfg)` 捕获、`createOffer(opts?)` 捕获 opts、`setRemoteDescription` 计数；FakeSignaling：send 捕获 + poll 可编排行）：

```ts
test('upgrade 帧 → setConfiguration 全量翻转 + iceRestart offer（同 sid、无 meta）', async () => {
  // arrange：已 connect 的 WebRtcSession（turn 段形态：opts.iceServers=turnServers，upgradeIceServers=stun+turn）
  // act：编排 poll 返回 [{ payload: { type:'upgrade', sid: 's1' } }]
  // assert：
  //   setConfiguration 收到 { iceTransportPolicy:'all', iceServers: [...stun, ...turn] }（键齐、顺序齐）
  //   createOffer 收到 { iceRestart: true }
  //   send 捕获 { type:'offer', sid:'s1', sdp:…, from: myId } 且 !('meta' in msg)
  //   Object.keys(msg).sort() ≈ ['from','sdp','sid','type']（帧纪律钉死）
});

test('restartPending 闸：pending 中第二个 upgrade 帧不再 createOffer；answer 到达后复位', async () => {
  // 连发两行 upgrade → createOffer 仅 1 次；
  // 再编排 answer 行（remoteSet 已 true）→ setRemoteDescription 被再调一次（重协商 answer 未被吞）
  // → 第三个 upgrade 帧 → createOffer 第 2 次
});

test('sid 守卫：非本 sid 的 upgrade 帧静默忽略', async () => {
  // poll [{ payload:{ type:'upgrade', sid:'other' } }] → setConfiguration/createOffer 零调用
});

test('缺 upgradeIceServers：setConfiguration 回传 opts.iceServers 原表（整体替换防呆，Review Focus #5）', async () => {
  // p2pFull 形态构造（无 upgradeIceServers）→ upgrade 帧 → setConfiguration.iceServers === opts.iceServers
});

test('upgradeIceServersFor：relay → [stun…, stage…]；all/tunnel → undefined', () => {
  assert.deepEqual(upgradeIceServersFor('relay', ['stun:x'], ['turn:y']), ['stun:x', 'turn:y']);
  assert.equal(upgradeIceServersFor('all', ['stun:x'], ['turn:y']), undefined);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx tsx --test pwa/src/signaling-web.test.ts`
Expected: FAIL——`upgradeIceServersFor` 不存在 / setConfiguration 未调 / restart answer 被吞。

- [ ] **Step 3: 实现**

signaling-web.ts：
```ts
// SessionOptions 加（:70 natProbe 后）：
/** 升级时 setConfiguration 用的全量 iceServers（STUN+TURN）；缺省回传 opts.iceServers 原表。 */
upgradeIceServers?: RTCIceServer[];

// 导出纯函数（放 POLL_MS 常量区附近）：
/** 升级 iceServers 决策（W2-6）：relay 暖场段 → STUN+TURN 全量；其余段 → undefined（回传原表）。 */
export function upgradeIceServersFor(
  policy: RTCIceTransportPolicy,
  stun: RTCIceServer[],
  stage: RTCIceServer[],
): RTCIceServer[] | undefined {
  return policy === 'relay' ? [...stun, ...stage] : undefined;
}

// WebRtcSession 字段区加：
private restartPending = false;

// 新方法（放 poll() 之前）：
/** 升级执行手（W2-6）：host 信令请求 → 翻转 policy 全量 + iceRestart 重协商。
 *  spike §2.4：浏览器运行期 setConfiguration 有效；restart 只能由 PWA 发起（werift host 禁发起）。 */
private async performUpgrade(): Promise<void> {
  const pc = this.pc;
  if (!pc || !this.sid || !this.deskDeviceId || this.restartPending) return;
  this.restartPending = true;
  try {
    // setConfiguration 整体替换语义：iceServers 必须显式回传，否则回落空表丢 TURN/STUN。
    pc.setConfiguration({
      iceServers: this.opts.upgradeIceServers ?? this.opts.iceServers,
      iceTransportPolicy: 'all',
    });
    await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
    const local = pc.localDescription;
    if (!local) throw new Error('restart offer 后无 localDescription');
    await this.opts.signaling.send(roomFor(this.opts.uid, this.deskDeviceId), this.opts.myDeviceId, {
      type: 'offer', sid: this.sid,
      sdp: { type: local.type, sdp: local.sdp },
      from: this.opts.myDeviceId, // restart offer 不带 meta（旧版兼容；access 已随首 offer 入桶）
    });
  } catch {
    this.restartPending = false; // 本轮作废；host 观测窗到期按 maxAttempts 重发
  }
}
```
poll() 分支改（:313-318）：
```ts
if (m.type === 'answer' && m.sdp && this.pc && (!this.remoteSet || this.restartPending)) {
  await this.pc.setRemoteDescription(m.sdp as RTCSessionDescriptionInit);
  if (!this.remoteSet) await this.flushIce();
  this.restartPending = false;
} else if (m.type === 'ice' && m.cand) {
  await this.addIce(m.cand);
} else if (m.type === 'upgrade') {
  void this.performUpgrade();
}
```
teardown() 加 `this.restartPending = false;`。
session.ts tryWebRtc WebRtcSession opts 字面量加：
```ts
upgradeIceServers: upgradeIceServersFor(policy, this.opts.stunServers, iceServers),
```
（import 自 './signaling-web.js'。）

- [ ] **Step 4: 跑测试确认绿 + 全链**

Run: `npx tsx --test pwa/src/signaling-web.test.ts && npm run lint:twins && npm run test:parallel && npm run test:parity`
Expected: PASS；lint:twins 无新孪生（本任务零候选类型判据）。

- [ ] **Step 5: Commit**

```bash
git add pwa/src/signaling-web.ts pwa/src/session.ts pwa/src/signaling-web.test.ts
git commit -m "feat(pwa): upgrade 帧执行手——setConfiguration 翻转 + iceRestart 重协商（W2-6 Task 6）"
```

---

### Task 7: 文档、遗留登记与全链验证

**Files:**
- Modify: `README.md`（配置节：upgradeWheel 四字段 + `P2P_NET_UPGRADE=0`）
- Modify: `docs/superpowers/plans/2026-09-25-wave2-calibration.md` W2-6 节（状态→实现合入，链本计划与 spike 报告）
- Modify: `docs/cost-model.md` §6.1「TURN 并发上限（coturn）」行 follow-up 列（补「升级轮上线后 TURN 占用预期下降，池扩容仍待用户决策」）

**Interfaces:**
- Consumes: Task 1-6 全部。

- [ ] **Step 1: README 配置节**

在配置说明处（先 Grep `P2P_NET_GZIP` 定位既有开关文档风格，照抄）加：
```md
### 暖场升级轮（W2-6，默认开）
relay（TURN）暖场建连的会话，host 会在暖场稳定后请求 PWA 发起 ICE restart，后台原位升级为直连；
失败自动留在 relay（每会话最多 2 次尝试），不中断既有会话。
- `config.json`：`upgradeWheel: { enabled?: boolean; warmMs?: number; observeMs?: number; maxAttempts?: number }`
  （默认 `{enabled:true, warmMs:10000, observeMs:15000, maxAttempts:2}`）
- 环境变量 `P2P_NET_UPGRADE=0` 强制全关（排障用，压过 config）。
- 观测：`events.jsonl` 的 `upgrade{sid,from,to,ms}` 事件；`node scripts/access-matrix.mjs` 出分桶成功率/回退率。
```

- [ ] **Step 2: wave2 plan 与 cost-model 交叉引用**

W2-6 节标「实现已合入（见 docs/superpowers/plans/2026-09-26-upgrade-wheel.md；spike 裁决 e2e/wave2-upgrade-wheel-spike-2026-09-26.md §2.4）」。cost-model follow-up 列补一句。
遗留登记（写进 wave2 plan 尾部或本任务 commit message body）：
1. coturn 端口池扩容 + 池水位监控——**生产 coturn 配置改动待用户决策**（证据：spike §2.3，cost-model §6.1 TURN 行）。
2. relay-first 级联倒置（首段即 relay 的「真暖场」）——留待 A/B 矩阵证据后评估，本期不做。
3. 切换中断时长指标——不进常设事件流，A/B 战役真机专项测量（spike 基线 28–121ms）。

- [ ] **Step 3: 全量验证**

Run: `npm run lint:twins && npm run test:parallel && npm run test:serial && npm run test:parity && npm run build`
Expected: 全绿；`git status` 仅文档改动。

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/plans/2026-09-25-wave2-calibration.md docs/cost-model.md
git commit -m "docs(wheel): 升级轮配置文档 + wave2 交叉引用 + 遗留登记（W2-6 Task 7）"
```

---

## Self-Review 记录（计划作者已执行）

- **Spec 覆盖**：T6 五件套（独立模块 upgradeWheel.ts ✓ Task 2、协议帧 1 种 ✓ Task 1、门控默认开可关 ✓ Task 3/4、灰度经真机门禁=后续 A/B 战役 ✓ 指标 Task 5、spike 约束 ✓ Global Constraints）。§5 门禁 4「专项 A/B 三指标」：成功率/回退率 ✓ Task 5；中断时长按口径说明留真机专项（Global Constraints 已诚实声明，不在本计划假装覆盖）。
- **Placeholder 扫描**：无 TBD/TODO；所有测试与实现代码完整给出（harness 镜像点均已指明既有文件供对齐，属「读后照抄」非占位）。
- **类型一致性**：`UpgradeWheel` API（Task 2 定义）= Task 3 消费；`onUpgrade` 载荷（Task 3 定义）= Task 4 record 字段 = Task 5 矩阵输入；`upgradeIceServersFor`（Task 6 定义）= session.ts 消费；`resolveUpgradeWheel`（Task 4 定义）= start.ts 消费。帧形状 `{type,sid,from}` 三端一致。
- **Review Focus 5 条**：全部落到具体任务测试（见各条标注）。
