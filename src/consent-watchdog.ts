/**
 * ICE 同意（RFC 7675 consent freshness）看门狗 —— werift 0.24.4 #69「上行背压排空停滞」的根因兜底。
 * （2026-09-23 自 v3 devanywhere-net 逐字移植，spec D3；实测依据：v3 docs/benchmark/upload-stall-69-2026-09-16.md
 *   与本仓 e2e/n3-consent-repro.md 复现证据）
 *
 * ## 为什么需要它（逐条都是可复跑的实测事实，见 `docs/benchmark/upload-stall-69-2026-09-16.md`）
 *
 * werift 0.24.4 实现了 RFC 7675 同意检查，但**到期后是一条死路**：
 *
 * 1. 同意循环（`lib/ice/src/ice.js`）每 4–6 s 发一枚 Binding 请求，`retransmissions: 0`、
 *    响应等待 `max(500ms, 2×RTT+200ms)` —— **单发、无重传**；
 * 2. 连续 30 s（`CONSENT_TIMEOUT`）没有一个有效响应 → `consentFresh=false` 且
 *    `this.setState("failed")`，随后**循环自己退出**（`isTerminalState()` 变真）；
 * 3. 到期后 `IceTransport.send()` 首行就是 `if (!canSendApplicationData()) return;`
 *    —— **静默丢包**：不抛错、不计数、不打日志，上层（DTLS/SCTP/DataChannel）以为发成功了；
 * 4. 重开同意循环的唯一路径是「**新候选对被提名**且 `state ∈ {connected, completed}`」
 *    （`checkComplete` 里那条 `queryConsent()`）；`state === 'failed'` 时永远不会满足
 *    —— **没有任何自愈路径**（`resetNominatedPair` / `setRemoteParams` 只 stop，不 start）。
 *
 * 于是现场表现是**假健康**：`dc.readyState === 'open'`、控制帧照收（对端还能发），
 * 但本端**一个应用包都发不出去**。更致命的是上面还有一层：SCTP 的发送队列因为
 * **再也收不到 SACK**（包被 ICE 静默吞掉）而 `flightSize` 填满 → `outboundQueue` 停止出队
 * → `sctp.send()` 的 promise 永不 resolve → `dataChannelFlush` 的
 * `addBufferedAmount(-len)` 永不执行 → **`dc.bufferedAmount` 永久钉在背压阈值上**。
 * 这正是 issue #69 的现场签名（`buffered=262976` 恒定 240 s、零进展、DC 仍 open）。
 *
 * ## 本看门狗做什么
 *
 * 周期性地读 ICE transport 的公开运行时字段（`iceTransports[0].connection`），
 * 发现「同一关联上 DTLS/SCTP 还活着，但 ICE 同意已死」这一**沉默黑洞形态**时，
 * 就地在原关联上重开同意循环（`queryConsent()` + 若 `state==='failed'` 则 `setState('connected')`）。
 * 实测（`scripts/werift-consent-expiry-repro.mjs` 阶段 D）：复活调用后立刻恢复收发，
 * 且积压的数据帧在一次复活内全部送达。
 *
 * 边界（必须明说，不许含糊）：
 * - 这是**对上游缺陷的兜底**，不是修复上游（werift 侧问题已在 issue 记录）；
 * - 复活次数有上限（`maxRevives`）：链路真的死了（对端不在线）时，复活会再次到期，
 *   到达上限后放弃并上报 `kind: 'give-up'`，由控制面决定是否重建会话（升降级/重握手）；
 * - 读的是 werift 运行时字段，属**未文档化接口**：全部经特性检测 + try/catch，
 *   字段缺失即视为「无可观测面」直接跳过（对非 werift 实现零副作用）。
 */

/** ICE transport 的最小可观测结构（werift `IceTransport` / `Connection` 的公开字段子集）。 */
export interface IceTransportLike {
  state?: string;
  consentFresh?: boolean;
  queryConsentHandle?: unknown;
  generation?: number;
  /** RFC 7675 复活入口（werift 内部同名方法）。 */
  queryConsent?: () => void;
  setState?: (state: string) => void;
}

export interface IceTransportsOwner {
  iceTransports?: Array<{ connection?: IceTransportLike }>;
}

export interface ConsentWatchdogEvent {
  kind: 'revive' | 'give-up';
  atMs: number;
  /** 触发时刻的 ICE 状态（`failed` = 已进入不可自愈的终态）。 */
  iceState: string | null;
  consentFresh: boolean | null;
  /** 本看门狗实例累计复活次数（含本次）。 */
  revives: number;
}

export interface ConsentWatchdogOptions {
  /** 检查周期（ms）。默认 3000：远小于 30 s 的同意有效期，最坏多损失一个周期。 */
  intervalMs?: number;
  /** 复活上限（次）。默认 5：链路真的断了就别无限重试，交给控制面。 */
  maxRevives?: number;
  /**
   * 「健康多久才算真的好了」（ms，默认 60000 = 2× 同意有效期）。
   *
   * 为什么不能一见到健康就归零（2026-09-16 现场实测教训）：复活后同意会被立即置回 true，
   * 下一个周期读到的就是「健康」——若此时归零，那么「每 30 s 过期一次」的病态链路会被
   * 无限复活下去，上限永远不触发（现场日志里 6 次复活全部记为「第 1 次」）。
   * 现在只在**距上次复活已过 60 s** 的持续健康之后才归零。
   */
  healthyResetMs?: number;
  /** 事件回调（复活/放弃）——宿主用它落日志或进事实面。 */
  onEvent?: (e: ConsentWatchdogEvent) => void;
}

/**
 * 「同意已死」判定。
 *
 * `everEstablished` 是**必须**的上下文（2026-09-16 公网现场教训）：werift 的 `consentFresh`
 * 字段初始值就是 `false`，只有 `queryConsent()` 跑起来才置 true —— 建链中途（`gatherCandidates`
 * 结束时的 `setState('completed')` 到 `connect()` 末尾的 `queryConsent()` 之间）读到的是
 * 「尚未新鲜」，不是「已过期」。把两者混为一谈会造成建链期误判（现场 3 个会话里 11 次这种误报）。
 *
 * 判据（两条都只可能在**建立之后**出现）：
 * 1. `state === 'failed'`：werift 只有同意到期这一条路径会把它置 failed（`ice.js:316`，
 *    全文件唯一一处）——这就是 #69 的永久黑洞；
 * 2. `consentFresh === false` 且已建立过：覆盖 `stopConsentLifecycle()` 之后到重新提名之间的
 *    窗口（`ice.js:1053` 置 false 但不改 state）——此窗口内发送同样被静默丢弃。
 */
export function consentExpired(
  ice: IceTransportLike | null | undefined,
  everEstablished: boolean,
): boolean {
  if (!ice) return false;
  if (ice.state === 'failed') return true;
  if (ice.state === 'closed') return false;
  return everEstablished && ice.consentFresh === false;
}

/**
 * 就地复活同意循环（幂等；不可用时静默返回 false）。
 *
 * 顺序是契约：先 `setState('connected')`（把 state 从终态 `failed` 拉回来，
 * 否则循环里的 `isTerminalState()` 会让它立刻退出），再 `queryConsent()`
 * （内部会把 `consentFresh` 置回 true 并重启 4–6 s 的心跳）。
 */
export function reviveConsent(ice: IceTransportLike | null | undefined): boolean {
  if (!ice || typeof ice.queryConsent !== 'function') return false;
  try {
    if (ice.state === 'failed') ice.setState?.('connected');
    ice.queryConsent();
    return true;
  } catch {
    return false;
  }
}

/**
 * 挂上同意看门狗。返回 detach（清定时器）。
 *
 * 只在「ICE 同意已死」时动作；其余时间零副作用（不写任何状态、不打日志）。
 */
export function attachConsentWatchdog(pc: IceTransportsOwner, opts: ConsentWatchdogOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? 3_000;
  const maxRevives = opts.maxRevives ?? 5;
  const healthyResetMs = opts.healthyResetMs ?? 60_000;
  let revives = 0;
  let lastReviveAtMs = 0;
  let givenUp = false;
  /** 「曾经建立过」闩锁：建链中途的 `consentFresh=false` 不算过期（见 `consentExpired` 注释）。 */
  let everEstablished = false;
  const timer = setInterval(() => {
    if (givenUp) return;
    const ice = pc?.iceTransports?.[0]?.connection;
    // 闩锁只认 `connected`：werift 里 `completed` 是 gatherCandidates() 结束时置的
    // **建链中途**态（`ice.js:705`），而此时 `connect()` 尚未跑完、同意循环还没启动
    // ——现场 11 次误报正是它（3 个会话的建链期）。
    if (ice && ice.state === 'connected') everEstablished = true;
    if (!consentExpired(ice, everEstablished)) {
      // 只有「距上次复活已过 healthyResetMs」的持续健康才归零：
      // 复活刚做完的那一拍必然读作健康，不能拿它当"好了"（见 healthyResetMs 注释）。
      if (Date.now() - lastReviveAtMs > healthyResetMs) revives = 0;
      return;
    }
    if (revives >= maxRevives) {
      givenUp = true;
      opts.onEvent?.({ kind: 'give-up', atMs: Date.now(), iceState: ice?.state ?? null, consentFresh: ice?.consentFresh ?? null, revives });
      return;
    }
    // 触发时刻的快照要在复活**之前**取：复活会就地改写 state/consentFresh，
    // 事后读就只剩"已恢复"的假象（事件的价值在于留下证据形态）。
    const iceState = ice?.state ?? null;
    const consentFresh = ice?.consentFresh ?? null;
    if (reviveConsent(ice)) {
      revives += 1;
      lastReviveAtMs = Date.now();
      opts.onEvent?.({ kind: 'revive', atMs: lastReviveAtMs, iceState, consentFresh, revives });
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
