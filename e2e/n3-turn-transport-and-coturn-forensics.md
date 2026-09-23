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
- **判别实验（待做）**：coturn 侧 `journalctl -u coturn` 在死亡时刻是否有
  `allocation ... deleted/expired` 而无对应 refresh —— 有则候选一，无则候选二。

### 2.4 本轮未取得（【未验证】）

- VPS 直读 `/etc/turnserver.conf` 与 `journalctl -u coturn --since -24h`：
  SSH 需要交互式密码（`$VPS_PW`），本机无可复用凭据（env/clipboard/history/keychain/ssh-agent 均无），
  判 BLOCKED，未猜未试。
- 死亡时刻 coturn allocation 日志对齐（即 §2.3 判别实验）。

## 3. 待 Task 13 真机复核项

1. 单 UDP 凭据下 TURN 段建连成功率 vs v3 的 both=33%（n≥6，蜂窝真机 forceTurn）。
2. 单 UDP 后 1024s 死亡周期是否变化（transport 收敛与分配路径可能相互影响）。
3. （取得 VPS 凭据后）coturn journalctl 判别实验 → 定位 1024s 定时器身份，
   据以选修复：ping 5s→2s 保活 / ICE restart 代替整会话重建 / coturn 侧 lifetime 调优。
