/** 端口扫描器（Task 15 产出，Task 16/17 消费）：本机 dev web 服务发现 → 服务清单数据源。
 *  10s reconcile 周期：macOS `lsof -nP -iTCP -sTCP:LISTEN` / Linux `ss -ltn` 枚举监听端口，
 *  与默认白名单（+extraWhitelist）合并为候选，HTTP 探测判「website」才上架
 *  （最终 2xx + content-type 含 text/html + 正文 >64B，跟随一次重定向，<title> 作友好名）。
 *  探测并发 8、判定缓存 60s、连续 2 轮非 website 除名；NEVER 集合永不上架。
 *  主线移植自 v2 仓 desktop/daemon/engine.js:442-955（只保留 website 探测，AI provider 扫描不带）。
 *  裁决备忘：lsof/ss 是 plan 特许的 OS 内省工具（「禁 spawn」约束针对包工具链），用 execFile
 *  （argv 数组、无 shell）；端口消失/拒绝是「不在场」信号而非失败——扫描周期绝不抛错。
 */

import { execFile } from 'node:child_process';
import { PORTS } from '../contracts.js';
import type { Logger } from '../log/logger.js';

/** 服务清单条目：name 取 HTML <title>（折叠空白、截 40 字符），取不到回退「网页服务 · <port>」。 */
export interface ServiceInfo {
  port: number;
  name: string;
}

export interface Scanner {
  list(): ServiceInfo[];
  start(): void;
  stop(): void;
}

/** 常见 dev server 端口 Top10：即使监听枚举漏报（权限/平台限制）也逐轮探测。 */
export const DEFAULT_WHITELIST: number[] = [3000, 3001, 4200, 5000, 5173, 8000, 8080, 8081, 8888, 9000];

/** 永不上架：已知非服务端口（旧控制台 3003 / vite preview 4173 / POC 18080/18088）+ 本包契约端口。 */
export const NEVER_PORTS: ReadonlySet<number> = new Set([
  3003, 4173, 18080, 18088,
  PORTS.CONTROL_PORT, PORTS.DISCOVERY_PORT, PORTS.DOCS_PORT, PORTS.TUNNEL_RELAY_PORT,
]);

const RECONCILE_INTERVAL_MS = 10_000;
const PROBE_CONCURRENCY = 8;
const PROBE_CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 1200;
const PROBE_BODY_CAP_BYTES = 64 * 1024;
const PROBE_MIN_BODY_BYTES = 64;
const UNMOUNT_STRIKES = 2;
const ENUM_TIMEOUT_MS = 8000;

/** 解析 macOS `lsof -nP -iTCP -sTCP:LISTEN` 输出 → 监听端口（仅回环/通配绑定，按端口去重）。 */
export function parseLsofOutput(out: string): number[] {
  const ports = new Set<number>();
  for (const line of out.split('\n').slice(1)) {
    const m = line.match(/TCP\s+(\S+):(\d+)\s+\(LISTEN\)/);
    if (!m) continue;
    if (!isLoopbackOrWildcard(m[1].replace(/^\[|\]$/g, ''))) continue;
    ports.add(Number(m[2]));
  }
  return [...ports];
}

/** 解析 Linux `ss -ltn` 输出 → 监听端口（仅回环/通配绑定，按端口去重）。 */
export function parseSsOutput(out: string): number[] {
  const ports = new Set<number>();
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || f[0] !== 'LISTEN') continue;
    const local = f[3];
    const i = local.lastIndexOf(':');
    if (i < 0) continue;
    if (!isLoopbackOrWildcard(local.slice(0, i).replace(/^\[|\]$/g, ''))) continue;
    const port = Number(local.slice(i + 1));
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return [...ports];
}

/** 仅回环（127.0.0.1/::1）与通配（*\/0.0.0.0/::）绑定可经 127.0.0.1 探测/回源；
 *  绑定具体网卡 IP 的服务回环不可达，不入候选。 */
function isLoopbackOrWildcard(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '*' || addr === '0.0.0.0' || addr === '::';
}

/** 提取 <title>（折叠空白、截 40 字符；取不到返回 null）。 */
function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const t = m[1].replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 40) : null;
}

/** 轻探一个端口：判「website」当且仅当 GET / 跟随一次重定向后最终 2xx + text/html + 正文 >64B
 *  （404/空响应/空壳 200/非 HTML 一律不算）。连接拒绝/超时/重置 = 不在场信号 → null；永不 reject。 */
export async function probePort(port: number, fetchImpl: typeof fetch = globalThis.fetch): Promise<ServiceInfo | null> {
  const origin = `http://127.0.0.1:${port}`;
  let url = `${origin}/`;
  for (let redirectsLeft = 1; ; redirectsLeft--) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { 'user-agent': 'p2p-net-scanner' },
      });
    } catch {
      return null;
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location && redirectsLeft > 0) {
      drain(res);
      try {
        const next = new URL(location, url);
        url = `${origin}${next.pathname}${next.search}`; // 只跟 path，不跨主机
        continue;
      } catch {
        return null;
      }
    }
    const ct = res.headers.get('content-type') ?? '';
    if (res.status < 200 || res.status >= 300 || !ct.includes('text/html')) {
      drain(res);
      return null;
    }
    const body = await readPrefix(res, PROBE_BODY_CAP_BYTES).catch(() => null);
    if (!body || body.length <= PROBE_MIN_BODY_BYTES) return null;
    const title = extractTitle(body.toString('utf8'));
    return { port, name: title ?? `网页服务 · ${port}` };
  }
}

/** 丢弃未读响应体（避免连接悬挂）；尽力而为，绝不抛错。 */
function drain(res: Response): void {
  res.body?.cancel().catch(() => {});
}

/** 只读响应体前 cap 字节（防巨型 HTML 拖内存），达到上限即取消余量。 */
async function readPrefix(res: Response, cap: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (size < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
    }
    if (size >= cap) await reader.cancel().catch(() => {});
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** execFile 的 promise 化（argv 数组、无 shell）。返回 null = 工具不可用/被杀（本轮放弃）；
 *  退出码非 0 但 stdout 为空（如 lsof 无匹配时退出码 1）按合法空结果处理。 */
function runEnumTool(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: ENUM_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (!err) return resolve(stdout);
      const code = (err as { code?: string | number }).code;
      if (typeof code === 'number' && stdout.trim() === '') return resolve('');
      return resolve(null);
    });
  });
}

/** 创建扫描器。start 立即跑首轮并挂 10s 周期（unref，不阻碍进程退出）；stop 清定时器。 */
export function createScanner(opts: { extraWhitelist?: number[]; log: Logger }): Scanner {
  const { log } = opts;
  const whitelist = [...new Set([...DEFAULT_WHITELIST, ...(opts.extraWhitelist ?? [])])]
    .filter((p) => !NEVER_PORTS.has(p));
  const services = new Map<number, ServiceInfo>();
  const probeCache = new Map<number, { info: ServiceInfo | null; ts: number }>();
  const strikes = new Map<number, number>(); // port -> 连续非 website 轮次（website 命中即清零）
  let timer: ReturnType<typeof setInterval> | null = null;
  let cycleRunning = false;

  /** 枚举本机监听端口；返回 null = 枚举工具本轮不可用（保留现状、跳过本轮，避免误判全员消失）。 */
  async function enumerateListeners(): Promise<number[] | null> {
    let cmd: string;
    let args: string[];
    let parse: (out: string) => number[];
    if (process.platform === 'darwin') {
      cmd = 'lsof'; args = ['-nP', '-iTCP', '-sTCP:LISTEN']; parse = parseLsofOutput;
    } else if (process.platform === 'linux') {
      cmd = 'ss'; args = ['-ltn']; parse = parseSsOutput;
    } else {
      log.debug('scanner', '当前平台无监听枚举工具，仅探测白名单端口', { platform: process.platform });
      return [];
    }
    const out = await runEnumTool(cmd, args);
    if (out === null) {
      log.warn('scanner', '监听端口枚举失败，本轮跳过', { cmd });
      return null;
    }
    return parse(out);
  }

  async function cycle(): Promise<void> {
    if (cycleRunning) return; // 上一轮未结束（慢机器/枚举卡顿）：跳过本轮
    cycleRunning = true;
    try {
      const enumPorts = await enumerateListeners();
      if (enumPorts === null) return;
      const listening = new Set(enumPorts);
      // 进程已消失 → 立即除名；缓存一并遗忘（进程重开时按新端口重新探测）
      for (const p of [...services.keys()]) {
        if (listening.has(p)) continue;
        services.delete(p);
        strikes.delete(p);
        probeCache.delete(p);
        log.info('scanner', '服务除名（进程消失）', { port: p });
      }
      for (const p of [...probeCache.keys()]) {
        if (!listening.has(p)) probeCache.delete(p);
      }
      // 候选 = 枚举端口 ∪ 白名单，NEVER 永不上架
      const candidates = [...new Set([...enumPorts, ...whitelist])].filter((p) => !NEVER_PORTS.has(p));
      // 60s 缓存内沿用旧判定；过期/未判定的并行探测（并发 8），整轮耗时取决于最慢批次
      const now = Date.now();
      const stale = candidates.filter((p) => {
        const c = probeCache.get(p);
        return !c || now - c.ts >= PROBE_CACHE_TTL_MS;
      });
      let i = 0;
      const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, stale.length) }, async () => {
        while (i < stale.length) {
          const port = stale[i++];
          const info = await probePort(port).catch(() => null);
          probeCache.set(port, { info, ts: Date.now() });
        }
      });
      await Promise.all(workers);
      // 判定落地：website 上架/更名；仍监听但连续 2 轮非 website 除名（防抖，单次抖动不除名）
      for (const p of candidates) {
        const info = probeCache.get(p)?.info ?? null;
        if (info) {
          strikes.delete(p);
          const prev = services.get(p);
          if (!prev) {
            services.set(p, info);
            log.info('scanner', '服务上架', { port: p, name: info.name });
          } else if (prev.name !== info.name) {
            services.set(p, info);
          }
        } else if (services.has(p)) {
          const n = (strikes.get(p) ?? 0) + 1;
          if (n >= UNMOUNT_STRIKES) {
            services.delete(p);
            strikes.delete(p);
            probeCache.delete(p);
            log.info('scanner', '服务除名（连续非 website）', { port: p, strikes: n });
          } else {
            strikes.set(p, n);
          }
        }
      }
      log.debug('scanner', 'reconcile 完成', {
        listeners: enumPorts.length, candidates: candidates.length, probed: stale.length, services: services.size,
      });
    } catch (e) {
      log.error('scanner', '扫描周期异常（已兜底，下轮重试）', { err: e instanceof Error ? e.message : String(e) });
    } finally {
      cycleRunning = false;
    }
  }

  return {
    list: () => [...services.values()].sort((a, b) => a.port - b.port),
    start: () => {
      if (timer) return; // 幂等：重复 start 不叠加定时器
      void cycle();
      timer = setInterval(() => { void cycle(); }, RECONCILE_INTERVAL_MS);
      timer.unref();
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
