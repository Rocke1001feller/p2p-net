# Wave 2 标定清单实施计划（v0.3.x）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把成本方程剩余未知数（中继率、单 VPS 饱和点、级联裁决）全部刷新为【实测-本仓】，并对「暖场升级轮」做生死 spike——Wave 2 结束回答「N 台什么规格 VPS → 多少在线 → 每千用户每月成本」。

**Architecture:** 三轨：仪器轨（W2-1 接入类型分桶计量、W2-2 NAT facts 探针）先行 → 标定轨（W2-3 饱和压测、W2-4 级联复审、W2-5 直连率矩阵战役）与杠杆 spike（W2-6）并行。全部改动走独立分支 + squash 回 main；测试链纪律不变。

**Tech Stack:** Node 20+ ESM / tsx --test / werift 0.24.4（host WebRTC+STUN）/ 浏览器 RTCPeerConnection（PWA）/ 既有 events.jsonl 事件流。

**Spec:** `docs/superpowers/specs/2026-09-25-wave2-calibration-design.md`（2026-09-25 已提交，473faef）

## Global Constraints

- 简单鲁棒，严控复杂度：不引入 ws 信令长连、三通道决策引擎（spec §0/§1 Out）。
- **token/secret/URL 绝不进事件**（events.ts:15 既有纪律，新字段同样遵守）。
- 新增测试一律动态端口（listen(0)），禁止绑 19727-19729；测试链 = `lint:twins && test:parallel && test:serial && test:parity`，全绿才算完。
- 成本方程引用的每个数字必须带证据分级（【实测-本仓】/【实测-外部】/【弱证据】/【推断】），N<20 的点估计禁止外推（cost-model §6.1 纪律）。
- 浏览器端无 Network Information API 的平台（iPhone Safari）必须降级为手动标注，不得报错（W2-1 设计前提）。
- 分支纪律：每任务 `wave2/<name>` 分支从 main 切出，TDD（先红后绿），完成后主会话 `git merge --squash` 回 main，提交信息带「squash 自 <分支>」，分支保留。
- 跨端共享语义一律单一事实源（机制甲纪律）：schema/类型进 `src/` 经 `./browser` 导出；禁止在 pwa/src 新建孪生（lint:twins 会拦）。

## Review Focus

1. **旧版 PWA（无 meta 字段的 offer）连新版 host**——host 必须按 `access:'unknown'` 落桶，不得抛错或拒连（W2-1 测试钉死）。
2. **NAT 探测时 coturn 不可达 / 用户只配了 1 台 relay**——facts 退化（`mappingConsistency:'unknown'`、`servers:1`）但 doctor 其余层照常（首败不阻断纪律），W2-2 测试钉死。
3. **饱和压测 driver 自身瓶颈（本机端口/CPU）被误读成 VPS 饱和**——driver 报告必须双瓶颈分离陈述（driver 侧 fd/端口水位与 VPS 侧指标分列），W2-3 报告模板钉死。
4. **矩阵战役某象限样本不足 N≥20**——报告该象限留白写「样本不足」，禁止编造或外推（spec §6 诚实清单），W2-5 报告模板钉死。
5. **werift 不支持 ICE restart**——W2-6 spike 第一问即验证；不支持则路线 b（影子 PC），spike 报告获批前禁止进实现（spec §3 T6 门禁）。

---

### Task W2-1: 接入类型分桶计量（仪器轨）

**Files:**
- Modify: `pwa/src/constants.ts`（LS 键）、`pwa/index.html:176-186`（「我的」tab 加标注 select 容器）、`pwa/src/shell.ts`（select wiring）、`pwa/src/signaling-web.ts:170`（offer 载荷带 meta）
- Modify: `src/signaling/protocol.ts`（SigMessage 增 meta——定义在此，client.ts 仅 import）、`src/host.ts`（offer 提取 meta 挂会话条目 + HostStatus 增 access）、`src/server/events.ts`（SessionEvent 增 access）
- Modify: `src/cli/start.ts:231`（session_start 带 access）
- Create: `scripts/access-matrix.mjs`（events.jsonl → 矩阵表）、`src/tests/access-matrix.test.ts`
- Test: `src/server/events.test.ts`、`pwa/src/signaling-web.test.ts`

**Interfaces:**
- Consumes: `SignalingClient.send(room, sender, msg, kind, ttl)`（client.ts:55）；offer 载荷现状 `{ type:'offer', sid, sdp, from }`（signaling-web.ts:170）
- Produces:
  - `SigMessage.meta?: { access?: string }`（protocol.ts）——offer 专用，其余消息不带；`isSigMessage` 校验不变（meta 可选，不进入类型守卫）
  - `HostStatus.access?: string`（host.ts）——offer meta → 会话条目 → onStatus 抛出的状态对象 → start.ts session_start
  - `SessionEvent.access?: string`（events.ts）——取值域 `'cellular-ct'|'cellular-cu'|'cellular-other'|'wifi-home'|'wifi-office'|'other'|'unknown'`
  - `recordSessionEvent` 不变（字段原样透传）
  - CLI：`node scripts/access-matrix.mjs [events.jsonl 路径]` → stdout 矩阵表（accessType × pathType 计数）

- [ ] **Step 1: 失败测试——SessionEvent.access 透传 + 旧版无 meta 兼容**

`src/server/events.test.ts` 追加：

```ts
test('session_start 带 access 透传进 events.jsonl 数据', () => {
  const lines: [string, any][] = [];
  const log = { event: (n: string, d: any) => lines.push([n, d]) } as any;
  recordSessionEvent(log, { name: 'session_start', sid: 'a', access: 'cellular-ct' });
  assert.deepEqual(lines, [['session_start', { sid: 'a', access: 'cellular-ct' }]]);
});

test('无 access 的旧版会话事件不变（兼容）', () => {
  const lines: [string, any][] = [];
  const log = { event: (n: string, d: any) => lines.push([n, d]) } as any;
  recordSessionEvent(log, { name: 'session_start', sid: 'b' });
  assert.deepEqual(lines, [['session_start', { sid: 'b' }]]);
});
```

- [ ] **Step 2: 跑测试确认红**（`npx tsx --test src/server/events.test.ts`，SessionEvent 无 access 字段时 TS 报错/断言差异）

- [ ] **Step 3: events.ts 增字段**

```ts
/** 接入类型分桶（Wave 2 W2-1）：PWA 侧标注经 offer meta 流入；缺省/旧版 = 'unknown'。 */
access?: string;
```

- [ ] **Step 4: SigMessage.meta + host 提取 + HostStatus 链路**。`src/signaling/protocol.ts` 的 `SigMessage` 接口增 `meta?: { access?: string }`；`src/host.ts` offer 处理处（:530「同 deviceId 新 offer → replace()」路由段）把 `msg.meta?.access` 存入会话条目（新增 `access?: string` 字段）；`HostStatus` 接口（host.ts，`onStatus?: (s: HostStatus) => void`）增 `access?: string`，`onSessionStatus`（:592）转发时合并条目上的 access。host.ts 既有测试补一例：offer 无 meta 时会话 access 为 undefined 不抛。

- [ ] **Step 5: start.ts session_start 带 access**（:231 处 `s` 即 HostStatus，onHostStatus 参数）

```ts
record({ name: 'session_start', sid, ...(s.access ? { access: s.access } : {}) });
```

- [ ] **Step 6: PWA 侧标注与 offer 携带**。`pwa/src/constants.ts` 增 `LS_ACCESS = 'p2p-net.pwa.access'`；`pwa/src/signaling-web.ts:170` offer 载荷增 `meta: { access: localStorage.getItem(LS_ACCESS) ?? autoAccess() }`，其中 `autoAccess()`（新函数，同文件）：`navigator.connection?.type === 'cellular' ? 'cellular-other' : 'unknown'`（Safari 无 connection 返回 'unknown'，不抛；TS 无 NetworkInformation 类型时用局部交叉类型 `(navigator as Navigator & { connection?: { type?: string } })`，禁止 any）；UI 标注入口＝`pwa/index.html:176-186`「我的」tab 加 `<select>`（六选项）容器 + `shell.ts` wiring 写 LS_ACCESS。`signaling-web.test.ts` 补：meta 随 offer 发出、无 LS 且无 connection 时 access='unknown'。

- [ ] **Step 7: 分析脚本**。`scripts/access-matrix.mjs`（零依赖）：读 events.jsonl，join session_start(access) 与 session_end(pathType) by sid，输出 `access × pathType` 计数矩阵 + 每 access 样本数；**无 access 字段的 start 一律计入 `unknown` 桶（Review Focus #1：旧版 PWA 兼容钉死）**；样本 <20 的单元格标注 `N不足`。测试 `src/tests/access-matrix.test.ts` 用 fixture 行（两条 start+end 配对 + 一条无 access 的 start + 一条孤儿 end）断言矩阵、unknown 桶与孤儿忽略。

- [ ] **Step 8: 全量测试 + 构建**。`npm test` 全绿；`npm run build && npm --prefix pwa run build` 通过。

- [ ] **Step 9: Commit**（`feat: W2-1 接入类型分桶计量——offer meta→会话事件→矩阵分析脚本`）

---

### Task W2-2: NAT facts 探针（仪器轨）

**Files:**
- Create: `src/natfacts.ts`（schema + 判定表，**纯模块零 Node 依赖**）、`src/natfactsHost.ts`（host 采集器，node:dgram，**仅 Node 不进 browser barrel**）、`src/tests/natfacts.test.ts`
- Modify: `src/cli/doctor.ts`（第 8 层 nat）、`src/log/logger.ts:10`（Layer union 增 `'nat'`）、`src/browser.ts`（**具名导出** NatFacts 类型 + judgeMappingConsistency——不得 export * 把 dgram 采集器带进浏览器 bundle）
- Create: `pwa/src/natfacts-web.ts`（浏览器采集器）+ `pwa/src/natfacts-web.test.ts`
- Modify: `pwa/src/signaling-web.ts`（facts 随 offer meta 扩展位上报——复用 W2-1 meta 通道：`meta.nat`）

**Interfaces:**
- Consumes: doctor.ts:416-462 既有 RFC 5389 最小帧模式（STUN_BINDING_REQUEST/MAGIC_COOKIE/txnId 校验，node:dgram）——W2-2 在其基础上**新增 XOR-MAPPED-ADDRESS 属性解析**（defaultStunProbe 只验响应存在性，不取 srflx）；W2-1 的 `SigMessage.meta`
- Produces:
  - `interface NatFacts { hasSrflx: boolean; srflxPortStable: boolean | null; mappingConsistency: 'endpoint-independent' | 'endpoint-dependent' | 'unknown'; servers: number }`（src/natfacts.ts，类型经 `./browser` 导出）
  - `collectNatFactsHost(stunServers: {host: string; port: number}[], timeoutMs?: number): Promise<NatFacts>`（src/natfactsHost.ts）
  - `collectNatFactsWeb(stunUrls: RTCIceServer[], timeoutMs?: number): Promise<NatFacts>`（pwa，PC 两连采 srflx）
  - doctor 第 8 层 `nat`（现有 7 层 auth/supabase/signaling/ice/vps/scanner/service 之后）：ok=facts 可采集；detail 渲染 mappingConsistency

**设计要点（防孪生 + 防 bundle 污染）**：schema 与判定表单一事实源在 `src/natfacts.ts`（纯，零 Node import，browser 具名导出）；Node 采集器独立 `src/natfactsHost.ts`（dgram 进不了 vite 构建，browser-entry 门禁只拦 werift，dgram 需靠模块拆分拦截）。两侧**采集器不同属正当边界**（浏览器无法 raw STUN），但 facts 语义相同——web 采集器产出原始观测（两个 srflx 的 ip:port），判定调同一个 `judgeMappingConsistency`。

- [ ] **Step 1: 失败测试——判定表**。`src/tests/natfacts.test.ts`：

```ts
import { judgeMappingConsistency } from '../natfacts.js';

test('同 ip:port 跨两服务器 → endpoint-independent', () => {
  assert.equal(judgeMappingConsistency([
    { ip: '1.2.3.4', port: 4000 }, { ip: '1.2.3.4', port: 4000 },
  ]), 'endpoint-independent');
});
test('port 变 → endpoint-dependent；单观测 → unknown；空 → unknown', () => {
  assert.equal(judgeMappingConsistency([
    { ip: '1.2.3.4', port: 4000 }, { ip: '1.2.3.4', port: 4001 },
  ]), 'endpoint-dependent');
  assert.equal(judgeMappingConsistency([{ ip: '1.2.3.4', port: 4000 }]), 'unknown');
  assert.equal(judgeMappingConsistency([]), 'unknown');
});
```

- [ ] **Step 2: 确认红 → 实现 natfacts.ts + natfactsHost.ts**。`src/natfacts.ts`：`judgeMappingConsistency(obs: {ip:string;port:number}[])` 纯函数 + NatFacts 类型（零 Node import）。`src/natfactsHost.ts`：`collectNatFactsHost`——复用 doctor.ts:416-462 的 RFC 5389 最小帧模式，但响应解析**新增 XOR-MAPPED-ADDRESS 属性（0x0020）提取**（defaultStunProbe 只验帧头不取 srflx；解析时 port/ip 需按 RFC 与 magic cookie 异或解码）；对每个 STUN 服务器发 2 次 binding（间隔 200ms），收 srflx 观测；全部超时 → `hasSrflx:false, servers:0`，不抛。转绿。

- [ ] **Step 3: doctor 第 8 层**。`src/log/logger.ts:10` Layer union 增 `'nat'`；`runDoctor` 在 `await guard('service', ...)` 后追加 `await guard('nat', ...)`：从 cfg.relays 推导 STUN 地址（relay.ip/hostname + PORTS.STUN_PORT=3478，contracts/ports.json 单源），调 `collectNatFactsHost`；ok = servers≥1；detail = `mapping=${mappingConsistency} servers=${servers}`；fix（ok=false 时）='检查 VPS coturn 与安全组 udp/tcp 放行'。cfg 缺失时 `gated('nat', 'relays 配置')` 与其他层同纪律。doctor 既有测试补：注入假采集器（deps 增 `natCollector` 可选注入缝），断言失败层不阻断后续。

- [ ] **Step 4: 浏览器采集器**（`pwa/src/natfacts-web.ts`）：`new RTCPeerConnection({iceServers: stunUrls})` + 空 datachannel + createOffer，gather 两轮（两个 PC 实例，各取首个 srflx candidate 的 ip/port），结果调 `judgeMappingConsistency`（从 'p2p-net/browser' import）；无 srflx（对称/全阻）→ hasSrflx=false。测试用注入假 PC 工厂（构造 candidate 字符串序列）。

- [ ] **Step 5: 上报**。signaling-web.ts offer meta 增 `nat`（W2-1 的 meta 通道已就位）：`meta: { access, nat: await collectNatFactsWeb(...).catch(() => undefined) }`——采集失败静默降级，不阻断连接。host 侧沿 W2-1 同链路透传：会话条目增 `nat?: string` → HostStatus 增 `nat?: string` → events.ts SessionEvent 增 `nat?: string`（JSON 序列化后的紧凑串，如 `m:ep-ind,servers:2`；**禁止带 ip**——隐私与事件纪律）→ start.ts session_start 一并带出。

- [ ] **Step 6: 全量 + 构建 + Commit**（`feat: W2-2 NAT facts 探针——schema 单源 + host/web 双采集器 + doctor 第 8 层`）

---

### Task W2-3: 单机饱和压测（标定轨）

**Files:**
- Create: `scripts/bench/tunnel-saturation.mjs`（driver）、`scripts/bench/README.md`（口径说明）
- Create: `e2e/wave2-saturation-<date>.md`（报告，执行后填）
- Test: `src/tests/bench-driver.test.ts`（driver 的 ramp 数学与统计纯函数）

**Interfaces:**
- Consumes: 隧道网关 `wss://<relay>/tunnel/s/<deviceId>?token=...`（生产真值）；`GET 127.0.0.1:19727/status` 的 `dataPlane.tunnelLinks`；VPS `vnstat`（ssh）
- Produces: `benchRamp(total, ratePerSec)` 纯函数（每 tick 应建连接数序列）；报告模板（双瓶颈分离：driver fd/端口水位 vs VPS 指标）

**关键设计**：driver 不进 npm 主依赖（devDependencies 的 ws 直接复用）；**服务端采样为真值**（v3 方法论铁律：不信 driver 自报并发）；爬坡 200/s；每连接 1KB/5s 心跳请求 + 每 30s 一次 1MB 大响应（混合工况）；饱和判据 = 连续 30s 内「新建成功率 <95% 或 p95 心跳 RTT >3×基线」。

- [ ] **Step 1: 失败测试——ramp 数学与统计**。`src/tests/bench-driver.test.ts`：

```ts
import { benchRamp, summarize } from '../scripts/bench/ramp.mjs';

test('benchRamp: 200/s 爬坡，tick=100ms 每拍 20 个', () => {
  const ticks = benchRamp({ total: 1000, ratePerSec: 200, tickMs: 100 });
  assert.equal(ticks.length, 50);
  assert.equal(ticks[0], 20);
  assert.equal(ticks.reduce((a, b) => a + b, 0), 1000);
});

test('summarize: 成功率/p95 计算', () => {
  const s = summarize([{ ok: true, rttMs: 10 }, { ok: true, rttMs: 20 }, { ok: false, rttMs: 0 }]);
  assert.equal(s.okRate, 2 / 3);
  assert.equal(s.p95Ms, 20);
});
```

- [ ] **Step 2: 确认红 → 实现 `scripts/bench/ramp.mjs` 纯函数**（被 driver 与测试共用；ESM，零依赖）。转绿。

- [ ] **Step 3: driver `scripts/bench/tunnel-saturation.mjs`**。骨架：

```js
// 用法：node scripts/bench/tunnel-saturation.mjs <wss-url> <token> <total> <ratePerSec>
// 真值口径：每 5s 采样一次 driver 侧（open 数/失败数/RTT 分布）+ 提示操作员另开终端
// 跑 p2p-net status 与 ssh vnstat——报告必须两侧并列，禁止只引 driver 自报。
import WebSocket from 'ws';
import { benchRamp, summarize } from './ramp.mjs';
// ...ramp 循环：每 tickMs 按 benchRamp 建连，conn 存活期每 5s 发 1KB ping（带时间戳），
// 每 30s 抽 5% 连接请 1MB 响应；process.resourceUsage() + 本机 fd 数（ls /dev/fd | wc -l）每拍落盘；
// 饱和判据触发即停：30s 滑窗 okRate<0.95 或 p95>3×基线。
```

- [ ] **Step 4: 本机自检**。起本地 echo WS（127.0.0.1，listen(0)）跑 200 连接冒烟，断言 driver 统计与 echo 服务端计数一致（一致性差 >1% 则 driver 有 bug，先修）。

- [ ] **Step 5: 真 VPS 爬坡执行**。1000 → 3000 → 5000 三档（或直到饱和判据），每档稳态 5min；同步采集 VPS vnstat / caddy 指标 / `p2p-net status`。**干扰源登记**：LE 证书 6 天续期窗口、coturn 扫描器背景税（cost-model §6.1）。

- [ ] **Step 6: 报告**。`e2e/wave2-saturation-<date>.md`：饱和曲线表（并发×吞吐×p95×错误率）、TLS 建连吞吐（/s）、driver 瓶颈水位 vs VPS 瓶颈**分列**、单 VPS 并发上限结论 → cost-model §6.1 增「单 VPS 并发上限」行【实测-本仓】。

- [ ] **Step 7: Commit**（`feat(bench): W2-3 隧道饱和压测 driver + ramp 数学`；报告与 cost-model 更新单独提交）

---

### Task W2-4: 级联顺序成本复审（标定轨，纯分析）

**Files:**
- Modify: `docs/cost-model.md`（§6.1 增级联裁决行）、`pwa/src/cascadePlan.ts:1-6`（注释更新裁决依据）
- Create: `e2e/wave2-cascade-review-<date>.md`

**Interfaces:**
- Consumes: 真机强制模式 URL 参数 `?tunnel=1` / `?transport=relay`（session.ts:51-52 既有验收覆盖）；events.jsonl 的 `cascade_choice`（mode+rttMs）
- Produces: 裁决结论（维持 p2p→tunnel→turn 或改序）+ 证据表

- [ ] **Step 1: 建链时延实测**。双真机各跑：强制 tunnel 10 次、强制 TURN 10 次，记录 connect 开始→`session_start` 时延（PWA console 时间戳对齐 events.jsonl）。命令/URL 逐条记录在报告。

- [ ] **Step 2: 成本复核**。隧道因子 1.17-1.20 vs TURN 1.27（§6.1 现值）×0.8 元/GB 折算，与外部旧数（0.93 vs 1.344）对照。

- [ ] **Step 3: 裁决入档**。报告给出结论（预期维持现序：tunnel 建链更快且成本持平略优；TLS 在 VPS 终止 vs DTLS 端到端的权衡原文保留）；cost-model §6.1 加「级联顺序」行【实测-本仓】；cascadePlan.ts 头注释更新为裁决摘要 + 报告指针。

- [ ] **Step 4: Commit**（`docs(cost): W2-4 级联顺序复审——现序 p2p→tunnel→turn 实测复核入档`）

---

### Task W2-5: 直连率矩阵战役 N≥20（标定轨，ops 战役）

**Files:**
- Create: `e2e/wave2-direct-rate-matrix-<date>.md`
- Modify: `docs/cost-model.md` §6.1 中继率行

**Interfaces:**
- Consumes: W2-1 的 access 分桶 + `scripts/access-matrix.mjs`；W2-2 的 nat facts（辅助解释）
- Produces: 中继率矩阵（象限 × pathType 分布 × N）

- [ ] **Step 1: 矩阵定义**。象限 = {Android/电信蜂窝， iPhone/联通蜂窝} × {Mac/家宽} × {白天/晚间}；每象限 N≥20 会话（自然使用，每次会话 ≥2min 或有真实流量）；PWA「我的」页标注当前网络（W2-1 的 select）。

- [ ] **Step 2: 跑批**（用户配合窗口，跨 ≥2 天）。每次会话后在 e2e 临时记录表打勾（日期/象限/时长）。

- [ ] **Step 3: 分析**。`node scripts/access-matrix.mjs ~/.p2p-net/logs/events.jsonl` 出矩阵；nat facts 分布附列；N<20 象限留白「样本不足」。

- [ ] **Step 4: 报告 + cost-model 刷新**。中继率行改【实测-本仓 N=<总数>】带置信区间（Wilson 95%）；结论对容量方程悲观/中心档的影响重算。

- [ ] **Step 5: Commit**（`docs(cost): W2-5 直连率矩阵 N≥20——中继率参数本仓实测化`）

---

### Task W2-6: 暖场升级轮 spike（杠杆轨，spike 先行，不进实现）

**Files:**
- Create: `scripts/spike/ice-restart.probe.mjs`（werift 能力探针，throwaway）
- Create: `e2e/wave2-upgrade-wheel-spike-<date>.md`（spike 报告）
- **禁止**：改 src/pwa 任何生产代码

**Interfaces:**
- Consumes: werift 0.24.4 API 表面（node_modules/werift/lib/webrtc/）；浏览器 `createOffer({iceRestart:true})`
- Produces: spike 报告——① werift ICE restart 可行性裁决；② 浏览器 restart 后 nominated 对迁移行为实测；③ 路线 a/b 推荐 + 实现预算

- [ ] **Step 1: werift 能力取证**。`grep -rn "restartIce\|iceRestart" node_modules/werift/lib/ | head -20`；若无，写探针：loopback 双 werift PC，首建限 relay 候选（iceTransportPolicy 或候选过滤），建连后调 restartIce/等价物，观察是否重新 gathering + 能否迁移到 host 候选。探针输出逐行落报告。

- [ ] **Step 2: 浏览器行为取证**（真机/本机 Chrome + Safari）：relay-only 建连 → `createOffer({iceRestart:true})` → 观察 onicecandidate 重新触发 + selected candidate pair 是否迁移（getStats 前后对比）。记录 nominated 迁移是否发生、迁移期数据面中断时长。

- [ ] **Step 3: 影子 PC（路线 b）内存粗测**。低端机可用性：relay 会话 + 额外一个 idle PC，Chrome DevTools Memory 快照对比；记录增量 MB。

- [ ] **Step 4: spike 报告**。裁决：路线 a 可行/不可行（证据）；推荐路线 + 实现预算（模块边界、协议帧、门控开关、A/B 判定阈值）+ 风险。**呈用户批准后才允许开实现任务**（spec §3 T6 门禁）。

- [ ] **Step 5: Commit**（`docs(spike): W2-6 暖场升级轮 spike 报告——路线裁决`；探针代码标 throwaway 随报告归档）

---

## 执行顺序与并行性

```
W2-1 ──┬─→ W2-5（需用户双真机窗口）
W2-2 ──┘
W2-3（本机+VPS 即可，与 W2-1/2 并行）
W2-4（纯分析，与一切并行，但实测步骤用 W2-1 的 access 更有读数——可先做强制模式时延，不等）
W2-6 spike（与一切并行；报告获批后另立实现计划）
```

每任务：独立分支 `wave2/<name>` → TDD → 主会话 squash 回 main → 部署管线（build → 全量测试 → install -g → kickstart → status 验证）。Wave 门禁（spec §5 四条）全过后 bump v0.3.0 发布。
