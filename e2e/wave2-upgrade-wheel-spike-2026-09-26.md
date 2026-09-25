# W2-6 暖场升级轮 spike 报告（2026-09-26）

> 分支 `wave2/spike`（worktree `p2p-net-w2-spike`）。Step 1（werift ICE restart 能力取证）+ Step 4 ①④ + **②③ 浏览器/内存取证（2026-09-26 真机窗口完成，见 §2 §3）**。
> ② 结论：三端浏览器 iceRestart 机制全部可用且数据面近无感（中断 28–121ms）；
> 但「relay→direct 迁移」仅桌面 Chrome 在窗内完成（402ms），两台蜂窝真机 8s 窗内未迁移——
> 路线 a 可行，但实现**不得假设单次 restart 即时迁移**（详见 §2.4 裁决）。

## 0. 工件清单（随报告归档，throwaway）

| 工件 | 说明 |
|---|---|
| `scripts/spike/ice-restart.probe.mjs` | werift 能力探针（E0–E4 五组实验），`node scripts/spike/ice-restart.probe.mjs` 可复跑 |
| `scripts/spike/ice-restart.probe.out.jsonl` | 探针逐步输出落盘（61 行 JSONL，含 VERDICT 终行） |
| `scripts/spike/grep-evidence.txt` | werift 0.24.4 API 表面 grep 取证（plan 原文命令 A + 任务书面命令 B + 底层锚点 C） |
| `scripts/spike/ice-restart.browser.html` | ②③ 浏览器取证页 v2（单 PC + 真实 TURN + werift 应答方，自包含可复跑） |
| `scripts/spike/ice-restart.serve.mjs` | ②③ 一体伺服（HTTP+WS 信令+werift 应答方；TURN 临时凭据读 /tmp 0600 文件，不落工件） |
| `scripts/spike/ice-restart.cdp-run.mjs` | ②③ CDP 收割驱动（桌面 Chrome/Android WebView/iPhone Safari 通用） |
| `scripts/spike/ice-restart.stun-probe.mjs` | STUN 直达探针（排查 TURN 池耗尽时隔离 STUN/TURN 用） |
| `scripts/spike/ice-restart.browser.{desktop-chrome,android,iphone}.out.jsonl` | ②③ 三端证据行落盘（候选只记 type+djb2 哈希，无 srflx 裸 IP/无凭据） |

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

## 2. ② 浏览器行为取证（2026-09-26 真机窗口完成）

### 2.0 实验设计与工件

- 工件：`scripts/spike/ice-restart.browser.html`（自包含取证页 v2）、`ice-restart.serve.mjs`（HTTP+WS 信令+werift 应答方一体）、`ice-restart.cdp-run.mjs`（CDP 收割驱动）、`ice-restart.stun-probe.mjs`（STUN 直达探针）；证据行落盘 `ice-restart.browser.{desktop-chrome,android,iphone}.out.jsonl`。
- 拓扑（与路线 a 生产形态同构）：浏览器 PC 以 `iceTransportPolicy:'relay'` + **真实 TURN**（coturn REST 临时凭据，1h TTL，凭据只经 /tmp 0600 文件与内存流转，不进任何落盘工件）建连到 werift 应答方（Mac 本机，host+srflx+relay 全候选）；2s 基线（25ms ping/pong）→ `setConfiguration` 翻转 `policy:'all'`+STUN（浏览器侧对照 werift E3）→ `createOffer({iceRestart:true})` → 观测 8s：ufrag 轮换、nominated 迁移、中断时长。候选/地址一律只记 candidateType + djb2 哈希（srflx 裸 IP 不落盘）。
- 三端：桌面 Chrome 154 headless（Mac）；Android 小米 MiuiBrowser（Chromium 135，WebView 系，蜂窝 LTE CGNAT）；iPhone Safari（iOS 18.7 / WebKit，蜂窝，页面经生产隧道 `/s/8888/` 送达）。

### 2.1 三端结果矩阵

| 端 | relay 建连 | setConfiguration 翻转 | ufrag 轮换（本端/对端） | nominated 迁移 | 迁移耗时 | 数据面中断（gap/首 pong） |
|---|---|---|---|---|---|---|
| 桌面 Chrome 154 | ✅ relay↔relay | ✅ `policyNow:'all'` | ✅ fgyY→LOpw / c1f0→9b69 | ✅ **relay→prflx/host** | **402ms** | 121ms / 8ms |
| Android Chromium 135（蜂窝） | ✅ relay↔relay | ✅ | ✅ XMNy→HrhO / d4a7→24e5 | ⚠ relay→**relay**（新分配 50003→50011；host/srflx 候选已采到但检查未胜出） | 1020ms | 28ms / 11ms |
| iPhone Safari（蜂窝） | ✅ relay↔relay | ✅ | ✅ AEBQ→RyYq / 9edb→96b4 | ✗ **8s 窗内未迁移**（nominated 保持 relay↔relay 原对） | — | 44ms / 31ms |

### 2.2 关键判读

1. **机制层面三端全绿**：`iceRestart` 在浏览器侧（含 WebKit）可用——ufrag 轮换、对端（werift）自动对称重启、`setConfiguration` 运行期翻转 `iceTransportPolicy` 有效（三端一致；与 werift E3「选项建期冻结」不同，**浏览器允许运行期翻转**）。数据面在重启期间近无感：中断 28–121ms，首 pong 8–31ms。
2. **迁移不保证即时**：仅桌面 Chrome（同机直连拓扑）在 402ms 内迁到更优路径；两台蜂窝真机 host/srflx 候选虽采到，但 8s 窗内检查未胜出（CGNAT↔家宽 NAT 下 srflx 对未成熟），Android 迁至新 relay 对、Safari 守原 relay 对。生产 p2p 段 10/10 直连（W2-4 自然级联）走的是**全新 PC 完整 ICE 交换**，与「restart 后即时升级直连」不是同一工况。
3. **对路线 a 的直接含义**：实现不得假设「单次 restart → 秒级迁移直连」。设计必须容忍「restart 后 nominated 留在 relay，直连对成熟后再迁/再 restart」的渐近形态，并把「是否迁成」交给 getStats 观测而非时序假设。
4. **Safari 保守性**：WebKit 重启后连 relay 对都不换（守原对）——升级轮在 Safari 上需要更长的观测窗或多次 restart 触发，验收口径不能用 Chrome 的 402ms 套。

### 2.3 附带发现（外溢价值，产能硬事实）

**coturn relay 端口池仅 20（min-port=50000 / max-port=50019），耗尽即 `ALLOCATE error 508: Cannot create socket`**（/var/log/syslog 实证，2026-09-26 07:33–07:36）。每 PC 视 transport 数占 1–2 个分配，分配残留 ~600s（allocation timeout），故 **TURN 并发会话硬顶 ≈ 10–20，且快速迭代场景极易撞池**。这正对上 W2-4 发现②（iPhone 强制 TURN 4/10 超时）的强候选根因（同口证实测，尚未逐样本对账，不定性）。**必须进成本/容量文档**：coturn 端口池 = TURN 兜底容量的第一约束，先于带宽。

### 2.4 ② 裁决

**路线 a go（条件满足）**：§1.4 第 1 条「浏览器作控制端会跑 checks」被三端实证；浏览器运行期翻转 policy 可行，实现可省掉「信令层过滤」的首建约束（保留作为纵深）。**但实现立项必须采纳 §2.2 第 2/3/4 条设计约束**（渐近迁移 + getStats 观测 + Safari 宽容窗），并连带把 coturn 端口池扩容/监控列为配套运维项。

## 3. ③ 影子 PC（路线 b）内存实测（2026-09-26 完成，结论：证据偏向路线 a）

- 桌面 Chrome 154：`performance.memory.usedJSHeapSize` 基线 1.60MB，顺序建 4 对 loopback PC（full gather）逐对增量在 **数十 KB 噪声级**（1.63→1.65MB，第 4 对后 close 回落至 0.59MB，GC 噪声主导）——**Chromium 上影子 PC 内存代价可忽略量级**。
- Android（MiuiBrowser）：`usedJSHeapSize` 全程冻结常数 42.1MB（隐私量化/冻结），**无法取证**；附带发现：Android WebView 系 loopback 双 PC 可正常 dc open（桌面 headless Chrome 不行，mDNS loopback 不连）。
- iPhone Safari：`performance.memory` 不存在（WebKit 无此 API），**无法取证**。
- 判读：路线 b（影子 PC）的内存成本在唯一可测端（Chromium 桌面）为噪声级，低端 Android 真机无法取证（指标冻结）。结合 ② 的正向结果，**路线 b 无必要作为主线**，保留为降级预案；移动端内存证据缺口记为路线 b 的否决弱证据之一（不是路线 a 的风险）。

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
