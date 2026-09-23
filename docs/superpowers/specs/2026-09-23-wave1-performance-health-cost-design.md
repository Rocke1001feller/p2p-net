# Wave 1 性能·健康·成本 设计（spec）— 2026-09-23（v2 迭代）

> 上游决策：二期三 Wave 中的 Wave 1（用户已批准方案 A）。目标：v0.1.0 已发布，用「速度+稳定+成本」赢得早期用户口碑。
> 方法学（用户钦定）：**批判**（不死搬硬套，标注迁移条件）、**实测**（Android 蜂窝真机随时可验）、**精简**（严控复杂度）。
> v2 迭代（2026-09-23 用户反馈）：①「可直接吸收」分类废除——侥幸=懒惰+危险，外部证据只有假设强弱之别，进 main 唯一路径=独立分支+本仓实测+问题陈述+squash 合并；②成本从观测指标升级为初心 feature（10 万用户近乎免费，见 D9）；③开发纪律入全局约束（§4）。
> 证据来源：一轮三试验场挖掘（性能/健康）+ 二轮成本专项深挖（`docs/superpowers/reports/2026-09-23-cost-deep-dive-three-fields.txt`）。

## 1. 基线（v0.1.0 实测，一切对比的锚）

- host 侧 done 时延 p50=4ms / p90=53ms（蜂窝 TURN 中继）
- 22min 真人实测：468 请求零错误、1.3MB 隧道流量
- 蜂窝 stall：16 次合计 587s，最久 82s；大 JSON（135-434KB）期 1KB 请求排队 39s（HOL 实证）
- 会话 ~15min 周期死亡重建（浸泡+实测共 8 次，均自愈但中断可感）
- 结构事实：`src/frames.ts` JSON 帧 + `dataB64/bodyB64`（base64 = 33% 字节税）；`src/peer.ts:246` 单条 ordered 'proxy' 通道扛全部流量；'ctrl' 带外通道已存在；LIVENESS 45s / WEDGE 60s；host 用 werift ^0.24.4

## 2. 证据分级：假设 / 已实测 / 避免

> 纪律：不存在「可直接吸收」。每条假设标注【外部实测/外部推断/未验证】+ 本仓实测落点（Task）。只有落点 Task 完成、记录归档后才许移入「已实测」。

### 2.1 强假设（外部实测级，本仓落点已定）

1. **base64 = 4/3 协议税；字节因子 TURN 1.68 / 隧道 1.17 / p2p 0**【外部实测 v3 tc-cost】→ Task 2/3 砍帧 + Task 5/12 本仓复测因子（方法照抄 tc-accounting：getStats 选定对增量、tx/rx 分开）
2. **通道池治 HOL**（v3 `PROXY_POOL_SIZE=4` + 同 id 粘滞 + 新流落最小 bufferedAmount + ctrl 带外，门禁 `hol_increment p95 ≤50ms`；v2 曾实测 78s 虚高 RTT 同病）【外部实测】→ Task 4/11/13
3. **stallSuspect 三条件**（`ctrlAlive && inFlight>0 && msSinceInboundFrame>5000ms`）；RTT 测量必须走带外（v2 实测 78s 虚高教训）【外部实测】→ Task 6
4. **werift 0.24.4 两枚确定性缺陷**：#69 RFC 7675 consent 30s 到期 → `send()` 静默丢包永久黑洞（签名：bufferedAmount 钉死+ctrl 假健康+数据零进展）；#50 SCTP 交付遍历断裂尾部滞留。与我们 stall/15min 死亡同签名，host 同款 werift 版本【外部实测】→ Task 7/8
5. **TURN 凭据双 transport = 33% 成功率毒药**（v3 三臂 n=6×3：UDP-only 100%、TCP-only 83%、both 33%；v2 仓同名 turn-credentials 函数至今双发，p2p-net 是 v2 血统）【外部实测】→ Task 1（先复核本仓现状）
6. **心跳「3×拍无入站才割 + 任意入站帧刷新」**（单拍即割在 WAN 拥塞窗批量误杀）；检测时延=定时器映射（15s 心跳+2s 看门狗 → p50 15.6s 检出）【外部实测】→ Task 6/9
7. **werift getStats 路径判定**：candidate-pair 行**无 selected 字段**，选定对 = `state==='succeeded'`（nominated 亦在）；`localCandidateId→local-candidate.candidateType`，relay→中继、host/srflx/prflx→直连；浏览器侧 `selected===true`；字节=选定对 bytesSent/Received 增量。可逐字移植 v3 `packages/core/src/status.ts:1-25` + `facts.ts:430-489`【外部实测+源码取证】→ Task 5
8. **coturn 运维纪律**：每并发 TURN 会话≈1 relay 端口（按 ×1.2 配段，现网 50000-50019=20 并发）；external-ip 必配；`nc -z` 探测是假阳性，只能应用层探针；401→success 是正常握手；fail2ban 别守 coturn；3478 tcp 必开（iPhone 蜂窝走 TURN/TCP）；allocation ~10min timeout 是会话关闭主因【外部实测】→ Task 1 取证臂 + 运维口径
9. **TURN 吞吐天花板 = 节点出口带宽档**（5Mbps 档实测封顶 0.32MiB/s）；固定带宽月出量公式 = 带宽×31557600/12×u：5M→0.8TB、100M→16.4TB（u=50%）；每 100 元月租⇔125GB/月【外部实测】→ Task 12 容量方程供给侧参数
10. **15min 死亡第三嫌疑：ICE ufrag 不匹配静默丢候选**（v2 `addIceTolerant` 实测：ICE generation 40s 内 18 次 → 修复后降到 2）【外部实测】→ Task 1/7 取证时一并查 ICE generation 频率

### 2.2 弱假设 / 思想级（迁移条件受限）

- v2 LIVENESS 15s：它有干净 ctrl 才敢收紧——我们**先修测量诚实，再收阈值**（顺序即 N4 的全部要点）→ Task 9
- v3 三通道级联+决策引擎（656 行）：为 10 万台+三通道设计，**二期不做**；只取「恢复用独立预算表」「升级迟滞」两条思想
- 信令：轮询制 1.25–3.3 QPS/在线，10 万在线 = 12.5–33 万 QPS，Supabase 任一档打不住【外部实测+算术】；ws 长连实测 4C/8G 单机 10000 并发×3 复跑、QPS/在线≈0.0099；Supabase Realtime ~$10/千连接/月（量级估算，未实测）。本仓信令 = PostgREST 轮询——**10 万用户目标下是三期必答题（二期登记不动手）**
- gzip/zstd 压缩：**三仓全部为处女地**（v2 显式剥 accept-encoding，v3 bench 负载故意不可压缩）→ Task 10 预注册实验，负载必须可压缩
- 「暖场通道」relay→direct 后台升级：EasyTier 实测存在，WebRTC 无此机制（ICE 建连期定型），需自研 upgrade 轮 → **Wave 2 候选**
- 级联顺序成本复审：隧道 0.933 元/GB + 建链 460-1752ms vs TURN 1.344 元/GB + 4158-6738ms【外部实测】；v2 级联 = TURN 放最后的成本裁决，v0.1.0 现状 = TURN 先于隧道 → **Wave 2 候选**（权衡：隧道 TLS 在 VPS 终止 vs TURN 端到端 DTLS）
- 直连率杠杆（IPv6 / NAT 类型 facts / 引导）：三仓均无实现与数据，先上 NAT 类型 facts 再决策 → **Wave 2**
- v3 压测方法论（Wave 2 标定可搬）：并发真值=服务端 healthz 采样（不信 driver 自报）、driver≈1GB/1000 连接、爬坡≈200/s/台、需多机多出口（单机 ~2k 端口耗尽、~6k 路径崩）；2C/1.9G→4.1k 并发；TLS 建连吞吐是第一约束（2C≈17-60/s）

### 2.3 明确要避免

base64 数据面帧；TURN 凭据双 transport；整包单帧（>43KiB 撞 Chromium 上限）；单拍未回即割；connect() 先拆后建；恢复路径复用首连超时；`nc -z` 判安全组；裸计时断言无噪声带；把推断当结论；死 STUN 节点进生产清单（v2 坑：三台两台死）；**引用无证据数字进成本方程**（capacity-plan 的 25% 中继率=拍脑袋、0.8 元/GB 无账单、50-100kbps 仅 n=2 弱证据——判伪，禁止引用）

### 2.4 待实测验证（本仓实验任务）

- 15min 死亡根因三分：①werift consent 黑洞（Task 7 复现）②coturn allocation 600s（Task 1 日志取证）③ICE ufrag 丢候选（同臂观察 ICE generation）
- 压缩收益：唯一变量=压缩开关，负载必须可压缩（三仓无先验），判定=大 payload 期 1KB 请求排队时延 + 字节量
- 通道池真蜂窝 hol_increment（v3 门禁出自 loopback/netem）
- 本仓字节因子复测：二进制帧前后各一次（getStats 增量法）
- 本仓直连率分布：分接入类型（蜂窝/家宽/企业网），Task 5 上线后真机首批+日常积累（N≥20 前不信任何点估计；外部参考：云↔云 100%、家宽无 VPN 100%、家宽+VPN 0%、蜂窝↔家宽 ≈1/3 联通 / 0 电信多出口 NAT——容量方程用悲观档）

## 3. 设计决策（D1-D9）

- **D1 二进制帧先行**：帧协议 v2——控制帧仍 JSON 文本；`res-chunk`/`ws-msg` 二进制体改二进制帧（4B 头 + 原始字节），双端按消息类型分流解码。砍 33% 税先于压缩（乘积效应，且确定性收益）
- **D2 proxy 通道池 4 条**：浏览器侧建 `proxy0..3`；req 全走 proxy0；res 按 id 粘滞、新 id 落最小 bufferedAmount（v3 已验证结构；ctrl 带外已有）
- **D3 N3 双管齐下**：先零成本取证（coturn 日志对齐死亡时刻）+ 移植 consent 看门狗（签名检测→ICE restart→K 次失败交控制面重建）；双侧都修（一侧复活会被另一侧拖死）
- **D4 TURN 凭据单 UDP**：supabase turn-credentials 函数改单 transport（保留配置位，真机 A/B 复核 v3 的 33% 结论）
- **D5 健康双驱动**：徽章 = 心跳新鲜 AND 数据面有进展；stallSuspect 三条件判黄/红；帧账本 {sent,res,bytesSent,bytesRecv,hung} 双端暴露（同时喂成本指标）
- **D6 压缩走实验**：bridge 层 >16KB 可压缩类型 gzip + `enc:'gzip'` 帧标记 + SW DecompressionStream；feature flag 控制；预注册 A/B（假设/唯一变量/对照臂/判定阈值）后凭数据落地
- **D7 N4 阈值重构**：心跳 5s + 15s（3 拍）判死 + 任意入站帧刷新 + pc 事件驱动硬失效（0ms）；LIVENESS 45s→15s，WEDGE 60s 降为最终兜底；参数入 config 可真机标定
- **D8 成本一等指标**：bytes 进 `:19727/status` 与 events.jsonl（session_end 汇总）；`docs/cost-model.md` 落 1.68 因子、bj2 容量红线、直连率=利润监控口径
- **D9 成本 = 容量方程（10 万用户近乎免费）**：初心量化——二期结束时要能回答「N 台什么规格 VPS → 多少注册用户 / 多少同时在线 → 每千用户每月成本」，且四指标不破 v0.1.0 底线。
  - 方程：**VPS 成本 = 在线数 ×（中继率+隧道率）× 会话带宽 × 字节因子**；信令成本单列（二期按 Supabase 档位上限标注部署规模上限，三期换 ws 长连）
  - 参数现状：字节因子【外部实测，Task 5/12 本仓复测】；会话带宽【弱证据 n=2，Task 5 起实测】；中继率【禁止引用 25%，Task 5 起分接入类型测量】；单价/计费方向【部署者自查——方向差 2×【外部实测】、时长差 3×【推断】是最大不确定项，估算必须带误差带】
  - 三支柱分工：**测量**（Wave 1：Task 5 路径类型 + wire 字节进账本）/ **效率**（Wave 1：Task 2/3 砍税 + Task 10 压缩实验）/ **标定与直连率提升**（Wave 2：单机饱和标定（v3 压测方法论可搬）、蜂窝×家宽×运营商直连率矩阵 N≥20、NAT facts、级联顺序复审）
  - 量化锚（草案）：单位成本 ≤¥4/在线·月（外部参考 v3 门禁同值）；10 万注册 / 10% 并发场景给出 VPS 配置清单与月账单区间（cost-model.md 推演）
  - 底线：任何成本优化不得压破 v0.1.0 四指标基线

## 4. 全局约束

- 简单鲁棒，严控复杂度：不引入三通道级联、决策引擎、ws 信令长连（见 §2.2）
- 帧协议变更双端同批发布；PWA 与 host 互为 sha256 对账（实验纪律）
- 一切因果结论分级标注【实测/推断/未验证】；实验预注册，A-B-A 反转优先
- TDD：每任务失败测试先行；`npm test` 全绿才许提交
- 真机门禁：Wave 1 结束时跑 60min 浸泡 + 蜂窝真人实测，四指标对比基线（p90 / stall 次数与时长 / 15min 周期 / 字节量），报告落 `e2e/`
- **开发纪律（二期起）**：每 Task 独立分支 `wave1/task-N-<slug>`；合并 = squash merge 回 main；合并门禁三件套 = ①问题陈述（解决了什么问题，证据分级）②本仓实测记录（动网络路径的 Task 必须真机；纯内部重构可 loopback+单测）③`npm test` 全绿；禁 force push main
- 假设只有实测落点 Task 完成、记录归档后，才许从 §2.1 移入「已实测」
- 成本优化不得破基线（D9 底线）

## 5. 退出门禁（Definition of Done）

1. `npm test` 全绿（含新增 hol/帧/看门狗/账本用例）
2. HOL：大响应在途窗口内小请求排队时延 p95 ≤50ms（loopback 集成测门禁）+ 真机对比基线 39s → 数量级下降
3. 15min 周期：根因查明【实测级】且修复后浸泡 60min 零周期死亡（或证明为运营商行为并给出无感快速重建 ≤2s）
4. 字节量：同场景中继字节 ≥-25%（二进制帧单项保底）
5. 成本模型落档 + status 可见字节账
6. 徽章在 stall 期如实变黄/红（真人实测确认「不再骗我」）
7. **路径可见**：`/status` dataPlane 与 events.jsonl 可见每会话 direct/relay/tunnel 归属 + wire 字节账
8. **容量方程 v1 落档**（`docs/cost-model.md`）：参数现状表（实测/推断/待标定分级）+ 单位成本估算 + 10 万用户部署形态推演（未知项显式标「待 Wave 2 标定」）
9. **真机门禁首批路径数据**：本次真机各路径占比（direct/relay/tunnel）与复测字节因子记录进 e2e 报告
