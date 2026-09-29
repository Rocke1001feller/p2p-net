# P1 多服务工作台评审报告（v0.3.3 → 0dc806e）

评审对象：`git log v0.3.3..0dc806e` 共 17 个 commit（版本位 chore + 16 个 P1 实现 commit，其中含 6 个自评审修复 C1/C2/C3/I4/I5/I6）。基线文档：`docs/superpowers/specs/2026-09-28-multi-service-workspace-design.md`、`docs/superpowers/plans/2026-09-28-multi-service-workspace.md`。

## 一、范围、方法与验证

- **范围**：P1 多服务工作台全部改动（`pwa/src` 的 shell/ui/serviceTree/serviceSnapshot/deviceColor/hiddenServices/consolePick/constants/workbenchRecovery/session、`pwa/index.html`、harness 与测试）；清洁期后续 commit（34c3633..f63f81a）未触 `pwa/src`，HEAD ≡ 0dc806e 代码面。
- **方法**：17 个 commit diff 分段精读 + HEAD 全量源码精读（`pwa/src/shell.ts` 1574 行全文通读）+ spec/plan 逐任务对账 + 三条状态链（选中链 / 隐藏链 / 快照链）竞态与 localStorage 一致性走查。
- **验证**：`npm test` 全绿（exit 0）；`npm run build:pwa` 成功（vite build 3.21s）；`npm run lint:docs` 绿。

## 二、总体评价

**这波改造质量高于仓库历史平均水平，可以放行。** 做得好的地方：

1. **三链一致**：spec → plan → 实现严格对齐。7 个计划任务全部落地，关键签名逐字一致；plan 的 5 条 Review Focus 全部有测试钉住，无一条落空。
2. **自评审修复成色高**：6 个自评审 finding（C1/C2/C3/I4/I5/I6）经逐条代码核验全部闭环（详见第三节），其中 5 个结构性消除根因，不是打补丁。
3. **防御纵深方向正确**：`wakeTimer` 回程前二次校验、换机时 `tabs` 全销毁、`tab.booted` 闩锁止住健康检查链空转——每层都假设上一层会失效，符合本仓「可探测的事禁止猜」的教训纪律。
4. **W-B①② 成果保住了**：P1 没有破坏 0.3.2 战役根治的「黑洞不拆连」语义；`afterConnected` 探活对象从历史 `consolePort` 改为 `selectedPort`，是这次改造里最值钱的一笔——多服务化后探活才真正名副其实。
5. **存储纪律统一**：localStorage 读写全部收敛到 `hiddenServices` / `serviceSnapshot` / `consolePick` 三个模块，shell 里没有散落的裸 `localStorage` 调用；隐私模式写失败全静默不炸。
6. **测试基建诚实**：harness 无事件冒泡模型这件事被明说，并用 spy 契约钉替代（C1），而不是假装测了冒泡——测试基建的自我认知清晰。

## 三、六个自评审修复的闭环判定

| 编号 | 议题 | 判定 | 一句话依据 |
|---|---|---|---|
| C1 | 抽屉遮罩点击穿透 | ✓ 闭环 | `stopPropagation` + harness 无冒泡模型改用 spy 契约钉；真冒泡行为只能靠真机门禁（见 I-5） |
| C2 | 重连不抢选中 | ✓ 闭环（核心）；残留归入 I-3 | `openWorkbench` 的 `everConnected && selectedPort !== null` 守卫成立，但视图维度没守全 |
| C3 | 快照组端口冲突渲染 | ✓ 闭环 | `buildDeviceGroups` 按设备分组渲染，跨设备同端口不串 |
| I4 | 隐藏记录双向反噬 | ✓ 闭环 | 写入方（onHide）与读取方（默认选中链）两个根因都消除了 |
| I5 | 抽屉关闭路径缺失 | ✓ 闭环 | 遮罩 + 「收起」按钮双路径，☰ 被盖问题根除 |
| I6 | 离线组服务行禁用态 | ✓ 闭环 | 结构性修复（禁用态渲染 + 空组提示行语义），无残留 |

## 四、Findings（按严重级）

**Critical：无。**

### Important

#### I-1 隐藏当前服务在离线/重连窗口不生效

- **位置**：`pwa/src/shell.ts` 的 `refreshServiceTree`（`connectedId` 判定）与 `onHide` 回调。
- **现象**：用户在断线窗口（级联未开）打开侧栏，隐藏「断线前正在看」的服务：隐藏记录会落盘（`hideService` 照跑），但 `onHide` 的 bounce 分支判定锚在 `connectedId`（`cascade?.isOpen ? desk.id : null`），断线窗口恒为 null → 既不回引导页也不清 `selectedPort`。重连后 C2 守卫（`openWorkbench` 的 `everConnected && selectedPort !== null` 提前返回）保留选中 → **用户持续看着自己刚刚明确隐藏的服务**，且该服务在侧栏已显示为隐藏态，界面自相矛盾。
- **根因**：bounce 语义的本质是「隐藏的是当前选中服务」，判定锚应是 `desk.id`（身份），而不是 `connectedId`（连接态）。连接态是 bounce 的时机问题，不是目标判定问题。
- **修复建议**：`onHide` 的 bounce 判定改锚 `desk.id`：`deviceId === desk.id && selectedPort === port`。补一例 harness 测试：离线窗口隐藏当前服务 → 重连后落引导页。

#### I-2 启动台网格不剔除已隐藏服务

- **位置**：`pwa/src/shell.ts` 的 `refreshDevicesUI`（直传 `currentServices` 全量给 `renderDevices`）。
- **现象**：隐藏语义只在侧栏树落地；设备页（启动台）的服务网格照样渲染已隐藏服务。「隐藏」在本产品的减法模型里语义是「不显示」，两个入口口径不一致。
- **根因**：`refreshDevicesUI` 没有把 `readHidden` 的过滤接进 `renderDevices`；spec §2.5 对启动台是否过滤也未裁决——这是设计留白，不是单纯实现漏。
- **修复建议**：需产品裁决。建议：启动台遵守隐藏（与侧栏一致），console 服务豁免（与 spec §4.1「console 不可隐藏」对齐）。裁决后 spec §2.5 回填 + 实现 + 测试。

#### I-3 重连抢视图

- **位置**：`pwa/src/shell.ts` 的 `afterConnected`（首行无条件 `showTab('workspace')`）与 `onTabChange` 注册块（`selectedPort !== null` 即 `enterImmersive()`）。
- **现象**：两层叠加——①重连发生时用户若正在设备页/启动台挑服务，被强制拽回工作台 tab（v0.3.3 既有行为）；②P1 新增 `onTabChange` → `enterImmersive`，只要 `selectedPort` 非 null，tab 一切换就自动把 console 拉满全屏。组合效果：用户看引导页（无选中）时重连至少被抢 tab；用户有选中服务时重连，console 直接自动打开铺满——重连是后台恢复事件，不应自作主张改用户视图。
- **根因**：`showTab('workspace')` 在 v0.3.3 单服务时代无害（工作台 = console，本来就是要去的地方）；多服务化后「工作台 tab」与「用户正在看的东西」解耦了，无条件跳转语义过期。`enterImmersive` 的触发条件没有区分「用户发起的切换」与「系统重连带动的切换」。
- **修复建议**：重连路径不强制 `showTab`（首连保留）；`enterImmersive` 触发限定为用户发起的 tab 切换（onTabChange 回调加来源标记，或重连期置标志位跳过）。这是体验语义问题，建议配合 I-1 一起在真机上过一遍。

#### I-4 `pendingOpenPort` 未按设备键控（潜伏缺陷）

- **位置**：`pwa/src/shell.ts` 的 `pendingOpenPort` 声明（`let pendingOpenPort: number | null`）、`onPick` 赋值点、`openWorkbench` 消费点。
- **现象**：跨机直达只记 port 不记 deviceId。当前被模态 UI 阻断不可达（连接中是全屏无取消流程；`btnOfflineClose` 自 v0.3.3 起未接线，是死按钮），但一旦离线条可关闭/连接可取消，即出现「连 B 失败 → 改连 C（同端口恰好存在）→ 服务错投」。
- **根因**：跨机直达的意图是「设备+端口」二元组，状态只存了一元。
- **修复建议**：`pendingOpenPort` 改存 `{ deviceId, port }`，`openWorkbench` 消费前校验 `deviceId === desk.id`；设备页直连与 `stopSession` 路径清除它；`btnOfflineClose` 接线（可取消连接）或删除。

#### I-5 P1 真机门禁未登记（证据链断最后一环）

- **位置**：`docs/superpowers/plans/2026-09-28-multi-service-workspace.md` Task 7 Step 4（5 条双机真机门禁）；spec/plan 头注写「真机门禁见 ROADMAP」但 ROADMAP 无此条目。
- **现象**：指针悬空。C1（遮罩穿透的真冒泡行为）等项的证据链缺最后一环——harness 钉不了的东西只有真机能钉，而门禁本身没登记就会永远挂账。
- **修复建议**：登记 ROADMAP 条目（本次已一并登记为 R4-10），下次双机在场时执行 5 条门禁并回填结果。

### Minor

#### M-1 `openService` 前台段异步间隙后不重读 hidden

- **位置**：`pwa/src/shell.ts` 的 `openService`。
- **现象**：前台段有异步间隙（`ensureSW`、50ms 级等待），间隙后不重读 hidden；「pick → 立即 hide 同端口」的极端手速下已隐藏服务可被打开。窗口窄且自愈（下次渲染即恢复），无伤数据。

#### M-2 换机不回收在途异步

- **位置**：`pwa/src/shell.ts` 的换机路径与 `bootWorkbench` 探活链。
- **现象**：在途的 bootWorkbench 探活、重挂体检链、`pendingFetch` 在换机后不被取消；`tabs.has(port)` 对新设备的同端口 tab 是瞎的。收敛靠 `tab.booted` 闩锁，最坏结果是幂等的无害冗余请求，无错态。

#### M-3 ServiceSnapshot 不记 consolePort

- **位置**：`pwa/src/serviceSnapshot.ts` 与 `pwa/src/shell.ts` 的 `refreshServiceTree`（`consolePort` 只对已连接设备传入）。
- **现象**：离线组的 console 行渲染 ✕（伪装成普通服务）且不可隐藏豁免不生效；离线窗口可写下一条针对 console 的隐藏记录，连上后被无视（console 不可隐藏是身份语义），成为永远生效不了的脏数据。

#### M-4 存储卫生

- **位置**：`pwa/src/serviceSnapshot.ts`、`pwa/src/consolePick.ts`、`pwa/src/shell.ts` 的 `markActive`。
- **现象**：四处小额债务——①快照无 TTL，设备永不再连则快照永存；②`LS_DEVICES` 12 台淘汰后 orphan 快照键/隐藏键不清理；③`writeLastGoodPort` 仍写 `p2p.lastConsolePort`，但生产侧已无读者（`readLastGoodPort` 仅剩测试引用），写的是死信；④`pickFallbackPort` / `readLastGoodPort` 生产侧已无调用方（仅测试引用），`markActive` 是空调用桩（`void port`）。均为 v0.3.2 → P1 默认选中链换轨后的遗留。

#### M-5 `shell-default-service.test.ts` 末例语义真空

- **位置**：`pwa/src/shell-default-service.test.ts` 末例（「console 被隐藏→重连仍选中」）。
- **现象**：C2 之后该例不再驱动默认选中链——重连在守卫处提前返回，测试只要保留现场就过，断言不到它名字声称的行为。建议改为「首连前预置隐藏」路径，才能重新钉住「console 不可隐藏」语义。

#### M-6 spec §4.2 有意偏差未回填

- **位置**：`docs/superpowers/specs/2026-09-28-multi-service-workspace-design.md` §4.2。
- **现象**：spec 写「从设备页进服务前抽屉短暂可见」，实现是启动台直达沉浸（无中间态）。实现更优，属有意偏差，但 spec 未回填——活文档与行为漂移就是这么开始的。建议 spec 回填偏差说明。

#### M-7 既有关联观察（v0.3.3 遗留，非 P1 引入）

- **位置**：`pwa/src/shell.ts` 的 `btnOfflineClose`、`stopSession`、`everConnected`。
- **现象**：①`btnOfflineClose` 未接线（死按钮，I-4 的闸门）；②`stopSession` 后旧 iframe 保持 `display:block`；③`everConnected` 不被 `stopSession` 复位，stop→重连走 isReconnect 路径冗余双开（幂等无害，但日志噪音）。登记随 I-4 一并处置。

## 五、spec/plan 偏差清单

- **7 个任务全部落地**，关键接口签名逐字对齐；plan 头注 5 条 Review Focus 全部有测试钉。
- **计划外增补 1**：`5f1b06f` 设备分组色（`deviceColor.ts`）——真机验收驱动（多设备分组灰成一坨，辨不开），合理增补。
- **计划外增补 2**：`0dc806e` 多设备侧栏树（`serviceSnapshot.ts` + `pendingOpenPort` 跨机直达）——Task 6 有「不缓存僵尸清单」约束，但该约束限定启动台语义；快照喂的是侧栏离线组，属有意扩展而非违反。代价是带出 I-4 / M-3 两笔登记。
- **悬空指针**：spec/plan 头注「真机门禁见 ROADMAP」，ROADMAP 无此条目 → I-5。

## 六、ROADMAP 映射

以下条目已登记进根 `ROADMAP.md` 的 `## v0.4.x` 节（编号续 R4-5 之后）：

| 条目 | 对应 finding |
|---|---|
| R4-6 | I-1 隐藏当前服务离线窗口失效 |
| R4-7 | I-2 启动台隐藏过滤（含产品裁决） |
| R4-8 | I-3 重连抢视图 |
| R4-9 | I-4 pendingOpenPort 键控 + btnOfflineClose（M-7 随此处置） |
| R4-10 | I-5 真机门禁执行 |
| R4-11 | M-2 换机在途异步回收 + M-3/M-4 存储卫生合并 |

M-1（窄窗口自愈）、M-5（测试语义）、M-6（spec 回填）属顺手修复级，不占 ROADMAP 编号，建议随下一次 pwa 改动顺带处置。
