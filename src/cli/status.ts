/** p2p-net status（Task 19）：查本地控制面 GET /status 并打印人话摘要。
 *
 *  - 只打 127.0.0.1 回环；端口来自 PORTS.CONTROL_PORT（contracts/ports.json 单一事实源，
 *    逻辑里绝不硬编码 19727）。
 *  - 2s 超时（AbortSignal.timeout）：控制面是本机常驻进程，超过即按「服务未运行」处理。
 *  - 失败文案带下一步：不可达/超时/非 2xx/畸形响应 → 「服务未运行，试 `p2p-net service status`」，
 *    exit 1；绝不甩堆栈。
 *  - 可测性：fetchImpl/port/out/err/timeoutMs 全经 deps 注入（与 start/service 同款 deps 模式）。
 */

import { PORTS } from '../contracts.js';

export interface StatusDeps {
  fetchImpl?: typeof fetch;
  /** 默认 PORTS.CONTROL_PORT；测试注入回环服务器随机端口。 */
  port?: number;
  out?: (line: string) => void;
  err?: (line: string) => void;
  timeoutMs?: number;
}

/** /status 响应形态（与 start.ts getStatus 对齐；缺字段容错渲染——运行中的旧版进程可能少字段）。 */
interface StatusBody {
  uptime?: number;
  deviceId?: string;
  sessions?: { active?: number; byMode?: Record<string, number>; avgRttMs?: number | null } | number;
  services?: number;
  mode?: string;
  /** Wave 1（spec D8）：数据面计量快照；旧进程无此字段 → 容错省略该行。
   *  F10 增补 tunnelLinks（隧道兜底腿在线/总数，字节已并入 totals）；旧进程无此字段 → 省略该行。 */
  dataPlane?: { totals?: { req?: number; resDone?: number; bytesSent?: number; bytesRecv?: number }; sessions?: number; tunnelLinks?: { open?: number; total?: number } } | null;
  /** F4 信令黑洞治理：信令面健康；旧进程无此字段 → 容错省略该行。
   *  authFailures（401/403 鉴权连败另账，2026-09-25 分类治理）：旧进程缺省按 0。 */
  signaling?: { consecutiveFailures?: number; firstFailureAt?: number; lastError?: string; recovering?: boolean; authFailures?: number } | null;
}

const HINT = 'p2p-net service status';

export async function runStatus(deps: StatusDeps = {}): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const port = deps.port ?? PORTS.CONTROL_PORT;
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));

  let res: Response;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? 2000),
    });
  } catch {
    err(`服务未运行，试 \`${HINT}\``);
    return 1;
  }
  if (!res.ok) {
    err(`控制面 /status 返回 HTTP ${res.status}：服务异常，试 \`${HINT}\``);
    return 1;
  }
  let body: StatusBody;
  try {
    body = (await res.json()) as StatusBody;
  } catch {
    err(`控制面 /status 响应无法解析：服务异常，试 \`${HINT}\``);
    return 1;
  }

  // 旧形态容错：sessions 曾是纯数字（T16 最小形态），按活跃数渲染
  const sessions =
    typeof body.sessions === 'object' && body.sessions !== null
      ? body.sessions
      : { active: typeof body.sessions === 'number' ? body.sessions : 0, byMode: {}, avgRttMs: null };
  const active = typeof sessions.active === 'number' ? sessions.active : 0;
  const byMode = sessions.byMode ?? {};
  const modes = Object.entries(byMode)
    .map(([m, n]) => `${m} ${n}`)
    .join('，');
  const rtt = typeof sessions.avgRttMs === 'number' ? `，平均 RTT ${Math.round(sessions.avgRttMs)} ms` : '';

  out(`p2p-net 运行中（${body.mode ?? 'foreground'} 模式），已运行 ${fmtUptime(body.uptime ?? 0)}`);
  out(`设备：${body.deviceId ?? '未知'}`);
  out(`活跃会话：${active}${modes ? `（${modes}）` : ''}${rtt}`);
  out(`发现服务：${typeof body.services === 'number' ? body.services : 0} 个`);
  const dp = body.dataPlane;
  const sent = dp?.totals?.bytesSent;
  const recv = dp?.totals?.bytesRecv;
  if (typeof sent === 'number' && typeof recv === 'number') {
    // 视角 = 本机（host）：bytesSent=发往客户端=上行；与 events.jsonl 的 bytesUp 同义。
    // F10 起 totals 并入隧道腿进程期累计（最贵路径成本可见），故标签不再只提活跃会话。
    out(`数据面流量：上行 ${fmtBytes(sent)} / 下行 ${fmtBytes(recv)}（${dp?.sessions ?? 0} 活跃会话 + 隧道腿进程期累计）`);
    const tl = dp?.tunnelLinks;
    if (tl && typeof tl.open === 'number' && typeof tl.total === 'number' && tl.total > 0) {
      out(`隧道兜底腿：${tl.open}/${tl.total} 条在线`);
    }
  }
  const sig = body.signaling;
  if (sig) {
    const n = sig.consecutiveFailures ?? 0;
    const authN = sig.authFailures ?? 0;
    if (authN > 0) {
      // 401/403 鉴权连败（2026-09-25 分类治理）：与网络黑洞不同——服务器可达、令牌被拒，
      // 自动续期进行中，隧道兜底腿（无需 JWT）不受影响
      out(`信令：鉴权连续失败 ${authN} 次（令牌被拒）——自动续期进行中，隧道兜底不受影响；若持续不愈请重跑 p2p-net login`);
    } else if (n > 0) {
      const secs = typeof sig.firstFailureAt === 'number' ? Math.max(0, Math.round((Date.now() - sig.firstFailureAt) / 1000)) : null;
      out(`信令：连续 ${n} 次轮询失败${secs !== null ? `（已 ${fmtUptime(secs)}）` : ''}——手机端可能连不上，持续不愈将自动重启`);
    } else {
      out('信令：正常');
    }
  }
  return 0;
}

/** 秒 → 「1 小时 2 分 3 秒」式人话。 */
function fmtUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h} 小时 ${m} 分 ${r} 秒`;
  if (m > 0) return `${m} 分 ${r} 秒`;
  return `${r} 秒`;
}

/** 字节量人话化：≥1MiB → X.X MiB；≥1KiB → X.X KiB；否则 N B。 */
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}
