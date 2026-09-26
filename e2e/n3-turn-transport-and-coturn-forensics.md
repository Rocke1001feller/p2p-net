# N3: TURN 单 transport 改造 + coturn 15min 死亡取证

> Wave 1 Task 1（spec D4 改造臂 + spec D3 取证臂）。
> 证据分级：【实测】=直接观测/日志直读；【推断】=间接证据链；【未验证】=本轮无法取得。

## 1. 改造：turn-credentials 默认只发单 UDP

**动机（外部证据）**：v3 三臂实测（n=6）：UDP-only 6/6、TCP-only 5/6、both 2/6=33% ——
凭据同时给 udp+tcp 两条 `turn:` url 是建连成功率毒药。

**改动**：`supabase/functions/turn-credentials/index.ts:41-53` —— 默认每 host 仅发
`turn:<h>:3478?transport=udp` 一条；env `TURN_TRANSPORT=udp|tcp|both` 可选（`both` 为毒药档，
仅供 A/B 复核 v3 的 33% 结论）。2026-09-23 已部署到 project `uchcxfgvdxowpvgqakaq`
（supabase CLI 2.70.3，部署输出 "Deployed Functions on project uchcxfgvdxowpvgqakaq: turn-credentials"）。

### 契约断言（curl 输出，secrets 已脱敏）

改前【实测】（HTTP 200，2026-09-23 ~14:0xZ）：

```
stun:49.233.155.13:3478
turn:49.233.155.13:3478?transport=udp
turn:49.233.155.13:3478?transport=tcp      ← 每 host 两条（udp+tcp）
ttlSeconds: 21600  username/credential: 存在（值略）
```

改后【实测】（HTTP 200，部署后同窗口）：

```
stun:49.233.155.13:3478
turn:49.233.155.13:3478?transport=udp      ← 每 host 仅一条 udp
ttlSeconds: 21600  username/credential: 存在（值略）
```

断言通过：turn 条目从 2 → 1（udp），stun 条目不变，凭据字段结构不变。

## 2. coturn 侧取证：15min 死亡周期对齐

### 2.1 host 侧事件日志（【实测】，替代 coturn 直读）

数据源 `~/.p2p-net/logs/events.jsonl`（host Mac，UTC）。2026-09-23 全天同一会话
（sid `bc0a0566…`，Redmi 蜂窝 → TURN relay）共 72 次 session_end{failed}，
**全部自动恢复、0 次需重新扫码**。

会话寿命（session_start → session_end）直方图：

| 寿命桶 | 次数 | 解读 |
|---|---|---|
| 1–4 min | 31 |  churn 窗口（蜂窝 blackout 簇/连续抖动期） |
| 5–16 min | 20 | 散布 |
| **17 min** | **20** | **众数桶：实测值 1023–1028s，绝大多数 1024–1025s** |
| 19 min | 1 | |

众数桶全量（20 次寿命，秒）：1027 1024 1024 1023 1025 1025 1024 1024 1025 1025
1028 1025 1025 1026 1028 1023 1024 1027 1018 1023 —— **±5s 的精度横跨 10 小时**。

基线报告死亡时刻复核：soak 的 03:47/03:51/04:09/04:26 与 human-live 的 08:15/08:18/08:22
均在 events.jsonl 中逐条对上【实测】。

**关键结论【实测】**：死亡周期不是 "~15min 随机波动"，而是一个 **1024±5s 的决定性定时器**
（蜂窝无线环境不可能给出 ±5s 跨 10h 的稳定性）。注意它与 brief 假设的
"~900s ≈ 1.5×600s(default allocation lifetime)" **不符**：实测众数 1024s ≈ 1.71×600s，
不是 900s 也不是 1200s 的干净倍数。

### 2.2 turnserver.conf 形态（【推断】）

直读 VPS 失败（见 §3），以 repo 声明的期望态 + init 执行记录替代：

- `node-init/init-node.sh` 的 `render_turnserver_conf()` 写入：`listening-port=3478`、
  `external-ip=${PUBLIC_IP}/${PRIVATE_IP}`（**external-ip 已配**，NAT 纪律满足）、
  `min-port=50000 max-port=50019`、`use-auth-secret` + `static-auth-secret`、
  **没有任何 lifetime/max-allocate 相关键** → coturn 默认值生效
  （allocation lifetime 600s、permission 300s、channel 600s、max-allocate-lifetime 3600s）。
- 该脚本幂等整文件覆盖写入；init 日志（`current.jsonl` layer=vps，2026-09-22 11:00–11:26Z）
  记录 "执行 init-node.sh（coturn+caddy+隧道，env 注入密钥）" 与 "重启 p2p-net-tunnel/caddy/coturn"
  与 "验证探针结果" 完成 → 期望态已落机【推断：脚本声明+执行记录，未直读实机】。

### 2.3 死亡机制假说（【推断】）

- 1024s 定时器身份未定：repo 全部常量（LIVENESS 45s、PING 5s、TOKEN_REFRESH 600s、
  DEFAULT_TURN_TTL 3600s、EXPIRY_MARGIN 660s…）无一等于 1024s/980s。
- 候选一：coturn 默认计时器组合（permission 300s + allocation 600s + 建连 ε + 判死 45s ≈ 950–980s，
  与 1024s 差 ~44–74s，对不齐）。
- 候选二：运营商 NAT 对 TURN UDP relay 地址段的会话回收定时器（部分运营商 UDP 会话定时器
  为固定值且复位条件苛刻；soak 遗留 #1 同此方向）。relay 端口 50006 曾被日志实证。
- **判别实验（2026-09-26 已执行，见 §2.5）**：**候选一证实**——死亡时刻 coturn 有
  `error 438: Stale nonce` 洪水且与 host session_end 逐分钟对齐；**候选二排除为主因**
  （仅解释第二类非钟表级死亡，见 §2.5.5）。

### 2.4 本轮未取得（【未验证】）→ 2026-09-26 全部取得

- ~~VPS 直读 `/etc/turnserver.conf` 与 `journalctl -u coturn`~~：2026-09-26 用户提供
  密码后直读成功。实机配置与 §2.2 期望态**逐行一致**【实测】：`listening-port=3478`、
  `external-ip=49.233.155.13/10.2.0.10`、`min-port=50000 max-port=50019`、`use-auth-secret`、
  `realm=p2p-net`、无 lifetime/stale-nonce 键 → 默认值生效（allocation 600s、permission 300s、
  channel 600s、**stale-nonce 600s**）。
- ~~死亡时刻 coturn allocation 日志对齐~~：已完成，见 §2.5。

### 2.5 判别实验落定：1024s 定时器身份 = coturn nonce 过期 + werift 438 单次重试未止血（2026-09-26）

数据源：`journalctl -u coturn`（VPS 直读，CST）× host `events.jsonl`（UTC，已换算）。
sid `bc0a0566…`（Redmi 蜂窝）2026-09-26 全天 232 次累计死亡中的当日部分逐条复核。

#### 2.5.1 438 洪水与死亡逐分钟对齐【实测】

当日 coturn `error 438: Stale nonce` 共 335 条，聚成 9 簇；**9 簇全部各对应一次
host session_end（同一分钟内）**：

| 438 簇起点 | 簇内条数 | host session_end | 上次死亡间隔 |
|---|---|---|---|
| 08:09 | 41 | 08:09:42 | 1036s |
| 08:26 | 41 | 08:26:41 | 1018s |
| 08:43 | 28 | 08:43:37 | 1017s |
| 09:00 | 40 | 09:00:36 | 1019s |
| 09:24 | 40 | 09:24:52 | 1018s |
| 09:41 | 40 | 09:41:49 | 1016s |
| 10:15 | 42 | 10:15:24 | 1025s |
| 10:35 | 30 | 10:35:28 | 1032s |
| 10:52 | 30 | 10:52:26 | 1017s |

当日另有 5 次非钟表死亡（438s/173s/249s/590s/990s 短周期 + failed）无 438 伴随——
属第二类死因（§2.5.5）。**钟表级 17min 死亡 100% 由 438 解释。**

#### 2.5.2 洪水属主 = host 侧 werift（非 Android Chrome）【实测】

438 会话 `000000000000007279` 的 close 行：`remote 106.37.77.254:45043` = **Mac 家庭出口**
（当日 coturn close 行中该 IP 出现 8643 次，手机侧 124.127.65.26 仅 169 次）。
→ 438 恢复失败发生在 **host 的 werift TURN client**，与手机端无关。

#### 2.5.3 会话全生命周期时间线（session 7279，CST）【实测】

```
10:18:37  ALLOCATE success lifetime=600（nonce N1 签发）
10:26:54  REFRESH#1 success（+497s；werift (5/6)×600=500s 节奏）
10:26:58  CHANNEL_BIND success（→ refreshAt = +500s = 10:35:18）
10:28:37  【N1 过期点（stale-nonce 默认 600s），期间无认证报文故无感知】
10:35:14  REFRESH#2 到期（+997s，N1 已死）
10:35:18  438 洪水开始（30 条/14s，与 ChannelBind refreshAt 同时刻、零成功报文）
10:35:28  host session_end{replaced}（PWA 15s pong 饿死看门狗）
10:35:31  新 session_start（2.6s 后自动恢复）
10:36:56  session 7279 closed, reason: allocation timeout（=最后成功 REFRESH+602s）
```

#### 2.5.4 根因链（代码直读 werift 0.24.4 `ice/src/turn/protocol.js`）【实测】

1. **nonce 过期点（600s）必然落在第二次 REFRESH（+1000s）之前**——结构必然，每会话必撞一次 438。
2. **500s 同相刷新**：allocation REFRESH 周期 `(5/6)×600=500s`（:349）与
   `DEFAULT_CHANNEL_REFRESH_TIME = 500`（:17）同相 → 438 时刻 REFRESH 与 ChannelBind 刷新
   **并发在飞**，多请求同时触发 coturn 签发新 nonce。
3. **requestWithRetry 对 438 只重试一次**（:493-524）：并发 438 的 nonce 竞态下单次重试未止血
   【推断：竞态机制细节需 werift DEBUG 日志钉死，host 未开启】；洪水 30 条/14s/零成功为实测结果。
4. **refresh 循环容错 = 死刑**：catch 后仅 log，按原周期再睡 500s（:359-361）——
   而剩余 lifetime（<100s）已不足以活到下次尝试，allocation 必死于 timeout。
5. **数据面即刻死亡**：getChannel 在 refreshAt 到期时主动重绑，失败抛错后 sendData 回落
   Send Indication → getPermission → CreatePermission 同样 438 → 发送路径全断（:525-539），
   无需等 allocation timeout。

死亡周期恒等式【实测+推断】：**会话寿命 ≈ ALLOCATE 延迟(~18s) + 第二次 REFRESH 点(+997s)
+ pong 看门狗(15s) ≈ 1017–1032s**；09-23 的 1024±5s 与今日的差值方向同 liveness 45s→15s
调参一致。

#### 2.5.5 第二类死因（非 438）：蜂窝传输劣化【实测】

11:06:25 死亡（590s 短周期）无 438：死前 40s cascade_choice rttMs 持续 150–240ms
（基线 50–100ms）；**Android 自身 allocation**（remote 124.127.65.26，session 7286）于
11:06:28 以 `allocation timeout` 关闭——其 11:05:28 的 REFRESH 在劣化链路上丢失。
→ 运营商/蜂窝路径质量类死亡真实存在但非众数，与 438 无涉。

#### 2.5.6 06:32–07:32 乒乓风暴【实测】

6–18s 周期 'replaced'，字节指纹两套交替（19516/11971 vs 19477/6139）、
access 在 cellular-other ↔ unknown 交替 → **同 deviceId 两个活客户端互相换绑**
（同浏览器档案双标签页类场景），07:32 后自行消失。属客户端使用形态问题，非网络缺陷。

#### 2.5.7 修复方向（按层级）

1. **正修（代码，p2p-net 侧包裹/补丁 werift）**：438 恢复循环——遇 438 取响应新 nonce
   立即重试直至成功（上限 K 次 + 50–100ms 退避），替代单次重试；REFRESH 失败不应再睡满
   500s，剩余 lifetime 不足时应立即重试。预期效果：14s 洪水 → <1s 自愈，17min 定时器消失。
2. **错峰（代码）**：ChannelBind refreshAt 与 allocation REFRESH 解同相（jitter 或不同常数），
   压缩并发 438 竞态面。
3. **缓解（协议层）**：PWA 侧 pong 饿死触发 **ICE restart 而非整会话重建**（W2-6 升级轮
   已为此类原位修复铺路）。
4. **运维（非修复，仅延后）**：coturn `stale-nonce` 显式调大（如 3600）只把定时器推后，
   不推荐单独使用；端口池 50000–50019（20 端口）扩容决策仍 pending。
5. **观察项**：host 当日 271 次 ALLOCATE / 8643 次 close（多为 watchdog stale）——
   allocation 采集后闲置即弃的churn 值得后续审计（与 ICE gather 频次相关）。

## 3. 待 Task 13 真机复核项

1. 单 UDP 凭据下 TURN 段建连成功率 vs v3 的 both=33%（n≥6，蜂窝真机 forceTurn）。
2. 单 UDP 后 1024s 死亡周期是否变化（transport 收敛与分配路径可能相互影响）。
   → 2026-09-26 复核：周期仍在（1017±8s），机制已定位于 TURN auth 层而非 transport 收敛（§2.5）。
3. ~~（取得 VPS 凭据后）coturn journalctl 判别实验 → 定位 1024s 定时器身份~~
   **✅ 2026-09-26 完成**：定时器身份 = coturn stale-nonce(600s) 在第二次 REFRESH(+997s)
   过期 + werift 438 单次重试未止血（§2.5）。修复选型更新为 §2.5.7 五条
   （首选：438 恢复循环补丁——建议立项 W2-7；原假设"ping 5s→2s 保活"对本根因无效，废止）。
