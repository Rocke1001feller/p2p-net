/** p2p-net service 常驻服务管理（Task 18）：install/uninstall/status/logs 四子命令。
 *
 *  平台策略（plan §5.2 + Controller 裁决）：
 *  - darwin → ~/Library/LaunchAgents/net.p2p-net.server.plist（launchctl bootstrap gui/$UID）；
 *    KeepAlive 崩溃自愈 + RunAtLoad 登录自启。
 *  - linux → ~/.config/systemd/user/p2p-net.service（systemctl --user enable --now）；
 *    Restart=always 崩溃自愈；只提示 loginctl enable-linger（需提权，不代跑）。
 *  - 其他平台（win32 等）→ 人话「暂不支持，Phase 2 规划」。
 *
 *  纪律：
 *  - spawn 特许：本子命令族的全部职能就是调 OS 服务管理器（裁决 #1）；
 *    一律 execFile 风格 argv 数组，绝不拼 shell 字符串；
 *  - 可测性：exec/platform/homeDir/uid/nodePath/tailFn 全经 deps 注入，单测绝不碰真实 launchctl/systemctl；
 *  - 幂等：写文件前 mkdir -p，unit 每次覆盖写；darwin 先 bootout（容忍失败）再 bootstrap；
 *  - 日志路径两平台统一 <configDir>/logs/service.log（T20 doctor 复用 serviceStatus 的精确形态）；
 *  - 模板在包根 assets/（../../assets/<name> 从 src/cli 与 dist/cli 同深度命中，contracts.ts 同款手法）；
 *    占位符 {{VAR}} 整体替换，plist 插值先 XML 转义，unit 插值转义 %、含空白路径加引号。
 */

import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ConfigError, loadAuth, loadConfig } from '../server/store.js';

// ---------- 类型与注入面 ----------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** execFile 风格进程执行（argv 数组、无 shell）；非零退出也 resolve，由调用方按 code 判定。 */
export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

export interface ServiceDeps {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
  /** 默认 process.execPath（裁决 #4）；测试注入以钉死输出。 */
  nodePath?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** logs -f 的 tail 进程（默认 spawn tail -n 50 [-f]，stdio 继承）；测试注入假实现。 */
  tailFn?: (logPath: string, follow: boolean) => Promise<number>;
}

/** service 预期失败（不支持平台/服务管理器拒绝）的统一人话错误：message 必带下一步。 */
export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  nodePath: string;
  lastCrashTail?: string;
}

// ---------- 常量 ----------

const LAUNCHD_LABEL = 'net.p2p-net.server';
const SYSTEMD_UNIT = 'p2p-net';
const LOG_FILE = join('logs', 'service.log');
const TAIL_LINES = 20;
const TAIL_MAX_BYTES = 64 * 1024;

// ---------- 纯渲染器 ----------

export interface RenderOpts {
  nodePath: string;
  entry: string;
  configDir: string;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** systemd unit 插值：% 是 specifier 必须转义为 %%；ExecStart 路径含空白时加双引号。 */
function systemdEscape(s: string, quoteWhitespace: boolean): string {
  let v = s.replace(/%/g, '%%');
  if (quoteWhitespace && /\s/.test(v)) v = `"${v.replace(/"/g, '\\"')}"`;
  return v;
}

function fillTemplate(name: string, vars: Record<string, string>): string {
  const tmpl = readFileSync(new URL(`../../assets/${name}`, import.meta.url), 'utf8');
  return tmpl.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
}

export function renderLaunchdPlist(opts: RenderOpts): string {
  return fillTemplate('launchd.plist.tmpl', {
    LABEL: LAUNCHD_LABEL,
    NODE_PATH: xmlEscape(opts.nodePath),
    ENTRY: xmlEscape(opts.entry),
    LOG_PATH: xmlEscape(join(opts.configDir, LOG_FILE)),
  });
}

export function renderSystemdUnit(opts: RenderOpts): string {
  return fillTemplate('systemd-user.service.tmpl', {
    NODE_PATH: systemdEscape(opts.nodePath, true),
    ENTRY: systemdEscape(opts.entry, true),
    LOG_PATH: systemdEscape(join(opts.configDir, LOG_FILE), false),
  });
}

/** node 来自 nvm/fnm/volta/asdf/n 等版本管理器路径时给出警告（不阻断）；否则 null。 */
export function warnIfVolatileNodePath(nodePath: string): string | null {
  if (!/(\.nvm|\/n\/versions|fnm|volta|asdf|nodenv|nvs)/i.test(nodePath)) return null;
  return `警告：node 路径来自版本管理器（nvm/fnm/volta 等易变路径）${nodePath}——切换默认版本后常驻服务会因路径失效而无法启动，届时请重跑 p2p-net service install`;
}

/**
 * 安装预检（I2 onboarding 顺序修复）：常驻单元跑的是 start --foreground，缺 config.json 或
 * auth.json 即启动即退，launchd KeepAlive / systemd Restart=always 会把它拉成 crash-loop——
 * 用户看到的只是「装完不好用」。把失败提前到安装这一刻：config/auth 必须齐备且可解析。
 */
function assertRunnableConfig(configDir: string): void {
  try {
    loadConfig(configDir);
  } catch (e) {
    if (e instanceof ConfigError) {
      throw new ServiceError(`无法安装常驻服务：${e.message}（服务以 start --foreground 运行，配置必须先就绪）`);
    }
    throw e;
  }
  let auth: unknown;
  try {
    auth = loadAuth(configDir);
  } catch (e) {
    if (e instanceof ConfigError) {
      throw new ServiceError(`无法安装常驻服务：${e.message}（凭据损坏会让服务启动即退、反复重启）`);
    }
    throw e;
  }
  if (!auth) {
    throw new ServiceError(`无法安装常驻服务：未登录（缺 ${join(configDir, 'auth.json')}）——请先运行 p2p-net login，并用 p2p-net start 前台验证可用后再安装常驻服务`);
  }
}

// ---------- 平台路径与默认实现 ----------

function resolveCtx(deps: ServiceDeps): { platform: NodeJS.Platform; homeDir: string; uid: number; exec: ExecFn; out: (l: string) => void } {
  return {
    platform: deps.platform ?? process.platform,
    homeDir: deps.homeDir ?? homedir(),
    uid: deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0),
    exec: deps.exec ?? defaultExec,
    out: deps.out ?? ((line: string) => console.log(line)),
  };
}

function unitPathFor(platform: NodeJS.Platform, homeDir: string): { unitDir: string; unitPath: string } {
  if (platform === 'darwin') {
    const unitDir = join(homeDir, 'Library', 'LaunchAgents');
    return { unitDir, unitPath: join(unitDir, `${LAUNCHD_LABEL}.plist`) };
  }
  if (platform === 'linux') {
    const unitDir = join(homeDir, '.config', 'systemd', 'user');
    return { unitDir, unitPath: join(unitDir, `${SYSTEMD_UNIT}.service`) };
  }
  throw new ServiceError(`当前平台（${platform}）暂不支持常驻服务，Phase 2 规划；可先 p2p-net start 前台运行`);
}

/** 当前包自身的 CLI 入口（裁决 #9）：dist 下为 dist/cli/bin.js；dev（tsx）下指向 src/cli，可接受。 */
function packageEntry(): string {
  return fileURLToPath(new URL('./bin.js', import.meta.url));
}

const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const raw = (err as { code?: unknown }).code;
      resolve({ code: typeof raw === 'number' ? raw : 127, stdout: stdout ?? '', stderr: stderr || err.message });
    });
  });

const defaultTail = (logPath: string, follow: boolean): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn('tail', ['-n', String(TAIL_LINES), ...(follow ? ['-f'] : []), logPath], { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 0));
  });

// ---------- install / uninstall ----------

export async function installService(opts: { configDir: string }, deps: ServiceDeps = {}): Promise<{ unitPath: string }> {
  const { platform, homeDir, uid, exec, out } = resolveCtx(deps);
  const { unitDir, unitPath } = unitPathFor(platform, homeDir);
  assertRunnableConfig(opts.configDir);
  const nodePath = deps.nodePath ?? process.execPath;
  const rendered =
    platform === 'darwin'
      ? renderLaunchdPlist({ nodePath, entry: packageEntry(), configDir: opts.configDir })
      : renderSystemdUnit({ nodePath, entry: packageEntry(), configDir: opts.configDir });

  // 幂等：目录先建（logs 目录必须存在，launchd 不会替 StandardOutPath 建目录），unit 覆盖写
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(join(opts.configDir, 'logs'), { recursive: true });
  writeFileSync(unitPath, rendered, 'utf8');

  if (platform === 'darwin') {
    await exec('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]); // 未加载时失败属正常，忽略
    const r = await exec('launchctl', ['bootstrap', `gui/${uid}`, unitPath]);
    if (r.code !== 0) {
      throw new ServiceError(
        `launchctl bootstrap 失败（exit ${r.code}）：${(r.stderr || r.stdout).trim()}。可尝试 p2p-net service uninstall 后重跑 p2p-net service install`,
      );
    }
  } else {
    const reload = await exec('systemctl', ['--user', 'daemon-reload']);
    if (reload.code !== 0) {
      throw new ServiceError(`systemctl --user daemon-reload 失败（exit ${reload.code}）：${(reload.stderr || reload.stdout).trim()}。请确认 systemd --user 会话可用（loginctl）`);
    }
    const enable = await exec('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
    if (enable.code !== 0) {
      throw new ServiceError(`systemctl --user enable --now 失败（exit ${enable.code}）：${(enable.stderr || enable.stdout).trim()}。可尝试 p2p-net service uninstall 后重跑 p2p-net service install`);
    }
  }

  const warn = warnIfVolatileNodePath(nodePath);
  if (warn) out(warn);
  out(`常驻服务已安装并启动：${unitPath}`);
  out(`日志：${join(opts.configDir, LOG_FILE)}（p2p-net service logs -f 跟随）；状态：p2p-net service status`);
  if (platform === 'linux') {
    out('提示：如需断 ssh/登出后仍存活，请执行 loginctl enable-linger $USER（需要管理员授权，本命令不代跑）');
  }
  return { unitPath };
}

export async function uninstallService(deps: ServiceDeps = {}): Promise<void> {
  const { platform, homeDir, uid, exec, out } = resolveCtx(deps);
  const { unitPath } = unitPathFor(platform, homeDir);
  if (platform === 'darwin') {
    await exec('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]); // 容忍「未加载」
  } else {
    await exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]); // 容忍「未启用」
    await exec('systemctl', ['--user', 'daemon-reload']);
  }
  rmSync(unitPath, { force: true });
  out(`常驻服务已卸载：${unitPath}（配置与日志保留在 ~/.p2p-net，重装 p2p-net service install 即可）`);
}

// ---------- status（T20 doctor 复用，形态钉死） ----------

export async function serviceStatus(opts: { configDir?: string } = {}, deps: ServiceDeps = {}): Promise<ServiceStatus> {
  const { platform, homeDir, uid, exec } = resolveCtx(deps);
  const { unitPath } = unitPathFor(platform, homeDir);
  const configDir = opts.configDir ?? join(homeDir, '.p2p-net');
  const nodePath = deps.nodePath ?? process.execPath;

  const installed = existsSync(unitPath);
  let running = false;
  if (installed) {
    if (platform === 'darwin') {
      const r = await exec('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`]);
      running = r.code === 0; // 「Could not find service」等非零一律按未运行
    } else {
      const r = await exec('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]);
      running = r.code === 0 && r.stdout.trim() === 'active';
    }
  }

  const tail = readTail(join(configDir, LOG_FILE), TAIL_LINES);
  return { installed, running, nodePath, ...(tail ? { lastCrashTail: tail } : {}) };
}

// ---------- CLI 子命令分发（bin 接线） ----------

export interface RunServiceDeps extends ServiceDeps {
  configDir?: string;
}

const USAGE = '用法：p2p-net service install|uninstall|status|logs [-f]';

export async function runService(argv: string[], deps: RunServiceDeps = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: { follow: { type: 'boolean', short: 'f', default: false } },
  });
  const sub = positionals[0];
  if (sub === undefined) throw new ServiceError(`缺少 service 子命令。${USAGE}`);
  if (!['install', 'uninstall', 'status', 'logs'].includes(sub)) {
    throw new ServiceError(`未知 service 子命令：${sub}。${USAGE}`);
  }

  const homeDir = deps.homeDir ?? homedir();
  const configDir = deps.configDir ?? join(homeDir, '.p2p-net');
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));

  if (sub === 'install') {
    await installService({ configDir }, deps);
    return 0;
  }
  if (sub === 'uninstall') {
    await uninstallService(deps);
    return 0;
  }
  if (sub === 'status') {
    const s = await serviceStatus({ configDir }, deps);
    if (!s.installed) {
      out('常驻服务未安装：p2p-net service install 可安装（崩溃自愈 + 开机自启）');
      return 0;
    }
    out(`常驻服务已安装：${s.running ? '运行中' : '已安装但未运行（p2p-net service logs 查看日志）'}`);
    out(`node：${s.nodePath}`);
    if (s.lastCrashTail) out(`最近日志尾部：\n${s.lastCrashTail}`);
    return 0;
  }

  // logs：无 -f 直接读尾行（不 spawn）；-f 走 tail -f（特许 spawn，stdio 继承）
  const logPath = join(configDir, LOG_FILE);
  if (!existsSync(logPath)) {
    err(`暂无日志 ${logPath}：服务可能尚未运行（p2p-net service status 查看状态，p2p-net service install 安装常驻服务）`);
    return 1;
  }
  if (values.follow) return (deps.tailFn ?? defaultTail)(logPath, true);
  const tail = readTail(logPath, TAIL_LINES * 3);
  if (tail) for (const line of tail.split('\n')) out(line);
  return 0;
}

// ---------- 工具 ----------

/** 读文件最后 maxLines 行（字节封顶 TAIL_MAX_BYTES，大日志不整读）；文件缺失/为空返回 undefined。 */
function readTail(path: string, maxLines: number): string | undefined {
  try {
    const size = statSync(path).size;
    if (size === 0) return undefined;
    const readLen = Math.min(size, TAIL_MAX_BYTES);
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, size - readLen);
      const lines = buf.toString('utf8').replace(/\n$/, '').split('\n');
      return lines.slice(-maxLines).join('\n');
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined; // best-effort：日志读不得让 status/logs 崩
  }
}
