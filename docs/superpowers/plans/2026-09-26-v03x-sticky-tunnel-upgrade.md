# v0.3.x 增量包：实验徽章 + 隧道计量 + 粘性回迁 + tunnel→p2p 升级

来源：用户双机实测反馈（2026-09-26），四项 bounded 设计已在对话中逐项批准。
分支：`feat/v03x-sticky-tunnel`（基于 main `29be1ff` / v0.3.0）。

## Global Constraints

- **中继不砍**：级联顺序 p2p→tunnel→turn 维持（W2-4 实测背书），只要求长服务不粘在中继上。
- tunnel→p2p 升级采用**旁路 make-before-break**，不做主动打断式升级。
- TDD：先写/改测试，实现到绿；全仓 `npm test`（lint:twins + parallel 518 测 + serial + parity 68）与 `npm run build` / `npm run build:pwa` 必须全绿。
- 测试命令模板：`npx tsx --test <file>`（单文件）；全量 `npm test`。
- 代码风格：中文注释、与现有文件同构；PWA 侧日志走 `#log`（`log()` helper），host 侧 `console.error/[p2p-net]`。
- 提交纪律：工作完成后 `git checkout -- package-lock.json pwa/package-lock.json` 防漂移。

## 已完成（不在本计划派发范围）

- `pwa/src/cascadePlan.ts`：`planStageModes(opts, lastMode?)` 记忆化（lastMode='tunnel' → `['tunnel','p2p','turn']`；forceTurn/forceTunnel 先行压过记忆化）+ 8 测试绿。
- `src/signaling/protocol.ts`：SigMessageType 加 `'tunnel-session'`；SigMessage 加可选 `phase?: 'start'|'end'`、`access?: string`（平铺、不进 isSigMessage 守卫）+ 3 测试绿。
- `pwa/src/tunnelBackcheck.ts`（新）：turn 会话 60s 节拍探活，活→onAlive+自停，未活/抛错→排下一拍，非 turn 空转，stop 幂等；时钟注入。测试 3 例**已绿**。
- `pwa/src/p2pUpgrade.ts`（新）：idle→probing→adopted 终态；首探 60s、连败退避 `firstDelayMs*2^(fails+1)` 封顶 480s；attempt 抛错=失败静默退避。测试 3 例中有 1 例红（见 Task 1）。

## Task 1: p2pUpgrade 连败退避封顶测试修复

`npx tsx --test pwa/src/p2pUpgrade.test.ts` 当前 1 红：
测试「连败退避 60→120→240→480s 封顶；隧道切走空转；stop 幂等」期望延迟序列
`[60000,120000,240000,480000,480000]`，实际产出 `[...,480000,480000]`（多一个 480000）。
先读 `pwa/src/p2pUpgrade.ts` 与 `pwa/src/p2pUpgrade.test.ts`，判定语义边界：
封顶后每拍应仍调度一次（480 循环），但测试驱动的拍数决定序列长度——以设计语义
「连败退避封顶 480s、封顶后持续以 480s 节拍探测；隧道切走（非 tunnel）空转；stop 幂等」
为准，修正实现或测试使语义自洽且测试绿。两文件之外不得改动。
验证：`npx tsx --test pwa/src/tunnelBackcheck.test.ts pwa/src/p2pUpgrade.test.ts` 全绿。

## Task 2: 隧道会话计量——host 侧（任务B 前半）

协议已就绪（`tunnel-session` 消息类型 + `phase`/`access` 字段，见 src/signaling/protocol.ts）。

1. `src/host.ts`：
   - `HostAgentOptions` 加 `onTunnelSession?: (msg: SigMessage) => void;`
   - `onSignal`（约 571 行，现有 `msg.type === 'offer'` 分支处）加分发：
     `if (msg.type === 'tunnel-session') { this.opts.onTunnelSession?.(msg as SigMessage); return; }`
2. `src/server/events.ts`：事件结构加可选 `mode?: string` 字段（session_start/session_end 事件携带，缺省='p2p' 语义由读取方兜底，不落盘字段时保持兼容）。
3. `src/cli/start.ts`：`hostAgentFactory` opts 接线 `onTunnelSession` → 调事件 record：
   `record({ name: msg.phase === 'start' ? 'session_start' : 'session_end', sid: msg.sid, mode: 'tunnel', access: msg.access })`
   （字段名以 events.ts 现有 record 签名/事件结构为准对齐）。
4. 测试（参照 `src/tests/host-session-policy.test.ts`、`src/cli/start.test.ts` 现有模式）：
   - host 收到 tunnel-session 消息 → onTunnelSession 被调、且不再走 offer 分支；
   - start 接线：phase='start' → session_start + mode:'tunnel'；phase='end' → session_end。
验证：新测试绿 + `npx tsx --test src/tests/host-session-policy.test.ts` 等相邻测试不红。

## Task 3: PWA 侧四件套——实验徽章(A) + 隧道埋点(B) + 粘性回迁(C) + 升级装配(D)

改动面：`pwa/src/shell.ts`、`pwa/src/session.ts`、`pwa/src/ui.ts` + 各自测试。四子任务按序 TDD。

### 3.1 任务A：实验徽章区分

- `pwa/src/ui.ts`：新增 `setExperimentMode(kind: 'relay'|'tunnel'|null)`；
  `setStatus` connected 分支（约 127 行）徽章文本在实验模式下显示「中继（实验）」/「隧道（实验）」；
  非实验（null）保持现状；disconnected 复位为 null。
- `pwa/src/shell.ts`：forceTurn/forceTunnel 解析处（约 463-472 行，`?transport=relay` / `?tunnel=1`）
  调 `ui.setExperimentMode('relay'|'tunnel')`；非强制路径传 null。

### 3.2 任务B：PWA 隧道会话埋点

- `pwa/src/shell.ts`：模块级 `activeTunnelSession: { sid: string } | null`。
- start：`onCascadeStatus`（约 512 行）connected 且 `mode==='tunnel'` 且无活跃会话 →
  `sid = 'tun_' + (crypto.randomUUID?.() ?? String(Date.now()))`，
  经 `SignalingClient.send(roomFor(uid, desk.id), myDeviceId, { type:'tunnel-session', sid, phase:'start', access, from: myDeviceId })`
  发到 host 房间（send 签名见 `pwa/src/signaling/client.ts:55`；roomFor 见现有房间构造函数）。
  `access` 读 localStorage 键 `p2p-net.pwa.access`（W2-1 键，读取方式同现有代码）。
- end（三处时机）：`startConnect` 重建旧实例前（约 443-445 行）；`onCascadeStatus` 收到 off/failed；
  `stopSession`。发送 phase:'end' 后清空 `activeTunnelSession`；无活跃会话时 end 空转。
- 测试：fake signaling client 断言 start/end 消息体与时机。

### 3.3 任务C：粘性记忆 + turn→tunnel 回迁

- `pwa/src/session.ts`：`CascadeOptions` 加 `lastMode?: StageMode | null`（或 connect 增参，以现有结构最小改动为准），
  级联规划改调 `planStageModes(this.opts, lastMode)`（签名已就绪，见 pwa/src/cascadePlan.ts）。
- `pwa/src/shell.ts`：`onCascadeStatus` connected 且 `s.mode` 存在 →
  `localStorage.setItem('p2p.lastLinkMode', s.mode)`；connect 调用处（约 481 行）读该键注入 lastMode。
- 回迁看门狗装配（TunnelBackcheck 已就绪，见 pwa/src/tunnelBackcheck.ts）：
  - `isTurnActive`: `cascade?.mode === 'turn' && cascade.isOpen`
  - `probe`: session.ts 的 CascadeSession 暴露 public `probeTunnelAlive(): Promise<boolean>`，
    包装私有 probeTunnel（6s 超时语义保持）。
  - `onAlive`: `log()` 记录 + `startConnect({ id: desk.id, tunnelUrl: desk.tunnelUrl, name: deskName }, true)` 重级联。
  - 生命周期：onCascadeStatus connected 且 mode==='turn' 启动；mode 变化/非 turn/off/stopSession 停止。
- 测试：session 层 planStageModes 收到 lastMode；shell 层 localStorage 写入与注入；回迁触发 startConnect。

### 3.4 任务D：tunnel→p2p 旁路升级装配

- `pwa/src/session.ts`：CascadeSession 加 `adoptP2pUpgrade(web: WebRtcSession): boolean`：
  仅 `mode==='tunnel'` 接受（否则 return false 且不动 web）；
  接受时：teardownWeb 清 wsMap 关网关 WS → `this.web = web` → `mode = 'p2p'` →
  emit connected（pairType='p2p' 语义对齐现有 emit）；return true。
- `pwa/src/shell.ts`：装配 P2pUpgrade（pwa/src/p2pUpgrade.ts 已就绪）：
  - `attempt`：构造旁路 WebRtcSession——构造面照抄 session.ts 约 170-191 行
    （同 signaling/uid/myDeviceId/stunServers/policy 'all'/liveness；onStatus 内部消化只等 isOpen；onFrame 丢弃）；
    connected 后调 `cascade.adoptP2pUpgrade(web)` 返回其结果；失败路径 teardown 旁路实例返回 false。
  - 生命周期：onCascadeStatus connected 且 mode==='tunnel' 启动；mode 变化/断开/stopSession 停止。
  - **分流零改动**：shell 分流全部按 `cascade.mode` 实时判断（约 250/275/287 行），
    热切换后新请求自然走 dc、在途隧道 fetch 自然完成，不得改分流逻辑。
- 测试：adoptP2pUpgrade 仅 tunnel 接受/turn 拒绝；接受后 mode/method/emit 正确；
  P2pUpgrade attempt 成功路径调 adopt、失败路径 teardown。

### 3.5 验证

`npm run build:pwa`（vite）通过；`npx tsx --test pwa/src/` 相关测试全绿；
`npm test` 全量绿（含 lint:twins + parity）。
