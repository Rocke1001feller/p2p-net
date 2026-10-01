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

### 遗留（本次不闭环）

- G5（iPhone 物理切网）+ R4-6（离线隐藏当前服务→重连视图）→ 用户配合步；
- G2 Android 侧观测 → Android 接入阶段；
- 5173 隧道可用性、启动台过滤裁决（R4-7）、首拍 5s 对蜂窝隧道偏紧（51778 首启被后台重载一次后才就绪——自愈但多一跳）。
