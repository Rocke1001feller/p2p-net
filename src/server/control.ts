/** 本地控制面与发现端点（Task 16 产出，Task 17 start 编排消费；PWA 侧机器经 /services 拉服务清单）。
 *  两个 node:http 平面都只绑 127.0.0.1（安全：仅本机可达，绝不绑 0.0.0.0）：
 *  - 控制面 CONTROL_PORT：GET /status 透传 getStatus()（{uptime,deviceId,sessions,services,mode}
 *    真聚合形态由 Task 19 在 start.ts 填充；本文件只做原样透传，不理解字段）。
 *  - 发现端点 DISCOVERY_PORT：GET /services → { console, services, self }；
 *    console 一期为空数组占位（字段保留），services 由 Task 15 scanner 清单映射为 { name, url: '/s/<port>/' }。
 *  端口占用必须同步抛人话：node:http 的 EADDRINUSE 只经异步 'error' 事件送达，listen+on('error')
 *  无法满足「启动即知占用」的同步语义，故 listen 前用 execFileSync(lsof/ss) 同步预检
 *  （argv 数组、无 shell——Task 15 已立的 plan 特许 OS 内省先例，此处同例外）；
 *  预检→listen 之间的抢端口竞态由异步 'error' 兜底：记人话日志，不让进程带裸堆栈崩掉。
 */

import { execFileSync } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { PORTS } from '../contracts.js';
import type { Logger } from '../log/logger.js';
import type { ServiceInfo } from './scanner.js';

/** 仅本机回环：控制面/发现端点绝不监听外部接口。 */
const BIND_HOST = '127.0.0.1';

/** 控制面：GET /status → getStatus() 原样透传。port 缺省取契约 CONTROL_PORT；测试传 0 走 OS 动态端口。 */
export function startControlPlane(opts: { log: Logger; getStatus(): unknown; port?: number }): Server {
  const port = opts.port ?? PORTS.CONTROL_PORT;
  assertPortFree(port);
  const srv = createServer((req, res) => {
    try {
      if (req.method === 'GET' && pathOf(req.url) === '/status') {
        sendJson(res, 200, opts.getStatus());
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      opts.log.error('service', '控制面请求处理异常', { err: errMsg(e) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.end();
    }
  });
  listenWithHumanError(srv, port, opts.log, '控制面');
  return srv;
}

/** 发现端点：GET /services → { console: [], services: [{name,url}], self: {deviceId} }。port 缺省取契约 DISCOVERY_PORT；测试传 0 走 OS 动态端口。 */
export function startDiscovery(opts: { log: Logger; getServices(): ServiceInfo[]; deviceId(): string; port?: number }): Server {
  const port = opts.port ?? PORTS.DISCOVERY_PORT;
  assertPortFree(port);
  const srv = createServer((req, res) => {
    try {
      if (req.method === 'GET' && pathOf(req.url) === '/services') {
        sendJson(res, 200, {
          console: [],
          services: opts.getServices().map((s) => ({ name: s.name, url: `/s/${s.port}/` })),
          self: { deviceId: opts.deviceId() },
        });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      opts.log.error('service', '发现端点请求处理异常', { err: errMsg(e) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.end();
    }
  });
  listenWithHumanError(srv, port, opts.log, '发现端点');
  return srv;
}

/** 占用提示统一文案：报「哪个端口 + 可能是谁 + 怎么办」，不甩 EADDRINUSE 堆栈。 */
function humanPortMessage(port: number): string {
  return `${port} 被占用：可能已有一个 p2p-net 实例，运行 \`p2p-net status\` 确认`;
}

/** listen 前同步预检：确认端口空闲才继续，被占则同步抛人话（满足启动即知占用语义）。
 *  port=0 由 OS 分配动态端口，无可预检，直接放行。
 *  平台无枚举工具时返回 null = 无法预检，放行给 listen 的异步 'error' 兜底。 */
function assertPortFree(port: number): void {
  if (port === 0) return;
  if (isPortListening(port) === true) throw new Error(humanPortMessage(port));
}

/** 同步查端口是否有 LISTEN：macOS lsof / Linux ss（argv 数组、无 shell）。
 *  true=被占；false=空闲；null=工具不可用（无法判定）。 */
function isPortListening(port: number): boolean | null {
  const tool = process.platform === 'darwin'
    ? { cmd: 'lsof', args: ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'] }
    : process.platform === 'linux'
      ? { cmd: 'ss', args: ['-ltnH', `sport = :${port}`] }
      : null;
  if (!tool) return null;
  try {
    const out = execFileSync(tool.cmd, tool.args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() !== '';
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer };
    // 进程跑完但退出码非 0：lsof 无匹配时退出码 1（合法空结果），按 stdout 是否为空判定
    if (typeof err.status === 'number') return String(err.stdout ?? '').trim() !== '';
    return null; // 工具不可用（ENOENT 等）：无法预检
  }
}

/** 绑回环并 listen；异步 'error'（预检后被抢端口等竞态）翻译为人话日志，不裸崩。 */
function listenWithHumanError(srv: Server, port: number, log: Logger, plane: string): void {
  srv.on('error', (e) => {
    const err = e as NodeJS.ErrnoException;
    log.error(
      'service',
      err.code === 'EADDRINUSE' ? humanPortMessage(port) : `${plane}监听失败：${err.message}`,
      { port },
    );
  });
  srv.on('listening', () => log.info('service', `${plane}已监听`, { bind: BIND_HOST, port }));
  srv.listen(port, BIND_HOST);
}

function pathOf(url: string | undefined): string {
  return new URL(url ?? '/', `http://${BIND_HOST}`).pathname;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
