# Layer 0 监管落地 + 自检探针（2026-09-25）

## 背景

host 同日三次死亡（F9 复现人为停 / 16:57 信令黑洞 exit 1 / 第三次 401 连败 exit 1），
归因发现 `src/cli/service.ts`（Task 18，launchd KeepAlive / systemd Restart=always）
**早已实现但开发机从未安装**——「决策-实现」之外更扎眼的缺口是「实现-采用」（狗粮纪律）。

## 事实链（全部实测取证）

1. **推翻「Mac 休眠」猜测**：`pmset -g` sleep 0（Feishu 等阻止）；`sysctl kern.sleeptime/waketime`
   均 epoch 0 = 自开机从未休眠；pmset log 事故窗口无 sleep/wake 事件。教训：可探测的事禁止猜。
2. **第三次死亡根因（与 16:57 不同）**：10:09:44Z `auth_refresh_failed`（Supabase 连接不可达）
   → 后续 poll 连续 401（199s × 45 次）→ 看门狗第三段 exit 1。
   **新登记**：看门狗把 401 鉴权失败与网络黑洞同口径计数——分类缺陷，待修（机制清单）。
3. **Layer 0 落地**：`p2p-net service install` → ~/Library/LaunchAgents/net.p2p-net.server.plist
   （KeepAlive=true + RunAtLoad=true；launchd 默认 ThrottleInterval=10s 防崩溃风暴）。
4. **复活实证**：kill -9 pid 24472（18:21:45）→ launchd 同秒拉起 pid 24609（距上次启动 >10s
   故无节流延迟）→ 控制面/信令恢复；service.log 两条启动横幅佐证。第二次重启
   （kickstart 部署新代码）pid 27997，`/status` 新增 `signaling.lastPollMs` 字段生效。

## 自检探针（debugging 优先原则：可观测性建设一概必做）

- 新增 `src/server/selfcheck.ts`：每 5s 对 scanner 发现的本地服务做 HTTP 级探测
  （TCP 握手测不出事件循环停顿——内核 backlog 代答，:3001 挂起 254s 那类假活必须 HTTP 级）；
  每目标三态机 ok|slow|fail，翻转才发 `selfcheck_alert`（稳态零噪音）；
  信令面 consecutiveFailures 0↔>0 翻转告警；每 12 周期（≈60s）一条 `selfcheck_heartbeat`
  紧凑快照（消除「无事件=健康还是探针死了」歧义）。
- `src/host.ts`：poll 计时，`signalingHealth()` 新增 `lastPollMs`。
- `src/cli/start.ts`：装配步骤 7.5 接线（`startSelfcheckFn` 可注入，测试不碰真定时器/fetch）。
- TDD：selfcheck.test.ts 7 例先红后绿；全量 382 例 374 过，6 例 control.test.ts 为
  「live host 占端口」已知环境性失败（host 现已常驻，该测试隔离问题优先级上升，机制清单在册）。

## 生产首条心跳（10:37:25Z，证据）

```
{"name":"selfcheck_heartbeat","targets":[{"port":3001,"ok":true,"ms":4},{"port":5173,"ok":true,"ms":4},
{"port":9333,"ok":true,"ms":9},{"port":57724,"ok":true,"ms":3}],
"sig":{"consecutiveFailures":0,"recovering":false,"recreated":false,"pollsOk":63,"pollsFailed":0,"lastPollMs":409}}
```

自此：信令 RTT、本地服务存活/延迟、翻转时点全部落盘——再发 16:47 类事故，
可直接读 events.jsonl 区分「Supabase 路径死」与「localhost 挂起」两个症状。
