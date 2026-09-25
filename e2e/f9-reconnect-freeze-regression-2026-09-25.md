# F9 真机门禁报告：dc 腿自动重连无声死亡（2026-09-25）

## 事故签名

Android 真机（2409BRN2CC，中国电信蜂窝）在「host 停机 → 手动点重连 → 自动重试」序列中，
watchdog 触发一次后页面**永久冻结**：UI 显示「连接断开，正在重连…」但日志零新增、零网络尝试、
零异常（__f9 空），host 恢复 173s 仍不自愈，仅手动点击/刷新可救。
16:17 现场对照：同一 host、同一 PWA 版本下，新打开的 iPhone 会话（隧道腿）一切正常，
Android 僵尸页「未连接」——证明是客户端运行时状态死亡，与服务/版本无关。

## 根因（双缺陷叠加，纯逻辑洞）

1. **交叠死锁（致死）**：watchdog 在自动重试的 `connect()` 进行中触发 → `cascade.stop()`
   → 在途 connect 抛 `'stopped'` → 旧 catch 无条件静默 return；同时 `onCascadeStatus` 的
   'off' 分支要求 `wasConnected===true`（手动重试进入时已清零、重试成功才回设）→
   两侧都不 `scheduleReconnect`、无待触发定时器 → 循环永久死亡。
2. **inflightSw 泄漏（放大器）**：在途计数只经 dc 腿回帧销账（onDcFrame）——隧道腿
   finish()、req-abort、90s GC 三处均不清 → 陈旧计数（实测 76 条）+ 陈旧活性证据 →
   看门狗在健康重试中途误触发，给缺陷 1 制造交叠窗口。

关键时间线（UTC）：08:01:07 手动点击 → 08:01:32/08:01:59 两轮级联失败（循环健康）→
08:02:06 watchdog 触发（在途 76、静默 61s）→ 冻结。修复前对照：同序列 62s 即死。

## 修复（8155b0e，squash 自 fix/reconnect-watchdog-interlock）

判定下沉可测纯模块，TDD 先红后绿（+8 测试）：

- `reconnectPolicy.onConnectStopped`：superseded/manualStop → 静默（原语义）；
  其余外部中断视同失败，按 onConnectFailure 口径续命自动重连。
- `DataPlaneLiveness.wedged` 增 link 参数：`!isOpen || mode==='tunnel'` 不判死——
  连接进行中没有数据面可黑。
- `shell.ts`：catch 'stopped' 走裁决；90s GC / 隧道 finish / req-abort 三处补
  inflightSw 成对清理。

## 回归序列与结果（Android 真机，新构建 main-DTTeAaWF.js）

| 相位 | 操作 | 断言 | 结果 |
|---|---|---|---|
| 0 | 重载页面（host 健康） | 新构建连接成功 | ✅ tunnel 模式，首屏 11s 就绪，inflightSw=0 |
| 1 | TaskStop host；`__p2pNetConnect()` 手动重连 | 重试循环 180s 不死、watchdog 零误触发 | ✅ 6 轮级联失败（~30s 节拍），watchdogCount=0，gen 1→7 |
| 2 | 重启 host | 零人工干预自愈 | ✅ host start_ready 后下一轮重试即中，gen 9，**升档 p2p 直连** |
| 3 | 自愈后稳态 | 工作台重建、帧流健康、账本对账 | ✅ 首屏 5s 就绪；page sent=50/res=49 ↔ host 账本 req=49/resDone=49 逐字一致；pathType=relay（F8 双侧规则） |

fix C 独立证据：相位 0 的隧道会话（工作台加载+轮询，数十次请求）结束 inflightSw=0——
修复前同等时长隧道会话泄漏至 76。

## 附带发现（超出门禁范围，已登记）

- **host 信令看门狗第三段「退出自愈」在无监管环境下 = 自杀**：本机裸后台任务运行期间，
  Mac 疑似休眠致信令 458s 黑洞（45 连败），watchdog 按设计 exit 1「交由常驻监管重启」——
  但测试环境无 launchd/pm2，进程就此死亡（bash-8r8hp9ss，16:11→16:57）。
  测试基座与独立部署文档都需要补「必须挂在监管器下」这条。
- 全量测试在 live host 运行时有 6 例确定性环境失败（control.test.ts 占端口）+
  每轮约 1 例不同的并发 flaky（signaling-watchdog / host-whitelist，单跑皆绿、与改动零交集）——
  测试隔离问题，登记进机制清单。
