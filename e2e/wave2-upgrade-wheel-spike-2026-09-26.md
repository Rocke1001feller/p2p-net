# W2-6 暖场升级轮 spike 报告（2026-09-26）

> 分支 `wave2/spike`（worktree `p2p-net-w2-spike`）。本报告只完成计划 W2-6 的 **Step 1（werift ICE restart 能力取证）** 与 **Step 4 中的 ①④ 两项**（① werift 能力裁决、④ 路线 a/b 推荐框架与实现预算初稿）。
> **② 浏览器行为取证（Chrome/Safari `createOffer({iceRestart:true})` 后 nominated 迁移与中断时长）＝ 待真机窗口，未做。**
> **③ 影子 PC（路线 b）低端机内存实测 ＝ 待真机窗口，未做。**
> 在 ② 落定前，本文 ① 的可行性裁决为「条件性裁决」，④ 为「框架与预算初稿」，不作为实现开工依据（spec §3 T6 门禁：spike 报告获批前禁止进实现）。

## 0. 工件清单（随报告归档，throwaway）

| 工件 | 说明 |
|---|---|
| `scripts/spike/ice-restart.probe.mjs` | werift 能力探针（E0–E4 五组实验），`node scripts/spike/ice-restart.probe.mjs` 可复跑 |
| `scripts/spike/ice-restart.probe.out.jsonl` | 探针逐步输出落盘（61 行 JSONL，含 VERDICT 终行） |
| `scripts/spike/grep-evidence.txt` | werift 0.24.4 API 表面 grep 取证（plan 原文命令 A + 任务书面命令 B + 底层锚点 C） |

环境：macOS（Intel x86_64）、node v24.13.1、werift 0.24.4（`npm ci` 锁定安装，与 `package.json` `werift: ^0.24.4` 一致）。

## 1. ① werift 能力裁决

### 1.1 API 表面（grep 取证，`grep-evidence.txt`）

werift 0.24.4 **存在** ICE restart API 表面（spec §3 T6「源码未见 restartIce」的假设被推翻）：

- `RTCPeerConnection.restartIce()` — `node_modules/werift/lib/webrtc/src/peerConnection.js:815`（置 `needRestart=true` 并触发 negotiationneeded）
- `RTCPeerConnection.createOffer({ iceRestart })` — `peerConnection.js:514`（`iceRestart || needRestart` → `secureManager.restartIce()`）
- `SecureTransportManager.restartIce()` — `secureTransportManager.js:280`（对每个 `IceTransport` 调 `restart()`）
- `IceTransport.restart()` — `transport/ice.js:266`（`iceRestarts++` → `connection.restart()` → state/gatheringState 重置 `"new"`）
- `Connection.restart()` — `werift/lib/ice/src/ice.js:624`（**轮换本地 ufrag/pwd**，清 nominated/checklist/远端候选，**保留既有 socket protocol** 并按新 generation/ufrag 重新广告其候选，ice.js:679-685）
- 对端对称重启 — `transport/ice.js:246-263`（`setRemoteParams` 见远端 ufrag/pwd 变化 → 自动 `restart()`）
- relay-only 抑制 — `secureTransportManager.js:121`（`forceTurn: config.iceTransportPolicy === "relay"`）→ `ice.js:852`（`gatherRelayOnly` 抑制 host/srflx）；TURN 分支不被排除（`ice.js:881`）
- 统计 — transport 级 `iceRestarts` 计数（`transport/dtls.js:531`）

### 1.2 行为取证（探针 E0–E4，证据行出自 `ice-restart.probe.out.jsonl`）

实验设计：loopback 双 werift RTCPeerConnection 同进程信令直连。loopback 无 TURN，「relay-only 首建」以**信令层候选过滤**模拟（首建屏蔽升级地址 `::1`，restart 后只放 `::1`；ICE restart 语义与候选类型无关）。死 STUN（`stun:127.0.0.1:9`）屏蔽 werift 默认回落的 `stun.l.google.com`（ice.js:598-601），保证无外网依赖。

| 实验 | 断言 | 结果 | 关键证据行 |
|---|---|---|---|
| E0 | restartIce/createOffer/setConfiguration 存在 | ✅ | `E0.api {"typeof pc.restartIce":"function",...}` |
| E1 | `iceTransportPolicy:'relay'`（配 TURN）抑制 host/srflx | ✅ 0 host/srflx | `E1.relay-only.gather {"hostSrflxEmitted":0,"relayEmitted":0,...}` |
| E2 | restart 后重新 gathering（onicecandidate 再触发） | ✅ 双端各重发 8 候选 | `E2.phase2.connected {"regatheredA":true,"regatheredB":true,...}` |
| E2 | ufrag/pwd 轮换（RFC 8445） | ✅ `05cb→e38a`（pwd 同步轮换） | `E2.phase2.offer {"ufragRotated":true,...}` |
| E2 | 对端见新 ufrag 自动对称 restart | ✅ B `7d9c→59f1` | `E2.phase2.answer {"bSymmetricRestart":true,...}` |
| E2 | **原生流程 nominated 对重建/迁移** | ❌ 无 nominated 对，datachannel echo 超时 | `E2.phase2.echo.fail` + `pairA/pairB {"found":false,...}` |
| E3 | `setConfiguration` 把 relay→all 翻转后重启 | ❌ 仍 0 host 候选（transport 选项建期冻结） | `E3.gather.after-flip-to-all {"hostSrflxEmitted":0,"configFlipEffective":false}` |
| E4a | 只手动驱动**发起方** `iceTransport.start()` | ✅ nominated 双端成立、echo 1ms、迁移到 `::1` | `E4a.initiator-only.result {"initiatorOnlyEchoMs":1,"initiatorOnlyNominated":true,...}` |

VERDICT 终行（JSONL 最后一行）：

```json
{"restartIceApiExists":true,"relayOnlySuppressionWorks":true,"restartRegathers":true,"ufragPwdRotated":true,"remoteAutoSymmetricRestart":true,"nominatedPairMigrates":false,"datachannelSurvivesRestart":false,"setConfigurationFlipEffective":false,"workaroundInitiatorOnlyNominates":true,"workaroundInitiatorOnlyEchoMs":1,"workaroundInternalStartMigrates":true}
```

### 1.3 原生流程阻断点（决定性证据）

**已建连（DTLS connected）的 werift PC 上，restart 后 connectivity checks 根本不会调度**：

- `peerConnection.connect()`（`peerConnection.js:780-792`）逐 transport 先查 `iceTransport.state === "connected"` 再查 `checkDtlsConnected()`；restart 只把 **ICE** 状态重置为 `new`，**DTLS 保持 `connected`**（这正是 RFC 8445 的设计——DTLS/SCTP 会话复用新对），于是第二查命中 → **直接 return，`iceTransport.start()` 被跳过**。
- DEBUG 日志对照（`DEBUG=werift*`，两次独立运行一致）：phase 1 建连期 ice 层 `start connect ice` 出现两次（双端各一）；phase 2 restart 后**零次**——远端候选已到位（日志见双端 `addRemoteCandidate`），但无任何出站 check、无 nomination，5 秒观察窗内数据面死亡。
- E4a 对照：手动对**发起方**调 `iceTransport.start()`（探针内模拟「控制端会跑 checks」的浏览器行为）后，同一会话 nominated 对双端重建、ufrag 为新一代、datachannel echo 1ms 恢复、A 端 nominated 对的 remote 即 B 的 `::1` 候选（B 端经 prflx 学到 A 的 `::1`）——**restart 链路的其余环节（角色协商、check/response、nomination、DTLS/SCTP 复用、向升级路径迁移）全部完好**。

### 1.4 裁决

**路线 a（ICE restart 原位升级）＝ 条件性可行：**

1. **升级轮必须由 PWA（浏览器）发起**（`createOffer({iceRestart:true})`），werift host 作受控应答方。浏览器作控制端会正常跑 checks（② 待验证的正是这条），host 侧 werift 只需响应与被提名——探针 E4a 已证明该拓扑下全链路成立，**host 侧无需任何 werift 补丁**。
2. **host 侧不能作为 restart 发起方**（werift↔werift 双端原生流程死锁，§1.3）。若产品需要 host 触发升级，应由 host 经信令**请求** PWA 发起 restart，而不是 host 自己 `restartIce()`；或者对 werift 打补丁（`connect()` 在 `iceTransport.state === 'new'` 时不得因 DTLS 已连接而早退）——补丁方案意味着 fork/patch 依赖形态变更，成本计入路线 a 预算但不推荐首选。
3. **「首建 relay-only → 后期放开直连」不能靠 `setConfiguration` 翻转**（E3：选项建期冻结）。路线 a 实现的候选策略必须是：PC 构造即 `iceTransportPolicy:'all'`，**首建由信令层过滤非 relay 候选**（本探针同源手法），升级时 restart + 放开过滤。
4. 信令纪律：restart 重协商期间，**必须先交换描述再放行候选**——werift 在已有旧远端描述时对新 ufrag 的乱序 trickle 候选直接 `OperationError: No media section matched the ICE usernameFragment` 拒绝（无描述时才会内部排队）。生产信令按 room 消息天然有序，仍需在 host 侧做候选缓冲兜底。

## 2. ② 浏览器行为取证 —— 待真机窗口，未做

计划 W2-6 Step 2：本机/真机 Chrome + Safari，relay-only 建连 → `createOffer({iceRestart:true})` → 观察 onicecandidate 重触发、getStats 前后 nominated 对迁移、迁移期数据面中断时长。**本窗口未执行。** 它是 §1.4 第 1 条「浏览器作控制端会跑 checks」假设的直接验证，也是路线 a 最终裁决的最后一环。

## 3. ③ 影子 PC（路线 b）内存实测 —— 待真机窗口，未做

计划 W2-6 Step 3：低端机 relay 会话 + 额外 idle PC 的 Chrome DevTools Memory 快照对比。**本窗口未执行。** 路线 b 的内存成本未知前，④ 的预算对比只能给框架。

## 4. ④ 路线 a/b 推荐框架与实现预算（初稿）

### 4.1 推荐

**主路线 a（PWA 发起的 ICE restart 原位升级），路线 b（影子 PC）作降级预案。** 理由：a 的协议面改动最小（复用既有 offer/answer/candidate 信令，无第二 PC 生命周期管理），且 §1.4 拓扑下 host 零补丁；b 的价值在于不依赖任何 restart 语义（现网零风险），代价是双 PC 瞬时内存（③ 未知）与原子切换的数据面编排。若 ② 发现浏览器 restart 行为不达标（不重新 gathering / nominated 不迁移 / Safari 异常），降级到 b。

### 4.2 路线 a 实现框架（初稿，非开工依据）

- **模块边界**：host 侧在会话条目上挂升级状态机（`warm(relay-only) → upgrading → direct|fallback`）；PWA 侧持有候选过滤策略对象（warm 期只放行 relay 类型，升级期全放行）。候选过滤在信令收发两处各设一道（防对端旧版本不过滤）。
- **协议帧**：复用既有 `offer/answer/candidate` 消息；新增一帧轻量控制消息（如 `{type:'upgrade'}`，host→PWA 请求发起 restart；PWA→host 回报结果由后续 offer/answer 天然承担）。**帧内严禁 token/URL**（事件纪律同上：upgrade 结果进 events.jsonl 只带 `from:'relay',to:'direct'|'fallback',ms`，不带地址）。
- **门控开关**：host 配置项（如 `upgradeWheel: off|auto`）+ 每会话一次性触发（restart 失败不重复发起，回退保持 relay 会话不中断——restart 失败的会话按 §1.3 观察是「数据面死亡」还是「保持旧对」取决于对端行为，**回退语义必须在 ② 中一并验证**）。
- **A/B 判定阈值**（spec §5 T6 既有要求）：升级成功率（目标 ≥ 直连率上限的 80%）、切换中断时长（restart 开始→数据面恢复，目标 p95 < 1.5s）、回退率（目标 < 10%）。计量接 W2-1 的 access 分桶，按桶分别达标。
- **实现预算（粗）**：host 侧状态机 + 过滤策略 + 信令帧 ≈ 2 个模块改动 + 1 个新测试文件；PWA 侧过滤策略 + restart 发起 + UI 无感 ≈ 1-2 个模块改动；测试链新增 parity 用例（restart 后 datachannel 存活、offer 无 meta 旧版兼容）。**不含** werift 补丁（§1.4-2 已规避）。

### 4.3 路线 b 实现框架（降级预案，初稿）

- relay 会话 PC 不动；后台建 `iceTransportPolicy:'all'` 且信令层只放行 host/srflx 的新 PC；新 PC datachannel 就绪后原子切换数据面引用，失败静默 close。无 restart 语义依赖。
- 预算：双 PC 生命周期管理 + 切换编排 ≈ 比 a 多一个 PC 管理模块；**③ 的低端机内存数据是 go/no-go 前提**。

### 4.4 风险

1. **② 未做**：浏览器 restart 行为是路线 a 的硬前提（§1.4-1）；若 Safari 不支持/行为异常，需按接入类型分桶降级（W2-1 的 access 桶正好承接）。
2. **回退语义未验证**：restart 失败后原 relay 会话是否保活，浏览器侧行为未知（② 必测项）。
3. werift 对端 quirks（不影响裁决，记录在案）： nominated 对的 local 侧记录偶发与实际收包 socket 不符（探针 run 中 B 端 pair local 记录为非收包地址，数据面不受影响）；PC 级 `iceConnectionState` 聚合在 restart 后可能不经 `checking` 直显 `completed`——做升级状态机时**不能以 PC 级 iceConnectionState 为唯一判据**，需以 nominated 对 + datachannel 探活为准。
4. 探针环境差异：本机 macOS 无 127/8 整段路由（`::1` 代替）；Linux 行为可能不同，不影响生产路径（生产候选是公网 relay/host 地址）。

## 5. 附：探针过程发现（外溢价值）

- werift 未配置 STUN 时 `Connection` 默认回落 `stun.l.google.com:19302`（ice.js:598-601）——**离线/内网部署的 host 会隐式依赖 Google STUN**，doctor/部署文档应显式配置。
- werift 不 gather loopback 接口地址（`selectAddressesFromInterfaces` 过滤 internal）；额外地址用 `iceAdditionalHostAddresses` 注入。
- macOS 不能 bind 也不能向 `127.0.0.2` 投递（`EADDRNOTAVAIL`；无 127/8 整段路由）——本机探针用 `::1`。
- restart 后 werift 重新 gathering 只**重广告既有 protocol 的候选**（ice.js:679-685 防重复添加），不会新建同地址 socket——暖场首建时就应把所有潜在直连 socket 建好（构造即 `'all'` 的另一佐证）。
- 发起方 restart 后本地 `remoteUsername` 被清空（ice.js:637-638），收到对端新一代 ufrag 的 answer 时**不会**二次本地 restart；应答方则对称 restart 一次——ufrag 双端各轮换一代，信令只需一趟 offer/answer。

## 6. 纪律与偏差声明

- 未改 `src/` 与 `pwa/src/` 任何生产代码（git status 仅新增 `scripts/spike/` 三件 + 本报告）。
- TDD 偏差：本任务为 throwaway 取证探针（plan W2-6 Files 无测试文件、明确禁止改生产代码），无「先红后绿」对象；以全量测试链与构建验证零回归：
  - `npm run lint:twins` ✓（twin-guard：pwa/src 未检出已登记孪生模式）
  - `npm run test:parallel`：406 测 404 过 2 跳过 0 败；`npm run test:serial`：1 测 1 过 0 败；`npm run test:parity`：66 测 66 过 0 败（合计 473 测 471 过 2 跳过 0 败，与 main 基线「473 测 0 败」一致，链 exit=0）
  - `npm run build` ✓（tsc -p tsconfig.json）
  - 环境磨合记录（非代码问题）：worktree 首跑测试链时 dist/ 未构建、`pwa/node_modules` 未装导致两轮红，经 `npm run build` + `npm --prefix pwa ci` 后转绿，与本次改动无关。
- 探针首轮曾误判「探针环境即 werift 缺陷」（127.0.0.2 不可投递），已通过 dgram 独立探针证伪并改用 `::1`，全部结论以 §1.2/§1.3 的可复跑证据为准。
