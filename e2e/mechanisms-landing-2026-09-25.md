# 机制落地门禁报告（甲+乙+丙 + 测试隔离）— 2026-09-25

> 门禁纪律：修复+部署+真机/生产确认+测试+证据归档+防复发断言，才算闭环。本报告即归档。

## 一、背景与授权

- 审计呈阅（本会话 24109 行 wire 记录）：三层本质（结构层副本=边界缺口纪念碑 / 知识层教训是被动文档 / 流程层纪律没管住平行语义）；用户批准组合 **甲+丙+乙**，执行顺序：真机回归（此前已全绿）→ 机制落地 → 发布决策。
- 新增入册机制项：shell cwd 纪律、测试隔离、debugging 优先、狗粮纪律。

## 二、合入清单（全部 squash 入 main，分支保留，未推 origin）

| 机制 | 分支 | main 提交 | 内容 |
|---|---|---|---|
| 乙1 | mech/lessons | 5434af4 | docs/superpowers/lessons.md 教训登记簿 7 条 + 计划自审 checklist |
| 甲2 | mech/ports | 6fa7864 | 端口契约单一事实源：STUN_PORT 入约；src/ports.ts 浏览器安全视图直读 ports.json；PWA 删副本改 import；parity 测试回填即红已实证 |
| 甲1+甲3+丙1 | mech/path-parity | 409352c | pathType 孪生消灭（frameLedger 改 import 根包 ./browser）；contracts/path-type-corpus.json 共享语料 25 条；test:parity 进 npm test |
| 丙2 | mech/twin-guard | 48aef2a | scripts/twin-guard.mjs 登记表门禁，test 链第一棒；5 处注释字面量按门禁语义改指契约键名 |
| 测试隔离 | mech/testiso | e988129 | control 工厂可注入端口+测试 listen(0)；watchdog 两例竞争根修（原断言未动）；scanner 注入缝+whitelist 甄别标记 |
| 回填 | — | c448070 / d82322d | lessons.md 条目①②⑦ 🚧→✅ |

并行施工方式：5 子代理各自独立 git worktree + 分支，主会话按 乙→甲2→甲1→丙2→testiso 序合入；冲突仅 package.json test 链与 browser-entry pin，均为加法合并。

## 三、终验（常驻 host PID 69990 运行中）

```
npm test 全链：
  lint:twins      ✓ 未检出已登记孪生模式
  test:parallel   406 测 / 404 过 / 0 败 / 2 跳过
  test:serial     1/1
  test:parity     66/66
```

——本仓首次真绿基线（历史错误基线 385~387 过/6 败 已废止）。

flaky 三根因（对照实验实锤，非猜测）：
1. SeqSignaling 采样竞争（20 跑 2 败 → 修后 30 跑 0 败）
2. recovering 瞬态窗口竞争（HoldSignaling 门控钉住黄灯窗口）
3. 跨进程探测污染（常驻 host scanner 的 lsof 全机探测打进零出站断言；双侧修复后 2s 探测风暴下 10/10 绿）

## 四、部署与生产实证

- `npm run build` + `npm install -g .` + `launchctl kickstart -k gui/$(id -u)/net.p2p-net.server`
- `p2p-net status`：运行中 / 发现服务 4 个 / 隧道兜底腿 1/1 在线 / 信令正常
- events.jsonl 自检心跳（新构建）：3001:4ms ✓ / 5173:3ms ✓ / 9333:17ms ✓ / 57724:3ms ✓；sig.consecutiveFailures=0、authFailures=0、lastPollMs=390

## 五、防复发断言现状

- pathType 语义漂移 → test:parity 红（语料 25 条双端同源）
- pwa/src 孪生复活（srflx/prflx 相等比较、19728/3478 字面量含注释）→ lint:twins 短路 npm test
- 端口契约回填副本 → constants.test.ts parity 红
- 测试绑固定端口 → 常驻 host 下即红（本机即门禁）

## 六、遗留（不阻塞，已登记）

- src/cli/doctor.ts:86 TURN_PORT 字面量、supabase edge fn 与 node-init shell 侧的 3478——跨运行时副本，各自机制另行收敛（mech/ports 报告建议）
- dist/browser.js 的 JSON import attributes 需 Node ≥20.10（engines >=20 的 20.0–20.9 直跑该入口会 SyntaxError；该入口本就只服务浏览器/tsx）
- tunnel.test.ts probe-close-rebind 模式与 ssh.test.ts 外部资源依赖：本轮 4 次全量未观察到失败，若复发优先查这两处
