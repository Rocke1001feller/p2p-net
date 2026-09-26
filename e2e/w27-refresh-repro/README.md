# W2-7 REFRESH#2 缺席判别实验（spike）

> 任务D（2026-09-26）：W2-7 浸泡死亡根因三候选判别——去掉 Android 变量。
> 证据分级：【实测】=直接观测/日志直读；【推断】=间接证据链；【未验证】=本轮无法取得。

## 1. 判别的死因（a6d40b9 §3.4 登记）

W2-7 真机浸泡（Android 强制 relay 经 coturn）+1190s 死于 `session_end{failed}`：
coturn 窗口**零 438**、`turn_438_repair` 事件**零触发**（旧 438 修复循环无罪——本轮不是 438 死法）；
TURN allocation 于 +1113s 死于 `allocation timeout`——**REFRESH#1(+497s) 成功，REFRESH#2(~+997s)
从未到达 VPS**（600s 静默后 coturn 判死）。

三候选：① Android 页面 ~20min 被冻结（浏览器侧 TURN 客户端停发）；② UDP 单包丢失无重传；
③ werift TURN 客户端 REFRESH 链缺陷。

## 2. 方法

**判别问题**：REFRESH#2 缺席在去掉 Android 后是否复现？

在本机 Mac（**与 W2-7 host 同一家庭出口**，mapped 地址与当日 host 一致）用仓库
`node_modules/werift@0.24.4` 手工构造 `TurnProtocol`（`turn-refresh-repro.mjs`）：

- 与 host ICE gather 路径**同参数**：`lifetime=600`（默认）、`transport=udp`、本地临时高位端口
  （OS ephemeral，本次 51952）——即 werift 自带 refresh 循环按 `(5/6)×600=500s` 节奏发 REFRESH，
  与真机客户端同一节奏、同一段 werift 代码路径（`ice/src/turn/protocol.js:341-364`）。
- 凭据运行时从 `~/.p2p-net/` 读取（`POST /functions/v1/turn-credentials`，与 host turnFetcher 同调用），
  access token 临期自动内存刷新；**秘密与公网地址只进原始档（/tmp），入库副本经
  `scrub-results.mjs` 占位符化**（`<VPS_IP>/<HOME_IP>/<TURN_USER>` 等，附秘密原文硬断言）。
- 打点（NDJSON，单调时钟 `performance.now` + 墙钟 UTC ISO 双时间戳）：
  - `send`/`recv`：transport 层每个进出 TURN 报文（进程内地面真值，含 STUN method/class/txid/字节数）；
  - `req`/`req_ok`/`req_err`：`turn.request` 漏斗的请求生命周期（seq、rttMs、响应 LIFETIME、错误码）；
  - `hb`：每 20s 心跳一条——区分「进程冻结/事件循环停摆」与「REFRESH 发出但途中丢失」。
- VPS 侧同窗口 `journalctl -u coturn -f -o short-iso-precise` 实时抓取，按 username/session 关联，
  核对每个 REFRESH 是否到达、被如何处理。跨时钟偏差 ±5s 量级，关联以 session/报文计数为准。
- 主跑 30min（预期 REFRESH ≈ +500/+1000/+1500s），收尾 `REFRESH LIFETIME=0` 注销。
- 补充臂 `nonce-probe.mjs`：字节级验证 438 响应形态（同 5 元组对照 / 新 5 元组 / 新 nonce 重试）。

**werift 重传事实（读码【实测】）**：TURN 请求走 `Transaction`，默认 `1+RETRY_MAX(6)` 次尝试，
`responseTimeout=50ms` 起步指数翻倍（窗口 ≈3.15s）——单包丢失不会杀死一次 REFRESH，
候选②成立需要 ~3s 内连丢 7 包（或路径黑洞）。

## 3. 结果【全部实测】

### 3.1 主跑时间线（客户端 UTC / coturn CST，关联 session=3810）

| 时刻 | 事件 |
|---|---|
| 07:13:08.2Z | ALLOCATE 成功（401→nonce 重试→success，rtt 27ms，lifetime=600）；relayed=`<VPS_IP>`:50014，mapped=`<HOME_IP>`:44715 |
| 15:13:11.6 | coturn `session …3810: new, lifetime=600` |
| +503.4s | **REFRESH#1：7 发 7 应**（err，108B，RTT 10–40ms）→ `TransactionTimeout`（6.4s） |
| 15:21:32–39 | coturn **幽灵 session …3841** 记 7×438（1 Wrong nonce + 6 Stale nonce），rp=7/sp=7 |
| **15:23:13.7** | **session …3810 closed, reason: allocation timeout**（rp=2 rb=160——只见过 ALLOCATE 两条；寿命 602s） |
| +1009.8s | REFRESH#2：同样 7 发 7 应 → `TransactionTimeout`；幽灵 session …3871 收 7×438 |
| +1516.2s | REFRESH#3：同上；幽灵 session …4036 收 7×438 |
| +1803.5s | 收尾 REFRESH(LIFETIME=0)：同上；幽灵 session …7590 收 7×438 |

心跳 20s×全程无缺：**进程没冻、事件循环没堵、werift refresh 循环每次都按期醒了、每次都把包发出去了**
（进程内地面真值 `send` 事件）。allocation 却连一次 REFRESH 都没活到。

### 3.2 决定性证据：五个外部端口（NAT 重映射）

coturn close 行的 `remote` 地址【实测】：

```
session …3810（allocation）   remote <HOME_IP>:44715   reason: allocation timeout
session …3841（REFRESH#1）    remote <HOME_IP>:45939   reason: allocation watchdog determined stale
session …3871（REFRESH#2）    remote <HOME_IP>:45448   同上
session …4036（REFRESH#3）    remote <HOME_IP>:45352   同上
session …7590（收尾）          remote <HOME_IP>:44340   同上
```

**同一客户端 socket（本地 51952）、同一公网 IP、五个不同外部端口**——家庭 NAT 在每次 ~500s
控制面静默后回收 UDP 映射，REFRESH 出方向时拿到**新端口**。coturn 按 5 元组键 session：
allocation 钉死在 44715 上，REFRESH 全部落进新开的「幽灵 session」。

### 3.3 438 响应为何救不回来（nonce-probe 字节级【实测】）

同一份签名 REFRESH（username/realm/nonce/integrity 完全相同）：

| 臂 | 路径 | 结果 |
|---|---|---|
| A 对照 | 原 5 元组（经 `requestWithRetry`） | **success，lifetime=600**（coturn `REFRESH processed, success`） |
| B | 新 socket=新 5 元组（raw） | **438，108B**，属性=`[ERROR-CODE, NONCE(新), REALM, SOFTWARE, FINGERPRINT]`——**无 MESSAGE-INTEGRITY**，带新 nonce |
| C | 新 5 元组 + B 给的新 nonce 重签 | **437 Invalid allocation**（这次带 MESSAGE-INTEGRITY） |

机制钉死（与主跑 debug 日志 `TURN STUN response failed MESSAGE-INTEGRITY check` 互证）：

1. 非 allocation session 上 coturn 的 438 **不签名** → werift `parseMessage(data, integrityKey)`
   对未签名消息返回 `undefined`（`index.mjs:7085`），`handleSTUNMessage` 直接丢弃；
   即使过了这道，`Transaction.responseReceived` 还有 `MESSAGE-INTEGRITY` 存在性门禁——
   **438 与携带的新 nonce 永远到不了 `requestWithRetry` 的 438 重试逻辑**（含 746948b 的修复循环），
   重传 7 次后 `TransactionTimeout`。
2. 就算 438 被接受、换新 nonce 重发：allocation 绑定旧 5 元组，新 5 元组上只有
   **437 Invalid allocation**——**TURN 层自愈在原理上不可能**，只能靠预防（保活防重映射）
   或 ICE 层重建（restart/重新 allocation）。
3. werift refresh 循环失败后**睡满下一个 500s**（`protocol.js:359-361`）——
   剩余 lifetime（<100s）内绝无第二次机会，allocation 必死于 +600s。

### 3.4 三候选裁决

| 候选 | 裁决 | 依据 |
|---|---|---|
| ② UDP 单包丢失 | **排除** | 28/28 条 REFRESH 全部收到服务器响应（每幽灵 session rp=7/sp=7，RTT 10–40ms）；重传机制工作正常 |
| ③ werift REFRESH 链缺陷 | **证实**（机制与预想不同） | 无 Android 的 Mac 上 4/4 次 REFRESH 全部未被 allocation session 处理，allocation +600s 死于 allocation timeout——coturn 侧「REFRESH 缺席」症状 100% 复现。完整链：NAT 静默重映射 → 幽灵 session 438（不签名）→ werift 完整性门禁丢弃 → TransactionTimeout → 睡满 500s → 判死 |
| ① Android 页面冻结 | **非必要条件**（对 W2-7 本身仍未证伪） | 无 Android 仍复现 coturn 侧 REFRESH 缺席+allocation timeout，证明该症状不需要 Android。但 W2-7 当窗**全量零 438**（连幽灵 session 都没有）说明手机的 REFRESH#2 根本没到 coturn——与本案（438 在幽灵 session 上）形态不同，手机腿更指向「未发出/路径黑洞」，需手机侧仪器另判 |

### 3.5 对既有认知的修正

- 候选③的真实缺陷**不是「werift 没发 REFRESH」**——它按时发、发满 7 次；断点在
  「未签名 438 被完整性门禁丢弃 + 失败后睡满整周期」。登记的「host 加 TURN 层 REFRESH 发送日志」
  若只记发送会误诊为网络丢包——必须同记响应/错误（本实验打点即参照系）。
- **Mac host 在家庭 NAT 下不可能让空闲 TURN allocation 活过首个 NAT 映射寿命**（本网约 500s）：
  ICE gather 后不载数据的 allocation 必死于此链。n3 取证里「8643 次 close / 多为 watchdog stale」
  的 churn 与此同源性极高【推断】。
- 数据面活跃的 relay 会话（ChannelData 同 socket 持续流动）NAT 映射不会老化——本实验覆盖的是
  **控制面静默**情形；W2-7 手机腿若先发生数据面停摆（①），同一条链会在 ~1 个映射寿命后接管杀死
  allocation，且 coturn 侧形态与本实验一致（438 落幽灵 session）。
- `turn_438_repair`（746948b）作用于 `requestWithRetry` 层；本链的 438 在更下层（parse/存在性门禁）
  即被丢弃，**修复循环对本链永远不可能触发**——与 W2-7「`turn_438_repair` 事件 0 条」互洽，
  也解释了为何 438 修复后 17min 死法消失而本死法仍在。

## 4. 修复方向（登记，不在本任务实施）

1. **保活防重映射（正修方向）**：TURN socket 周期（≤30–60s）轻量流量（STUN Binding 或
   permission refresh；relay 会话的数据面心跳亦可计入）——让 NAT 映射不过期，从根上消灭幽灵 session。
   对**空闲 gather allocation 同样必要**。
2. **快速失败**：refresh 失败不睡满整周期（剩余 lifetime 内立即重试/升级 ICE restart）；
   werift 对无签名 438 可选择性采信 nonce（安全权衡需评审——即便采信也只会撞上 437，
   价值在于快速检出死亡而非自愈）。
3. **观测**：host 落 TURN 层 REFRESH 发送/响应/失败事件（对齐本实验打点）；
   coturn 侧「allocation timeout + 同 username 幽灵 session 438」可作为告警指纹。

## 5. 产物与复跑

```
results/client-run1.jsonl   主跑客户端 NDJSON（脱敏；send/recv/req/hb 全量）
results/coturn-run1.txt     主跑 coturn journal 实验行（脱敏；3810+4 幽灵 session）
results/client-probe1.jsonl nonce-probe 三臂 NDJSON（脱敏）
results/coturn-probe1.txt   探针窗口 coturn 行（7679 allocation + 7680 幽灵）
```

```bash
# 终端 A（仓库根，需 ~/.p2p-net 已 init+login）：
node e2e/w27-refresh-repro/turn-refresh-repro.mjs --out /tmp/w27-client.jsonl --duration-ms 1800000
# 终端 B（VPS journal 实时抓取，时区 CST；断线不影响——事后可 --since/--until 补抓）：
ssh ubuntu@<VPS> "sudo journalctl -u coturn -f --since now -o short-iso-precise --no-pager" > /tmp/w27-coturn.txt
# 补充臂（秒级，字节级验证 438/437 形态）：
node e2e/w27-refresh-repro/nonce-probe.mjs --out /tmp/w27-probe.jsonl
# 脱敏入库（含秘密原文硬断言）：
node e2e/w27-refresh-repro/scrub-results.mjs --client /tmp/w27-client.jsonl --coturn /tmp/w27-coturn.txt --tag runN
```
