# ROADMAP.md — p2p-net 长期路线追踪

> 本文件是 p2p-net 的**长期活文档**：一期（MVP）之后的所有事项先登记在这里，再立项。
> 立项规则：每个事项启动时走自己的 brainstorm → spec → plan 小循环（spec 存 `docs/superpowers/specs/`），完成后在此勾选。
> 一期设计见 `docs/superpowers/specs/2026-09-22-p2p-net-design.md`。

## 一期（MVP）范围快照

Mac/Linux Server + VPS(A类) 入口 + Supabase 全自动引导 + 扫码即登录 + 服务清单 + service 常驻 + 可观测性三件套。详见 spec §10 阶段 P0–P5。

## Wave 1（0.2.0）性能与健康——已完成项核销

> 2026-09-23 立项（spec/plan 见 `docs/superpowers/`），验收见 `e2e/wave1-realdevice-gate.md`（Go，四指标全过）。

- [x] 队头阻塞优化（proxy 通道池 + 帧协议 v2 二进制 + TURN 端口收敛）
- [x] 绿点假象治理（stallSuspect 黄灯 + pc failed 0ms 拆连 + N4 阈值收回 15s）
- [x] TURN/NAT 路径回收（ICE consent 看门狗，werift #69 兜底）
- [x] 帧账本 + 字节计量（成本一等指标；`docs/cost-model.md`，重载因子 ≈1.27【实测-本仓】）
- [x] 隧道响应 gzip 实验（A/B 结论「默认开」，见 `e2e/compression-ab-results-2026-09-24.md`；DEFAULT 翻转已登记独立任务）

## 二期候选（已登记）

### R2-1 B类入口：Cloudflare Pages 托管 PWA
- 目标：用户提供 CF 账号信息与 pages 域名设置后，`p2p-net init` 额外产出唯一一个 `xxx.pages.dev` URL + QR。
- 价值：无 VPS 公网 IP 证书顾虑、全球 CDN 加速入口。
- 粗设计：pwa-dist 同一产物，wrangler/API 部署；config.json 改由 Pages Function 或直接构建期注入（二选一，立项时定）。
- 前置：一期 P2 的 PWA 运行时配置注入。
- 状态：已登记。

### R2-2 Windows 服务化
- 目标：Windows Server/PC 上 `service install` 等价能力（计划任务或 WinSW/NSSM 评估）。
- 前置：一期 §5.2 service 层抽象。
- 状态：已登记。

### R2-3 TURN secret 轮换命令
- 目标：`p2p-net rotate-secret` 一处发起，Supabase secrets + 全部 VPS coturn 同步换秘。
- 前置：一期 §4 的 secret 分发链。
- 状态：已登记。

### R2-4 多 Server 聚合 UI 打磨
- 目标：PWA 服务清单按 Server 分组的正式 UI（tab group 或聚集卡片）；多 Server 会话管理。
- 前置：一期 Q3 决策 = Client 侧聚合的协议基础。
- 状态：已登记。

### R2-5 统一身份穿透（SSO / Identity Pass-through）
- 目标：**扫码登录一次，接入服务全部免登**——p2p-net 账号即一切接入服务的身份。
- 背景：数据面是全流量唯一入口（SW → DataChannel → bridge → localhost），bridge 转发时处于天然的身份注入点；DevAnyWhere v2 的 consoleTicket 免登是本思路雏形。
- 粗设计：
  1. bridge 转发请求时注入签名身份头：`X-P2PNet-User: <uid>` + `X-P2PNet-Token: <短期 HMAC/JWT>`（以会话凭据对 `uid|exp` 签名）；
  2. 服务侧一行中间件校验签名与过期（发布 `@p2p-net/verify` 小中间件包：Express/Fastify/Flask/FastAPI）；
  3. 安全边界：服务**只信**来自 127.0.0.1 且签名正确的头（防公网伪造）；未采用约定的服务不受影响（各登各的）；
  4. 登出 = Server 侧吊销签名密钥/会话。
- 风险点：header 伪造防护、签名密钥轮换、各框架中间件维护面。
- 前置：一期 §5.3 端口白名单强制（身份注入必须建立在已收敛的转发面上）。
- 状态：已登记（用户明确提出，二期优先候选）。

### R2-6 Server↔Server 数据面（如真需要）
- 目标：S1 能把 S2 的服务清单/流量转发给连自己的 Client。
- 说明：一期决策 Q3 已判定 Client 侧聚合足够；仅当真实场景证明需要 Server 间管道时立项。
- 状态：观望。

## v0.4.x（已登记，2026-09-27）

> 来源：v0.3.1→v0.3.2 战役（`e2e/wave2-direct-rate-matrix-2026-09-26.md` §3.8–§3.10）切割与遗留登记。

### R4-1 W-B 工作台重载解耦（残余部分）
- 已闭合：W-A 死亡循环（每 ~2min 假性重级联 → 重建工作台）随 v0.3.2 根治；tunnel→p2p 采纳本就不重建（make-before-break 热切只换底层传输，`session.ts:169-176` 仅刷状态条）。
- 残余：「数据面真实中断→重连」仍强制重建工作台（`pwa/src/shell.ts:810-818`，2026-09-12 白屏根治措施的有意设计）。触发面：切网 WiFi↔蜂窝、隧道 TCP 被掐、host 重启/重装、中继死亡链。
- 候选方向（立项时二选一或组合）：① 重连后先探活再定夺（looksBooted 式探针判 iframe 真死才重载——须直面 2026-09-12 探针可靠性教训）；② 工作台状态持久化无损重载（chat 草稿/路由/会话位置落 localStorage，devanywhere-ui 侧，覆盖一切重载场景含系统杀后台）。
- 状态：已登记（用户体感确认当前零重载，优先级由真实中断频率决定）。

### R4-2 旁路空转负缓存
- 现象：ep-dep 象限旁路永远落 relay 永远被门禁拦（v0.3.2 实测 22min×7 次，全部 0 字节），退避封顶 480s 后仍周期性空转；单设备代价微小，规模化是白烧的控制面/TURN 分配负载。
- 粗设计：同象限连败 N 次挂起探测，监听 `online`/网络切换事件再唤醒。
- 状态：已登记。

### R4-3 adopt-direct 实机补验
- 缺口：「真直连旁路采纳后存活」路径仅 harness 测试覆盖（`shell-upgrade.test.ts` stats:'direct'），ep-dep 象限实机建不成直连。
- 行动：遇全锥/低限制 NAT 环境（如办公网、热点）专项补验。
- 状态：已登记。

### R4-4 中继长程服务与 TURN 正修
- 范围：主 p2p 腿落 relay 的拒绝策略（原 Fix B2）；NAT 重映射死亡链正修（W2-7：≤30–60s 保活 + 快速失败 + TURN REFRESH 观测）；forceTurn×TunnelBackcheck 回迁环定夺；coturn 端口池扩容（容量议题，挂本线或容量专项）；级联超时预算与蜂窝抖动联动（§3.8.3）。
- 状态：已登记。

### OPS-1 VPS 证书续期（运维，非代码）
- 49.233.155.13 HTTPS 证书 2026-09-27 起剩 5 天（doctor 实测）。不续期则 PWA 入口全灭。
- 状态：**待办，时限最紧**。

## 三期及以后（远期想法，备忘）

- 托管版/计费（DevAnyWhere 产品线的 Stripe M3 与本包的关系，届时再评）。
- 服务市场/清单生态（围绕服务清单的发现与分发）。
- 移动端独立 App（Flutter 壳复用 PWA 协议）。
