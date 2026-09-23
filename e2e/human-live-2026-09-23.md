# 真人真机实测报告（human-live）— 2026-09-23

**性质**：p2p-net v0.1.0 发布前最后一项验收 —— 真人（项目 owner）在 Android 蜂窝真机上自由操作真实重量级 SPA（devanywhere-ui :3001，vibe-code-ui 衍生），AI 侧同步观测网络。量化指标与用户实际体感的对齐实验。

- 链路：Redmi（4G 蜂窝）→ VPS TURN 中继（49.233.155.13，forceTurn 真中继）→ Mac host :3001
- 窗口：08:05:42Z – 08:27:51Z（约 22 分钟，用户全程自由操作，无脚本）
- 前提：用户账号 app@tanpin.top 经隧道完成注册 + onboarding（Git 配置/Connect Agents/Complete）全程无人工协助

## 1. 总览数字（vs 门禁口径）

| 指标 | 实测值 | 说明 |
|---|---|---|
| 真实 API 请求 | **468 个，全部完成（done 468），错误 0** | 含 file-tree/git/messages/skills/preferences/PATCH 写 |
| 隧道传输量 | **1.30 MB**（b64 前原始字节合计） | 重量级 SPA 真实负载 |
| host 侧 done 时延 | **p50=4ms / p90=53ms / p99=2238ms / max=40.8s** | 链路良好时极快；max 为 stall 期队头阻塞 |
| 蜂窝 stall（探针间隙>15s） | **16 次，合计 587s，最久 82s** | 占测试窗口 ~44%，当日蜂窝质量极差 |
| 会话判死→自愈 | **4 次：20s / 35s / 50s / 56s** | 全部自动恢复，零人工干预 |
| RTT | 平稳期 39–180ms；stall 恢复期 200–450ms | |

**用户体感反馈（owner 原话）**：「非常不错。devanywhere-ui 的所有能力都被 p2p-net 很好地支持了。稳定性和速度都有了量化指标跟用户实际体感对齐。」

## 2. 体感↔数据时间线（对齐证据）

| 时刻(UTC) | 用户操作 | 网络侧 |
|---|---|---|
| 08:07–08:09 | 开项目 / Source Control / 开 Claude 会话 | 请求密集，done 2–222ms，RTT 39ms |
| ~08:09 | 首次卡顿感 | 35s stall；135KB skills 响应耗 40.8s，1KB 请求排 39s（队头阻塞实证） |
| 08:15/08:18 | 两次「重连中」 | stall 超 45s 活性阈值 → 判死 → 20s/35s 自动重建 |
| 08:16–08:21 | 刷 Chat 长对话（单条 messages 132–311KB） | 恢复期请求 200–700ms，浏览流畅 |
| 08:22 | Files 页 "Loading files..." 挂住 | 第三次判死窗口（50s 恢复），截图取证 |

## 3. 新发现（浸泡测试未覆盖的）

1. **队头阻塞（HOL blocking）是二期第一优化点**。大 payload（file-tree 最大 434KB、messages 311KB、skills 135KB）在 stall 期阻塞后续小请求——1KB 的 commands/list 也等 39s。这些响应全是 JSON，gzip/br 可压缩 ~85%（135KB→~20KB），stall 期传输时间可降一个量级。
2. **45s 活性阈值 vs 当日 stall 分布**：stall 中位 ~30s（45s 能扛住），但 4 次 >50s 的 stall 仍判死。判死后 20–56s 自愈、SW 缓存让首屏秒回，体感可接受。**建议 v0.1.0 保持 45s 不动**，二期用更多真实数据再评。
3. **「绿点假象」**：stall 期间徽标仍绿（探针也在排队），用户看到绿点但页面转圈。二期可做「在飞请求时长」驱动的健康指示。
4. **onboarding 全链路经隧道可用**：注册→Git 配置（预填 host git config）→Connect Agents（Codex 已认证✓）→主界面，说明 account/bootstrap 全部 API 在隧道下工作正常。
5. **小观察（低优先）**：设备卡「上次连接」时间戳在持续使用期间不刷新（停留 15:57）。
6. **使用形态**：用户在普通浏览器 tab 中使用（非安装态 PWA），二期可引导「添加到主屏幕」。

## 4. 结论

- **发布门禁「真机 E2E」：PASS**。量化指标与用户体感双向对齐；真实服务清单在真实蜂窝下「能用、好用、偶发卡但永远自己回来」。
- stall 源于蜂窝链路本身（探针间隙+RTT 尖峰为证），非 p2p-net 逻辑、非 VPS 带宽；修复弧 2（LIVENESS 45s + SW 缓存）在 4 次 >50s stall 下均实现自愈，设计意图达成。
- 遗留项转入 ROADMAP.md 二期：HOL 优化（压缩/优先级/增量）、绿点假象、TURN 路径回收（浸泡遗留 #1）、设备卡时间戳。
