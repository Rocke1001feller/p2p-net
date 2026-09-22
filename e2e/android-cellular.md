# E2E 真机验收手册：Android 蜂窝网络 ↔ 桌面 p2p-net

> 用途：v0.1.0 发布前的真机端到端验收。全程手动，逐项打勾。
> 方法学事实源：老仓 POC harness（`poc/webrtc-pwa/{README.md,server.js,results.log}`）——
> 2026-09-05/09-17 已在「蜂窝（对称 NAT）↔ coturn relay」拓扑实证 DataChannel 全链路
> （connect ~8-12s、入口 HTML ~700ms、2.7MB bundle 10-20s、relayAddr 落在 VPS 50000+ 端口段）。
> 本手册把同一验收动作迁移到 p2p-net 正式 CLI。POC 期的坑（ICE 竞态、信令残留、sid 竞态、
> 多 host 抢答）已在 p2p-net 工程化修掉（信令房间隔离 + 120s TTL + sid 守卫 + 最新会话优先），
> 本手册只验收，不再复现这些坑。

---

## 0. 前置条件

- [ ] Android 真机：已开 USB debugging，`adb devices` 能看到设备（`device` 状态，非 `unauthorized`）
- [ ] 手机**关掉 WiFi**，纯蜂窝上网（状态栏无 WiFi 图标；`adb shell ip addr` 不应有 wlan0 的 inet 地址）
- [ ] 桌面机：macOS 或 Linux，Node.js >= 20（`node -v` 确认）
- [ ] 一枚 **Supabase Access Token**（建议配一个全新 Supabase 项目做测试）
- [ ] 一台测试 VPS（Ubuntu 22.04/24.04 或 Debian 12），`user@ip` + 密码，安全组已按 README 清单放行
  （22/tcp、80/tcp、443/tcp、3478 tcp+udp、50000-50019/udp）
- [ ] 桌面机上一个真实 dev server 当靶子，例如 Vite 项目跑在 5173，或：
  ```bash
  mkdir -p /tmp/p2p-net-target && echo '<h1>P2P OK</h1>' > /tmp/p2p-net-target/index.html
  (cd /tmp/p2p-net-target && python3 -m http.server 5173)
  ```

## 1. 安装（干净机 / 干净账号）

- [ ] 安装本包（二选一）：
  ```bash
  npm i -g p2p-net@0.1.0        # 发布后的正式通道
  # 或发布前本地验收：
  cd <本仓库> && npm run build && npm link
  ```
- [ ] `p2p-net --help` 打印命令清单（init/login/start/service/status/doctor），退出码 0
- [ ] 确认干净：`ls ~/.p2p-net` 应为「不存在」；存在则先备份后 `rm -rf ~/.p2p-net`

## 2. init：Supabase 引导 + VPS 编排

```bash
p2p-net init
```

按提示逐项录入（密码/token 均不回显）：

- [ ] `VPS #1: ` 输入 `root@<VPS-IP> <密码>`，再空行结束
- [ ] `Supabase Access Token: ` 粘贴 token
- [ ] `projectRef` 留空（自动新建）→ `region` 留空（默认 ap-southeast-1）
- [ ] 录入首个账号邮箱 + 密码（这就是手机端登录用的账号，也是 `p2p-net login` 的账号）

预期结果（逐项勾）：

- [ ] Supabase 阶段全绿：项目创建/复用 → DDL 建表 → 两个 Edge Function（redeem-pairing-ticket、turn-credentials）部署 → secrets 写入
- [ ] VPS 阶段全绿：SSH 连通 → coturn/caddy/node 安装 → 配置落盘 → 三个服务 active
- [ ] 末尾打印 `p2p-net init 完成。` + `Supabase: https://<ref>.supabase.co` + `PWA: https://<VPS-IP>` + 安全组清单
- [ ] `~/.p2p-net/config.json` 存在且权限 0600（`stat -f '%Lp' ~/.p2p-net/config.json` → `600`）

中途失败怎么办：按报错文末的安全组清单复核后**直接重跑 `p2p-net init`**——幂等续跑，密钥会重新生成并全量重推。

## 3. login + start

```bash
p2p-net login        # 输 init 时创建的邮箱/密码 → 预期「登录成功：<email>（凭据已 0600 保存…）」
p2p-net start        # 前台常驻；本手册期间保持这个终端开着
```

预期输出（逐项勾）：

- [ ] 首行提示 `未安装常驻服务：p2p-net service install 可后台常驻（当前前台运行，Ctrl+C 退出）`
- [ ] 每台 relay 打印：`Relay <VPS-IP> 配对链接（120s 有效，过期自动换新票）：` + `https://<VPS-IP>/connect?t=…&d=…&u=…` + 终端二维码
- [ ] 末尾 `p2p-net 已启动（前台模式）：控制面 http://127.0.0.1:19727/status，发现端点 http://127.0.0.1:19728/services`
- [ ] 另开终端 `curl -s http://127.0.0.1:19728/services` 返回 JSON，里面能看到 5173 靶子服务

## 4. 手机扫码 → PWA → 服务操作

- [ ] 手机相机（或扫码器）扫终端二维码 → 打开 `https://<VPS-IP>/connect?…`
  （也可以 `adb shell am start -a android.intent.action.VIEW -d '<完整配对URL>'`）
- [ ] PWA 打开后**自动完成配对登录**（无需输账号密码），进入服务清单页
- [ ] 清单里能看到桌面的 5173（及其他白名单端口）服务
- [ ] 点进 5173 服务：iframe 打开靶子页面，显示 `P2P OK`（或你的真实 dev server 页面）
- [ ] 页面可操作：点击链接/刷新均正常；Android 返回键行为正常

> 票据只有 120 秒：扫码慢了会自动换新票重打，扫**最新**那张即可。旧票据兑换会失败，属预期。

## 5. 验收点（逐条勾）

- [ ] **级联路径可见**：PWA 连接状态灯落定在 `p2p` / `relay` / `tunnel` 三者之一
  （蜂窝对称 NAT 下 POC 实证多数落 `relay`；落哪个都算过，但必须明确显示其一）
- [ ] **iframe 服务可用**：5173 页面完整渲染、可交互（对照 POC Step1 标准：文本/子资源/大图/POST 穿透）
- [ ] **status 显示活跃会话**：桌面另开终端 `p2p-net status`，预期形如：
  ```
  p2p-net 运行中（foreground 模式），已运行 X 分 X 秒
  设备：<deviceId>
  活跃会话：1（relay 1），平均 RTT XXX ms     ← 模式以实际级联为准
  发现服务：N 个
  ```
- [ ] **事件流有记录**：`tail -20 ~/.p2p-net/logs/events.jsonl`，按时间序应见：
  - `{"name":"session_start","sid":…}`
  - `{"name":"cascade_choice","sid":…,"mode":"p2p"|"relay","rttMs":…}`（与状态灯一致）
  - 关掉手机页面后：`{"name":"session_end","sid":…,"reason":"closed"}`
- [ ] **token/secret 卫生**：`grep -r 'access_token\|TURN_STATIC' ~/.p2p-net/logs/ | wc -l` → 0；终端输出里也不应出现

## 6. 故障注入复核

### 6a. 纯蜂窝（本手册全程已在做）

- [ ] 再次确认手机 WiFi 关闭；如中途开过，关掉后**刷新 PWA** 重连一次，级联应自动重建

### 6b. kill 桌面服务进程 → 观察自愈

- [ ] 先停掉 §3 的前台 start（其终端里 Ctrl+C），避免与常驻服务争 19727/19728 端口
- [ ] 装常驻服务：`p2p-net service install`（预期打印 unit 路径 + 日志路径）
- [ ] `p2p-net service status` → 「常驻服务已安装：运行中」
- [ ] 杀掉服务进程：`pkill -f 'bin\.js start'`
- [ ] 等约 5-10 秒（systemd RestartSec=3；launchd KeepAlive 立即重拉），再 `p2p-net service status` → 仍「运行中」
- [ ] 手机刷新 PWA，无需重新扫码即可重连（登录态在手机侧持久化）
- [ ] `p2p-net service logs` 尾部能看到新一轮 `start_ready`

### 6c. 停掉 VPS coturn → doctor 归因

- [ ] VPS 上 `systemctl stop coturn`
- [ ] 手机刷新 PWA：打洞/relay 均不可用时应级联到 tunnel（状态灯落 `tunnel`，iframe 仍可用——反向隧道兜底；
      若运营商 NAT 意外打穿 p2p 也算过，判据是 iframe 可用 + 状态灯明确落其一）
- [ ] 桌面跑 `p2p-net doctor`：**`ice` 层必败**（detail：`3478/tcp 不可达：<ip>`，fix 提示
      `systemctl status coturn` 并复查安全组 3478 tcp+udp 与 50000-50019/udp）；
      注意 `vps` 层此时应仍是绿的——vps 探针查的是 caddy 证书与隧道服务，不查 coturn，绿≠误报
- [ ] **退出码 = 失败层数**（`echo $?`，此时 ≥ 1）
- [ ] 恢复：VPS 上 `systemctl start coturn`，重跑 `p2p-net doctor` 应全绿（退出码 0）

## 7. 结果记录（填写存档）

| 项 | 实测值 |
|---|---|
| 日期 / 执行人 | |
| 手机型号 / 运营商 / 网络（4G/5G） | |
| 桌面平台（macOS/Linux + 版本） | |
| VPS 厂商 / 地域 | |
| 级联落点（p2p / relay / tunnel） | |
| 配对到 connected 耗时（秒） | |
| 5173 首屏加载耗时（秒） | |
| `p2p-net status` 平均 RTT（ms） | |
| events.jsonl 事件链完整（start→choice→end） | ☐ |
| 6b 自愈通过 | ☐ |
| 6c doctor 归因正确（ice 层失败 + fix 指向 coturn/安全组） | ☐ |
| 结论（PASS / FAIL + 备注） | |

> 参考基线（POC 2026-09-17，蜂窝 relay）：connect 8-12s、入口 HTML ~0.7s、2.7MB bundle 10-20s。
> 显著劣于基线（如 connect > 30s）请附 `~/.p2p-net/logs/current.jsonl` 相关时段开 issue。

## 8. 收尾

```bash
p2p-net service uninstall   # 卸常驻服务
rm -rf ~/.p2p-net           # 清本地（可选）
# VPS 可选清理：systemctl disable --now coturn caddy p2p-net-tunnel && rm -rf /opt/p2p-net
```
