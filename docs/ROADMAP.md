# ROADMAP.md — p2p-net 长期路线追踪

> 本文件是 p2p-net 的**长期活文档**：一期（MVP）之后的所有事项先登记在这里，再立项。
> 立项规则：每个事项启动时走自己的 brainstorm → spec → plan 小循环（spec 存 `docs/superpowers/specs/`），完成后在此勾选。
> 一期设计见 `docs/superpowers/specs/2026-09-22-p2p-net-design.md`。

## 一期（MVP）范围快照

Mac/Linux Server + VPS(A类) 入口 + Supabase 全自动引导 + 扫码即登录 + 服务清单 + service 常驻 + 可观测性三件套。详见 spec §10 阶段 P0–P5。

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

## 三期及以后（远期想法，备忘）

- 托管版/计费（DevAnyWhere 产品线的 Stripe M3 与本包的关系，届时再评）。
- 服务市场/清单生态（围绕服务清单的发现与分发）。
- 移动端独立 App（Flutter 壳复用 PWA 协议）。
