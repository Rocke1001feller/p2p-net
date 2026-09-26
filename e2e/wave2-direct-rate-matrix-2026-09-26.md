# Wave 2 W2-5 直连率矩阵战役（2026-09-26 起，跨 ≥2 天）

> 计划：`docs/superpowers/plans/2026-09-25-wave2-calibration.md` Task W2-5；spec §6 诚实清单：N<20 象限留白「样本不足」，禁止编造外推。
> 一战三验：① 直连率矩阵（W2-5 本体）② W2-7 werift 438 修复真机终验（会话跨过 17min 不死 + `turn_438_repair{recovered}`）③ W2-6 暖场升级轮 A/B（`upgrade` 事件 to=direct/fallback，门禁四条 #4）。

## 0. 战役基线（部署实录）

| 项 | 值 |
|---|---|
| host 代码 | repo main @ **fdaad57**（含 W2-1/W2-2/W2-6/W2-7 + 双机撞车根修） |
| host 部署 | npm pack tarball shasum `567571fd592ed418bfb74192798b9d11351f4dd1`（版本串仍为 0.2.1，发布窗口才 bump）→ install -g → `launchctl kickstart -k gui/501/net.p2p-net.server`，2026-09-26 13:14 CST 起（`start_ready` 05:14:23Z） |
| PWA 部署 | repo `pwa-dist`（`build:pwa` 产物）rsync → VPS `/opt/p2p-net/pwa/`（`--exclude=config.json`），13:20 CST 首轮 + 13:26 CST 撞车修复轮 |
| host 监管 | launchd `net.p2p-net.server`（KeepAlive=true，非裸后台——17 点事故形态已排除） |
| 测试链 | lint:twins + parallel + serial + parity（68）全绿（fdaad57 时点后重跑全绿） |
| 撞车根修 | fdaad57：bindPhone hostname 常量 → `ensureHostLabel` 每安装稳定标签；iPhone 重绑新 deviceId `bdebf3e7-4596-482f-bf60-3538a8388f2f`（label `p2p-net-pwa-8bad10c0`），Android 保持 `bc0a0566-3f63-450c-a95c-5a27d26933ee` |

客户端标注（localStorage `p2p-net.pwa.access`，CDP 预设）：Android/Redmi = `cellular-ct`，iPhone = `cellular-cu`。

## 1. 矩阵定义（plan W2-5 Step 1 原文）

象限 = {Android/电信蜂窝， iPhone/联通蜂窝} × {Mac/家宽} × {白天(09:00–18:00)/晚间(18:00–24:00)}，共 4 象限；
每象限 N≥20 会话（自然使用，每次 ≥2min 或有真实流量）。
分析：`node scripts/access-matrix.mjs ~/.p2p-net/logs/events.jsonl`（session_start.access × session_end.pathType），nat facts 附列。

## 2. 跑批记录表（每轮打勾：日期/象限/时长/异常）

用户裁决（2026-09-26 14:0x）：第一轮后不再继续矩阵跑批——「一个切面差不多就可以反映所有」。N 计数按 spec §6 诚实清单处理（见 §3.1）。

| # | 日期 | 时段 | 设备 | 时长 | 异常（用户回报） |
|---|---|---|---|---|---|
| R1 | 09-26 | 白天 | iPhone/联通 | ~13:16–13:35（含自动重连） | Safari 一瞬间卡死一次（= 05:34:56Z session_end reason=failed，已取证） |
| R1 | 09-26 | 白天 | Android/电信 | ~13:17 起 | 无 WebRTC 会话——p2p 段 10s 超时 → 隧道腿连接并保持（badge「隧道」） |
| （早间） | 09-26 | 凌晨–上午 | Android/电信 | 00:09–03:06Z | 旧 host（0.2.1）：13 会话全 relay，8 次准点死于 ~1016s（17min 定时器），coturn 438 交叉验证成立 |

## 3. 分析（战役结束后填）

### 3.1 样本计数与诚实声明

- 今日带 access 标注的 WebRTC 会话：Android/电信 ×1（06:18:56Z，W2-7 浸泡臂）+ iPhone/联通 ×3（05:16/05:25/05:34Z）；早间旧 host Android/auto ×13。四象限全部 **N<20 → 「样本不足」，禁止外推**（spec §6 / plan Review Focus #4）。
- 方向性信号（不外推）：本组合（电信/联通蜂窝 × Mac 家宽，nat=endpoint-dependent）自然级联 **0% 直连**（16 会话 100% relay/tunnel），升级直连 0/3——与 wave1 门禁 §2.1 勘误（同组合选中继）及 nat=ep-dep 机制解释一致。

### 3.2 重大发现

1. **双机路径分叉【实测】**：iPhone/Safari → WebRTC 出生即 TURN relay（级联 p2p 段失败后未被隧道截胡）；Android/miui 浏览器 → p2p 段 10s 超时 → **隧道腿**连接并稳定保持。两条腿都是 VPS 中继路径，用户体感均「非常流畅」。
2. **仪器缺口（W2-1 后续增强，已登记）**：隧道腿会话**不产生** session_start/session_end 事件 → access×pathType 矩阵对隧道腿不可见。若用户长期停隧道腿，矩阵样本被系统性低估。需补：隧道腿接入计量事件（access 标注沿 offer 外的通道或隧道握手带上）。
3. **W2-6 升级轮 A/B 首批真机读数【实测】**：3 次升级尝试（iPhone relay 会话）全部 15s 有界回退（to=fallback），0 成功——对称 NAT 下升级本不应成功，**回退机制按设计工作，会话不中断**。升级成功率待有直连条件的象限样本。
4. **iPhone 卡死瞬间取证【实测】**：05:34:56Z session_end reason=failed（ICE failed，app↑177KB），即用户感知的一瞬卡死；iPhone 三个会话均短命（75s/52s/55s，replaced×2 + failed×1），重连快故体感顺滑。replace 链路有缺口（见 §3.3 未决项 b）。
5. **17min 死亡定时器（旧 host）最终档案【实测】**：00:09–03:06Z 连续 13 会话，8 次死亡间隔 1014–1018s（≈16.9min）全部 reason=replaced；coturn 同时段 334 条「438 Stale nonce」，死亡时刻逐一对齐——根因链（stale-nonce 600s → 二次 REFRESH 438 → werift 单次重试未止血 → 黑洞 → PWA 重建）生产环境全链路实证闭环。W2-7 修复的真机终验 = §3.4。
6. **成本读数【实测】**：今日 relay 会话 wire 字节 ≈1.5MB 总量级（分分钱以下）。单价口径（W2-4【实测-本仓】）：隧道 ≈0.94–0.96 元/GB、TURN ≈1.02 元/GB、直连 ≈0（仅 KB 级信令税）。**隧道与 TURN 同价带，隧道建连快 7.4–12.2×，级联顺序 p2p→tunnel→turn 维持正确。**

### 3.3 未决项（登记追查）

a. Android p2p 段 10s 超时根因未定性（offer 是否到 host、answer 是否回、ICE 是否败于 ep-dep——host 分层日志无 WebRTC 层，PWA 侧日志已灭失）；下次复现抓 PWA console + host signaling 双侧。
b. iPhone replaced×2 的链路缺口：05:26:14Z replaced 后 8min 无 session_start（疑 PWA 落隧道腿后 05:34:00Z 重试 WebRTC），replace 语义（offer 到即杀旧 or 新会话成活才杀旧）需读码钉死。
c. 短命 relay 会话 wireBytes 明显小于 appBytes（pair 切换期字节归属碎片化）——计量口径 caveat，勿用于因子估计；因子以 wave1 浸泡/W2-4 为准。

### 3.4 W2-7 真机终验（438 修复）

- 终验臂：06:18:56Z Android 强制 relay（?transport=relay）浸泡，目标 ≥20min。
- 判据：会话跨过 ≈06:36Z（1016s 老死亡点）不死 + events.jsonl 出现 `turn_438_repair{outcome:recovered}` + coturn 同时段 438 簇。
- 结果：观察中（/tmp/w27-soak.log，25min 窗口）。

## 4. 结论与 cost-model §6.1 回填

（待 §3.4 终验与用户对「样本不足」口径的裁决后填：中继率行维持【弱证据】或升【实测-本仓 N=16 方向性信号】，由用户拍板。）
