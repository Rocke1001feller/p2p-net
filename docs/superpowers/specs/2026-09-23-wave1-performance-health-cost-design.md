# Wave 1 性能·健康·成本 设计（spec）— 2026-09-23

> 上游决策：二期三 Wave 中的 Wave 1（用户已批准方案 A）。目标：v0.1.0 已发布，用「速度+稳定+成本」赢得早期用户口碑。
> 方法学（用户钦定）：**批判**（不死搬硬套，标注迁移条件）、**实测**（Android 蜂窝真机随时可验）、**精简**（严控复杂度）。
> 证据来源：三试验场挖掘报告（stripe 仓 v2/poc、money 仓 v2.0.0-beta 线、TryEverything 仓 devanywhere-net v3 实验室）。

## 1. 基线（v0.1.0 实测，一切对比的锚）

- host 侧 done 时延 p50=4ms / p90=53ms（蜂窝 TURN 中继）
- 22min 真人实测：468 请求零错误、1.3MB 隧道流量
- 蜂窝 stall：16 次合计 587s，最久 82s；大 JSON（135-434KB）期 1KB 请求排队 39s（HOL 实证）
- 会话 ~15min 周期死亡重建（浸泡+实测共 8 次，均自愈但中断可感）
- 结构事实：`src/frames.ts` JSON 帧 + `dataB64/bodyB64`（base64 = 33% 字节税）；`src/peer.ts:246` 单条 ordered 'proxy' 通道扛全部流量；'ctrl' 带外通道已存在；LIVENESS 45s / WEDGE 60s；host 用 werift ^0.24.4

## 2. 三试验场证据浓缩（四类）

### 可直接吸收
1. **base64 = 33% 协议税**（v3 `tc-cost` 实测：TURN 字节因子 1.68；砍 base64 → 中继成本 -25%，性能同收）——v3 自评「不需架构改动即可回收」
2. **通道池治 HOL**：v3 `PROXY_POOL_SIZE=4` + 同 id 粘滞 + 新流落最小 bufferedAmount + ctrl 带外，门禁 `hol_increment p95 ≤50ms`（v2 曾实测 78s 虚高 RTT 同病）
3. **stallSuspect 三条件**（v3）：`ctrlAlive && inFlight>0 && msSinceInboundFrame>5000ms` = 黑洞判据；v2 同款看门狗（9s×2 条/3s 扫描）真机验证
4. **werift 0.24.4 两枚确定性缺陷**（v3 实测级）：#69 RFC 7675 consent 30s 到期 → `send()` 静默丢包永久黑洞（签名：bufferedAmount 钉死+ctrl 假健康+数据零进展，公网 13 次死亡全被看门狗救回）；#50 SCTP 交付遍历断裂尾部滞留。**与我们 stall/15min 死亡同签名，host 同款 werift 版本**
5. **TURN 双 transport 毒药**（v3 三臂 n=6：UDP-only 6/6、TCP-only 5/6、**both 2/6=33%**）——凭据只发单 transport
6. **检测时延=定时器映射**（v3 实测：15s 心跳+2s 看门狗 → p50 15.6s 检出；2s/250ms → 2.09s）；硬失效必须事件驱动
7. **心跳容忍**：任意入站帧刷新存活；「一拍未回即割」在拥塞窗批量误杀（v3 万级压测实录）
8. **成本模型**（stripe 仓 capacity-plan-100k）：中继=计费稀缺资源；打洞率 +10% ≈ 中继成本 -40%；中继定位「暖场通道」；bj2（=我们的 49.233.155.13，30Mbps 按带宽计费）月供载荷 ≈2.9TB@u50%
9. **coturn 运维纪律**：external-ip 必配；`nc -z` 探测是假阳性（SYN-proxy），只能应用层探针；401→success 是正常握手；fail2ban 别守 coturn

### 批判后吸收（迁移条件）
- v2 LIVENESS 15s：它有干净 ctrl 才敢收紧——我们**先修测量诚实，再收阈值**（顺序即 N4 的全部要点）
- v3 三通道级联+决策引擎（656 行）：为 10 万台+三通道设计，**二期不做**；只取「恢复用独立预算表」「升级迟滞」两条思想
- ws 信令长连：10 万级才成立的账，**二期不做**
- zstd/gzip 压缩：**三仓全部为处女地**（v2 显式剥 accept-encoding，v3 grep 零命中）——必须我们自己做预注册 A/B 实验，不许凭理论直接上

### 明确要避免
base64 数据面帧；TURN 凭据双 transport；整包单帧（>43KiB 撞 Chromium 上限）；单拍未回即割；connect() 先拆后建；恢复路径复用首连超时；`nc -z` 判安全组；裸计时断言无噪声带；把推断当结论（一切因果声明分级【实测/推断/未验证】）

### 待实测验证（Wave 1 实验任务）
- 15min 死亡根因二分：①werift consent 黑洞（复现装置可移植）②coturn allocation 600s 不 refresh（15min≈1.5×lifetime，日志取证）
- 压缩收益：唯一变量=压缩开关，判定=大 payload 期 1KB 请求排队时延 + 字节量
- 通道池在真蜂窝 TURN 腿的 hol_increment（v3 门禁出自 loopback/netem）

## 3. 设计决策（D1-D8）

- **D1 二进制帧先行**：帧协议 v2——控制帧仍 JSON 文本；`res-chunk`/`ws-msg` 二进制体改二进制帧（4B 头 + 原始字节），双端按消息类型分流解码。砍 33% 税先于压缩（乘积效应，且确定性收益）
- **D2 proxy 通道池 4 条**：浏览器侧建 `proxy0..3`；req 全走 proxy0；res 按 id 粘滞、新 id 落最小 bufferedAmount（v3 已验证结构；ctrl 带外已有）
- **D3 N3 双管齐下**：先零成本取证（coturn 日志对齐死亡时刻）+ 移植 consent 看门狗（签名检测→ICE restart→K 次失败交控制面重建）；双侧都修（一侧复活会被另一侧拖死）
- **D4 TURN 凭据单 UDP**：supabase turn-credentials 函数改单 transport（保留配置位，真机 A/B 复核 v3 的 33% 结论）
- **D5 健康双驱动**：徽章 = 心跳新鲜 AND 数据面有进展；stallSuspect 三条件判黄/红；帧账本 {sent,res,bytesSent,bytesRecv,hung} 双端暴露（同时喂成本指标）
- **D6 压缩走实验**：bridge 层 >16KB 可压缩类型 gzip + `enc:'gzip'` 帧标记 + SW DecompressionStream；feature flag 控制；预注册 A/B（假设/唯一变量/对照臂/判定阈值）后凭数据落地
- **D7 N4 阈值重构**：心跳 5s + 15s（3 拍）判死 + 任意入站帧刷新 + pc 事件驱动硬失效（0ms）；LIVENESS 45s→15s，WEDGE 60s 降为最终兜底；参数入 config 可真机标定
- **D8 成本一等指标**：bytes 进 `:19727/status` 与 events.jsonl（session_end 汇总）；`docs/cost-model.md` 落 1.68 因子、bj2 容量红线、直连率=利润监控口径

## 4. 全局约束

- 简单鲁棒，严控复杂度：不引入三通道级联、决策引擎、ws 信令长连（见 §2 批判吸收）
- 帧协议变更双端同批发布；PWA 与 host 互为 sha256 对账（实验纪律）
- 一切因果结论分级标注【实测/推断/未验证】；实验预注册，A-B-A 反转优先
- TDD：每任务失败测试先行；`npm test` 全绿才许提交
- 真机门禁：Wave 1 结束时跑 60min 浸泡 + 蜂窝真人实测，四指标对比基线（p90 / stall 次数与时长 / 15min 周期 / 字节量），报告落 `e2e/`

## 5. 退出门禁（Definition of Done）

1. `npm test` 全绿（含新增 hol/帧/看门狗/账本用例）
2. HOL：大响应在途窗口内小请求排队时延 p95 ≤50ms（loopback 集成测门禁）+ 真机对比基线 39s → 数量级下降
3. 15min 周期：根因查明【实测级】且修复后浸泡 60min 零周期死亡（或证明为运营商行为并给出无感快速重建 ≤2s）
4. 字节量：同场景中继字节 ≥-25%（二进制帧单项保底）
5. 成本模型落档 + status 可见字节账
6. 徽章在 stall 期如实变黄/红（真人实测确认「不再骗我」）
