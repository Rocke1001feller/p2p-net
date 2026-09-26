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

a. ~~Android p2p 段 10s 超时根因未定性~~ **已闭环（见 §3.8）**：17:22–17:26 重连风暴双侧取证齐备——offer 去程丢失（×6）+ answer/ICE 回程超时（×1）两形态实证；信令往返预算 vs 蜂窝抖动为根因族。
b. iPhone replaced×2 的链路缺口：05:26:14Z replaced 后 8min 无 session_start（疑 PWA 落隧道腿后 05:34:00Z 重试 WebRTC），replace 语义（offer 到即杀旧 or 新会话成活才杀旧）需读码钉死。
c. 短命 relay 会话 wireBytes 明显小于 appBytes（pair 切换期字节归属碎片化）——计量口径 caveat，勿用于因子估计；因子以 wave1 浸泡/W2-4 为准。

### 3.4 W2-7 真机终验（438 修复）

- 终验臂：06:18:56Z Android 强制 relay（?transport=relay）浸泡，目标 ≥20min。
- 结果【实测】：**跨过 17min 老死亡点**（1016s），但 **+1190s（19分50秒）仍死**（session_end reason=failed）。死法与旧 host 不同：coturn 窗口**零 438**，allocation 于 +1113s 死于「allocation timeout」（= 仅 +497s 完成一次 REFRESH，+997s 的第二次 REFRESH 未到达 coturn，600s 静默判死）；**`turn_438_repair` 事件 0 条**（438 修复循环从未被触发——本次根本不是 438 死法）。
- 未定性：REFRESH#2 缺席原因三候选——Android 页面 ~20min 被冻结（浏览器侧 TURN 客户端停发）/ UDP 单包丢失无重传 / host werift REFRESH 链缺陷。判别实验登记：桌面 werift loopback 复现（排除手机因素）+ host 加 TURN 层 REFRESH 发送日志。
- 附带：06:38:51Z 一条 upgrade fallback 落在垂死会话上（session_end 后 5s），升级轮对濒死会话的触发纪律待查。
- **判别结论（任务D，桌面 werift 复现，全链证据见 `e2e/w27-refresh-repro/README.md`）【全部实测】**：死亡链 = 家庭 NAT 在 ~500s 控制面静默后回收 UDP 映射并**重映射新外部端口**（同一客户端 socket 五个不同外部端口铁证）→ REFRESH 从新端口发出 → coturn 按五元组落「幽灵 session」回 438（**不签名**）→ werift 完整性门禁丢弃无签名 438 → 7 发 7 应全无效 TransactionTimeout → werift 失败后睡满 500s → allocation 死于 +600s。三候选裁决：② UDP 丢包**排除**（28/28 包有响应）；③ werift 链缺陷**证实**（机制如上）；① Android 冻结**非必要条件**（Mac 无 Android 100% 复现 coturn 侧形态），但 W2-7 当窗全量零 438（连幽灵 session 都无）形态不同，手机腿更指向「未发出/路径黑洞」，需手机侧仪器另判。**最重推论：TURN 层自愈原理上不可能**（采信 438 拿新 nonce 重签也只在五元组上撞 437 Invalid allocation）——正修方向只有保活防重映射（≤30–60s 轻量流量，对空闲 gather allocation 同样必要）或 ICE 层重建。`turn_438_repair` 对本链永不可能触发（438 在更下层即被丢弃），与「17min 死法消失而本死法仍在」互洽。

### 3.5 隧道腿僵尸事件（14:0x–14:4x，iPhone 前台四大功能全灭）

用户报告：iPhone Safari 后台转前台，badge「隧道」绿，Chats/Files/Shell/Source Control 全灭。取证链【全部实测】：

1. PWA 侧 fetch `/s/3001/` → **HTTP 502，body = `desktop offline`**（VPS 隧道网关对无腿 deviceId 的固定响应，relay.ts:289）。
2. VPS `ss`：重启前 443 上**无任何来自 Mac 出口的 TCP**（106.37.77.254 / 144.168.58.189 均无）——host 腿在 VPS 侧不存在。
3. host 自报「隧道兜底腿 1/1 在线」、日志 05:59:24Z 重连成功后 46+min 零记录——**半开僵尸：VPS 侧已死，Mac 侧 ESTAB 不自知**。
4. `launchctl kickstart -k` 重启 host → 腿重建（VPS 443 出现 106.37.77.254 连接）→ **iPhone 同一页面（未刷新）复测 HTTP 200**。
5. 代码根因【读码】：`src/tunnel/client.ts` **只有 close 事件驱动重连（指数退避 1→30s），无任何应用层 ping/pong 活性检测**；relay.ts:206 注明 ping/pong 帧纯转发——client 从不发 ping。中间设备（家用 NAT/代理）静默回收会话后，close 事件可迟到数小时（TCP keepalive 默认 2h 量级）→ host 假绿 + 全量隧道客户端 502。今晨 tunnel_reconnect 10–65min 间隔（00:07–05:59Z 共 10 次）= 同一盲区的历史发作记录。
6. 架构事实（纠正直觉）：**PWA 隧道模式数据面 = 逐请求经网关的无状态设计**（session.ts:261 `fetch(${gw}/s/port/path)`），手机侧无持久连接可被 iOS 后台杀死——本次事件与 iPhone 后台**无关**，纯属 host 腿单点。WebRTC 模式（p2p/relay）才有持久 PC 怕后台。

**修复落地（用户已拍板 a+b+c+d，当日完成并部署）**：任务A=client.ts 应用层心跳看门狗（15s `ping()`+连续 2 拍缺席 `terminate()` 交既有退避重连；`HeartbeatOptions` intervalMs/tolerateMisses 可配、计时器可注入；`isAlive`/`onLegDead` 外暴露）；任务B=`tunnelLinks.open` 按 `isAlive` 计数（假绿灯消灭）+ 事件流新增 `tunnel_leg_dead`（sid=relay ip）；任务C/D 见 §3.6。僵尸腿语义变化：从「数小时假绿灯」变为「最坏 ~35s 判死自愈」。

### 3.6 修复落地与部署实录（2026-09-26 下午，swarm 三路并行）

- **合并**：A+B（agent e19273b）→ squash main `577ae79`；C 前台探活（df9d6e6）→ `361d924`；D 判别档案（f89aa07）→ `ab5e705`。合并后全量测试链绿（parallel 504 / serial / parity 68）。
- **任务C 形态**：`pwa/src/foregroundProbe.ts`（`shouldProbeOnForeground` + 状态机 idle→probing→idle/down，去抖防重入）；双触发=`pageshow persisted=true`（bfcache 恢复无论时长必探）∨ `visibilitychange` 后台 >60s（`?probehidden=` 秒可标定）；探活端点=发现端口 `/services`（全模式最轻，4s 超时）；失败→琥珀黄灯「连接待恢复，点我重试」可点击重探；**pong 心跳刷不熄黄灯**（pong 只证明控制面活，杜绝绿色谎言）；8 单测钉死触发条件与状态迁移。
- **部署【实测】**：tarball `rocke1001feller-p2p-net-0.2.1.tgz`（sha256 `9b111d69…`）`npm install -g` → `launchctl kickstart -k gui/501/net.p2p-net.server`（≈16:20 CST）；全局包 dist 内核验 heartbeat/tunnel_leg_dead 代码在包；PWA `pwa-dist` rsync 上 VPS（线上 bundle `main-D4P6vgLn.js` 含黄灯文案）；**复测 `/s/3001/` HTTP 200（0.19s）**——僵尸期同请求为 502 `desktop offline`；`tunnel_leg_dead` 计数 0（健康态不触发，符合预期）；Android 真机会话在重启后自然恢复级联。
- **遗留登记（待拍板立项）**：① W2-7 正修=TURN socket ≤30–60s 保活防 NAT 重映射（对空闲 gather allocation 同样必要）+ 快速失败（refresh 失败不睡满整周期）+ host TURN 层 REFRESH 发送/响应/失败事件（打点参照系=`e2e/w27-refresh-repro`）；② W2-7 手机腿（当窗零 438 形态）需手机侧仪器另判；③ §3.2.2 仪器缺口（隧道腿会话不产生 session 事件）未修。

### 3.7 console-hijack 事件（16:2x–16:4x，部署后双机工作台白屏/卡连接）

用户报告：A/B/C/D 部署后 iPhone Safari + Android 双双不可用——badge 绿但工作台白屏或卡「连接中」，刷新无效，「越迭代越差」。systematic-debugging 四阶段取证，根因**与本次修复无关（非回归），系时间巧合叠加既有架构缺口**：

1. **squatter 实证**：本机 MiMo-Code vite dev server（页面 title=OpenCode，PID 22154，**15:56:12 启动**，监听 :3000）被 scanner 发现（name 取 `<title>`），进入服务清单。
2. **架构缺口**：control `/services` 的 `console` 字段一期恒为 `[]`（占位）；PWA `openWorkbench` 兜底 = 清单**按端口序**首个含 `/s/` 服务 → :3000 恒赢真工作台 :3001。
3. **劫持链**：手机工作台 iframe 加载 OpenCode vite 壳（body ~200B、4 scripts、空白）→ `looksBooted`（devanywhere-ui 标记）永不通过 → 重载 3 次 → 「工作台没能加载出来」sheet。iPhone CDP 实证 iframe `title:"OpenCode"`。
4. **时间巧合**：squatter 15:56 出现；我的部署 16:20 kickstart host → PWA 重连重取清单**才首次踩中**——用户时序上紧贴部署，故误判「越迭代越差」。
5. **排除本次修复**：`tunnel_leg_dead` 零触发（心跳修复无罪）；transient「三种通道均不可达」= 16:26–16:31 三条 relay session_end failed（重启+蜂窝 churn，16:34 自愈），登记 v0.4.x 观察项。

**修复（TDD，squash main `b7f5309`，全量测试绿 518+1+68）**：

- **host 自述**：`config.json` 可选 `consolePort`（1-65535 校验，畸形 fail-closed）；`startDiscovery` 自述 `console=[{url:'/s/<port>/'}]`——**配置了即恒自述**，缺省保持 `[]`（PWA 兜底链接管）。
- **PWA 加固**：新增 `pwa/src/consolePick.ts`——`pickFallbackPort`（last-good 在清单内→粘性复用；否则清单首个 `/s/` 服务）+ localStorage `p2p.lastConsolePort` 读写（全静默容错）；`openWorkbench` 兜底链第③级换为 `pickFallbackPort`；`looksBooted` 通过即写 last-good。双保险：自述压过一切；自述缺席时 last-good 粘性防新 squatter。

**部署与端到端复验【全部实测】**：tarball 重装 + `config.json` 加 `"consolePort":3001`（jq 合并，0600 保持）→ kickstart。本机 `curl 127.0.0.1:19728/services` → `console:[{url:"/s/3001/"}]` ✔；iPhone CDP `__p2pNetDebug()` → connected/tunnel、`consolePort:3001`、iframe `/s/3001/`（真工作台 DOM 91KB）✔；Android 两 tab（旧 bundle 残留仍指向 /s/3000/ OpenCode）**刷新后** → connected/turn、`consolePort:3001`、iframe `/s/3001/`、title `DevAnyWhere` ✔。**教训：PWA 修复类部署后双机必须强刷取新 bundle，后台驻留页不自动更新。**

**切割口径（v0.3.x）**：squatter（MiMo-Code vite）未杀，保留无妨——console 自述已压过它；NAT 重映射正修（W2-7）不在本窗，划 v0.4.x。

### 3.8 Android 重连风暴双侧取证（17:22–17:26，§3.3.a 闭环）

用户回报：Android 实机「漫长反复重连」后稳定中继，体感不如 iPhone 隧道流畅。PWA `#log` DOM（CDP 直读，未灭失）× host events.jsonl/selfcheck 双侧对齐【全部实测】：

1. **风暴形态**：17:23:04–17:26:47 共 **8 次级联失败**（全部 `turn=webrc_timeout_15000`，`?transport=relay` 强制 TURN tab），间隔呈 **1→2→4→8→15s 指数退避**（shell.ts:526，按设计工作，非无退避猛撞）；17:26:52 第 9 次 **3s 成功**后稳定 ≥14min（pulse 回帧持续增长）。
2. **失败双形态**：① 17:23:04 offer 到 host（host 同刻记 `session_end replaced`）但 PWA 15s 超时——answer/ICE **回程**失败；② 其余 ×6 host **无任何记录**——offer **去程**未到 host。同期 host selfcheck signaling 零 alert（host↔Supabase 通畅）→ 瓶颈在 **Android↔Supabase 去程/回程抖动**（cascade_choice rtt 同期 54↔896ms 剧烈波动）。
3. **超时预算边际【读码+实测】**：`CASCADE_TIMEOUT_MS.turn=15s`（pwa/src/constants.ts:33）；成功样本级联耗时 3–12s——17:22:15→27 首连 **12s 已贴近上限**。WiFi 富余、蜂窝抖动期击穿上限。
4. **隧道 vs 中继体感差【方向性】**：iPhone=tunnel（HTTPS 逐请求，TCP 443 一等公民）全程稳；Android=TURN（UDP 承载，蜂窝对 UDP 不友好，与 W2-7 NAT 映射回收同族）。根治归 v0.4.x（TURN 保活 + 快速失败 + 超时预算联动设计），v0.3.0 不动。
5. **仪器改进登记**：relay tab 本次日志未灭失的关键 = `#log` DOM 驻留；plain tab 因 CDP helper urlMatch 前缀撞车（'49.233.155.13/' 同时命中 `?transport=relay`）从未被刷新、日志停在 13:34——helper 已补 last-match 变体（/tmp/p2p-cdp-last.mjs），后续真机操作注意 tab 区分。

## 4. 结论与 cost-model §6.1 回填

用户裁决（2026-09-26 17:4x）：「样本不足」口径定性为 **【实测-本仓 N=16 方向性信号】**——双机双运营商（Android/电信蜂窝 + iPhone/联通蜂窝 × Mac 家宽，nat=endpoint-dependent）足以说明问题，不再做更多时段跑批；更多时段若有新问题归运营商变量，不改变本组合定性。**门禁收口，随 v0.3.0 发布。**

- **直连率矩阵（W2-5 本体）**：本组合自然级联 **0% 直连**（16 会话 100% relay/tunnel），升级直连 0/3——定性方向性信号，不外推其他 NAT 组合。机制解释：endpoint-dependent 映射下打洞原理性低产，与 wave1 门禁 §2.1 勘误互洽。
- **W2-7 werift 438 修复真机终验**：17min 定时死亡形态修复后**零复发**（§3.4）；新死亡链（NAT 重映射→幽灵 session→未签名 438→完整性丢弃）判别归档，正修（≤30–60s 保活防重映射 + 快速失败 + TURN REFRESH 观测）立项 **v0.4.x**。
- **W2-6 暖场升级轮**：3 次升级全部 15s 有界回退（to=fallback），会话不中断——回退机制按设计工作；升级成功率待有直连条件的象限（不阻塞收口）。
- **cost-model §6.1**：隧道 ≈0.94–0.96 元/GB、TURN ≈1.02 元/GB、直连 ≈0（KB 级信令税）【实测-本仓】；隧道与 TURN 同价带，隧道建连快 7.4–12.2×，级联顺序 p2p→tunnel→turn 维持。今日 relay 会话 wire ≈1.5MB（分分钱以下）。
- **v0.3.0 增量清单**：console-hijack 根治（§3.7，host console 自述 + PWA last-good 兜底）+ 本档案收口；遗留立项：① W2-7 正修（v0.4.x）② 仪器缺口——§3.2.2 隧道腿计量【v0.3.1 已闭合，见 §3.9】、§3.8.5 helper 变体【已补 last-match 并投入使用】③ coturn 端口池扩容→判定为**容量议题**（20 并发 allocation 对双机富余、对规模化不够，非稳定性根因——风暴是信令抖动非端口耗尽，coturn 侧无 487/500），挂 v0.4.x 或容量专项，本窗不动。

### 3.9 v0.3.1 增量包（实验徽章 + 隧道计量 + 粘性回迁 + tunnel→p2p 升级）实施与真机验证

**流程**：SDD（计划 `docs/superpowers/plans/2026-09-26-v03x-sticky-tunnel-upgrade.md`）——3 实施者并行（文件集互不相交）→ 3 任务评审 → 2 修复轮 → 终审 → squash `d7cc5e7` → release `2d891af`（v0.3.1）。评审抓到 2 个生产级缺陷并闭环：① **Critical**：实验徽章复位写成「非 connected 即复位」，生产链路（setExperimentMode→connecting 重绘→级联 connecting 帧）两处叠加清零，徽章永不渲染——收窄为 off/failed + 重绘守卫 connected（`924d686` 前）；② **Important**：tunnel-session end 帧按发送时刻 `desk.id` 组房间，双桌切换时错发新桌房间（host A 幽灵 active+1 无自愈）——`activeTunnelSession` 改存 `{sid, room}` 钉死开账房间，双桌用例锁定。

**部署**：`npm pack` 0.3.1 → `install -g` → kickstart（pid 70675）；PWA rsync 49.233.155.13；双机硬刷（SW 注销 + `Page.reload{ignoreCache:true}`）。

**真机验证【全部实测，iPhone=联通蜂窝、Android=电信蜂窝】**：

1. **A 实验徽章**：relay tab 硬刷后徽章 `中继（实验）`（8/9 轮询，1 次瞬时空绘制）；两台 plain tab 诚实显示 `隧道`（自然落点无实验标注）——「实验 tab 与生产落点视觉无区分」的人祸闭环。**教训回填**：relay tab 时间源 09:58 一直在跑**部署前旧 bundle**（SW 控制），`[exp]` 日志行是旧构建已有（514eed8 引入）——「有日志行」不能当「新构建」证据，须查 `performance.timeOrigin`。
2. **B 隧道计量（§3.2.2 仪器缺口闭合）**：host events.jsonl 三连实证——`13:44:20 tun_79143fc9`、`14:04:35 tun_a734c6f6`（iPhone）、`14:07:49 tun_b9a2913a`（Android），全部 `session_start mode:'tunnel' access=cellular-*`；PWA `#log` 同刻 `[tunnel-session] start` 对齐。
3. **C 落点粘性**：iPhone 重连 14:04:09、Android 全新启动 14:07:49，均 **隧道直达**（`[tunnel-session] start` 紧跟 boot/services，无 p2p 段 ~40s 空转——对照 13:43 周期 p2p 尝试 43s 后才落隧道）；`localStorage p2p.lastLinkMode='tunnel'` 双机在盘。
4. **D tunnel→p2p 旁路升级**：iPhone 14:05:20 `[p2pupg] 旁路升级未成（upgrade_wait_timeout）→ 退避待下一拍`——隧道 connected（14:04:10）后 60s 首探、旁路 10s 等候失败静默退避，**隧道服务零中断**（徽章恒隧道、pulse 持续）。旁路未成与本象限 p2p 自然直连 0%（§4）完全一致——nat m:ep-dep 下 p2p 本就不通，看门狗按设计安静退避，不打扰隧道。
5. **双机当前健康态**：iPhone `隧道` connected gen:6；Android `隧道` connected（新 tab 14:07:36 boot）。

**事故与排障登记（helper 层面）**：
- Android plain tab 僵尸：部署前旧 bundle + 后台 tab 导航挂起（`readyState:loading`/`vis:hidden` 卡死，CDP `location.reload` 被节流不触发）——`Page.close` + `am start VIEW` 重开恢复；但 `am start` 意图复用了前台 relay tab（relay 实验 tab 被导航回收，v0.4.x 要用需重开 `?transport=relay`）。
- Android WebView CDP `caches.keys()` 挂起（25s 超时击穿 helper）——强刷流程改为「SW 注销 + `Page.reload{ignoreCache:true}`」两步，绕开 Cache Storage API。
- 教训：后台 tab 的 JS 定时器被节流，`setTimeout(()=>location.reload())` 不可靠；`Page.reload` 是 CDP 协议层，不经页面计时器。

**开放观察项（登记 v0.4.x）**：
- forceTurn × TunnelBackcheck：relay tab 60s 探活成功即触发重级联，但 Q 重解析仍 forceTurn → 落回 turn，呈 ~60-90s 周期级回迁环（host 侧 14:04:14/14:06:13 两条 `session_end replaced` 疑似此形态）。dev-only 路径、生产无感，但 relay 长 soak 会周期重分配——v0.4.x TURN 正修时一并定夺（候选：forceTurn 时禁 arm backcheck）。
- 实验 tab 与生产 tab 共享同源 `localStorage p2p.lastLinkMode`：实验落点会写入生产记忆键。当前无害（'turn' 不改段序、'tunnel' 即生产期望），登记。
