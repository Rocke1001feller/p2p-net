# p2p-net

**自托管 WebRTC 远程访问数据面：你的 Supabase + 你的 VPS = 5 分钟手机连上电脑。**

手机浏览器打开一个 PWA，扫一下桌面终端里的二维码，就能直接使用你电脑上 localhost 的 dev server——信令走你自己的 Supabase 项目（PostgREST 轮询），媒体/数据走 WebRTC DataChannel 点对点直连；打洞不通时自动级联到你自己的 VPS（coturn TURN 中继 → 反向隧道兜底）。数据面不过任何第三方服务器。

## 三件准备

1. **Supabase Access Token**：supabase.com → 右上角头像 → Account → Access Tokens 生成一枚（init 全程只调 Supabase Management API 纯 HTTPS，不落盘）。
2. **至少一台 Ubuntu VPS**：记下 `user@ip` + 密码。支持 Ubuntu 22.04/24.04 与 Debian 12，init 经 SSH 幂等部署 coturn + caddy + 隧道服务 + PWA 静态站。
3. （可选）**Cloudflare Pages**：Phase 2 的 PWA 托管通道，MVP 阶段不需要——PWA 已由 VPS 上的 caddy 托管。

本机要求 Node.js >= 20；桌面端支持 macOS（launchd）与 Linux（systemd --user）。

## 快速开始

```bash
npx @rocke1001feller/p2p-net init      # 交互式：录入 VPS → Supabase 引导（建表/部署函数/写 secrets）→ 逐台 VPS 编排
npx @rocke1001feller/p2p-net login     # 邮箱+密码登录（init 时创建的首个账号），凭据 0600 落 ~/.p2p-net/auth.json
npx @rocke1001feller/p2p-net start     # 前台启动：端口扫描 + 控制面 + HostAgent + 隧道 + 每台 relay 打印配对 URL 与二维码
```

手机（与电脑不同网也行）扫终端里的二维码 → PWA 打开 → 自动完成配对登录 → 看到本机服务清单 → 点进 5173/3000 等服务即可操作。

确认好用之后装常驻服务（崩溃自愈 + 开机自启）：

```bash
npx @rocke1001feller/p2p-net service install    # macOS → launchd；Linux → systemd --user
npx @rocke1001feller/p2p-net service status     # 查看常驻服务状态
```

## A 类 URL（配对链接）说明

`start` 为每台 relay 打印一张 A 类 URL + 终端二维码，形如：

```
https://<VPS-IP>/connect?t=<ticketId>&d=<deviceId>&u=<接入地址>
```

- 票据**一次性、120 秒过期**，过期自动换新票重打，扫码失败等下一轮即可；
- 该 URL 只含 ticketId/deviceId（扫码载荷，产品设计）；access token、TURN/隧道 secret 等凭据永远不进该 URL、不进日志；
- PWA 拿到票据后调 `redeem-pairing-ticket` 兑换会话，全程无需在手机输入账号密码。

## 安全组端口清单（每台 VPS）

与 `node-init/init-node.sh` 实际渲染的配置一一对应；init 结束时也会原样打印：

| 端口 | 协议 | 用途 |
|---|---|---|
| 22 | tcp | SSH（init 完成后建议收紧为你的办公 IP） |
| 80 | tcp | HTTP（Let's Encrypt 证书签发 + 跳转 HTTPS） |
| 443 | tcp | HTTPS（PWA + 隧道；隧道 relay 仅监听 127.0.0.1:19700，无需放行） |
| 3478 | tcp + udp | TURN/STUN（coturn） |
| 50000-50019 | udp | TURN relay 端口段（coturn min-port/max-port） |

## 安全边界（使用前必读）

- p2p-net 会把**本机 localhost 端口**暴露给「你账号下的手机」：默认白名单 Top10（3000/3001/4200/5000/5173/8000/8080/8081/8888/9000）+ 自动发现判为 website 的监听端口会上架到手机服务清单；NEVER 集合（3003/4173/18080/18088）与本包控制端口（19700/19727/19728/19729）**永不上架**。
- 扫码 URL 含一次性配对票据，120 秒过期；`~/.p2p-net/auth.json`、`config.json`、`init-state.json` 均 0600 保存。
- Supabase Access Token、VPS 密码、TURN/隧道密钥绝不落本地盘（tunnelSecret 例外：写入 0600 的 config.json，是 start 的运行时凭证）。
- 隧道公网入口 `https://<relay>/tunnel/s/<deviceId>` 以 deviceId（uuid，扫码载荷可见）为持链能力凭证，入口本身无额外鉴权；桌面侧白名单是最终闸门——非白名单端口的隧道请求一律 fail-closed 拒绝（HTTP 403 / WS open-err）。

## 部署通道声明

init 全程使用 **Supabase Management API 纯 HTTPS 调用**，不依赖 supabase CLI / npx / Docker；运行期不 spawn 任何外部工具链——唯一例外：端口枚举用 OS 自带的 `lsof`（macOS）/ `ss`（Linux），常驻服务管理用 `launchctl`（macOS）/ `systemctl --user`（Linux）。

## 关于 Supabase 项目的建议

建议为 p2p-net 使用一个**全新的 Supabase project**：init 会在项目里建表（`supabase/ddl/0001_core.sql`）、部署两个 Edge Function（`redeem-pairing-ticket`、`turn-credentials`）、写入 secrets。全部操作幂等（重跑 init 安全），但与既有项目混用前请自行评估表名/函数名冲突。

## 状态与诊断

```bash
npx @rocke1001feller/p2p-net status      # 运行状态：设备 ID / 活跃会话数 / 链路模式（p2p·relay）/ 平均 RTT / 服务数
npx @rocke1001feller/p2p-net doctor      # 八层归因诊断：auth → supabase → signaling → ice → vps → scanner → service → nat
npx @rocke1001feller/p2p-net doctor --json   # 机器可读输出；退出码 = 失败层数
```

日志位置：`~/.p2p-net/logs/`（`current.jsonl` 运行日志、`events.jsonl` 会话事件、`service.log` 常驻服务 stdout/stderr；自动轮转）。常驻服务日志也可以 `npx @rocke1001feller/p2p-net service logs -f` 跟随。

## 配置开关

### 暖场升级轮（W2-6，默认开）
relay（TURN）暖场建连的会话，host 会在暖场稳定后请求 PWA 发起 ICE restart，后台原位升级为直连；
失败自动留在 relay（每会话最多 2 次尝试），不中断既有会话。
- `config.json`：`upgradeWheel: { enabled?: boolean; warmMs?: number; observeMs?: number; maxAttempts?: number }`
  （默认 `{enabled:true, warmMs:10000, observeMs:15000, maxAttempts:2}`）
- 环境变量 `P2P_NET_UPGRADE=0` 强制全关（排障用，压过 config）。
- 观测：`events.jsonl` 的 `upgrade{sid,from,to,ms}` 事件；`node scripts/access-matrix.mjs` 出分桶成功率/回退率。

## 配额说明

信令 = **PostgREST 轮询**（默认 800ms 一次增量轮询）：HostAgent 常驻期间会持续产生 Supabase 读请求，免费额度（Free tier）下请注意用量；长时间不用时建议 `service uninstall` 或 Ctrl+C 停掉前台进程。WebRTC 只在 **PWA 打开时**才建立——合上手机页面即断开，不占 TURN 流量。

## 故障排查

先跑 `npx @rocke1001feller/p2p-net doctor`——八层探针按连接级联同序归因，每层给出人话 detail + 可操作的 fix 建议；常见情形：

- **auth 层失败**：登录态过期 → 重跑 `npx @rocke1001feller/p2p-net login`；
- **vps 层失败**：多为安全组未放行（对照上方端口清单）或 VPS 上 coturn/caddy 异常（`systemctl status coturn caddy p2p-net-tunnel`）；
- **scanner 层服务数不对**：确认你的 dev server 监听的端口在白名单内或能被 HTTP 探测判为 website（2xx + HTML）；
- **常驻服务没起来**：`npx @rocke1001feller/p2p-net service status` 看尾部日志；node 路径若来自 nvm/fnm 等版本管理器，切换默认版本后需重跑 `service install`。

## 卸载

```bash
npx @rocke1001feller/p2p-net service uninstall   # 停并删除常驻服务单元
rm -rf ~/.p2p-net               # 删除本地配置/凭据/日志
# VPS 上（可选）：systemctl disable --now coturn caddy p2p-net-tunnel && rm -rf /opt/p2p-net
```

Supabase 侧项目不再需要时，直接在 supabase.com 控制台删除 project 即可。

## License

[MIT](./LICENSE)
