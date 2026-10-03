# 战役：P1 多服务工作台双机真机门禁（Android + iPhone）

- 开档：2026-10-01
- 坐标：初心 = docs/superpowers/specs/2026-09-22-p2p-net-design.md；里程碑 = v0.3.2/v0.3.3；被测 = main@清洁后（P1 工作台未发版）
- 前置闭环：清洁 L1-L5 ✅、P1 评审 ✅（`docs/superpowers/reports/2026-09-29-p1-workspace-review.md`，Critical 0 / Important 5 → R4-6..R4-11）
- 被测服务变更：**devanywhere-ui**（https://github.com/ai-baymax-dabai/devanywhere-ui，本机 3001/5173）替换 CloudCLI 角色；配套勘定：测试夹具 `pwa/src/serviceSnapshot.test.ts` 的 'CloudCLI' 名称不改（纯占位夹具，与线上服务无关——记入 R4 候选待定）

## §1 部署基线（2026-10-01 10:40 闭环）

- [x] host 侧：npm 0.3.3 常驻服务（launchd net.p2p-net.server）——P1 为纯 PWA 变更，host 协议不变。**插曲**：refresh token 9-30 起被吊销（401 空转），2026-10-01 经 Management API 重置密码恢复（记录：`~/.p2p-net/ACCOUNT-RECOVERY.md`，0600）；吊销根因未明，列为观察项
- [x] VPS 侧：49.233.155.13 服务的 PWA 与本地 pwa-dist **sha256 逐字节一致**（9-28 晚已部署含 P1 构建，本次零部署）
- [x] 本机被测服务：devanywhere-ui dev 长驻（5173 client 200 / 3001 server）——服务清单实测：console=/s/3001/、DevAnyWhere=/s/5173/、Kimi Code=/s/51778/

## §2 门禁条件（P1 plan Task 7 Step 4 既定 5 条，双机各过一遍）

| # | 条件 | Android | iPhone |
|---|---|---|---|
| G1 | 工作台切换两个服务，各自现场不丢（W-B 回归） | | |
| G2 | 隐藏/恢复跨设备隔离（iPhone 隐藏不影响 Android） | | |
| G3 | 进服务自动沉浸，「∧ 唤起」→ 4s 自动回沉浸 | | |
| G4 | 设备页点服务图标直达对应服务 | | |
| G5 | 通道升降级（关开 WiFi 切蜂窝）中工作台不重载、沉浸不被打破 | | |

## §3 评审 Important 项的真机观测点（顺带取证，非门禁）

- R4-6：离线窗口隐藏当前服务 → 重连后是否持续看到「刚被隐藏的服务」
- R4-7：启动台网格是否应过滤已隐藏服务（产品裁决前的现状记录）
- R4-8：重连后是否被强行切走当前视图（afterConnected 无条件 showTab('workspace') + onTabChange→enterImmersive）
- R4-9：pendingOpenPort 只记 port 不记 deviceId（潜伏，当前模态阻断不可达——验证「不可达」是否属实）
- R4-10：本人档即其闭环（本门禁 = P1 plan Task 7 的真机执行）

## §4 仪器

- Android：adb（设备 6T7T6TZ5F6SKXCMN 已连接）+ Chrome CDP（adb forward tcp:9222）+ e2e/ice-restart-spike-2026-09-26/ice-restart.cdp-run.mjs（CDP 收割驱动）
- iPhone：Safari 手动 + 用户配合操作（无 CDP 等价物——W-B② 既有缺口沿用）
- host 侧：~/.p2p-net/logs/events.jsonl（会话事件）+ current.jsonl（运行日志）+ /status

## §5 结论（iPhone 侧，2026-10-01 自测完成）

**仪器链（新资产）**：iOS 27 上 ios-webkit-debug-proxy 1.9.2 失效（握手通但页面列表空）——改用 **pymobiledevice3 webinspector cdp --port 9333**（usbmuxd 直连，免隧道免 sudo），CDP 驱动 Safari PWA 页面 + `__p2pNetDebug()` 钩子全量取证。驱动脚本 `ios-cdp.tmp.mjs`（仓库根，战役结束归档/删除待定）。注意 9222 被本机 Chrome（webbridge）占用，须用 --port 9333。

### 门禁判定（iPhone，连接方式=tunnel 蜂窝）

| # | 条件 | 判定 | 证据 |
|---|---|---|---|
| G1 | 切换服务现场不丢 | **PASS** | iframe 池元素身份跨切换不变（`__gateF` 对象恒等）；3001(console)/51778 标记与现场保留；5173/51778 首启标记丢失经查为「5s 首拍体检」对慢首屏的设计性后台重载（shell.ts `scheduleHealthChecks`），重载后即就绪——非重建缺陷 |
| G2 | 隐藏/恢复（iPhone 侧机制） | **PASS（半）** | ✕→行变「恢复」、LS `p2p-net.pwa.hiddenServices={"<deviceId>":[5173]}` 按设备分键 ✓；`.svc-unhide` 恢复后 LS 清空 ✓；console(3001) 无 ✕ ✓（spec §4.1）。**Android 侧「不受影响」待 Android 接入后补判** |
| G3 | 沉浸 + 唤起 4s 自动回沉浸 | **PASS** | immersive: true→pill→false（工作台呈现）→≈4s 后回 true 并稳定 7s+ |
| G4 | 设备页图标直达 | **PASS** | launchpad 三图标渲染；点击 51778 → sel=51778、imm=true、唯一可见 iframe=/s/51778/ |
| G5 | 通道升降级不重载/不打破沉浸 | **待测（物理步）** | iPhone 切 WiFi↔蜂窝无法自动化，需用户配合（连同 R4-6 观测一并做） |

### 顺带实证（用户操作路径）

- devanywhere-ui（3001，console）经隧道全功能可用：chat / shell / files / source control（用户亲测 2026-10-01）；PWA 侧 wireBytesRecv=752KB。
- 多设备侧栏树真机渲染 ✓：本机 3 服务 + dva-win 3 服务分组共存（"Win 服务台 A·3000 / Win Vite 案例 B·5173 / Win 报表 C·8888"）。
- 页面刷新后落 console(3001)：符合默认选中链 ①console 自述优先于 ③lastService 的文档化设计（shell.ts `openWorkbench` 注释链）——UX 上「用户期待回到 lastService」与设计的张力记入 R4-8 关联观察。

### 观测点取证

- **R4-7（I-2）实证**：隐藏 5173 后启动台网格仍渲染 5173 图标——启动台不过滤已隐藏服务，待产品裁决。
- **R4-2/R4-4 活样本**：iPhone 蜂窝 NAT=`m:ep-dep,servers:2`，旁路会话（sid d27cd648）03:33/03:37/03:54 三次 session_start→30s 0 字节 failed——ep-dep 象限 relay 空转与登记一致；主用 tunnel 腿正常承载。
- **5173（vite dev client）经隧道永不就绪**：root 空、innerText=0，健康检查按 5s/12s/25s 反复后台重载（设计动作，但永不成功）——vite dev 模块协议（ESM+HMR WS）疑似过不了隧道转发面；与 NEVER 集合含 4173(vite preview) 的历史经验互证。**登记新遗留**：vite dev server 隧道可用性排查（候选 R4 项）。
- **R4-8**：刷新=新会话走默认选中链（不抢）；页内重连的抢视图观测并入 G5 物理步。

### G5 / R4-6 / R4-8 专项（2026-10-01 下午，iPhone 仪器直测）

**G5 通道切换 — PASS（带边界备注）**：
- WiFi off/on（蜂窝恒定）：会话骑行蜂窝，零扰动——无 session 事件、gen=1、sel/imm 不变 ✓
- host 进程 SIGKILL 重启（真实中断 ~2s）：**tunnel 模式对 host 重启透明**（PWA↔VPS 的 WS 不断、relay 解耦）——connected 保持、gen=1 不重建、选中不丢；沉浸出现 ~6s 波动（exitImmersive→自动回沉浸）后自愈 ✓
- host 停机 ~7 分钟长中断：PWA **3s 内如实判离线**（connected=false，stall/probeDown 不误报），**沉浸保持冻住服务 UI**（不白屏不弹条）；host 恢复后 **4s 内自动重连**（mode=tunnel），选中为空时默认链正确开 console 并自动沉浸 ✓
- 边界：p2p/relay 模式的真实 ICE 迁移在本环境（蜂窝 ep-dep 对称 NAT）构造不出，该路径仍仅 harness 覆盖（与 R4-3 登记一致）。

**R4-6（评审 I-1）— 运行时反证，建议核销**：评审静态推断「离线隐藏当前服务不 bounce → 重连后卡在已隐藏服务」**未复现**——host 停机离线窗口内隐藏当前服务（51778），bounce 正常触发：sel=null、回引导页、LS 正确记录；重连后默认链开 console，全程无「卡在隐藏服务」。在线隐藏同样回引导页。评审锚点推断与运行时不符，R4-6 可降级关闭。

**R4-8 — 部分取证，保持开放**：长中断重连 sel 保持/默认链行为正确；但 WiFi 切换窗口曾观测到 sel 51778→3001 的无会话事件跳变，同期用户正在 iPhone Mirroring 上操作（Kimi token 弹窗截图在档），大概率为用户触控，无法排除系统侧原因——保持开放，留待 Android 阶段双机对照。

**仪器副产品**：pymobiledevice3 CDP server（9333）被扫描器判为 website 上架——实测期已隐藏，提示「本机调试类 HTTP 服务会被自动发现」这一既有行为，不设 NEVER（属预期自动发现面）。

**gen 语义记录**：长中断期间 gen 1→10——gen 是重连代际计数而非重建计数（重建未发生）。

---

## §6 Android 侧（2026-10-03，红米 K80 / Android 16 / MIUI 浏览器 Chrome135 内核）

**仪器链突破（重要）**：Android「无 CDP」缺口关闭——MIUI 浏览器暴露 `browser_webview_devtools_remote_<pid>` Unix socket，`adb forward tcp:9334 localabstract:<socket>` 即得完整 CDP（本战役驱动脚本与 iPhone 同一套 `ios-cdp.tmp.mjs`）。此前触屏盲驾阶段的两个「疑点」事后证明全是触屏伪影：①「切回白屏」= 我误按 BACK 键把 iframe 历史导航到空白（恢复由健康检查重载完成）；②「抽屉点了不收口」= 抽屉滑入动画未结束时点击落在遮罩上（C1 遮罩收抽屉，设计行为）。**教训：无仪器阶段的「疑似缺陷」必须先拿仪器复核再立案。**

**配对路径实录（真实用户路径踩坑链）**：MIUI 浏览器 VIEW intent 可复用已开实例不导航前台 tab（需进标签管理器手动切）；`input text` 经中文 IME 会拼音重组（解法：键盘「中/英」切英文模式）；`input text` 在首个 `&` 处截断（解法：`/connect?t=<ticket>` 精简 URL——redeem 只需 ticket，d/u 为提示参数，缺省走「登录成功→选设备」流）；「连不上」底条会随自动重连循环反复弹出。**建议产品项登记：connect URL 容错（去 query 参数依赖）已足够，但 bootPolicy 对死设备的自动重连循环应考虑降频/让位用户选机。**

### 门禁判定（Android，蜂窝/电信 ep-dep → tunnel，中途 WiFi(GOAWAY0724) 双向切换）

| # | 条件 | 判定 | 证据 |
|---|---|---|---|
| G1 | 切换服务现场不丢 | **PASS** | CDP 直验：3001↔52233 双向切换，iframe 元素恒等、`__markA` 窗口标记往返存活、无重载日志 |
| G2 | 隐藏/恢复跨设备隔离 | **PASS** | iPhone 10-01 隐藏 5173 → Android 侧 5173 仍可见（live 对照）；Android 隐藏 52233 → 仅自身 LS 落键 `{"47290b9b…":[52233]}`，选中视图不受扰；双向同码同键，iPhone 侧此前已实证 |
| G3 | 沉浸 + 唤起 4s 回沉浸 | **PASS** | 唤起后 chrome 呈现，5.5s 后复查已自动回沉浸 |
| G4 | 设备页图标直达 | **PASS** | 启动台点 Kimi Code 图标 → 直达 52233 沉浸；离线设备（dva-win）卡片无服务网格（评审 Review Focus #3 顺带实证） |
| G5 | 通道切换不重载/不打破 | **PASS** | WiFi 加入（12:37:58）+ 蜂窝数据关闭（12:39:52）+ 反向（12:41:15）三事件窗内 PWA connected/sel/imm/gen 全稳，host 侧零 session 事件 |

### 顺带实证与观测

- `[workbench] 数据面已重连 → 工作台仍存活，不重建`（W-B①）与 `[p2pupg] 旁路落中继（非直连）→ 不采纳，保持隧道`（W-A 修复）在 Android 真机日志面板上逐字在档；
- 多设备侧栏树 Android 渲染 ✓（在线/离线分组、console 行无 ✕、离线组灰显带 ✕）；
- R4-3 维持开放：WiFi 窗口内旁路仍落 relay 被正确拒绝（04:42:58，ep-dep），adopt-direct 真直连路径仍未获实机样本；
- 新发现（minor）：`[services] 3 个； console=[object Object]`——日志格式瑕疵（对象未展开）；Android BACK 键在 iframe 聚焦时导航 iframe 历史（可致白屏，健康检查 5s 后自愈）——建议评估 BACK 键拦截策略。

**Android 阶段收尾状态**：WiFi 已恢复关闭（与开测前一致）；选中停留在 Kimi Code 52233；debug 浮层页面（?debug=1）保持打开供复查。
