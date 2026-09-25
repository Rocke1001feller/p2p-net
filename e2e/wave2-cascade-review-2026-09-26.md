# W2-4 级联裁决复审报告（2026-09-26）

> 对应 `docs/cost-model.md` §6.4「级联顺序成本复审」。问题：**数据面级联顺序 p2p → tunnel → turn 是否仍最优？**
> 结论：**维持 p2p → tunnel → turn 不变**——隧道建连比 TURN 快 7–12 倍（真机实测），且按 0.8 元/GB 折算隧道单价 ≤ TURN；时延与成本两个维度同向。
> 附带两个如实登记的新发现（§4、§5），均未定性、不挡裁决。

## 0. 实验设置

- 方法：强制模式 A/B。真机打开 PWA，经 CDP 注入强制 `tunnel`（绕过 WebRTC 走隧道兜底腿）或 `relay`（ICE 候选只放 relay，强制 TURN），各连测 10 次，计时口径 = 从发起连接到标题出现「隧道/直连/中继」。
- 设备与通道：
  - **Android**（小米 2409BRN2CC，WebView「p2p-net 随行」，CDP 127.0.0.1:9333，MutationObserver 注入计时）；
  - **iPhone**（iPhone14,7，Safari，CDP 127.0.0.1:9229；iOS CDP 不支持 addScriptToEvaluateOnNewDocument，用 120ms 纯轮询口径）；
  - 双机均蜂窝网络（无 WiFi），host = Mac 家宽，relay/TURN = 49.233.155.13。
- 对账：driver 自报一律与 host `~/.p2p-net/logs/events.jsonl` 对账（mode/rtt），不一致处以 events 为准。
- 干扰源登记：快速迭代间 TURN 分配可能有竞争（见 §5）；两轮之间手机正常亮屏前台。

## 1. 实测时延（10 次/格，ms）

| 设备 × 模式 | 成功率 | p50 | min | max | 逐次样本 |
|---|---|---|---|---|---|
| Android × tunnel | 10/10 | **733** | 587 | 933 | 933 908 797 635 587 635 744 721 629 792 |
| Android × TURN | 10/10 | **5437** | 4080 | 6180 | 6180 5639 4285 4129 4080 5565 5557 5462 5412 4139 |
| iPhone × tunnel | 10/10 | **358** | 260 | 485 | 453 460 358 485 354 260 386 355 356 357 |
| iPhone × TURN | **6/10** | **4350**（成功样本） | 3007 | 6496 | 5460 4640 ✗ 6496 3447 3007 4060 ✗ ✗ ✗ |

- 倍数：Android TURN/tunnel ≈ **7.4×**；iPhone ≈ **12.2×**。
- events.jsonl 对账：TURN 轮会话事件 mode=relay、rtt 33–58ms ✓（强制生效证据）。
- iPhone TURN 4/10 样本 >45s 未建连（判失败），见 §5。

## 2. 成本复核（0.8 元/GB 流量单价折算）

| 路径 | 线字节因子 | 折算单价 | 证据 |
|---|---|---|---|
| 隧道 | 1.17–1.20 | ≈**0.94–0.96 元/GB** | 因子【实测-外部】 |
| TURN | 1.27（重载） | ≈**1.02 元/GB** | 因子【实测-本仓】（2026-09-24 真机蜂窝 A/B：A1=1.264 / B=1.284） |
| p2p 直连 | 0（不过中继） | 0 | — |

TURN 因子本仓复测 1.27 后两者单价已接近（差 6–8%）；**时延维度隧道领先 7–12×，是决定性差异**。

## 3. 裁决

**维持 p2p → tunnel → turn 级联顺序不变。** 理由：

1. 时延：tunnel 建连 p50 358–733ms vs TURN 4350–5437ms，隧道快 7.4–12.2×【实测-本仓，双端各 N=10】；
2. 成本：隧道 ≈0.94–0.96 元/GB ≤ TURN ≈1.02 元/GB，同向不冲突；
3. 成功率：tunnel 双端 20/20；TURN iPhone 端出现 4/10 超时（§5）——TURN 作为**最终兜底**保留，顺序不变。
4. 旧裁决（v0.1.0「TURN 先于隧道」时代的复审动议）正式关闭：§6.4 原文「复审价值下降」的判断被实测加固。

## 4. 发现①：Android 强制 TURN 时 UI 标题显示「直连」但 host events=relay（未解，登记）

Android TURN 轮 10/10 样本 PWA 标题为「47290b9b… **直连**」，而 host events.jsonl 同期记 mode=relay（rtt 33–58ms，对账成立）。
同一口径下 iPhone TURN 轮正确显示「中继」。疑似 Android WebView 的 `getStats` 形态差异导致 PWA 侧 pathType 分类与 host 不一致。
**影响面**：仅 UI 标签（用户看到的连接类型）；计量/事件记账以 host 为准不受影响。不挡裁决，登记待查（候选落点：PWA pathType 判定对 WebView stats 的 candidateType 字段兼容）。

## 5. 发现②：iPhone 强制 TURN 4/10 超时（未解，登记）

iPhone TURN 轮样本 3、8、9、10 连续失败（>45s 未建连），前 7 样本 6 成 1 败；Android TURN 10/10 全成。
疑似快速迭代间 TURN 分配竞争或 Safari ICE 重分配行为差异；未取证定性（需 coturn 侧分配日志 + 逐样本 ICE 状态），如实登记。
**影响面**：仅强制 TURN 的实验场景；生产级联中 TURN 为最终兜底、单点重试可缓解。若 W2-5 矩阵战役在自然使用中复现中继建连失败，升格处理。

## 6. 原始数据索引

| 文件 | 内容 |
|---|---|
| `/tmp/w24-tunnel.jsonl`、`/tmp/w24-relay.jsonl` | Android tunnel×10 / TURN×10（注入式 driver `/tmp/w24-forced-mode.cjs`） |
| `/tmp/w24-ios-tunnel.jsonl`、`/tmp/w24-ios-relay.jsonl` | iPhone tunnel×10 / TURN×10（轮询式 driver `/tmp/w24-ios.cjs`） |
| `~/.p2p-net/logs/events.jsonl` | host 侧会话事件对账（mode/rtt） |
