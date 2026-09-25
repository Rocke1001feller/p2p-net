# scripts/bench — W2-3 隧道饱和压测

单机饱和压测工具链：本机 driver 对隧道网关（`wss://<relay>/tunnel/s/<deviceId>`）
爬坡建连，回答「单 VPS 隧道入口能扛多少并发 WS 腿」。判定与统计语义单一事实源
在 `ramp.mjs`（纯函数，driver 与测试共用），driver 不得另写一套。

## 文件

| 文件 | 角色 |
|---|---|
| `ramp.mjs` | 纯函数：`benchRamp`（爬坡序列，余数平铺、Σ严格等于 total）、`summarize`（成功率/p95 最近秩，失败样本不进 p95）、`checkSaturated`（饱和判据）。零依赖。 |
| `tunnel-saturation.mjs` | driver：爬坡建连 + 混合工况 + 采样落盘 + 饱和判据即停 + 双瓶颈报告模板。依赖仅 devDependencies 已有的 `ws`（不加新生产依赖）。 |

## 用法

```bash
node scripts/bench/tunnel-saturation.mjs <wss-url> <token|-> <total> <ratePerSec> [选项]
# 例（真 VPS 一档：1000 连接 @200/s，稳态 5min）：
node scripts/bench/tunnel-saturation.mjs 'wss://<relay>/tunnel/s/<deviceId>' '<token>' 1000 200 --steady-ms 300000
# 本机自检（对本地 echo WS，200 连接冒烟）：
node scripts/bench/tunnel-saturation.mjs 'ws://127.0.0.1:<port>/echo' - 200 2000 \
  --tick-ms 50 --steady-ms 2000 --hb-interval-ms 300 --big-bytes 65536 \
  --sample-interval-ms 500 --out /tmp/bench-samples.jsonl
```

`<wss-url>` 可含 `{i}` 占位符（按连接序号替换）。默认值即生产口径：
心跳 1KB/5s/连接、每 30s 抽 5% 连接请 1MB 大响应、采样 5s、滑窗 30s。

## 口径（读数怎么解释）

- **真值铁律（v3 方法论）：不信 driver 自报并发。** driver 采样只是自报水位，
  报告必须双瓶颈分列——A：driver 侧（fd 峰值/`ulimit -n`、RSS、ELU、CPU，
  采样文件每拍一行）；B：VPS 侧（`vnstat`/caddy 指标/`p2p-net status` 的
  `dataPlane.tunnelLinks` 服务端在线腿数），由操作员另开终端采集誊抄。
  driver 收尾会打印 B 侧采集命令模板。**禁止只引 driver 自报下结论。**
- **对端 echo 契约**（本机自检与真 VPS 同一套）：`{"t":"ping","seq":N,"ts":<ms>,"pad":"…"}`
  原文回弹 → 计 RTT；`{"t":"big","bytes":N}` → 对端回 N 字节 → 计大响应完成。
- **饱和判据**：30s 滑窗内 新建连接成功率 <95%，或 心跳 p95 > 3×基线。
  触发即停（`verdict:"saturated"`）。
- **基线口径**：爬坡完成后第一个完整滑窗的 p95——此时混合工况（心跳 + 大
  响应轮）已全量展开，基线代表「目标并发下健康混合工况」。稀疏心跳期（爬坡
  中）不建基线，否则大响应突发会被误读成退化；基线未建立或为 0（本机
  loopback 亚毫秒，3×0=0 是退化阈值）时 RTT 判据跳过，新建成功率判据始终生效。
- **失败样本口径**：建连超时/拒绝、心跳超时/发送失败计入成功率分母，
  但**不进** p95（占位 rttMs=0 会把延迟分布拉假）。
- **迟到回弹**：已超时记失败的心跳回弹只忽略，绝不得计入大响应字节。

## 纪律

- **URL/token 绝不进日志与采样文件**：日志只打 scheme 与计数；ws 错误只透传
  `err.code`（message 可能带地址）；采样行纯计数与水位。自检测试机械断言
  stdout/stderr/采样行不含目标端口字面量。
- **fd 水位用 `lsof -p <pid>`**：macOS/Linux 的 `/dev/fd` 是调用进程视图，
  `ls /dev/fd` 量到的是 ls 自己而非 driver（计划原文写法在此订正）。
- `perMessageDeflate` 关闭：隧道流量是已压缩帧，压缩 CPU 税会污染饱和读数。
- 采样默认落 `./bench-samples-<时间戳>.jsonl`（已入 .gitignore）。
- 自检（`src/tests/bench-driver.test.ts`）：本地 echo WS（listen(0) 动态端口）
  200 连接冒烟，driver 计数与 echo 服务端计数对账，**偏差 >1% 即 driver 有
  bug，先修 driver 再上真 VPS**。真 VPS 爬坡（1000→3000→5000 档、干扰源
  登记、报告归档 `e2e/wave2-saturation-<date>.md`）由主会话执行，不在本工具内。
