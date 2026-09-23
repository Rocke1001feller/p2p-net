# 直连 / 中继 / 隧道——p2p-net 数据面三概念科普

> 2026-09-23 用户要求逐字存档的概念对齐文档（一字不差保存会话输出），供反复学习。

核实完了，有一个重要发现要先说：**v0.1.0 里隧道不只是历史文档的备用方案，它已经真实落地了**（`src/tunnel/relay.ts` + `src/tunnel/client.ts`，README 的三级级联里写明了）。所以这三个概念在现行架构里全部存在，你问得正是时候。下面是科普。

---

## 先纠正一个层级错位：三者不是并列关系

**直连**和**中继**是同一层级的概念——WebRTC 数据面内部的两条传输路径，由 ICE 协议**自动协商**，应用无感。**隧道**是另一个物种：它不是 WebRTC 的一条路径，而是我们**自建的另一整条数据面通道**。三者在 v0.1.0 里是**级联兜底**关系：①直连 → ②中继 → ③隧道，上一级不可用自动降下一级（README.md:5）。

## 逐个精确定义

### ① 直连（Direct Connection / P2P，对等直连）

- **协议**：WebRTC ICE 的 `host`/`srflx` 候选对。STUN（RFC 8489）帮两端探出 NAT 公网映射地址，然后**打洞（NAT hole punching）**建立直达 UDP 通道。
- **数据流**：PWA 浏览器 ←——→ 你的电脑，**中间没有任何服务器**。
- **加密**：DTLS 端到端（WebRTC 强制），无人可见明文。
- **成本**：VPS 流量 = **0**。这是「近乎免费」的物理基础。
- **弱点**：对称型 NAT、严格防火墙下打洞会失败——蜂窝网络恰好是对称 NAT 高发区，所以我们真机实测常落到中继。

### ② 中继（Relay / TURN Relay，TURN 中转）

- **协议**：TURN（RFC 8656），我们的实现是 VPS 上的 **coturn**。双方都在 TURN 服务器上开 allocation，服务器在传输层**原样转发**每一个字节。
- **数据流**：PWA ←→ coturn@VPS ←→ host。
- **加密**：**仍是 DTLS 端到端**——coturn 转发的只是密文，VPS 看不见内容（只见流量体积/时序）。这是它和隧道的本质区别之一。
- **成本**：每个字节进出 VPS 两次，v3 实测 TURN 字节因子 **1.68**（封装+开销）。这是「付费路径」。
- **何时发生**：ICE 发现直连候选对全部不通时自动降级，应用层无感。

### ③ 隧道（Reverse Tunnel，反向隧道）

- **协议**：无标准 RFC，是 frp/nps/ngrok/cloudflared 一脉的模式。我们的实现：桌面**主动外发**一条持久 WSS 到 VPS 的 tunnel relay（`src/tunnel/client.ts`），VPS 上 caddy 在 443 终止 HTTPS 后转给 relay（仅监听 127.0.0.1:19700，README.md:52），公网入口是 `https://<relay>/tunnel/s/<deviceId>`（README.md:61）。
- **数据流**：PWA —HTTPS→ caddy@VPS →（桌面维持的持久 WSS）→ host → localhost 服务。
- **加密**：**TLS 在 VPS 终止**——caddy/relay 处是明文落地，VPS 在信任边界之内。这与中继的端到端 DTLS 是根本性差异。
- **成本**：同样是 100% 流量过 VPS 的付费路径，开销构成不同（帧开销+WS/TLS，当前还有 base64 税）。
- **存在意义**：**100% 连通率**——只要 VPS 活着。有些网络（封死 UDP 的企业网、极端 NAT）连 TURN 都不通，隧道走纯 443 HTTPS 出站，永远能建。所以它兜的是「连 TURN 都死了」的长尾。

### 一个命名撞车要提醒你

我们的代码里「隧道」一词其实有两个含义：①上面讲的反向隧道通道；②`frames.ts` 的帧类型叫 `TunnelFrame`（隧道帧）——但它是 **DataChannel 和隧道共用的应用层信封**（frames.ts:1 注释「隧道帧协议编解码」）。也就是说我们的隧道**复用了 DataChannel 的同一套帧协议**——换传输不换协议，req 帧加 `via:'tunnel'` 标记区分来路（frames.ts:14）。读代码时看到 "tunnel" 要先分辨说的是哪一层。

## 对比表

| 维度 | ① 直连 Direct/P2P | ② 中继 TURN Relay | ③ 隧道 Reverse Tunnel |
|---|---|---|---|
| 谁转发数据 | 无人，两端直达 | coturn（传输层，**不识内容**） | caddy+tunnel relay（应用层，**可见明文**） |
| VPS 带宽 | 0 | ≈ 字节×1.68 | ≈ 字节×帧/WS 开销 |
| 端到端加密 | DTLS ✓ | DTLS ✓（VPS 只见密文） | ✗ TLS 在 VPS 终止 |
| 连通率 | 打洞成才行 | UDP/TCP 通即可 | ~100%（VPS 活即可） |
| 延迟 | 物理延迟 | +一跳 | +一跳+应用层处理 |
| 谁决定用它 | ICE 自动 | ICE 自动降级 | 我们应用层兜底逻辑 |
| 在 v0.1.0 | 已落地 | 已落地（真机主用路径） | 已落地（三级兜底） |

## 历史脉络：你截图那个 commit 在说什么

2026-09-05 再架构设计（stripe 仓）的 A4 决策是「**双模**：WebRTC 优先 + 反向隧道兜底」（:27），§2.2 定义隧道模式（:82-84）。你截图的 Gate 2 行说的是：**如果** iOS Safari 的 Service Worker 在量产机上挂起，PWA 就整体收缩为纯隧道模式——后来 Gate 2 spike 实测通过（:173），所以隧道保持为兜底而非主力。p2p-net 独立成包后，这条兜底被真正实现为第三级级联。

而在更早的 EasyTier 时代（cores/PeerToPeer），只有「P2P/中继」两个词——概念同构，实现不同（EasyTier relay ≠ TURN relay，但成本同类）。

## 决策框架：什么时候用哪条

- **直连 vs 中继不需要人决策**——ICE 协议按候选优先级自动试，先 host/srflx 后 relay。我们能做的是**提高直连率**（IPv6、NAT 引导），这是成本第一杠杆。
- **隧道是战略保留项**：它本质是 frp 的「全中转」世界——draft-ideas 里算过账，全中转 10 万用户 = 每月数十万，是我们当初弃 frp 选 P2P 路线的根本原因。所以它只配做兜底，永不做主力。
- **成本方程**因此写成：VPS 成本 = 在线数 × **（中继率 + 隧道率）** × 会话带宽 × 字节因子。直连率是利润率，这就是 Wave 2 容量标定要量的东西。

## 词汇表对齐（读 spec/plan 的高频词）

| 中文 | 英文 | 一句话 |
|---|---|---|
| 信令 | Signaling | 交换 offer/answer/ICE 候选的控制通道（Supabase），只传元数据不传数据 |
| ICE / 候选 | ICE / candidate | 连通性协商协议；候选=一个可试的地址（host/srflx/prflx/relay 四型） |
| 打洞 | Hole punching | 用 srflx 地址在 NAT 上凿出直达通道的技术 |
| 直连率 | Direct rate | 落在路径①的会话占比 ≈ 打洞成功率 |
| 中继率 | Relay rate | 落在路径②③的会话占比 = 成本之源 |
| TURN allocation | — | 客户端在 TURN 服务器上租的中转槽位，lifetime 600s（15min 死亡案的涉案人） |
| DataChannel | — | WebRTC 的数据通道 = SCTP over DTLS over ICE |

---

有理解出入的地方请指出；若概念对齐了，我就按你已同意的切法开工：spec §2 重写 + D9 容量方程 + 开发纪律入约束，同时派成本专项 swarm 回三大试验场。
