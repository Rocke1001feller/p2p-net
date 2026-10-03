# p2p-net ROADMAP

> 本文件是 p2p-net 路线追踪的**唯一事实源**（2026-09-29 单源化：原 `docs/ROADMAP.md` 已并入本文件并删除）。
> 一期设计见 `docs/superpowers/specs/2026-09-22-p2p-net-design.md`；立项规则：每个事项启动时走自己的 brainstorm → spec → plan 小循环（spec 存 `docs/superpowers/specs/`），完成即勾选并注明版本。
> 每条注明来源（用户反馈 / 实测发现 / 遗留项）。引用代码用符号名，不用行号（防漂移）。

## 一期 v0.1.0（已完成）

- A类入口（VPS + Caddy + https://IP + 扫码/URL）、supabase 账号体系（signup/login）
- WebRTC 数据面（P2P 优先 / TURN 中继兜底）、服务清单转发（svc=N）
- launchd/systemd 服务化（install 必选）、结构化日志 + 事件流（events.jsonl）+ 19727/status + bench 脚本（scripts/bench/）
- 验收：296 单测全绿、bench 达标、60min 浸泡 4 次掉线全自愈（e2e/real-service-soak.md）、
  Android 蜂窝真机 E2E（e2e/android-cellular.md）、真人实测（e2e/human-live-2026-09-23.md）

## Wave 1（0.2.0）性能与健康——已完成核销

> 2026-09-23 立项（spec/plan 见 `docs/superpowers/`），验收见 `e2e/wave1-realdevice-gate.md`（Go，四指标全过）。

- [x] 队头阻塞优化（proxy 通道池 + 帧协议 v2 二进制 + TURN 端口收敛）
- [x] 绿点假象治理（stallSuspect 黄灯 + pc failed 0ms 拆连 + N4 阈值收回 15s；LIVENESS 复评随阈值收口闭环）
- [x] TURN/NAT 路径回收（ICE consent 看门狗，werift #69 兜底）
- [x] 帧账本 + 字节计量（成本一等指标；`docs/cost-model.md`，重载因子 ≈1.27【实测-本仓】）
- [x] 隧道响应 gzip 实验（A/B 结论「默认开」，见 `e2e/compression-ab-results-2026-09-24.md`；DEFAULT 翻转于 0.2.1 落地）

## 二期候选（已登记）

### R2-1 B类入口：Cloudflare Pages 托管 PWA
- 目标：用户提供 CF 账号信息与 pages 域名设置后，`p2p-net init` 额外产出唯一一个 `xxx.pages.dev` URL + QR。
- 价值：无 VPS 公网 IP 证书顾虑、全球 CDN 加速入口。
- 粗设计：pwa-dist 同一产物，wrangler/API 部署；config.json 改由 Pages Function 或直接构建期注入（二选一，立项时定）。
- 前置：一期 P2 的 PWA 运行时配置注入。
- 状态：已登记。

### R2-2 Windows 服务化
- 目标：Windows Server/PC 上 `service install` 等价能力（计划任务或 WinSW/NSSM 评估）。
- 前置：一期 service 层抽象。
- 状态：已登记。

### R2-3 TURN secret 轮换命令
- 目标：`p2p-net rotate-secret` 一处发起，Supabase secrets + 全部 VPS coturn 同步换秘。
- 前置：一期的 secret 分发链。
- 状态：已登记。

### R2-4 多 Server 聚合 UI 打磨
- 目标：PWA 服务清单按 Server 分组的正式 UI；多 Server 会话管理。
- **状态回填（2026-09-29）**：主体已由 2026-09-28 P1 多服务工作台交付（多设备侧栏树分组渲染、Chrome tab-group 风格启动台、per-device 分组色，commits 092d5df→0dc806e），余「打磨」项（交互细节/会话管理深化）。状态：主体已交付，余打磨。

### R2-5 统一身份穿透（SSO / Identity Pass-through）
- 目标：**扫码登录一次，接入服务全部免登**——p2p-net 账号即一切接入服务的身份。
- 背景：数据面是全流量唯一入口（SW → DataChannel → bridge → localhost），bridge 转发时处于天然的身份注入点；DevAnyWhere v2 的 consoleTicket 免登是本思路雏形。
- 粗设计：
  1. bridge 转发请求时注入签名身份头：`X-P2PNet-User: <uid>` + `X-P2PNet-Token: <短期 HMAC/JWT>`（以会话凭据对 `uid|exp` 签名）；
  2. 服务侧一行中间件校验签名与过期（发布 `@p2p-net/verify` 小中间件包：Express/Fastify/Flask/FastAPI）；
  3. 安全边界：服务**只信**来自 127.0.0.1 且签名正确的头（防公网伪造）；未采用约定的服务不受影响（各登各的）；
  4. 登出 = Server 侧吊销签名密钥/会话。
- 风险点：header 伪造防护、签名密钥轮换、各框架中间件维护面。
- 前置：一期端口白名单强制（身份注入必须建立在已收敛的转发面上）。
- 状态：已登记（用户明确提出，二期优先候选）。

### R2-6 Server↔Server 数据面（如真需要）
- 目标：S1 能把 S2 的服务清单/流量转发给连自己的 Client。
- 说明：一期决策 Q3 已判定 Client 侧聚合足够；仅当真实场景证明需要 Server 间管道时立项。
- 状态：观望。

### R2-7 设备生命周期命令补全
- 目标：`p2p-net uninstall`（干净卸载）、`status`（含未登录时引导）、`version`、`update`（覆盖式升级，任何时刻单实例单版本）。
- 来源：一期用户验收反馈第二/四条；用户确认（2026-09-29）为规划组成部分。
- 状态：已登记。

### R2-8 dva-* 多平台安装测试矩阵
- 目标：dva-win / dva-mac / dva-linux / dva-mac-arm64 self-hosted runners，接入后验证 server↔server 互通。
- 来源：一期用户验收反馈第一/三条。
- 状态：已登记。

### R2-9 网络质量测评 case 库
- 目标：横向对比指标（RTT 分布/吞吐/stall 频率/自愈时长），形成「选宽带」式标尺。
- 来源：一期用户验收反馈第六条。
- 状态：已登记。

### R2-10 PWA 主屏引导 + 设备卡时间戳
- 目标：PWA「添加到主屏幕」引导 + 设备卡「上次连接」时间戳刷新修复。
- 状态：已登记。

## v0.4.x（已登记，2026-09-27）

> 来源：v0.3.1→v0.3.2 战役（`e2e/wave2-direct-rate-matrix-2026-09-26.md` §3.8–§3.10）切割与遗留登记。

### R4-1 W-B 工作台重载解耦（残余部分）
- 已闭合：W-A 死亡循环（每 ~2min 假性重级联 → 重建工作台）随 v0.3.2 根治；tunnel→p2p 采纳本就不重建（make-before-break 热切只换底层传输，`pwa/src/session.ts` 的采纳路径仅刷状态条）。
- **状态回填（2026-09-29）**：候选方向①「重连后先探活再定夺」已实现（shell.ts 的 afterConnected 探活块，commit 036ffe7）并经双机真机验证（战役档案 §3.11）。残余 = 方向②「工作台状态持久化无损重载」（chat 草稿/路由/会话位置落 localStorage，覆盖系统杀后台等一切重载场景）。
- 状态：方向①已交付；方向②已登记（优先级由真实中断频率决定）。

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

### R4-5 测试套件定时器 flake（2026-09-29 清洁期发现）
- 现象：全量 `npm test` 重负载下偶发 `consent-watchdog` 与 `natfacts` 两例毫秒级假定时器测试失败（BASE 复现，与业务 diff 无关）；分段单跑全绿。
- 行动：两测试的定时器预算放宽或注入时钟；登记前影响为零（分段门禁可靠）。
- 状态：已登记。

### R4-12 vite dev 模式过隧道白屏（2026-10-01 双机实测发现）
- 现象：vite **dev** 服务器（默认 base='/'）经隧道访问白屏——shim 能包装 fetch/XHR/WS、SW 能改写 HTML 静态属性的根绝对路径，但 **ES 模块静态 import 走浏览器原生加载**（`/@vite/client`、`/node_modules/.vite/*` 等根绝对路径逃逸出 `/s/<port>/` scope → 源站 404）。生产构建不受影响（入口经改写、chunk 间相对 import）。
- 影响面：README「点进 5173 即可操作」的承诺对 dev 服务器不成立——恰是开发者最高频场景。
- 候选方向（立项时定）：① SW 对 scope 外同源请求按 Referer 兜底改写进隧道 scope；② init/start 探测到 vite dev 时引导 `--base`；③ 文档声明仅支持生产构建。① 最彻底但动 SW 拦截面，需评估副作用。
- 实证：`e2e/p1-workspace-dual-device-2026-10-01.md`。
- 状态：已登记。

### OPS-1 VPS 证书续期（运维，非代码）
- 49.233.155.13 HTTPS 证书（Let's Encrypt shortlived IP 证书，6 天期）。
- 状态：**已闭环（自动续期实证，零人工动作）**。2026-09-27 勘察：Caddy 已于 Sep 26 02:24:25 自动续期成功（journalctl `tls.renew certificate renewed successfully`，进程未重启）；ARI 机制在位，下一次续期排程 selected_time≈Sep 29，远早于当前证书 Oct 2 09:25 GMT 到期。续期窗口内唯一风险是 LE/网络瞬时故障，Caddy 会持续重试，无需值守；9-30 前后抽查一次 `openssl s_client` 到期日即可。

### R4-6 隐藏当前服务在离线/重连窗口不生效（P1 评审 I-1）
- 现象：断线窗口打开侧栏隐藏「断线前正在看」的服务，记录落盘但不回引导页、不清选中——`pwa/src/shell.ts` 的 `onHide` bounce 判定锚在 `connectedId`（级联未开时恒 null）；重连后 C2 守卫保留选中，用户持续看着自己刚隐藏的服务，侧栏却显示它已隐藏。
- 行动：bounce 判定改锚 `desk.id`（身份而非连接态）；补 harness 测试（离线窗口隐藏当前服务 → 重连落引导页）。
- 状态：**运行时反证，建议核销（2026-10-01 双机战役）**——iPhone 真机 + host 停机离线窗口实测：离线隐藏当前服务 bounce 正常触发（sel=null、回引导页、LS 正确落盘），重连后默认链开 console，全程无「卡在隐藏服务」；评审的锚点机制推断与运行时行为不符。详见 `e2e/p1-workspace-dual-device-2026-10-01.md` G5/R4-6 段。

### R4-7 启动台网格不剔除已隐藏服务（P1 评审 I-2，需产品裁决）
- 现象：隐藏语义只在侧栏树落地；设备页（启动台）服务网格照样渲染已隐藏服务——`refreshDevicesUI` 直传 `currentServices` 全量给 `renderDevices`，两个入口口径不一致。spec §2.5 对此未裁决（设计留白）。
- 行动：产品裁决后回填 spec §2.5；建议启动台遵守隐藏、console 服务豁免（对齐 §4.1），实现 + 测试。
- 状态：已登记（详见 `docs/superpowers/reports/2026-09-29-p1-workspace-review.md`）。

### R4-8 重连抢视图（P1 评审 I-3）
- 现象：①`afterConnected` 首行无条件 `showTab('workspace')`（v0.3.3 既有，单服务时代无害、多服务化后语义过期）——重连时用户在设备页挑服务会被拽回工作台 tab；②P1 新增 `onTabChange` → `selectedPort` 非 null 即 `enterImmersive()`，tab 切换自动拉满 console，不区分用户发起还是系统重连带动。
- 行动：重连路径不强制 `showTab`（首连保留）；沉浸触发限定用户发起的切换（来源标记或重连期标志位）。建议与 R4-6 一并真机过验。
- 状态：已登记（详见 `docs/superpowers/reports/2026-09-29-p1-workspace-review.md`）。

### R4-9 pendingOpenPort 未按设备键控 + btnOfflineClose 死按钮（P1 评审 I-4 / M-7）
- 现象：跨机直达状态 `pendingOpenPort` 只记 port 不记 deviceId，当前被模态 UI 阻断不可达；一旦离线条可关闭/连接可取消，即「连 B 失败 → 改连 C 同端口 → 服务错投」。关联：`btnOfflineClose` 自 v0.3.3 起未接线（死按钮）；`stopSession` 后旧 iframe 保持可见；`everConnected` 不被 `stopSession` 复位导致 stop→重连走 isReconnect 冗余双开（幂等无害）。
- 行动：`pendingOpenPort` 改存 `{ deviceId, port }` 并在 `openWorkbench` 消费前校验 `deviceId === desk.id`；设备页直连与 `stopSession` 路径清除；`btnOfflineClose` 接线（可取消连接）或删除；M-7 三项随此一并处置。
- 状态：已登记（详见 `docs/superpowers/reports/2026-09-29-p1-workspace-review.md`）。

### R4-10 P1 双机真机门禁执行（P1 评审 I-5）
- 现象：plan（`docs/superpowers/plans/2026-09-28-multi-service-workspace.md` Task 7 Step 4）登记了 5 条双机真机门禁，spec/plan 头注「真机门禁见 ROADMAP」但 ROADMAP 原本无此条目（指针悬空）；C1 遮罩穿透的真冒泡行为等只有真机能钉的项缺最后一环证据。
- 行动：下次双机在场时执行 5 条门禁（遮罩真冒泡、多设备树渲染、跨机直达、隐藏/恢复、重连不抢选中），结果回填本条目与评审报告。
- 状态：**已全部闭环（2026-10-03）**——iPhone 侧 10-01、Android 侧 10-03 均仪器直测完成，G1–G5 双端 PASS，证据链见 `e2e/p1-workspace-dual-device-2026-10-01.md`（含 Android CDP 仪器链突破与触屏伪影甄别实录）。

### R4-12 vite dev server 经隧道永不就绪（2026-10-01 战役发现）
- 现象：vite dev client（5173）经隧道打开后 root 恒空、innerText=0，永不就绪——PWA 健康检查按 5s/12s/25s 反复后台重载（动作符合设计，但永不成功）；devanywhere-ui server(3001，生产式) 与 Kimi Code(51778) 同链路正常。疑 vite dev 模块协议（逐文件 ESM + HMR WS + import query）过不了 SW→隧道转发面；与 NEVER 集合含 4173（vite preview）的历史经验互证。
- 行动：定位断点层（SW 转发 / 隧道 WS / vite HMR 握手）；如属协议面不可行，文档化「vite dev 请经 build 预览或直连使用」。
- 状态：已登记。

### R4-13 体检首拍 5s 对蜂窝隧道偏紧（2026-10-01 战役发现）
- 现象：51778 首启在 5s 首拍时尚未就绪（蜂窝+隧道首载偏慢）→ 被设计性后台重载一次后才就绪——自愈但多一跳，首启体感白屏窗口被拉长；对「永不就绪」型服务（R4-12）则构成无意义重载循环。
- 行动：评估首拍延迟放宽（如 5s→10s）或首拍前加数据面就绪闸；与 R4-12 一并评审。
- 状态：已登记。

### R4-11 换机在途异步回收 + 存储卫生（P1 评审 M-2 / M-3 / M-4）
- 现象：①换机不回收在途 bootWorkbench 探活/重挂体检链/pendingFetch，`tabs.has(port)` 对新设备同端口 tab 是瞎的（靠 `tab.booted` 闩收敛，最坏无害冗余）；②ServiceSnapshot 不记 consolePort → 离线组 console 行渲染 ✕ 且豁免失效，可写下连上后被无视的隐藏脏记录；③快照无 TTL、`LS_DEVICES` 12 台淘汰后 orphan 键不清理、`writeLastGoodPort` 写 `p2p.lastConsolePort` 已无生产读者、`pickFallbackPort`/`readLastGoodPort`/`markActive` 为生产侧死代码/空桩。
- 行动：换机时取消在途链（或按 deviceId 键控校验）；快照补 console 身份；快照 TTL 与 orphan 清理；删 `p2p.lastConsolePort` 死写与 consolePick 死导出、`markActive` 空桩。
- 状态：已登记（详见 `docs/superpowers/reports/2026-09-29-p1-workspace-review.md`）。

## 三期+（远期构思，仅备忘）

- devanywhere-ui（https://github.com/ai-baymax-dabai/devanywhere-ui）等更多服务清单项接入打磨。
- 10 万用户容量规划（文档未建档，立项时补）。
- 托管版/计费（DevAnyWhere 产品线的 Stripe M3 与本包的关系，届时再评）。
- 服务市场/清单生态（围绕服务清单的发现与分发）。
- 移动端独立 App（Flutter 壳复用 PWA 协议）。
- P2P 直连率提升（NAT 打洞成功率统计与优化）。

## 发布当日 checklist（一期收尾，历史记录）
1. [x] 真机 E2E + 真人实测（e2e/ 两份报告）
2. [x] ~~确认 npm 名字 `p2p-net` 可用~~ → 裸名被占位保护拦截（与 p2pnet 相似），更名 `@rocke1001feller/p2p-net`（bin 仍为 p2p-net）
3. [x] `gh repo create p2p-net --public --source=. --push` → https://github.com/Rocke1001feller/p2p-net
4. [x] `npm publish --access public` → **@rocke1001feller/p2p-net@0.1.0 已发布**（2026-09-23，注册表传播 ~8min，npx 冒烟通过）
5. [x] `git tag v0.1.0 && git push origin main --tags`
6. [x] T9 env-gated 真 sshd 测试——已由当日真 VPS init/deploy/验收合并认定
