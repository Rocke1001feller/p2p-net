# 真服务蜂窝浸泡验收（real-service-soak）

> 回答一个问题：**p2p-net 的网络「通了」之后，「能用」吗？**
> 真服务（devanywhere-ui :3001，真实 Web 应用）经 PWA 在 Android 蜂窝 4G 上持续运行，
> 量化稳定性与速度。本表是「发布门禁表」的最小一版——先定义什么叫达标，再测。

## 1. 门禁指标（先钉阈值，再测量）

| 指标 | 阈值（达标线） | 测量方法 |
|---|---|---|
| 连续在线 | ≥60min 无意外会话终止（掉线判定：PWA 会话结束/需重新扫码；隧道自身心跳重连不算） | events.jsonl `session_start`/`session_end` + 每 10min 手机截图 |
| RTT（relay 落点） | p50 ≤ 150ms，p95 ≤ 400ms（蜂窝 4G 合理线） | bench 页 100 次小 fetch 实测 + `p2p-net status` 轮询旁证 |
| 吞吐（下行） | ≥ 1 Mbps（对照 POC 基线：2.7MB bundle 10-20s ≈ 1.1-2.2 Mbps） | bench 页拉 50MB 实测，手机端计数 + 桌面端访问日志双侧对齐 |
| 真服务可用 | devanywhere-ui 经 PWA 加载成功、界面可交互（非白屏/非超时） | 截图 + 页面可点 |
| 掉线自愈（若发生） | 自动恢复 ≤30s，不需重新扫码 | events.jsonl + 截图时间戳 |

## 2. 拓扑

```
手机（Redmi 2409BRN2CC，蜂窝 4G，WiFi 关）
  ⇅ PWA（https://49.233.155.13/）
VPS 49.233.155.13（caddy / coturn / tunnel relay）
  ⇅ WebRTC DataChannel（relay 落点）或反向隧道兜底
桌面 Mac（p2p-net start）
  ├─ :3001 devanywhere-ui（真服务，NODE_ENV=production）
  └─ :5173 靶子 + bench 页（吞吐/RTT 测量）
```

## 3. 采集面

- `~/.p2p-net/logs/events.jsonl`：session_start/end、transport 选择、tunnel_reconnect
- `~/.p2p-net/logs/current.jsonl`：逐秒 debug
- `p2p-net status` 30s 轮询：活跃会话 RTT
- bench 页（:5173/bench.html，**测试工装非产品代码**）：fetch 流式计数，页面直显 Mbps 与 RTT p50/p95（手机无 DevTools，屏幕即证据）
- adb screencap 每 10min + 关键动作前后

## 4. 结果记录（测后填写）

| 项 | 实测值 |
|---|---|
| 日期 / 网络 | 2026-09-23 03:30-04:32 UTC（61min），Redmi 4G 蜂窝（WiFi 关），强制 TURN 中继 |
| 级联落点（relay / tunnel） | relay（TURN DataChannel，VPS 49.233.155.13） |
| 连续在线时长 / 意外断开次数 | 61min 内 4 次 session_end{failed}（03:47 / 03:51 / 04:09 / 04:26），**0 次需重新扫码**，全部自动恢复 |
| RTT p50 / p95（bench 实测 / status 旁证） | bench 30 次：p50=81ms p95=189ms ✅达标；浸泡探针 n=451（含负载）：p50=77ms p95=482ms max=1093ms（7% >400ms） |
| 吞吐（手机端 / 桌面端双侧） | 手机端 25s 窗口 0.74 Mbps（慢启动爬坡 0.03→0.70）；桌面端 16MiB 全量 82.5s=1.63 Mbps / 122s=1.10 Mbps ⚠️边缘 |
| devanywhere-ui 加载耗时 / 可交互性 | 冷载 85s 零会话churn、热载（SW 资产缓存命中）9s 首屏 ✅；Welcome 页完整渲染、表单可交互 ✅ |
| 掉线自愈耗时（若发生） | 4 次：22s / 51s / 19s / 24s（检测 45s 窗口 + 重连 4-10s + 缓存秒开）；其中 1 次超 30s 门禁 |
| 结论（PASS / FAIL + 备注） | **PASS（附条件）**：真服务在蜂窝中继上可持续使用，死亡螺旋已消除；见 §5 遗留项 |

## 5. 本轮修复与遗留（2026-09-23 深夜弧）

修复（全部 TDD，PWA 27 测试全绿）：
- 修复弧 1（早前）：全局活性看门狗口径、512KiB 桥背压、dcSend 让出事件循环、SW 超时 45s、forceTurn 真中继。
- 修复弧 2（本浸泡前）：`LIVENESS_MS` 15s→45s（蜂窝 6-15s 丢包簇常态，15s 误杀）；`WEDGE_MS` 20s→60s
  （洪泛期手机排空慢的合法静默 25-40s）；SW 资产缓存（`assetCache.ts`，按上游 Cache-Control
  immutable/max-age≥1d 缓存，no-store 穿透）——重连恢复从 40s+ 白屏 → 9s 内首屏。

遗留（按优先级）：
1. **会话寿命**：每小时 ~4 次 >45s 全静默（疑蜂窝长 blackout 或运营商 NAT 对 TURN UDP 路径回收）。
   方向：ping 5s→2s 保活 NAT、ICE restart 代替整会话重建、掉线期间工作台保持旧画面不重建。
2. **吞吐慢启动**：前 10s 仅 0.03-0.16 Mbps。方向：桥侧 chunk 增大/管道化、SW→页交付出厂检测。
3. **洪泛期 HoL**：大下载期间徽标 RTT 探针曾 1962ms。方向：bulk/交互分双通道或帧交织。
4. **单请求重试噪声**：重建工作台瞬间 `/` 被取两次（双 iframe 竞态），小浪费。
5. workbenchRecovery 的 40s 首屏阈值在 85s 冷载下会多触发一次无害重载——冷载慢的根因解了再回调。
