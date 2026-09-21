# p2p-net 设计文档（一期 MVP）

- 日期：2026-09-22
- 状态：设计已获批准，待 spec 审阅
- 作者：Rocke1001feller + Kimi Code（brainstorming 流程产出）
- 后续计划追踪：见 `docs/ROADMAP.md`（长期活文档，本文档第 13 节为机制说明）

---

## 1. 背景与目标

**是什么**：把 DevAnyWhere v2 已产品化验证的「账号为根、多 Server 多 Client 的 WebRTC 远控数据面」抽成独立 npm 包 `p2p-net`，让任何开发者/创业团队只准备三样东西即可自部署整套系统：

1. Supabase Access Token（必选）
2. 一组 relay VPS（`username@ip password` 列表，必选）
3. Cloudflare Pages（可选，二期）

**本质判断**：对标的不是 ngrok（公网隧道），而是 Tailscale 式的开发者自助体验——但零 VPN 客户端、入口是纯 Web PWA、协调后端用 Supabase 替代自建。核心价值不是 WebRTC 管线（已两轮真机验收），而是 **bootstrap 编排**：Supabase 一键初始化 + VPS 无人值守初始化 + 凭据分发 + 配置注入。

**用户命令面**：

```bash
npx p2p-net init      # 交互式录入三件准备 → 全自动初始化 Supabase + VPS
npx p2p-net start     # 前台运行 Server（未装 service 时提示）
npx p2p-net service install   # 常驻后台（必选能力，一期交付）
npx p2p-net doctor    # 分层归因诊断
npx p2p-net status    # 实时会话/性能视图
```

**拓扑**：账号为根。Server（跑 start 的设备）与 Client（PWA 端）都隶属 Supabase 账号；S→多 C；S↔S 一期不做数据面管道，Client 侧聚合多 Server（见 §2 决策 Q3）。

**来源**：核心库抽取自 `~/Documents/money/DevAnyWhere/cores/devanywhere-p2p`（~1800 行、零原生依赖、双入口、凭据全注入），宿主运行时抽取自 `devanywhere-server`，后端资产来自新老两仓 supabase 目录的精简合并。

## 2. 已锁定决策

| # | 决策点 | 结论 |
|---|---|---|
| Q1 | 与 DevAnyWhere v2 的代码关系 | p2p-net 独立新仓成为**上游**；DevAnyWhere v2 后续改为依赖它（切换另行立项） |
| Q2 | Supabase 凭据粒度 | **个人 Access Token + Management API**；token 用完即弃不落盘 |
| Q3 | Server↔Server 语义 | 一期 = **Client 侧聚合**（一 Client 连多 Server，服务清单按 Server 分组）；Server 间数据面管道不做 |
| Q4 | PWA 分发 | **pwa-dist 随 npm 包钉版发布**，用户永不碰前端构建；配置运行时注入（§3） |
| Q5 | 开源策略 | 公开仓 + npm public（`p2p-net` 名字已查可占）+ **MIT** License |
| Q6 | 一期 MVP 边界 | 一台 Mac + 一台 VPS + 一部手机蜂窝扫码全链路；Pages/Windows/S↔S 管道全部二期 |
| F1 | service 化 | **必选能力**（创业团队远程办公刚需），一期交付 launchd + systemd |
| F2 | 可观测性 | **从第一天内建**（§6），同时设复杂度红线：无外部 APM、无 metrics server、无远程上报 |

技术选型补充：Node ≥20；全 TypeScript，单一 tsconfig，tsc 直出 dist（不提交 dist 进 git，prepublish 构建）；CLI 参数解析用内置 `util.parseArgs`；SSH 用 `ssh2`（纯 JS，无原生依赖）；QR 用 `qrcode-terminal`。**运行期零外部工具链调用**（不 spawn npm/git/tar——继承 DevAnyWhere 宪法第 10 条精神）。

## 3. 架构总览

```
┌ Server 机（用户电脑）        ┌ Supabase（用户的 project）     ┌ VPS × N（用户的）
│  p2p-net service (常驻)      │  auth / devices                │  coturn (TURN REST)
│   ├ DvaHostAgent (WebRTC)    │  pairing_tickets               │  caddy ≥2.10 (IP 短证书)
│   ├ TunnelClient → VPS ×N    │  signaling_messages            │   ├ 托管 PWA (pwa-dist)
│   ├ 端口扫描器/服务清单       │  edge functions ×2:            │   ├ /config.json（运行时配置）
│   ├ 配对出票 + QR            │   turn-credentials             │   └ /tunnel 反代 →
│   ├ 本地控制面 127.0.0.1     │   redeem-pairing-ticket        │  p2p-net-tunnel.service
│   └ NDJSON 日志+事件流        │                                │
└────────────┬─────────────────┴───────────┬────────────────────┘
             │ 信令=PostgREST 800ms 轮询    │ 媒体面=级联
             ▼                              ▼
   Client（手机浏览器 PWA）：扫 QR → 票据兑换登录 →
   级联连接（p2p 直连 10s → tunnel 6s → TURN 15s）→
   SW 拦 /s/<port>/ → 按 Server 分组的 iframe 服务清单
```

**关键设计：PWA 产物通用化 + 配置运行时注入**。pwa-dist 不含任何部署相关常量；每台 VPS 的 Caddy 托管由 init 写入的 `/config.json`（supabaseUrl / publishableKey / relay 列表 / turn 函数地址），PWA 启动先拉取。"每用户配置不同"与"PWA 不重建"两个约束同时满足。Server 端配置同理落在 `~/.p2p-net/config.json`。

**包内布局**（单仓单包，四层目录纪律）：

```
p2p-net/
├── lib/        # 核心库：peer / host / frames / signaling / bridge / tunnel（Node+browser 双入口）
├── cli/        # init / start / service / doctor / status / deploy-pwa
├── node-init/  # VPS 初始化脚本与配置模板资产（SSH 时推送执行）
└── pwa-dist/   # 版本钉死的 PWA 产物（prepublish 时构建打进 tarball）
```

## 4. init 编排

交互式，**边录入边验证、失败即停并给可操作提示**。全程幂等、断点可续（state 文件记录已完成阶段，重跑=修复）。

### 4.1 Supabase 引导

1. 录入个人 Access Token → Management API 列 org/project，询问「新建 project（选 region）还是接管已有」；
2. 等 project ready → `/database/query` 跑**幂等 DDL 包**（§8 清单）；
3. 部署 2 个 edge function 并设 secrets（含全部署统一 TURN secret）；
4. 取 anon/publishable key → 提示输入首个账号邮箱+密码，admin API 建号；
5. **自验探针**：信令 RLS 读写回环 + turn-credentials 真调用，全绿才进下一步。

### 4.2 VPS 初始化（每台，可并行）

SSH（`username@ip password`，init 交互收集、不落盘）连上后推送并执行 `node-init` 脚本：

1. OS 检查（一期仅 Ubuntu 22.04/24.04、Debian 12）；
2. 探测公网/内网 IP（NAT 机型写 `external-ip`）；
3. 装 coturn + 官方 Caddy ≥2.10 二进制（不走 apt 旧版）；
4. 写 `turnserver.conf`（TURN REST `use-auth-secret`，secret 与 Supabase 侧一致）、`Caddyfile`（`default_sni <IP>` + ACME 短证书 profile）；
5. 装 `p2p-net-tunnel.service`（relay 代码取自包内 `node-init/` 资产，源自 `lib/tunnel/relay`）；
6. SFTP 推 `pwa-dist` → `/opt/p2p-net/pwa`，写 `/config.json`；
7. 验证：`https://<ip>/` 可达、证书已签发、隧道网关探活。

云安全组无法自动化 → init 末尾打印端口 checklist（22 / 80 / 443 / 3478 tcp+udp / 50000+ udp）并要求用户确认。

### 4.3 本地落盘

`~/.p2p-net/config.json`（0600）：supabaseUrl、publishableKey、relay 列表、本机设备身份。**Access Token、service_role、SSH 密码一律不落盘。**

## 5. start 运行时与 service 层

### 5.1 start（前台进程）

email/password 登录（refresh token 自动续期）→ `bind_device_auth(role=server)` → DvaHostAgent + 每 VPS 一条 TunnelClient → 端口扫描器（默认白名单 = 开发者 Top10 端口 3000/3001/4200/5000/5173/8000/8080/8081/8888/9000 + 自动探测 2xx/HTML；保留 NEVER 集合）→ 出票打 QR：**A类每 VPS 一张**（`https://<ip>/connect?t=<ticket>&d=<deviceId>&u=<tunnelGw>`）。未装 service 时启动横幅建议安装。

### 5.2 service 层（必选能力）

`p2p-net service install|uninstall|status|logs [-f]`：

- macOS = launchd plist，Linux = systemd unit；崩溃自动重启（带退避）、开机自启、日志落固定路径（`~/.p2p-net/logs/`）；
- 安装时把 `process.execPath` 绝对路径钉进单元文件；检测到 nvm 等易变路径时显式警告；doctor 复核 node 路径存在；
- init 成功流程末尾默认提议执行 install。

### 5.3 必修安全洞

抽取时在库里**真正实现 `isPortAllowed` 强制**：WebRTC 与隧道路径共用同一套白名单校验（现状：该钩子被库静默忽略，WebRTC 路径无强制——PWA 可让 Server 打任意 localhost 端口）。

## 6. 可观测性（内建，一期交付）

设计灵魂不是"多打日志"，而是**分层归因**——此前 debugging 的痛根是无法定位故障层。

- **统一 NDJSON 日志**：`{ts, level, comp, layer, sid?, msg, ...ctx}`；`layer` 固定枚举：`auth / supabase / signaling / ice / tunnel / vps / bridge / scanner / pairing / service`。所有错误必须带 layer + 可操作修复提示。手写 ~80 行 logger，零依赖，按大小轮转（默认 5×10MB）。
- **事件流**：会话级事实独立记录——session start/end、级联选中路径、pair 类型（p2p/relay/tunnel）、RTT、字节数、失败原因。即性能/稳定性分析数据源。
- **`doctor`（诊断主力）**：按连接级联同序分层探测——auth token → Supabase 可达 → 信令自发自收回环 → TURN 凭据签发 + coturn 探活 → 每 VPS HTTPS/证书/隧道网关 → 本地扫描器快照 → service 单元状态 + 上次崩溃日志尾部。任一失败即停，输出人话 + 修复建议；`--json` 可脚本化。
- **`status`**：本地控制面端点 + CLI 视图——活跃会话、各自模式/RTT/字节、运行时长。
- **Client 侧**：PWA 状态灯（pairType/RTT）+「诊断信息一键复制」（UA、所选路径、RTT、错误尾部），报障可贴。
- **复杂度红线**：无外部 APM、无 metrics server、无远程上报（一期）。logger / doctor / status 三件套全部进程内实现。

## 7. 协议与契约

沿用已验证协议，仅做品牌清洗：房间 `sig:<uid>:<deviceId>`；帧格式不变；票据 120s TTL 单次原子消费；级联超时表（10s/6s/15s）。QR 只保留 URL 形态（废弃 `dva2|` 前缀）。本地控制面/发现端口启用**新默认段 19727-19729**（与 DevAnyWhere 19527-9 共存不撞）。

**契约单一事实源第一天就位**：`contracts/ports.json` + `contracts/frames.md`，CI 断言所有消费点一致（前置吸收 DevAnyWhere 宪法 12/13 条教训）。

## 8. Supabase 后端精简清单

从新老两仓 9 个 migration + 4 个函数中精简，**剥离商业逻辑**（invites / claim / seed / Turnstile 全部不带）：

- 表：`devices`（user_id/role/hostname 幂等键）、`pairing_tickets`（120s TTL）、`signaling_messages`（房间 RLS owner-only，anon 全 revoke）；
- RPC：`bind_device_auth`（**去 invite_required 闸**变体）；
- 函数 ×2：`turn-credentials`（TURN host 从 secrets 配置读取，不再硬编码单 host）、`redeem-pairing-ticket`（原子消费 → magiclink token_hash）；
- Auth：email/password（默认开启）；首账号由 init 用 admin API 建。

## 9. 测试策略

四层：

1. **unit**：帧编解码、协议、退避、白名单、logger 轮转；
2. **契约断言**：ports.json / 帧字段全消费点一致（CI）；
3. **集成**：真 Supabase 测试 project（env 注入）+ 本地回环 werift 双端互联；
4. **E2E 金标准**：沿用已实证的真机 harness——adb reverse + Android 实体机蜂窝网络 + autotest/uitest，脚本化 `npm run e2e:android`。

发布验收：**干净机器**（没装过本包的机器）`init → start → doctor 全绿`；`npm pack` 校验 tarball 内容（含 pwa-dist、node-init 资产）。

## 10. 阶段划分

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| P0 | 建仓、抽库（含 isPortAllowed 修复）、品牌清洗、logger 基建、契约事实源 | 库单测绿、双入口可用 |
| P1 | Supabase bootstrapper（Management API 全自动）+ 精简 DDL 包 | 空 token → 可用后端，自验探针绿 |
| P2 | VPS SSH 编排 + node-init 资产 + PWA/config.json 部署 | 裸 VPS → `https://<ip>/` 打开 PWA |
| P3 | start 运行时 + 配对 QR + service install（launchd/systemd） | 前台+后台跑通，扫码建连 |
| P4 | doctor / status / 事件流收口 | 人为注入每层故障，doctor 均能正确归因 |
| P5 | E2E 真机验收 + README + npm 发布 v0.1.0 | 蜂窝真机全链路 + 干净机器验收 |

可观测性横切所有阶段：logger 在 P0 落地，每阶段同步交付本层 doctor 探针，P4 只做收口与故障注入演练。

## 11. 风险清单与消解

| 风险 | 消解 |
|---|---|
| WebRTC 路径无端口白名单强制（已知洞） | P0 必修，双路径统一校验（§5.3） |
| Caddy 版本/证书续期失败 = 全站白屏 | 钉官方 ≥2.10 二进制；doctor 证书探针；init 验证签发结果 |
| 云安全组开不了 | init 末尾 checklist + doctor 复探 |
| 常量硬编码漂移 | PWA/Server 全部运行时配置注入（§3） |
| 双树分叉债（CLI vs desktop daemon 教训） | 单包单源；DevAnyWhere 改依赖时反向对齐 |
| PostgREST 轮询吃免费额度 | README 配额说明；事件流留观测钩子 |
| 契约字段链路丢失（dsc 历史事故） | 契约事实源 + CI 断言 + 端到端用例（§7） |
| nvm 下 service 找不到 node | 钉绝对路径 + install 警告 + doctor 复核（§5.2） |
| Management API 函数部署端点不满足 | init 期退化为钉版 supabase CLI（非运行期，不违宪法 10） |

## 12. 开放细节（实施期钉死，不阻塞设计）

- GitHub 公开仓 owner（首次 push 时定）；
- edge function 部署的 Management API 端点可行性（P1 先行 spike 验证）；
- pwa-dist 构建在 prepublish 的具体接线（vite 双入口 + sw.js 固定名沿用 v2 做法）。

## 13. 后续计划追踪机制

- **`docs/ROADMAP.md` 为长期活文档**：二期及以后的所有事项先登记、后立项；
- 立项时走各自的 brainstorm → spec → plan 小循环，本文件不承载二期细节；
- ROADMAP 初版随本 spec 一并提交，已登记：B类 Pages 入口、Windows 服务化、TURN secret 轮换、多 Server 聚合 UI、**统一身份穿透（SSO）**、Server↔Server 数据面（如真需要）。

## 附录 A：来源资产映射（DevAnyWhere → p2p-net）

| p2p-net 模块 | 来源 | 动作 |
|---|---|---|
| lib/ | `cores/devanywhere-p2p/src/`（~1800 行） | 整体抽取 + 品牌清洗 + isPortAllowed 补实现 |
| 端口扫描器 | `devanywhere-server/desktop/daemon/engine.js`（~500 行） | 抽成独立模块，白名单泛化 |
| token 续期 | `desktop/lib/transport.js:74-116` | 抽成 auth 模块 |
| 配对出票 | `desktop/app/src/cloud.ts` + `cli/lib/cloud.js` | 重写为 CLI 出票（URL 形态 QR） |
| DDL 包 | legacy 0001-0008 + v2 0009 | 精简合并，剥商业逻辑 |
| 函数 ×2 | `turn-credentials`（v2）+ `redeem-pairing-ticket`（legacy） | 收入本仓，TURN host 配置化 |
| VPS node-init | `docs/coturn-relay-ops.md`（486 行 runbook） | 固化为脚本资产（从零写代码） |
| PWA | `devanywhere-client/pwa` | 改造为运行时配置注入，随包发布 |
| E2E harness | `poc/webrtc-pwa`（老仓）+ M1 验收流程 | 脚本化迁移 |
