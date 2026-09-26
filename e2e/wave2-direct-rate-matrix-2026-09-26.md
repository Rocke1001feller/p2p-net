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

| # | 日期 | 时段 | 设备 | 时长 | 异常（用户回报） |
|---|---|---|---|---|---|
| （战役进行中，逐轮登记） | | | | | |

## 3. 分析（战役结束后填）

（access-matrix 输出、Wilson 95% 置信区间、nat 分布、17min 边界跨越统计、upgrade A/B 读数）

## 4. 结论与 cost-model §6.1 回填

（中继率行改【实测-本仓 N=?】，容量方程悲观/中心档影响重算）
