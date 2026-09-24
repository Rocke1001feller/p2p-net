# CHANGELOG

## Unreleased（main 已合入，未发布）

真机门禁（`e2e/wave1-realdevice-gate.md`）§5 登记的 5 项独立修复，均经独立分支 + squash 合并：

- host 信令面看门狗：轮询连续失败三段楼梯（标记恢复中→重建客户端→`onSignalingBlackHole`，默认退出靠 launchd/systemd 自愈），`/status` 新增 `signaling`（治 F4 信令黑洞）
- PWA 手动重试不再杀死自动重连循环（`reconnectPolicy` 裁决模块，治 F3）
- PWA boot 无票重进自动重连最近桌面（`bootPolicy` 裁决模块，票据优先、否则 LS_DESK_ID 记忆，治 F6）
- pathType 双侧规则：任一端 relay 候选即判中继（F8 终裁——host 无缺陷，本地判据漏报对端 relay；`src/pathType.ts` + `pwa/src/frameLedger.ts`，门禁 §2.1 自然臂读数勘误为 100% relay）
- **gzip DEFAULT 翻转为开**（H6 A/B 判定落地）：隧道响应 gzip 默认开启，`P2P_NET_GZIP=0` 为紧急关闭开关；双端协商不变（SW 无 DecompressionStream 不声明 `x-p2p-gzip`，host 绝不压）

## 0.2.0（2026-09-25）—— Wave 1 性能与健康

### 性能
- proxy 4 通道池：req 恒 proxy0 保序，res/ws 按 id/wid 粘滞落最小 bufferedAmount 通道（HOL 门禁：大传输期 1KB 探测排队增量 p95≤500ms，loopback 跳线串行口径）
- 帧协议 v2：res-chunk/ws-msg 二进制出站（省 33% base64 线税 + 双端编解码 CPU），旧端自动回退
- TURN 单 UDP 端口 3478 收敛（析取 coturn 实测：多端口段不增建连率）
- 隧道响应 gzip 流式压缩（实验档 `P2P_NET_GZIP`，双端协商；真机 A/B 判定「默认开」，翻转于 Unreleased 落地）

### 健康
- ICE consent 看门狗：werift 0.24.4 #69 授权死信兜底（复活上限 5 次，give-up 走会话终态）
- stallSuspect 三条件黄灯：链路自报健康但数据面静默 >5s 即琥珀示警，绿点谎言归零
- N4 活性阈值：LIVENESS 45s→15s（3 拍）+ pc failed 事件 0ms 拆连（旧行为无人触发重连）
- 帧账本 + 字节计量：`/status dataPlane`、`p2p-net status` 流量行、`events.jsonl session_end` 带 bytesUp/Down

### 成本
- `docs/cost-model.md`：容量方程 v1 + 参数现状表；重载字节因子 ≈1.27【实测-本仓】（外部 1.68 作废）、轻载固定协议税与扫描器税入册、蜂窝↔Mac 自然级联直连 N=1 首测点

### 验收
- `e2e/wave1-realdevice-gate.md`：真机蜂窝门禁 **Go（四条核心条件全过）**——排队 p95 39s→2.3–3.5s（<5s 线）；60min 浸泡真 stall 0 次、假绿点 0 次、4 次重建恢复均 <11s；TURN 建连 33%→90%（9/10，唯一失败为真 TURN 层超时）；真人实测体感不低于 v0.1.0
- `e2e/compression-ab-results-2026-09-24.md`：gzip A/B——探测 p50 -65%、中继线字节 -69%，判定「默认开」
