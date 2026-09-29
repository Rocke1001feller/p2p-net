# CHANGELOG

## Unreleased

### P1 多服务工作台（产品模型 v1 落地，16 commit）
- 产品模型 v1（账号→设备→服务）+ 原型 + P1 spec：设备页=启动台、工作台=侧栏树+沉浸式、默认落设备页（c489ffc）
- 设备页启动台：服务网格 + per-device 分组色（Chrome tab-group 风格）；工作台侧栏树：hide/unhide、per-device 服务记忆与隐藏存储、默认服务选择链 + 引导页（8e46991、a21ed52、e6cb9ee、445bcc7、6d634de、092d5df、5f1b06f、0dc806e）
- 评审修复：drawer 关闭路径与 stopPropagation（C1/I5）、重连不抢占用户当前服务（C2）、stopSession 复位沉浸式状态机（C3）、健康检查后台化且覆盖全部服务（I4）、svcGuide 入 appHost 去 56px 魔法 inset（I6）

## 0.3.3（2026-09-27）—— W-B① 重连探活 + OPS-1 闭环

- feat(pwa)：重连后工作台先探活再定夺——存活不重建，已死才强制重载（036ffe7；R4-1 候选方向①）
- 双机真机验证：战役档案 §3.11 W-B①② 实录 + Android CDP 仪器缺口登记（`e2e/wave2-direct-rate-matrix-2026-09-26.md`）
- OPS-1 闭环：VPS 证书 Caddy 自动续期实证（Sep 26 成功，ARI 排程在位），无需人工值守
- v0.4.x 立项登记：W-B 残余 / 旁路负缓存 / adopt-direct 补验 / 中继正修 / 证书续期

## 0.3.2（2026-09-27）—— W-A 旁路采纳死亡循环根修

- fix(pwa)：'all' 起跑会话忽略 upgrade restart + 旁路采纳仅真直连（aae0747，Fix C + Fix B1）——根治每 ~2min 假性重级联重建工作台
- 战役档案 §3.10：根因定罪/修复/真机验证实录（`e2e/wave2-direct-rate-matrix-2026-09-26.md`）

## 0.3.1（2026-09-26）—— v0.3.x 增量包

- feat：实验徽章 + 隧道计量 + 粘性回迁 + tunnel→p2p 升级（d7cc5e7）
- package-lock 版本号同步（48259fc）
- 战役档案 §3.9：增量包实施/评审/真机验证实录 + §4 遗留立项状态回填（`e2e/wave2-direct-rate-matrix-2026-09-26.md`）

## 0.3.0（2026-09-26）—— Wave 2 标定：直连率杠杆 + 稳定性三连根修

- feat(wheel)：W2-6 暖场升级轮——relay 暖场会话稳定后原位升级直连，失败留 relay（7d1b8ab；配置开关 upgradeWheel，默认开）
- feat：W2-2 NAT facts 探针 + doctor 第八层 nat（e28d044）；W2-1 接入类型分桶计量（fa77b33）；W2-3 隧道饱和压测 driver + ramp 数学（eb08c3b）
- fix(turn)：W2-7 werift 438 stale-nonce 恢复循环——17min 死亡定时器根修（746948b）
- fix(tunnel)：僵尸腿根修——应用层心跳看门狗 + status 活性如实化（577ae79）
- fix(pwa)：前台探活——后台超阈回前台轻量探活，失败黄灯「连接待恢复，点我重试」（361d924）；双机同 deviceId 撞车根修（fdaad57）
- fix(host,pwa)：console-hijack 根治——console 自述 consolePort + PWA last-good 兜底，低位端口劫持工作台白屏不再（b7f5309）
- W2-5 直连率矩阵战役收口（口径定性：方向性信号）；W2-3/W2-4 成本实测入档 `docs/cost-model.md`

## 0.2.1（2026-09-25）—— 稳定性根修 + 机制落地（防复发门禁）

真机门禁（`e2e/wave1-realdevice-gate.md`）§5 登记的 5 项独立修复，均经独立分支 + squash 合并：

- host 信令面看门狗：轮询连续失败三段楼梯（标记恢复中→重建客户端→`onSignalingBlackHole`，默认退出靠 launchd/systemd 自愈），`/status` 新增 `signaling`（治 F4 信令黑洞）
- PWA 手动重试不再杀死自动重连循环（`reconnectPolicy` 裁决模块，治 F3）
- PWA boot 无票重进自动重连最近桌面（`bootPolicy` 裁决模块，票据优先、否则 LS_DESK_ID 记忆，治 F6）
- pathType 双侧规则：任一端 relay 候选即判中继（F8 终裁——host 无缺陷，本地判据漏报对端 relay；`src/pathType.ts` + `pwa/src/frameLedger.ts`，门禁 §2.1 自然臂读数勘误为 100% relay）
- **gzip DEFAULT 翻转为开**（H6 A/B 判定落地）：隧道响应 gzip 默认开启，`P2P_NET_GZIP=0` 为紧急关闭开关；双端协商不变（SW 无 DecompressionStream 不声明 `x-p2p-gzip`，host 绝不压）

### 稳定性根修（双真机回归：Android/电信 + iPhone/联通）
- 配对票据 TTL 120s→2h（真机复现「二维码已过期」根因）
- 隧道 relay 补 `content-encoding` 响应头——iPhone 隧道腿大响应空返回根因（67727f0）
- F9 自动重连无声死亡根修 + 真机四相位回归门禁（10ef47d，报告 `e2e/f9-reconnect-freeze-regression-2026-09-25.md`）
- 401/403 鉴权连败不再误判信令黑洞：分类治理 + 节流即时续期，不撞黑洞三段楼梯（1d11b96）

### 可观测性（debugging 优先原则首批落地）
- 自检探针：5s 服务/信令探测留痕，快照翻转告警 + 60s 心跳写 `events.jsonl`；host poll 计时 `lastPollMs`（1c52cd7）
- F10 隧道兜底腿计量并入 `/status` 数据面——成本模型补最贵变量（19b44e5）
- Layer 0 狗粮落地：`p2p-net service install`（launchd/systemd，KeepAlive）开发机实装，kill -9 复活实证（`e2e/layer0-supervision-selfcheck-2026-09-25.md`）

### 机制（审计「孪生副本=误判复发根源」的结构性答案，门禁报告 `e2e/mechanisms-landing-2026-09-25.md`）
- 甲1：pathType 孪生副本消灭——PWA 改 import 根包 `./browser` 导出，双端单一实现
- 甲2：端口契约单一事实源——`src/ports.ts` 浏览器安全直读 `contracts/ports.json`（STUN_PORT 入约），PWA 删副本
- 甲3+丙1：共享测试语料 `contracts/path-type-corpus.json`（25 条），`npm run test:parity` 双端同源断言
- 丙2：`npm run lint:twins` 孪生复活门禁（`scripts/twin-guard.mjs` 登记表），test 链第一棒
- 乙1：`docs/superpowers/lessons.md` 教训登记簿（7 条）+ 计划自审 checklist
- 测试隔离：套件在常驻 host 下真绿（control 动态端口化、watchdog 两例竞争根修、scanner 探测污染隔离）；全量 473 测 0 败

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
