/**
 * 工作台首屏的"该不该开窗 / 该不该重载"决策（纯函数，单测友好）。
 *
 * 由来（2026-09-12，真机 CDP 取证，白屏第 3 次复发）：
 *   数据面会短时黑洞（控制帧正常、HTTP 回帧丢失，watchdog 已能识别并拆连重连）。
 *   若黑洞恰好覆盖"控制台首屏"那一瞬，控制台的 JS/CSS 资源请求会 504，
 *   而**失败的 <script>/<link> 永远不会自动重试** → iframe 永久白屏：
 *     证据：手机侧日志 `[watchdog] 数据面 4 条请求 >9s 无回帧 → 拆连重连` +
 *           504 /s/3001/assets/vendor-react…js / vendor-xterm…js / index.css；
 *           数分钟后同样资源再打全部 200（206KB/648ms、160KB/701ms、396KB/2678ms）。
 *   旧实现只在**首次**连上时建 iframe，重连后既不体检也不重载 → 用户看到的就是"永远白屏"。
 *
 * 因此把两处判断抽成纯函数，并用单测钉死行为：
 *   ① 开窗闸门：数据面没探活成功就不把 iframe 指向控制台（别烧首屏）；
 *   ② 开窗后体检：没 boot 起来就重载，超过上限才放弃（交给用户手动重试）。
 */

export type BootGateDecision = 'boot' | 'defer' | 'giveup';
export type HealthDecision = 'ok' | 'reload' | 'giveup';

/** 数据面探活判定：拿到上游真实应答（含 404/405）即证明回帧路径活着；
 *  只有合成失败（隧道网关 502 / SW 链路快败 503 / 超时 504）才算死。
 *  （2026-09-22 蜂窝真机实锤：探针打 /api/auth/status 是控制台私有语义，
 *   普通静态服务恒 404 → 开窗闸门永远 defer → 工作台空白。） */
export function dataPlaneAlive(status: number): boolean {
  return status !== 502 && status !== 503 && status !== 504;
}

/** 开窗闸门：探活成功→开窗；失败→延后（等数据面重连），延后次数超限→交给用户手动重试。 */
export function bootGateDecision({
  dataPlaneReady,
  deferCount,
  maxDefer = 3,
}: { dataPlaneReady: boolean; deferCount: number; maxDefer?: number }): BootGateDecision {
  if (dataPlaneReady) return 'boot';
  return deferCount >= maxDefer ? 'giveup' : 'defer';
}

/** 开窗后体检：已 boot 或还在容差窗口内→ok；否则重载；重载次数超限→giveup。 */
export function healthDecision({
  booted,
  reloadCount,
  maxReload = 3,
}: { booted: boolean; reloadCount: number; maxReload?: number }): HealthDecision {
  if (booted) return 'ok';
  return reloadCount >= maxReload ? 'giveup' : 'reload';
}

/** 体检节奏（毫秒；从 set src 起算）——既要尽早救活，也别狂刷。 */
export const HEALTH_CHECK_DELAYS_MS = [5_000, 12_000, 25_000];

/**
 * 判断 iframe 里的控制台是否真的起来了。
 * 控制台是 React 应用：`#root` 有子节点 = 脚本跑通了。
 * 退一步只要有可见文本也算（版本差异兜底）；异常（跨源/未挂载）一律算没起来。
 */
export function looksBooted(doc: Document | null | undefined): boolean {
  if (!doc) return false;
  try {
    const root = doc.getElementById('root');
    if (root && root.childElementCount > 0) return true;
    const text = (doc.body?.innerText ?? '').trim();
    return text.length > 0;
  } catch {
    return false;
  }
}
