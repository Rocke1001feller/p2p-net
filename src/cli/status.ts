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
