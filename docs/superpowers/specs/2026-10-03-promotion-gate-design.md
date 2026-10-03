# 晋级制研发纪律与多平台真机门禁——设计 spec

> 状态：**草案，待用户评审**（按新纪律未做任何 git 提交；落位方式由评审定：随第一波晋升 squash 进新仓，或迁移手术时手工放入）
> 来源：2026-10-03 两轮脑暴收敛 + 同日基础设施摸底与全链路冒烟演练
> 用户已裁决项：根 v0.3.0；存量 32 提交一条归档分支 + 两波晋升；squash 后证据进档案与 commit message、归档分支用完删；runner 仅保留 org 级共享池；dva-linux 与 dva-win 同生共死但按 24h 服务器运行
> 关联：`~/Downloads/ci-runner-governance.md`（org runner 治理）、`~/.agents/skills/ios-device-debugging/`（iOS 仪器链 canonical）、根 `ROADMAP.md` R4-3/8/12/13

## 1. 目标与不变量

- **main = 已验收成果台账**（append-only 账本），不是工作现场；开发发生在 worktree 车间分支。
- **晋升门槛 = 真机实证**：任何进入 main 的代码必须附多设备真机验证证据（本 spec §5–§7）。
- **main 历史自 v0.3.0 起**：此前 116 个提交不携带前进（占旧历史 73%）；旧仓库归档、永不销毁。
- main 的 log 读起来是一列「已验收里程碑」：squash commit message = 成果摘要 + 证据指针。

## 2. 一次性迁移手术（目标仓：github.com/ai-baymax-dabai/PeerToPeer-net）

| # | 步骤 | 要点 |
|---|---|---|
| 1 | 旧仓库归档 | GitHub 上 rename `Rocke1001feller/p2p-net` → `p2p-net-archive`（或 archive 保护只读）。「不想要」= 不携带前进，不是销毁；旧 hash 引用一律可去归档查 |
| 2 | 历史重根 | `git filter-repo` 以 `v0.3.0` 为根截断：携带 45 提交（2026-10-03 晚定格实测：v0.3.x 11 + 未验收 34；以执行时 `git rev-list --count` 实数为准）+ 5 tag（v0.3.0/1/2/3、golden-2026-09-27） |
| 3 | 推入新仓 | 重写后 push main + tags 到 ai-baymax-dabai/PeerToPeer-net |
| 4 | 存量归档分支 | 建 `legacy/pre-discipline` 指向旧 main 尖（34 个未验收提交，重写后新 hash）；打 tag `legacy/wave1` 于旧 origin/main 位置，标出两波晋升分界 |
| 5 | 分支保护 | GitHub branch protection：禁直推 main、仅允许 PR + squash merge |
| 6 | 车间与收编 | `git worktree add` 起车间目录；`ios-cdp.tmp.mjs` 收编为 `e2e/tools/cdp-drive.mjs`（去 .tmp 化） |

已知代价（接受）：重写后 43 提交全换新 hash，旧档案/文档中的 hash 引用悬空（去归档仓查）；`ios-cdp.tmp.mjs` 等未跟踪临时文件不随迁。

## 3. 晋升流程（每次变更的循环）

1. 车间：`git worktree add ../p2p-workshops/<topic> -b wt/<topic>`（自 main 分出）。
2. 开发完毕，按 §6 矩阵确定最低门禁组合并执行。
3. 证据落档：战役档案 + PR 描述链接 + checklist 勾选（§7）。
4. PR → CI（L0 自动门禁）→ 真机门禁人工确认 → **squash merge** 进 main。
5. 删除 `wt/<topic>` 分支与车间 worktree；存量晋升波次完成后删 `legacy/pre-discipline`。

## 4. 门禁分层 L0–L4

| 层 | 名称 | 内容 | 执行者/载体 | 自动化 |
|---|---|---|---|---|
| L0 | 代码自检 | npm test 全链（lint:twins → lint:docs → parallel → serial → parity）+ 构建，跨平台矩阵 | 迁移后 GHA workflow，`runs-on: [self-hosted, shared-ci]`（POSIX）/ `[self-hosted, Windows, shared-ci-win]`（canary，当前 1/10 绿），跑在 dva 舰队 | 全自动 |
| L1 | 主机闭环 | daemon `/status` 健康 + 服务清单冒烟 + 日志无致命 | 本机或 dva 节点脚本，可并入 CI | 全自动 |
| L2 | 双机真机门禁 | Android + iPhone（蜂窝）× G 门禁表（G1 切换现场不丢 / G2 隐藏恢复设备隔离 / G3 沉浸唤起 / G4 图标直达 / G5 通道升降级不重载） | agent 驱动仪器链 + 战役档案；G 门禁定义以 `e2e/p1-workspace-dual-device-2026-10-01.md` 为模板 | 半自动（CDP） |
| L3 | 舰队互联 | dva 节点 daemon 接入设备树、跨平台 daemon 冒烟、多节点服务树渲染 | agent + dva 节点 + 战役档案 | 半自动 |
| L4 | 物理特例 | iPhone 切 WiFi/蜂窝等物理步、R4-3 直连迁移（ep-dep 对称 NAT 构造不出） | 用户最小配合，档案登记 | 人工 |

## 5. 变更类型 → 最低门禁矩阵

| 变更类型 | L0 | L1 | L2 | L3 |
|---|---|---|---|---|
| docs / 注释 | ✓(lint:docs) | — | — | — |
| PWA UI | ✓ | ✓ | ✓（受影响 G 项子集） | — |
| daemon / host / tunnel 核心 | ✓ | ✓ | ✓（全 G） | ✓（≥2 平台节点） |
| 服务清单 / 新服务接入 | ✓ | ✓ | ✓（新服务双机冒烟） | ✓（1 节点） |
| 构建 / CI / 发布工程 | ✓ | ✓ | — | ✓（矩阵跑通即证） |

## 6. 证据规范

- **战役档案**：`e2e/<代号>-<主题>-<YYYY-MM-DD>.md`，五段式：元数据（**含被测设备序列号/型号**）→ 部署基线（checkbox）→ 门禁表（#/条件/判定/证据 四列，判定用 PASS / PASS（半）/ 待测 等定性词加粗）→ 顺带观测点 → 结论 + 遗留（登记 ROADMAP）。
- **PR 模板 checklist**：L0 绿 / 档案链接 / 按 §5 矩阵勾选受影响门禁 / 遗留已登记 ROADMAP。
- **squash commit message**：成果摘要 + 证据指针（档案路径 + 关键判定）。
- 可选硬门禁（仿 docs-guard）：变更触及 `pwa/` 或 `host/` 的 feat/fix PR 必须引用 e2e 档案，否则 lint 报错。

## 7. 基础设施标准

### 7.1 CI（引用 ci-runner-governance.md）
- 只用 org 级共享池标签：`shared-ci`（POSIX）、`shared-ci-win`（Windows，canary 毕业前 continue-on-error）；定向调试用机器名标签。
- 红线：fork PR 一律不进 self-hosted；runner 机器不放生产 secrets。
- 排队 p95 > 5 分钟触发扩容讨论，不自建 repo 级 runner。

### 7.2 仪器链（canonical）
- **iOS**：`~/.agents/skills/ios-device-debugging/` 是唯一标准——接手先跑 `bash ~/.agents/skills/ios-device-debugging/scripts/check-ios-env.sh`；CDP 桥 `pymobiledevice3 webinspector cdp --port 9233`（**调试端口一律 9232+，9222 永久归 Chrome**）；pymobiledevice3 在 `~/.local/bin`（uv）。
- **Android**：`adb forward tcp:9334 localabstract:browser_webview_devtools_remote_<pid>`（socket 名 `adb shell cat /proc/net/unix | grep devtools`）；MIUI 触控坑：IME 拼音重组、`&` 截断、动画未完成点击落遮罩、BACK 键导航 iframe 历史。
- **共用驱动**：`e2e/tools/cdp-drive.mjs`（迁移后；过渡期仓库根 `ios-cdp.tmp.mjs`），`IOS_CDP_HTTP` 切端口，node 走 nvm 绝对路径，须在仓库根执行。
- **取证读取面**：PWA 页 eval `JSON.stringify(__p2pNetDebug())` → `{connected, mode, services[], selectedPort, immersive, desk, gen, stall, probeDown, frames}`。
- PATH 陷阱：adb / pymobiledevice3 / node 均不在净化 shell 默认 PATH，一律绝对路径。
- 副作用预期：本机 CDP 桥端口会被 daemon 自动发现扫上服务架（预期行为，撤桥即落架，不设 NEVER）。

### 7.3 设备台账（2026-10-03 实测）

| 设备 | 角色 | 状态与要点 |
|---|---|---|
| 本机 Mac | 主 host daemon | 健康（45.5h+）；node 仅 nvm |
| VPS 49.233.155.13 | Caddy 443 + tunnel relay(19700) + coturn + Supabase 信令 | OPS-1 已闭环，例行巡检即可 |
| dva-linux | 舰队节点 / GHA runner | Ubuntu 24.04 VM（宿主 = dva-win，同生共死，24h 开机）；无 ~/.p2p-net，需 bootstrap |
| dva-mac | 舰队节点 / runner | macOS 15.8.1 Intel；需 bootstrap |
| dva-mac-arm64 | 舰队节点 / runner | macOS 27 M2；**node 仅 nvm**；需 bootstrap |
| dva-win | 舰队节点 / runner | 唯一有 ~/.p2p-net 配置；**10-03 下午 daemon 仍未在跑（待排查）**；SSH 默认中文 PowerShell |
| Android 红米 | 真机 L2 | serial `6T7T6TZ5F6SKXCMN` = model `2409BRN2CC`（同一台）；MIUI Chrome 135；电信蜂窝 → tunnel 腿 |
| iPhone 13 | 真机 L2 | iPhone14,7 / iOS 27.0.1；电信蜂窝 → tunnel 腿 |

拓扑事实：双手机蜂窝 ep-dep 对称 NAT，直连打不通，主用 tunnel 腿（`__p2pNetDebug().mode === "tunnel"` 实证）；直连迁移路径仅 harness 覆盖（R4-3 保持开放）。

### 7.4 演练/晋升前置预检（新增条款，dva-win 教材）
每次 L2/L3 演练或晋升验证开始前，先跑预检清单并记入档案元数据：
1. 本机 daemon `/status` 健康；2. iPhone 接手自检脚本 + Safari 有可检页面；3. Android `adb devices` + forward + `/json/list` 非空；4. 意图使用的舰队节点 daemon 在线（如 dva-win 的 `curl 127.0.0.1:19727/status`）——不在线则当次 L3 降级为 deferred 并登记，**不得冒充已验**。

### 7.5 GitHub 平台能力接入（2026-10-03 用户增补：gh 已全面打通，`/opt/local/bin/gh`）

原则：不为用而用——每项能力挂在一个真实痛点上；未接入的明说不接。并行开发（多 worktree 车间）是日常铁律，以下能力为其服务：

| 能力 | 接入方式 | 纪律 |
|---|---|---|
| Issues | ROADMAP 条目与遗留的登记源：凡「登记 ROADMAP」的项同时开 Issue（label：gate-debt / bug / enhancement），ROADMAP 引用 Issue 号 | 战役遗留、评审发现、门禁缺口一律 Issue 化，不散落在对话里 |
| Pull requests | 唯一晋升通道（分支保护强制）；PR 描述 = 晋升清单 checklist（L0 绿 / 档案链接 / §5 矩阵勾选 / 遗留 Issue 链接） | main 只经 PR+squash；`wt/*` 车间分支 push 后即开 PR |
| Actions | L0 自动门禁载体：npm test 全链跨平台矩阵（`runs-on: [self-hosted, shared-ci]`；Windows 走 `shared-ci-win` canary，治理规范 §5）；后续可加「档案存在性 lint」 | PR 必过 L0；canary 期间 Windows job continue-on-error |
| Releases | v0.3.x tag 配 GitHub Release：发布说明从战役档案/squash 摘要生成 | 每个对外版本一个 Release；golden 快照可选 prerelease |
| Packages | 沿用 `@ai-baymax-dabai` scope（devanywhere-ui 先例）；p2p-net 若拆 npm 包（contracts/类型）同通道 | GITHUB_TOKEN 推包，不引第三方 registry |
| Deployments | **暂不接入**：部署面是 VPS（init-node.sh）+ 各 dva 节点 daemon，GitHub Environments 无对应物；待有 CI/CD 诉求再立项 | 不硬凑 |

gh 优先：能 gh 命令化的平台操作（建仓/改名/分支保护/开 PR/发 Release/开 Issue）一律命令化，不留给浏览器。

## 8. 冒烟演练记录（2026-10-03，本标准首次实证）

| 层 | 结果 | 证据 |
|---|---|---|
| L1 主机闭环 | ✓ | `/status`：uptime 45.5h、tunnel 1/1、signaling 0 连续失败 |
| L2 双机 | ✓ | Android `?debug=1`：connected/mode=tunnel/3 服务/沉浸 Kimi Code(52233)/帧流健康；iPhone 同入口：connected/tunnel/gen1/沉浸 console(3001)——CDP 双端全量读取成功 |
| L3 舰队 | ✗ deferred | 舰队 0 daemon 在线（dva-win 复活未存活，其余未 bootstrap）；按 §7.4 记 deferred，不冒充 |

顺带实证：CDP 桥端口被自动发现扫上服务架（9232/9233/9334 现身服务清单）；Android 残留 `connect?t=` 配对页（票据 120s 过期后滞留无害）。
撤收：CDP 桥与 adb forward 全部清零；iPhone 页面留在工作台入口（原配对页票据已过期），Android 未做任何变更。

## 9. 遗留登记（晋升工作需一并处理）

| 项 | 说明 |
|---|---|
| dva-win daemon 排查 | 配置在、进程无；查拉起方式/开机自启/崩溃日志 |
| 舰队 bootstrap ×3 | dva-linux / dva-mac / dva-mac-arm64 从零起 daemon（arm64 注意 nvm） |
| AGENTS.md 漂移修正 | iPhone 条目从 ios-webkit-debug-proxy 改为 skill canonical（pymobiledevice3:9232+）；后者已卸载 |
| R4-3 | adopt-direct 真直连实机样本（环境构造不出，L4） |
| R4-8 / R4-12 / R4-13 | 重连抢视图对照 / vite 过隧道白屏 / 首拍 5s 偏紧 |

## 10. 实施顺序

① 用户评审本 spec → ② writing-plans 出迁移实施计划（步骤级，含验证点）→ ③ 执行迁移手术（§2）→ ④ 第一波晋升（legacy/wave1 内容按全门禁实战——门禁的首次真实考验）→ ⑤ 第二波晋升 → ⑥ 常驻纪律运转。
