# Wave 1 真机蜂窝门禁报告（2026-09-24，spec §验收 / task-13-brief Step 7）

> 链路：红米真机 × 蜂窝网络 × VPS 49.233.155.13（coturn + PWA）；host = Mac 全局安装 p2p-net 0.2.0 候选。
> 基线 = v0.1.0 发布前真机评测（排队 p95 39s / stall 16 次 587s / 假绿点 / TURN 建连 33%）。
> 判定口径：四条核心 Go 条件全过 = Go；任一不过 = 回 systematic-debugging，不许带伤发布。

## 0. 判定：**Go（四条核心条件全过）**

真人实测（用户 2026-09-24 反馈）：操作体感流畅度不低于 v0.1.0；过程中 host 侧重启数次后彻底稳定（对应失效形态 F4 的手动恢复，已登记独立修复项）。

## 1. 四指标对比表

| 指标 | v0.1.0 基线 | Wave 1 实测 | 门禁线 | 判定 |
|---|---|---|---|---|
| 排队 p95（大 payload 期探测） | 39s | A1=2336ms / A2=3507ms【实测-真机】 | <5s | ✅ |
| stall（16 次/587s/最久 82s） | 存在 | 60min 浸泡：真 stall 0 次；黄灯如实亮 1 次；4 次会话重建恢复 3.7s/10.1s/7.2s/6.6s【实测-真机】 | 恢复 <11s 且无假绿 | ✅ |
| 假绿点（hung 冻结假象） | 存在 | 全程 hung 计数冻结 27，零新增【实测-真机】 | 0 | ✅ |
| TURN 建连成功率 | 33% | 9/10 = 90%【实测-真机】 | 显著提升 | ✅ |

辅助指标：
- 冷启动 10 次（点卡→connected）：p50=5635ms，p95=13339ms，max=13339ms（n=9）；E2E 含页面重载 p50=6710ms。唯一失败 #5 已归因：offer 到达（Δ2）但 `turn=webrc_timeout_15000`——真 TURN 层失败，与 33% 基线病同类，非信令/协议回归。
- 浸泡 RTT：p50=58ms / p90=165ms / max=325ms（强制 TURN 臂）；自然直连臂 p50≈47ms（range 34–352ms）。
- 剔除声明：Step 6 之前 3 次冷启动 FAIL（v1/v2 循环）为脚本协议错误产物（boot 无票不自动连，见 F6），不计入成功率。

## 2. 成本门禁数据（spec 退出门禁 #9）

### 2.1 路径占比——D9 中继率参数本仓首个实测点（N=1，禁止外推）

自然级联窗口（不带 `?transport=relay`，10min，每 60s 采样）：**10/10 样本 pathType=direct**（手机侧 `frames.pathType`），全程 connected、零 stall、零重建。强制 relay 浸泡臂按构造 100% relay。

| 会话臂 | direct | relay | tunnel | 数据源 |
|---|---|---|---|---|
| 自然级联（N=1 会话，10 样本） | 100% | 0% | 0% | 手机 `__p2pNetDebug().frames.pathType`【实测-真机】 |
| 强制 relay 浸泡臂（61 样本/60min） | 0% | 100% | 0% | 同上（构造如此） |

约束：N=1 单会话、单运营商、单 desk 网络（Mac 所在宽带），**严禁外推为直连率结论**；Wave 2 直连率矩阵（N≥20）标定。host 侧旁证缺口见 F8。

### 2.2 字节因子复测（tx/rx 合记与工况拆分）

重载工况（gzip A/B 窗口，VPS eth0 双向 ÷2 腿 ÷ 应用字节）：

| 相位 | eth0 Δ(双向) | 应用字节 | 因子 |
|---|---|---|---|
| A1（gzip off） | 16,306,570B | 6.45MB | 1.264 |
| B（gzip on） | 5,152,658B | 2.01MB | 1.284 |
| A2（off 反转） | 31.6MB | — | 2.42（重建风暴工况，单记不入点估计） |

**重载字节因子 ≈1.27【实测-本仓】**，对照外部基线 1.68 降 24%，与砍 base64 预期 ≈1.26 吻合；已回填 `docs/cost-model.md` §6.1（分级升【实测-本仓】，外部 1.68 作废）。

轻载工况（54min 近空闲窗口）：eth0 Δ=16.91MB，其中 coturn 可记账 ≈98%；coturn 账内真实凭据会话 10.15MB（61%）vs 空用户名 STUN 6.46MB（39%，含扫描器 45.33.12.214 / 50.116.26.161 背景辐射，估每月数十 GB/台固定税）。**轻载表象因子 ≈25×**（SCTP 心跳/ICE consent/重传等固定协议税主导）——容量方程必须用重载因子，轻载税作为固定扣减项，均已写入 cost-model.md §6.1 附注。

coturn 侧字节对账边界标记：M_A1s/M_A1e/M_Bs/M_Be/M_A2s/M_A2e（epoch 1790260681–1790261471，coturn journal + `/proc/net/dev`）。

## 3. 压缩 A/B 结论（spec D6 / H6）

详档 `e2e/compression-ab-results-2026-09-24.md`。结论：**H6 两假设同时成立 → 判定「默认开」**——探测 p50 -65.0%（≥30% 线）、中继线字节 -69.0%（≥20% 线）；p95 表象劣化 +47% 经 A2 反转证明为时间漂移非 gzip 归因，撤退线不触发。DEFAULT 翻转不进本分支，登记为独立小任务（§5 ④）。

## 4. 失效形态目录（本仓真机实录，含今晨已破链条）

| # | 形态 | 现状 |
|---|---|---|
| F1 | Shape A：单向 host→phone 死，consent 看门狗结构性失明 | 已修（Task 7/8），浸泡期零复发 |
| F2 | Shape B：SCTP 假死 ICE 绿灯，wedge 60s 兜底 | 已修，浸泡期零复发 |
| F3 | 手动重试杀死自动重连循环（`shell.ts:478` 仅 isRetry 才 scheduleReconnect，failed 态不认） | 登记独立修复 ② |
| F4 | host 信令轮询黑洞：offer 全进黑洞、/status 假正常（uptime 在走），9min 与 20+min 两次均不自愈，靠手动重启恢复——**信令面无看门狗是 Wave 1「健康」头号遗留** | 登记独立修复 ① |
| F5 | 重建杀在飞请求：A2 相位中段 gen 30→31，在飞 fetch 全部悬挂至脚本超时 | 实录登记，Wave 2 评估在飞请求迁移/重放 |
| F6 | boot 无票不自动连：`shell.ts:899 boot()` 仅 `desk.id`（来自 URL 票据）存在时自动 startConnect，普通重进停在设备页等人点卡——设计还是缺陷待用户裁决 | 登记独立裁决 ③ |
| F7 | ~17min 会话回收周期 ×3（间隔 17/17/17min，健康→突然死、前兆微弱）：疑似运营商 NAT 绑定周期，非 v0.1.0 的 15min consent 固定回收（看门狗生效中：重建均由 ICE failed 驱动、无 hung）。恢复 <11s 用户无感，不阻塞发布 | 开放问题，判别实验建议：双运营商对照 + coturn 日志绑定计时 |
| F8 | host 实时 pathType 归属滞后：手机已 direct 时 host `/status` totals.pathType=unknown、byPath 仍计 relay（session_end 才落账）——影响直连率北极星指标的实时性 | 登记独立修复（数据质量） |

## 5. 发现节：独立 bounded 任务（均不进本分支）

1. **host 信令面看门狗**：poll failed 带时间戳+连续计数、N 次连续失败重建 poll 客户端、/status 暴露 signalingHealth（治 F4）。
2. **手动重试杀自动重连修复**（治 F3，`shell.ts:478`）。
3. **boot 无票不自动连裁决**（F6：设计确认 or 缺陷修复，需用户拍板）。
4. **gzip DEFAULT 翻转为开**（H6 已判定「默认开」，下一版本窗口执行）。
5. **host 实时 pathType 归属修复**（治 F8）。

## 6. 原始数据档案

- 浸泡：`/tmp/p2p-soak.jsonl`（95 样本/60min 强制 TURN）；自然级联：`/tmp/p2p-natural.json`（10 样本）。
- 冷启动：`/tmp/p2p-coldstart.json`（10 次）；A/B：`/tmp/p2p-ab-{A1,B,A2}.json`。
- host 日志：`/tmp/p2p-gate.log`；host events：`~/.p2p-net/logs/events.jsonl`（session_end.pathType 落账）。
- 真人实测覆盖 task-13-brief Step 4（用户第一波反馈，见 §0）。
