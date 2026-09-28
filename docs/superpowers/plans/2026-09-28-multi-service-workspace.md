# P1 多服务工作台 UI 改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 PWA 从「单服务直载」改造为「账号→设备(group)→服务(tab)」的多服务工作台：设备页=启动台，工作台=侧栏树+沉浸式，服务自动发现全部可见、用户只能做减法（隐藏/可恢复）。

**Architecture:** 全部改动在 `pwa/`（shell + ui + index.html + 两个新纯模块）。隐藏清单与上次选中按 deviceId 分键持久化在 localStorage；端口裁决链拆半——console 自述只产出「默认选中」，全量服务进侧栏树；iframe 池（`tabs: Map<port, TabEntry>`）原样复用，切换=显隐不重建。

**Tech Stack:** TypeScript / Vite PWA / node:test + tsx（无 jsdom，用 `pwa/src/shell.test-harness.ts`）。

**Spec:** `docs/superpowers/specs/2026-09-28-multi-service-workspace-design.md`（executor 必读；原型 `docs/prototypes/product-model-v2.html` 是 UI 视觉参照）

## Global Constraints

- 默认落地页 = **设备页**（启动台），不是工作台（spec §2.6，2026-09-28 用户裁决）。现有 `boot()` 已落在设备页（shell.ts:1123），**不得改动**；`afterConnected()` 连接成功后仍进工作台并打开默认选中服务（console 锚定降级后的「默认首页服务」语义，spec §2.4）。
- **console 服务不可隐藏**：侧栏树里 console 行不渲染 ✕；存储里即使混入 console 端口也必须无视（spec §4.1 裁决）。
- 服务从清单消失（进程死了）：iframe 保留 + 服务行灰显「已离线」，**不自动隐藏**（spec §4.3）。
- 用户唯一减法操作是「隐藏」，可恢复；无「手动添加服务」入口（spec §2.2）。
- 通道变化（隧道↔P2P 升降级）不打破沉浸；W-B①（重连探活不重建，`afterConnected` shell.ts:811-823）与 W-B②（iframe 内位置记忆）行为不得回归（spec §4.4）。
- `?svc=<port>` 验收钩子保留，语义不变：直开指定服务、跳过默认选中（shell.ts:909-914 现有逻辑原样保留）。
- `__p2pNetDebug().services` 保留（shell.ts:1336）。
- 不改扫描器判定规则、不改级联/通道逻辑、不动多设备连接管理（spec §3 非目标）。
- 存储风格沿用 consolePick.ts 的注入式 `PickStorage` + try/catch 静默（隐私模式写不进不炸）。
- 不 bump 版本号、不发布 npm、不部署 VPS——本计划只到「全量测试绿 + `npm run build:pwa` 成功」；真机门禁清单列出但由用户执行。

## Review Focus

1. **存储里混入 console 端口的隐藏记录**（旧版本/手工写脏）：console 服务必须仍显示且不可隐藏——合理的用户预期是「主页永远在那」。测试钉在 Task 4（`buildServiceTree` 的 hidden 含 consolePort 时该行仍 `isHidden:false`）。
2. **默认选中链命中已隐藏服务**（lastService 指向的端口恰被用户隐藏）：必须跳过，落空→引导页，而不是打开一个用户明确隐藏了的服务。测试钉在 Task 3。
3. **未连接设备的启动台卡片没有服务清单**（服务清单只在连接后存在）：卡片只显示连接入口，不渲染空网格、不报错。测试钉在 Task 6。
4. **沉浸中发生通道升级/降级事件**：沉浸状态必须保持（spec §4.2），badge 变化不应触到任何显隐逻辑。测试钉在 Task 5。
5. **`?svc=` 直开时不写 lastService**：验收钩子不应污染「上次选中」记忆，否则下次默认选中会被测试端口粘性劫持。测试钉在 Task 3。

---

### Task 1: 隐藏服务存储模块 hiddenServices.ts

**Files:**
- Create: `pwa/src/hiddenServices.ts`
- Modify: `pwa/src/constants.ts:23`（在 `LS_DEVICES` 后追加两个键）
- Test: `pwa/src/hiddenServices.test.ts`

**Interfaces:**
- Consumes: `PickStorage` 类型（`pwa/src/consolePick.ts:20-23`，`import type { PickStorage } from './consolePick.js'`）
- Produces:
  ```ts
  export function readHidden(storage: PickStorage, deviceId: string): number[]
  export function hideService(storage: PickStorage, deviceId: string, port: number): void
  export function unhideService(storage: PickStorage, deviceId: string, port: number): void
  ```
  持久化键 `LS_HIDDEN_SERVICES`（constants.ts 新增 `export const LS_HIDDEN_SERVICES = 'p2p-net.pwa.hiddenServices'`），值形态 `Record<deviceId, number[]>`（spec §4.1 示例写的是字符串数组；实现统一存 number，读取时容忍字符串强制转换——防御脏数据）。

- [ ] **Step 1: 写失败测试**

```ts
// pwa/src/hiddenServices.test.ts — node:test 风格同 consolePick.test.ts
test('readHidden: 空存储返回 []', ...)
test('hide→read 往返；按 deviceId 隔离（A 机隐藏不影响 B 机）', ...)
test('hide 幂等（重复隐藏不重复记录）；unhide 只删目标端口', ...)
test('脏数据防御：JSON 损坏 / 值不是数组 / 元素是字符串数字 → 强制转换或丢弃，不抛', ...)
test('storage 抛错（隐私模式）→ readHidden 返回 []，hide/unhide 静默', ...)
```
存储用内存 stub `{ getItem, setItem }`（同 consolePick.test.ts 现有写法）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test pwa/src/hiddenServices.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `pwa/src/hiddenServices.ts`**

三个函数 + 内部 `readMap/writeMap`；全部 try/catch 静默，注释一行说明「隐私模式写不进不炸，沿用 consolePick 风格」。constants.ts 追加 `LS_HIDDEN_SERVICES`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test pwa/src/hiddenServices.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pwa/src/hiddenServices.ts pwa/src/hiddenServices.test.ts pwa/src/constants.ts
git commit -m "feat(pwa): per-device hidden services storage"
```

### Task 2: per-device lastService（consolePick 扩展）

**Files:**
- Modify: `pwa/src/consolePick.ts`（文件末尾追加）
- Modify: `pwa/src/constants.ts`（追加 `LS_LAST_SERVICE`）
- Test: `pwa/src/consolePick.test.ts`（追加测试）

**Interfaces:**
- Consumes: Task 1 的 `PickStorage`（本文件自有定义，直接用）
- Produces:
  ```ts
  export function readLastService(storage: PickStorage, deviceId: string): number | null
  export function writeLastService(storage: PickStorage, deviceId: string, port: number): void
  ```
  键 `LS_LAST_SERVICE = 'p2p-net.pwa.lastService'`，值 `Record<deviceId, number>`（spec §4.1「复用 last-good 通道，扩展为 per-device」；旧键 `p2p.lastConsolePort` 不动，平滑共存）。

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 pwa/src/consolePick.test.ts
test('readLastService/writeLastService: 往返；per-device 隔离', ...)
test('readLastService: 无记录 / 脏 JSON / 非正整数 → null', ...)
test('storage 抛错 → null / 静默', ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test pwa/src/consolePick.test.ts`
Expected: FAIL（函数未导出）

- [ ] **Step 3: 实现**

consolePick.ts 末尾追加两函数 + constants.ts 追加键。`readLastService` 校验 `Number.isInteger(n) && n > 0`（对齐 `readLastGoodPort` 现有校验）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test pwa/src/consolePick.test.ts`
Expected: PASS（含既有测试不回归）

- [ ] **Step 5: Commit**

```bash
git add pwa/src/consolePick.ts pwa/src/consolePick.test.ts pwa/src/constants.ts
git commit -m "feat(pwa): per-device lastService memory"
```

### Task 3: openWorkbench 默认选中链重构 + 引导页

**Files:**
- Modify: `pwa/src/shell.ts:889-917`（openWorkbench 重写）、`pwa/src/shell.ts:919-938`（openService 内写 lastService）
- Modify: `pwa/index.html`（`#screen-workspace` 内加 `#svcGuide` 引导页元素，默认 `display:none`）
- Test: `pwa/src/shell-default-service.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `readHidden`；Task 2 `readLastService` / `writeLastService`；consolePick 既有 `pickFallbackPort` 不再被 openWorkbench 调用（函数保留，其它引用不动）。
- Produces（后续任务依赖的 shell 内部状态与缝）:
  - `selectedPort: number | null`（模块级，当前选中服务端口；`__p2pNetDebug()` 增加 `selectedPort` 字段）
  - `#svcGuide` 引导页元素：默认选中落空时显示，文案按场景三选一——`empty`「未发现服务」/ `no-selection`「☰ 从侧栏挑一个服务」/ `all-hidden`「已全部隐藏」（恢复入口在 Task 4 侧栏里，此处只出文案）；显示时隐藏 `#appHost` 内所有 iframe，不弹 offlineSheet（spec §4.3/§4.5）。
  - openService 成功显隐后写 `writeLastService(localStorage, desk.id, port)`（`desk` 是模块级 const，shell.ts:133）；`?svc=` 直开路径**不写**（Review Focus 5）。

- [ ] **Step 1: 写失败测试**（沿用 shell-sticky.test.ts 的 setup 模式：`installShellHarness({search, services})` → `await import('./shell.js')` → `waitFor __p2pNetConnect` → `installFakeRtc({autoOpen:true})` → 驱动连接）

```ts
// pwa/src/shell-default-service.test.ts
test('console 自述在清单内 → 默认选中 console 端口（无视它在清单中的位置）', ...)
test('无 console 自述 → 选中 lastService（仍在清单且未被隐藏）', ...)
test('lastService 已被用户隐藏 → 不选中它，落空进引导页（Review Focus 2）', ...)
test('无 console 无 lastService → 引导页 no-selection，不盲选清单首个', ...)
test('console 自述端口已死（不在清单）→ 引导页，不 hijack 到其它服务（spec §4.5）', ...)
test('?svc=3001 直开 → 打开 3001 且 lastService 不被写入（Review Focus 5）', ...)
test('默认选中打开后 → lastService 已写入该端口', ...)
```
断言缝：`__p2pNetDebug().selectedPort`、`h.el('svcGuide')` 的 style.display / textContent（FakeEl 支持 style 与 textContent，引导页文案 id 加进 `observeTextIds`）、harness localStorage 直查 `p2p-net.pwa.lastService`。隐藏态通过预先 `hideService(h.localStorage, deskId, port)` 注入。deskId：harness 默认身份里 desk.id 是 `'desk-smoke'`（shell.ts:289，或连接时传入的 id，以 shell-sticky.test.ts 实际用法为准）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test pwa/src/shell-default-service.test.ts`
Expected: FAIL（selectedPort / svcGuide 不存在）

- [ ] **Step 3: 实现**

openWorkbench 重写为：解析 console 自述端口 → 否则 `'p2p-net'` 命名服务 → 否则 `readLastService` 在「清单 − hidden − 非 console 豁免」内 → 否则 null。console 端口即使在 hidden 列表也照常可选（Review Focus 1 的选中侧）。null → `showGuide(...)` 返回；非 null → `consolePort = <该端口>`（保留全局赋值，`scheduleHealthChecks` 等旧逻辑不炸）→ `await openService(port)`。`?svc=` 块原样保留但跳过 lastService 写入。openService 尾部（非 svcQ 路径）写 lastService + 赋 `selectedPort`。index.html 加 `#svcGuide`。空清单 → `showGuide('empty')`（替换原「桌面未自述工作台端口」offlineSheet，spec §4.3「不弹 sheet」）。

- [ ] **Step 4: 跑测试确认通过 + 既有 shell 测试不回归**

Run: `npx tsx --test pwa/src/shell-default-service.test.ts pwa/src/shell.test.ts pwa/src/shell-sticky.test.ts pwa/src/shell-reconnect-probe.test.ts`
Expected: PASS（注意：既有测试若断言旧「清单首个盲选」或旧 offlineSheet 文案，按新语义更新该断言并在 commit message 说明）

- [ ] **Step 5: Commit**

```bash
git add pwa/src/shell.ts pwa/index.html pwa/src/shell-default-service.test.ts
git commit -m "feat(pwa): default-service selection chain + guide page"
```

### Task 4: 侧栏树（纯模型 + 抽屉 UI + 隐藏/恢复）

**Files:**
- Create: `pwa/src/serviceTree.ts`
- Test: `pwa/src/serviceTree.test.ts`
- Modify: `pwa/src/ui.ts`（追加 `renderServiceTree` 与抽屉开关）
- Modify: `pwa/index.html`（`#svcDrawer` 抽屉 markup + CSS + connbar 加 ☰ 按钮 `#btnSvcTree`）
- Modify: `pwa/src/shell.ts`（接线：fetchServices 成功后渲染树；☰ 开合；隐藏/恢复回调；隐藏当前选中→引导页）
- Test: `pwa/src/shell-service-tree.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `readHidden/hideService/unhideService`；Task 3 `selectedPort` / `consolePort` / `#svcGuide`。
- Produces:
  ```ts
  // pwa/src/serviceTree.ts
  export interface ServiceRow {
    port: number; name: string; url?: string;
    isConsole: boolean; isSelected: boolean; isGone: boolean;
  }
  export function buildServiceTree(opts: {
    services: { name: string; port: number; url?: string }[];
    hidden: number[];
    consolePort: number | null;
    selectedPort: number | null;
    openPorts: number[];   // tabs 池里的端口（用于算出 gone：openPorts 中已不在 services 的）
  }): { visible: ServiceRow[]; hidden: ServiceRow[]; gone: ServiceRow[] }
  ```
  规则：hidden 含 consolePort → 忽略（Review Focus 1）；`gone` = openPorts − services 的差集（灰显「已离线」，spec §4.3）；`hidden` 段 = 清单内且被隐藏（可恢复）。三段各自保持 services 原始顺序。
  ```ts
  // pwa/src/ui.ts 追加
  export function renderServiceTree(
    model: { deviceName: string; visible: ServiceRow[]; hidden: ServiceRow[]; gone: ServiceRow[] },
    handlers: { onPick(port: number): void; onHide(port: number): void; onUnhide(port: number): void },
  ): void
  export function openSvcDrawer(): void   // #svcDrawer 加 .show
  export function closeSvcDrawer(): void
  ```
  console 行不渲染 ✕（`isConsole` 判定）；gone 行灰显无 ✕。点服务行 → `onPick`；点 ✕ → `onHide`；隐藏段点恢复 → `onUnhide`。

- [ ] **Step 1: 写 serviceTree 纯函数失败测试**

```ts
// pwa/src/serviceTree.test.ts
test('默认全部可见：无 hidden 时 visible=全量，顺序保持', ...)
test('隐藏进 hidden 段；consolePort 在 hidden 里被忽略（Review Focus 1）', ...)
test('gone：openPorts 有而 services 没有的端口进 gone 段', ...)
test('isSelected 标记与 selectedPort 一致', ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test pwa/src/serviceTree.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `pwa/src/serviceTree.ts`**

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test pwa/src/serviceTree.test.ts`
Expected: PASS

- [ ] **Step 5: 写 shell 接线失败测试**

```ts
// pwa/src/shell-service-tree.test.ts（setup 同 Task 3）
test('连接成功后抽屉内渲染全部服务（多服务清单桩）', ...)
test('onHide 当前选中服务 → 立即回引导页，iframe 保留（display:none 但仍在 #appHost），hidden 持久化（spec §4.5）', ...)
test('onHide 非当前服务 → 选中不受影响', ...)
test('onUnhide → 服务回到 visible 段且可点开', ...)
test('console 行无隐藏入口（isConsole 行调 onHide 的路径不存在——断言 renderServiceTree 的模型入参里 console 行 isConsole=true）', ...)
test('全部隐藏 → 引导页 all-hidden 文案（spec §4.5）', ...)
```
断言缝：FakeEl 树（`h.el('svcTree').children`）/ localStorage / `__p2pNetDebug()` / `h.el('svcGuide')`。抽屉开合与渲染用 FakeEl classList/style 断言。

- [ ] **Step 6: 跑测试确认失败**

Run: `npx tsx --test pwa/src/shell-service-tree.test.ts`
Expected: FAIL

- [ ] **Step 7: 实现 ui.ts + index.html + shell.ts 接线**

index.html：`#svcDrawer`（左侧抽屉，默认收起，`.show` 滑出；内含设备名头、`#svcTree`、`#svcGone`、`#svcHidden` 三段容器）+ connbar 左侧 ☰ `#btnSvcTree`。CSS 参照原型 `docs/prototypes/product-model-v2.html` 抽屉样式。shell.ts：fetchServices 成功后调 `buildServiceTree` + `renderServiceTree`；`onPick` = `closeSvcDrawer(); openService(port)`；`onHide` = `hideService(...)` + 重渲染 + 若等于 selectedPort 则 `showGuide('no-selection')`（iframe 只 display:none，不销毁）；`onUnhide` = `unhideService(...)` + 重渲染；`#btnSvcTree` 点击 toggle 抽屉。服务清单刷新（重连后）重渲染树。

- [ ] **Step 8: 跑测试确认通过 + 回归**

Run: `npx tsx --test pwa/src/serviceTree.test.ts pwa/src/shell-service-tree.test.ts pwa/src/shell-default-service.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add pwa/src/serviceTree.ts pwa/src/serviceTree.test.ts pwa/src/ui.ts pwa/index.html pwa/src/shell.ts pwa/src/shell-service-tree.test.ts
git commit -m "feat(pwa): workspace sidebar service tree with hide/unhide"
```

### Task 5: 沉浸模式 + 「∧ 唤起」状态机

**Files:**
- Modify: `pwa/src/shell.ts`（沉浸状态机 + 接线）
- Modify: `pwa/index.html`（`#wakePill` 元素 + CSS；connbar/tabbar/svcDrawer 的沉浸显隐类）
- Test: `pwa/src/shell-immersive.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 `openService` / `selectedPort`；Task 4 抽屉开关。
- Produces:
  - 模块级 `let immersive: boolean`；`__p2pNetDebug()` 增加 `immersive` 字段。
  - `enterImmersive()`：connbar/tabbar/svcDrawer 隐藏，`#wakePill` 显示；`exitImmersive()`：三者恢复、pill 隐藏，并启动 4s 无交互回沉浸计时（仅当 `selectedPort` 非 null）；计时器在任意点击/按键/触摸（document 级 capture 监听）时重置。
  - 空闲时长常量 `WAKE_IDLE_MS = 4000`，可用 `?wakeidle=<ms>` 覆盖（测试用 50ms；与 `?svc=`/`?dsc=` 同级排障钩子）。

- [ ] **Step 1: 写失败测试**

```ts
// pwa/src/shell-immersive.test.ts（setup 同 Task 3，search 带 '?wakeidle=50'）
test('openService 后进入沉浸：connbar/tabbar/svcDrawer display:none，wakePill 可见，debug.immersive===true', ...)
test('点 wakePill → 退出沉浸（三者恢复，pill 隐藏）', ...)
test('退出后 50ms 无交互 → 自动回沉浸（仅当仍有选中服务）', ...)
test('交互重置计时：退出后 30ms 触发一次 document 点击 → 再过 40ms 仍未回沉浸；等到总计 >50ms 无交互才回', ...)
test('切到底部其它 tab（devices/me）→ 退出沉浸且不再自动回（无选中服务在屏）', ...)
test('沉浸中发生通道升级事件 → immersive 保持 true，无显隐变化（Review Focus 4；驱动方式照抄 shell-upgrade.test.ts 的事件注入）', ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test pwa/src/shell-immersive.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

openService 尾部调 `enterImmersive()`；`showTab(name)` 包装：name!=='workspace' 时 `exitImmersive({sticky:true})`（不再排回沉浸计时）；wakePill onclick → `exitImmersive()` + 排计时；document capture 交互监听重置计时。注意 harness 的 FakeEl/假 document 是否支持 addEventListener——harness FakeEl 有 addEventListener 空实现（shell.test-harness.ts:60），document 级监听在 harness 里可能是空操作；若如此，测试改用导出的内部缝（如 `__p2pNetDebug().poke()` 触发交互重置）替代真实事件——实现时二选一，以 harness 实际能力为准，并在测试注释里说明。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx tsx --test pwa/src/shell-immersive.test.ts pwa/src/shell-upgrade.test.ts pwa/src/shell-upgrade-fail.test.ts pwa/src/shell-upgrade-relay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pwa/src/shell.ts pwa/index.html pwa/src/shell-immersive.test.ts
git commit -m "feat(pwa): immersive workspace with wake pill"
```

### Task 6: 设备页启动台化（已连接设备的服务网格）

**Files:**
- Modify: `pwa/src/ui.ts:216-236`（renderDevices 扩展第三参）
- Modify: `pwa/src/shell.ts`（调用点传 connectedId/services/onOpenService；连接状态变化时重渲染设备页）
- Test: `pwa/src/ui.test.ts`（追加 renderDevices 网格用例）、`pwa/src/shell-launchpad.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 `openService` / `currentServices`；既有 `SavedDevice`（ui.ts 顶部 import 的类型）。
- Produces:
  ```ts
  // ui.ts renderDevices 新签名（前两个参数不变）
  export function renderDevices(
    devices: SavedDevice[],
    onConnect: (d: SavedDevice) => void,
    opts?: {
      connectedId?: string | null;
      services?: { name: string; port: number }[];
      onOpenService?: (port: number) => void;
    },
  ): void
  ```
  `d.id === opts.connectedId` 的卡片在卡片内追加服务网格（图标+名，样式参照原型 v2 启动台）；点击图标 → `opts.onOpenService(port)`。其余设备卡片保持现状（Review Focus 3：未连接设备无服务清单，不渲染网格不报错）。**不缓存服务清单到设备记忆**（YAGNI：清单只能来自活连接，缓存会展示僵尸服务）。

- [ ] **Step 1: 写失败测试**

```ts
// ui.test.ts 追加（ui.test.ts 现有 DOM 方式照其既有风格）
test('renderDevices: connectedId 命中的卡片渲染服务网格，其余卡片无网格', ...)
test('网格图标点击触发 onOpenService(对应端口)', ...)
test('opts 缺省 → 全部卡片旧行为（纯连接入口），不报错（Review Focus 3）', ...)

// shell-launchpad.test.ts（setup 同 Task 3）
test('连接成功后设备页：已连接设备卡片带服务网格；点击图标 → 切到工作台并打开该服务（沉浸）', ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test pwa/src/ui.test.ts pwa/src/shell-launchpad.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

ui.ts renderDevices 扩展；shell.ts 所有 renderDevices 调用点（设备列表加载处 + afterConnected 成功后）补传第三参：`{ connectedId: everConnected ? desk.id : null, services: currentServices, onOpenService: (port) => { showTab('workspace'); void openService(port); } }`。断开连接时以 `connectedId:null` 重渲染。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test pwa/src/ui.test.ts pwa/src/shell-launchpad.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pwa/src/ui.ts pwa/src/ui.test.ts pwa/src/shell.ts pwa/src/shell-launchpad.test.ts
git commit -m "feat(pwa): launchpad devices page with service grid"
```

### Task 7: 全量回归 + 构建 + 真机门禁清单

**Files:**
- 无新文件；可能按回归结果微调前面任务的文件。

**Interfaces:**
- Consumes: 全部前序任务。

- [ ] **Step 1: 全量测试**

Run: `npm test`（根目录，含 lint:twins → test:parallel → serial → parity）
Expected: 全绿。若有既有测试因语义变更失败，只允许按新语义更新断言，禁止删测试；每处更新在 commit message 说明理由。

- [ ] **Step 2: 构建**

Run: `npm run build:pwa`
Expected: 成功产出 `pwa-dist/`。

- [ ] **Step 3: Commit（如有微调）**

```bash
git add -A && git commit -m "test(pwa): multi-service workspace regression sweep"
```

- [ ] **Step 4: 真机门禁清单（交用户执行，写进 commit/PR 描述）**

spec §5 门禁：双机（iPhone + Android）各连同一台 Mac（≥2 个服务：3001 工作台 + 任一 dev server），验证——
1. 工作台切换两个服务，各自现场不丢（W-B 回归）；
2. 隐藏/恢复跨设备隔离（iPhone 隐藏不影响 Android）；
3. 进服务自动沉浸，「∧ 唤起」→ 4s 自动回沉浸；
4. 设备页点服务图标直达对应服务；
5. 通道升降级（关开 WiFi 切蜂窝）中工作台不重载、沉浸不被打破。

---

## Self-Review 记录（2026-09-28）

1. **Spec coverage**：§4.1 存储 → Task 1/2 ✓；§4.4 裁决链拆半 + §4.3 引导页 → Task 3 ✓；§4.2 侧栏 + §4.5 隐藏边界 → Task 4 ✓；§4.2 沉浸 → Task 5 ✓；§2.5 启动台 → Task 6 ✓；§5 测试 → 各任务单测 + Task 7 ✓。§4.3「iframe 不销毁」由 Task 4 隐藏当前服务用例钉住 ✓。
2. **Step scan**：每步单一动作 + 可检查结果 ✓。
3. **Type consistency**：`readHidden/hideService/unhideService`、`readLastService/writeLastService`、`buildServiceTree/ServiceRow`、`renderServiceTree`、`renderDevices` 三参、`selectedPort/immersive` debug 字段——全文一致 ✓。
4. **Review Focus**：5 条各自落到 Task 3/4/5/6 的具体测试 ✓。
5. **Proportion**：计划 ≈5× spec 行数，其中代码块几乎全是测试断言与签名，无实现 transcript ✓。
