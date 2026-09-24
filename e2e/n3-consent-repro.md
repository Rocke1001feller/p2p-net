# N3: consent 失效「静默黑洞」复现取证（spec D3 前置）

- 日期：2026-09-23（UTC，脚本 `at` 字段）；本机 loopback 装置，无公网/netem/VPN 依赖
- 脚本：`scripts/consent-expiry-repro.mjs`（逐字移植自 v3 `scripts/werift-consent-expiry-repro.mjs`，275 行，三处适配）
- werift：**0.24.4**（本仓 `node_modules/werift/package.json` 实测，package.json 声明 ^0.24.4）
- 装置：同进程两枚 RTCPeerConnection（A=initiator，B=responder）；唯一变量 = B 侧 `iceFilterStunResponse` 是否丢弃入站 STUN
- 预注册假设 H5：【consent 到期 → ICE 静默丢包 → DataChannel 假健康永久黑洞】

## 因果分级说明

- **【实测-注入】**：本次脚本直接观测到的行为（注入点已知、逐 500ms NDJSON 采样在盘）。
- **【推断】**：由实测数据按协议语义推出的结论，证据形态写明。
- **【假设】**：未在本次装置中验证的外推。

## ① 基线臂（无看门狗，~85s）

Run: `npx tsx scripts/consent-expiry-repro.mjs --out e2e/consent-expiry-baseline.jsonl`

关键输出（原样）：

```
[setup] A↔B connected=connected dcA=open dcB=open
[phase A 结束] A→B：发 99 帧 / 达 99 帧；B→A：发 99 帧 / 达 99 帧
[phase B 开始] responder 丢弃入站 STUN（40000ms）；consent 预期在 ~30s 后到期
[phase B 结束] A.ice.state=failed A.consentFresh=false dcA.readyState=open buffered=41000
             阶段 B 期间：A→B 发 789 帧 / 达 566 帧；B→A 发 789 帧 / 达 584 帧
[phase C 开始] 恢复 STUN 响应（40000ms）；观察是否自愈
[phase C 结束] A.ice.state=failed A.consentFresh=false
             阶段 C 期间：A→B 发 790 帧 / 达 0 帧；B→A 发 1579 帧 / 达 0 帧
[落盘] e2e/consent-expiry-baseline.jsonl（340 拍）
[判定] {"at":"2026-09-23T23:17:45.263Z","watchdog":false,"fieldShape":null,"phaseB_iceState":"failed","phaseB_consentFresh":false,"phaseB_dcOpen":true,"phaseB_aToB_delivered":566,"phaseB_aToB_sent":789,"phaseC_iceState":"failed","phaseC_aToB_delivered":0,"phaseC_aToB_sent":790}
```

### 逐 500ms 采样时间线（A 侧，证据：e2e/consent-expiry-baseline.jsonl 340 拍）

| 时刻（UTC） | 事件 | iceState | consentFresh | aToB | dcA | buffered |
|---|---|---|---|---|---|---|
| 23:16:20.258 | 建连完成 | connected | true | 0 | open | 0 |
| 23:16:25.265 | 进入 B，B 开始丢入站 STUN | connected | true | 99 | open | 0 |
| B+5s…B+25s | 数据照常双向交付（consent 请求无响应，consentSent 1→7，rspRecv 钉 2） | connected | true | 198→592 | open | 0 |
| **23:16:54.298（B+29.0s）** | **consent 到期：iceState→failed、consentFresh→false，aToB 冻结于 665** | **failed** | **false** | **665** | **open** | 0→1600 |
| 23:16:54.798 起 | **A→B 交付永久停滞**（B 剩余 ~11s 与 C 全程 40s 零增长） | failed | false | 665 | open | 1600→21400→39200 |
| 23:17:05.312 | 进入 C，恢复 STUN 响应 | failed | false | 665 | open | — |
| C 末（23:17:45） | 不自愈：C 全程 A→B 达 0 / B→A 达 0 | failed | false | 665 | open | 197800 |

观测要点【实测-注入】：

1. consent 在注入后 **~29.0s** 到期（RFC 7675 名义 30s），到期瞬间 iceState/consentFresh 同时翻转，aToB 同拍冻结——三者同拍（±500ms 采样粒度内）是「consent 到期 ⇒ 交付停」的直接证据。
2. 到期后 `dcA.readyState` 恒为 `open`（C 全程采样集合仅 {open}）——**假健康**：ICE 已 failed，DataChannel 无感知、不触发 onclose/onerror。
3. 到期后 bufferedAmount 单调增长、零排空（B 末 41000 → C 末 197800，即发出不入网、积压在 SCTP 发送缓冲）——黑洞签名。

## ② 现场形状臂（--field-shape，issue #69 签名对照）

Run: `npx tsx scripts/consent-expiry-repro.mjs --field-shape --out e2e/consent-expiry-fieldshape.jsonl`（在黑洞已形成后追加 32MiB/16KiB 帧/256KiB 背压门上传）

```
[phase E 结束] {"payloadTarget":33554432,"payloadSent":81920,"deliveredFrames":0,"bufferedFinal":516920,"wedged":true,"elapsedMs":65106,"iceState":"failed","consentFresh":false}
[判定] {"at":"2026-09-23T23:21:33.958Z",...,"phaseB_iceState":"failed","phaseB_consentFresh":false,"phaseB_dcOpen":true,"phaseB_aToB_delivered":582,"phaseB_aToB_sent":793,"phaseC_iceState":"failed","phaseC_aToB_delivered":0,"phaseC_aToB_sent":790}
```

E 相 A 侧采样：aToB 全程钉 680，buffered 由 278920 单调爬至 515720，dcA 恒 open，iceState 恒 failed。

与 v3 现场（issue #69，2026-09-16 实录，v3 `docs/benchmark/upload-stall-69-2026-09-16.md`）的同签名对照【实测-注入（本侧）/【推断】（与现场同因）：

| 签名 | v3 现场 #69 | 本复现 E 相 |
|---|---|---|
| bufferedAmount 钉死零进展 | ~257KiB 钉死 | 上传在背压门处 wedged（payloadSent 81920/33554432 = 0.24%），deliveredFrames=0；buffered 因背景 ping 持续单调增长至 516920 |
| 交付停 | 上传零进展 | deliveredFrames=0 |
| DC 假 open | 是 | dcA=open 全程 |
| iceState/consentFresh | 现场无观测手段 | failed / false |

## ③ 预注册判定逐项

| 预注册阈值（开跑前固定，见脚本头与 task-7-brief Step 2） | 实测 | 结论 |
|---|---|---|
| B 末 initiator `ice.state==='failed'` | failed（B+29.0s 翻转，B 末保持） | **成立**【实测-注入】 |
| B 末 `consentFresh===false` | false（同拍翻转） | **成立**【实测-注入】 |
| B 末 A→B 交付停止增长 | aToB 冻结于 665，到期后 B 剩余 ~11s 零增长 | **成立**【实测-注入】 |
| B 末 `dcA.readyState==='open'`（假健康） | open（B/C/E 全程） | **成立**【实测-注入】 |
| C 末应用数据仍不恢复（不可自愈） | C 全程 A→B 达 0、B→A 达 0，iceState 恒 failed | **成立**【实测-注入】 |

**总判定：H5 起因链成立【实测-注入】——werift 0.24.4 在本仓复现 consent 到期静默黑洞，且不可自愈。**

### 与预注册措辞的一处如实出入（不改脚本、不改阈值，照实记录）

brief Step 2 的 Expected 行文「阶段 B 末 A→B 交付 ≈ 0（远小于发出）」按整个 B 窗聚合读，与实测（B 窗发 789 / 达 566）**字面不符**；但脚本头预注册的权威判定阈值表述为「A→B 交付**停止增长**」，该阈值**成立**：566 帧全部交付于到期前 ~29s，到期后交付即刻且永久停止。两者不矛盾——consent 名义 30s 才到期，B 窗 40s 内前 ~29s 属正常交付期。脚本聚合打印（`phaseB_aToB_delivered: 566`）是窗口聚合值，逐 500ms 采样（在盘）证明停滞点与 consent 到期同拍。**脚本未做任何修改。**

## ④ 对 Task 8 的含义【推断】

- 看门狗必要性成立：黑洞不自愈（C 相 40s 零恢复），且上层唯一可观测信号是 ICE 层 `consentFresh===false` / `iceState==='failed'`——`dcA.readyState`、`bufferedAmount` 语义均不告警。证据形态：本文件 ① 时间线。
- 看门狗复活路径需触发 ICE restart 类动作（gen 字段在盘可查：到期后 `gen` 未自增，werift 不会自行重启）。证据形态：baseline.jsonl `gen` 字段全程不变【实测-注入】；restart 能复活为**【假设】**，Task 8 验证臂实测。
- E 相证明：对已黑洞通道的大上传，背压门只能发现「发不出去」，无法区分 consent 黑洞与其他 wedge——需要 ICE 层信号做归因【推断】。

## 产物

- `scripts/consent-expiry-repro.mjs`（逐字移植，275 行）
- `e2e/consent-expiry-baseline.jsonl`（340 拍）
- `e2e/consent-expiry-fieldshape.jsonl`（590 拍）
- 本报告

## ⑤ 验证臂（--watchdog，Task 8 看门狗兜底生效【实测-注入】）

同一脚本挂 `--watchdog`（动态 import `src/consent-watchdog.js`，interval 3000ms，生产默认值）复跑三阶段：

```
[watchdog] 已挂（interval 3000ms）
[phase A 结束] A→B：发 98 帧 / 达 98 帧；B→A：发 98 帧 / 达 98 帧
[phase B 开始] responder 丢弃入站 STUN（40000ms）
[watchdog] revive 第 1 次（iceState=failed consentFresh=false）
[phase B 结束] A.ice.state=connected A.consentFresh=true dcA.readyState=open buffered=0
[phase C 结束] A.ice.state=connected A.consentFresh=true
[判定] {"watchdog":true,"phaseB_iceState":"connected","phaseB_consentFresh":true,
        "phaseB_dcOpen":true,"phaseB_aToB_delivered":789,"phaseB_aToB_sent":789,
        "phaseC_iceState":"connected","phaseC_aToB_delivered":786,"phaseC_aToB_sent":786}
```

### 与基线臂对照

| 指标（A→B） | 基线臂（无看门狗） | 验证臂（看门狗） |
|---|---|---|
| B 相末 iceState / consentFresh | failed / false | **connected / true** |
| B 相交付 | 冻结 665（注入后 29s 起零增长） | **789/789（100% 交付）** |
| C 相交付 | 0（不可自愈） | **786/786** |
| dcA.readyState | open（假健康） | open（真健康：buffered=0） |
| 用户体感 | 永久黑洞 | 一次 ~3s 抖动（revive 第 1 次即拉回） |

预注册判定（Task 8 brief Step 7）：① B 相出现 `revive 第 1 次` ✓；② B/C 相 A→B 交付恢复增长 ✓；③ `phaseC_aToB_delivered` 显著大于 0（786 vs 基线 ≈0）✓——三项全成立【实测-注入】（2026-09-24 本仓 loopback，产物 `e2e/consent-expiry-watchdog.jsonl` 340 拍）。

注：复活语义 = 就地 `setState('connected')` + `queryConsent()`（v3 实测：ICE restart 路径只 stop 不 start，不重开同意循环）。真机「无固定周期回收」终判归 Task 13。
