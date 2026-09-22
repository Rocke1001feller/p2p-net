/** p2p-net start 前台编排（Task 17）：把前面各任务的零件装成一台常驻前台进程。
 *
 *  装配顺序（plan 裁决，测试钉死）：
 *  loadConfig → loadAuth（无则引导 p2p-net login）→ ensureFreshToken（变更即重存 auth.json）
 *  → bind_device_auth RPC 取 deviceId（落 config.json 复用；已有 deviceId 直接复用不打 RPC）
 *  → createScanner().start() → startControlPlane/startDiscovery（只绑 127.0.0.1）
 *  → new HostAgent（isPortAllowed 白名单必传，§5.3 安全洞）→ 每 relay 一条 TunnelClient
 *  （token = HMAC(tunnelSecret, deviceId)，secret 从 0600 config.json 读）
 *  → 配对环：每台 relay 打 https://<ip>/connect?… URL + qrcode-terminal QR
 *  → 运行期 token 周期续期（默认 10min，远小于 JWT ~1h TTL）。
 *
 *  纪律：
 *  - 薄编排：这里只有接线，业务逻辑都在被装配的模块里；
 *  - token/tunnelSecret 绝不进 stdout/日志（终端 URL 含 ticketId+deviceId 是产品设计）；
 *  - 可测性：全部外部面经 deps 注入（ruling #9），生产全走默认值；
 *  - 长驻进程：装配走 teardown 栈——中途任何一步抛错，已启动组件反向逐个收尾后原样重抛；
 *    stop() 跑同一栈（配对环/refresher/隧道/HostAgent/scanner/两个 http server）。
 */

import { createHmac } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import qrcode from 'qrcode-terminal';

import { PORTS } from '../contracts.js';
import { HostAgent, type HostAgentOptions, type HostStatus } from '../host.js';
import { createLogger, type Logger } from '../log/logger.js';
import { ensureFreshToken, type AuthState } from '../server/auth.js';
import { startControlPlane, startDiscovery } from '../server/control.js';
import { aggregateSessions, recordSessionEvent, type SessionEvent } from '../server/events.js';
import { bindDeviceAuth, fetchTurnCredentials, startPairingLoop, type PairingHandle, type TicketStatus } from '../server/pairing.js';
import { createScanner, DEFAULT_WHITELIST, NEVER_PORTS, type Scanner, type ServiceInfo } from '../server/scanner.js';
import { loadAuth, loadConfig, saveAuth, saveConfig, type AppConfig } from '../server/store.js';
import { TunnelClient } from '../tunnel/client.js';

/** 控制面/发现端点的最小收尾面（生产为 node:http Server，测试注入假 server）。 */
export interface ServerLike {
  close(cb?: (err?: Error) => void): void;
}

/** HostAgent 的最小装配面（测试注入假 agent 断言参数）。 */
export interface HostAgentLike {
  start(): void;
  stop(): void;
}

/** TunnelClient 的最小装配面。 */
export interface TunnelClientLike {
  connect(url: string): void;
  onFrame(cb: (frame: unknown) => void): void;
  onReconnect(cb: () => void): void;
  close(): void;
}

export interface RunStartOptions {
  /** T18 常驻服务以 --foreground 调用：抑制「未安装常驻服务」横幅。 */
  foreground?: boolean;
}

export interface RunStartDeps {
  configDir?: string;
  log?: Logger;
  out?: (line: string) => void;
  /** QR 图形打印（默认 qrcode-terminal small 图打到 stdout）。 */
  printQr?: (text: string) => void;
  fetchImpl?: typeof fetch;
  loadConfigFn?: typeof loadConfig;
  saveConfigFn?: typeof saveConfig;
  loadAuthFn?: typeof loadAuth;
  saveAuthFn?: typeof saveAuth;
  ensureFreshTokenFn?: typeof ensureFreshToken;
  bindDeviceFn?: typeof bindDeviceAuth;
  createScannerFn?: typeof createScanner;
  startControlPlaneFn?: (opts: { log: Logger; getStatus(): unknown }) => ServerLike;
  startDiscoveryFn?: (opts: { log: Logger; getServices(): ServiceInfo[]; deviceId(): string }) => ServerLike;
  hostAgentFactory?: (opts: HostAgentOptions) => HostAgentLike;
  tunnelFactory?: () => TunnelClientLike;
  issuePairingTicketFn?: (cfg: AppConfig, accessToken: string) => Promise<{ ticketId: string }>;
  pollTicketStatusFn?: (cfg: AppConfig, accessToken: string, ticketId: string) => Promise<TicketStatus>;
  /** 运行期 token 周期续期间隔（默认 10min；测试注入小值）。 */
  tokenRefreshIntervalMs?: number;
}

/** start 进程句柄：stop() 反向收尾全部组件（SIGINT 由 bin 接线 → handle.stop()）。 */
export interface StartHandle {
  stop(): Promise<void>;
}

/** 运行期 token 续期默认周期：10min（GoTrue JWT 默认 1h TTL，留足重试余量）。 */
const TOKEN_REFRESH_INTERVAL_MS = 10 * 60_000;

/** 会话事件环形缓冲容量（Task 19 ruling #3）：FIFO 丢最旧；events.jsonl 写透不受其影响。 */
const EVENT_RING_CAPACITY = 2000;

export async function runStart(opts: RunStartOptions = {}, deps: RunStartDeps = {}): Promise<StartHandle> {
  const dir = deps.configDir ?? join(homedir(), '.p2p-net');
  const log = deps.log ?? createLogger({ dir: join(dir, 'logs'), comp: 'cli-start' });
  const out = deps.out ?? ((line: string) => console.log(line));
  const printQr = deps.printQr ?? ((text: string) => qrcode.generate(text, { small: true }, (qr: string) => out(qr)));
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const saveConfigFn = deps.saveConfigFn ?? saveConfig;
  const loadAuthFn = deps.loadAuthFn ?? loadAuth;
  const saveAuthFn = deps.saveAuthFn ?? saveAuth;
  const ensureFreshTokenFn = deps.ensureFreshTokenFn ?? ensureFreshToken;
  const bindDeviceFn = deps.bindDeviceFn ?? bindDeviceAuth;

  // 1) 配置（缺失/畸形 → ConfigError 人话，引导 init）
  const cfg = loadConfigFn(dir);

  // 2) 登录态（缺失 → 引导 login；形态异常 → 引导重登）
  const auth0 = asAuthState(loadAuthFn(dir));
  if (!auth0) throw new Error('未登录或登录态损坏：请先运行 p2p-net login 登录后再启动');

  // 3) 续期：返回对象变更（引用不等）即重存 auth.json；AuthError 人话直接上抛（bin 打印，exit 1）。
  //    注意 let 有意为之：运行期周期 refresher（步骤 10）会按引用重赋值，
  //    HostAgent/turnFetcher/配对环的 accessToken 闭包下次读取即得新令牌。
  let auth = await ensureFreshTokenFn(cfg, auth0);
  if (auth !== auth0) saveAuthFn(dir, auth);

  // 4) deviceId：config 已有则复用；否则 bind_device_auth RPC 取回并落 config.json
  let deviceId = cfg.deviceId;
  if (!deviceId) {
    deviceId = await bindDeviceFn(cfg, auth.accessToken, fetchImpl);
    saveConfigFn(dir, { ...cfg, deviceId });
  }

  if (!opts.foreground) {
    out('未安装常驻服务：p2p-net service install 可后台常驻（当前前台运行，Ctrl+C 退出）');
  }

  // 装配 teardown 栈：每起步成功即入栈；中途抛错反向逐个收尾（各自 guard，绝不遮罩原始错误），
  // stop() 复用同一栈。splice 排空保证二次执行为空转。
  const teardowns: Array<() => void | Promise<void>> = [];
  const runTeardowns = async (): Promise<void> => {
    for (const td of teardowns.splice(0).reverse()) {
      try {
        await td();
      } catch {
        // best-effort 收尾：单个组件收尾失败不得中断其余组件
      }
    }
  };

  let stopped = false;
  let host: HostAgentLike;
  let pairing: PairingHandle | null = null;
  const tunnels: TunnelClientLike[] = [];
  let scanner: Scanner;
  let control: ServerLike;
  let discovery: ServerLike;

  try {
    // 5) 端口扫描器
    const scannerFn = deps.createScannerFn ?? createScanner;
    scanner = scannerFn({ log });
    scanner.start();
    teardowns.push(() => scanner.stop());

    // HostAgent 端口白名单（ruling #3）：默认白名单 ∪ 扫描结果 ∪ 发现端点，NEVER 集合防御性排除。
    // 注意 DISCOVERY_PORT 本身在 NEVER 集合（防 scanner 上架），但对桥必须显式放行——PWA 经桥拉 /services。
    const isPortAllowed = (port: number): boolean => {
      if (port === PORTS.DISCOVERY_PORT) return true;
      if (NEVER_PORTS.has(port)) return false;
      if (DEFAULT_WHITELIST.includes(port)) return true;
      return scanner.list().some((s) => s.port === port);
    };

    // 6) 本地控制面 + 发现端点（只绑 127.0.0.1；getStatus 为 Task 19 真聚合形态）
    //
    // 会话事件流（Task 19，plan 裁决 #2——映射语义勿改）：
    //   connected    → session_start(sid=clientKey) + cascade_choice(mode=pairType ?? 'p2p', rttMs)
    //   closed       → session_end(reason='closed')；failed → session_end(reason='failed')
    //   connecting/disconnected → 无会话事件（disconnected 是 ICE 可自愈瞬时态，
    //     见 peer.ts 2026-09-12 修复注释——绝不能因抖动终结会话）
    // Dedupe：Peer 每 5s 经 stats 定时器重发状态（peer.ts scheduleStats），逐 sid 记最后签名
    //   (state|pairType|rttMs)，完全相同的状态零事件；openSids 保证同 sid 无 end 不重发
    //   session_start，session_end 也只对有 start 的 sid 发一次。
    // record 单调用点（ruling #3）：写透 log.event（events.jsonl，轮转归 logger）+ 入环形缓冲
    //   喂 getStatus().sessions 实时聚合。事件只带 sid/mode/rtt/reason，token/secret 绝不进。
    const eventRing: SessionEvent[] = [];
    const openSids = new Set<string>();
    const lastSig = new Map<string, string>();
    const record = (e: SessionEvent): void => {
      recordSessionEvent(log, e);
      if (eventRing.length >= EVENT_RING_CAPACITY) eventRing.shift(); // FIFO 丢最旧
      eventRing.push(e);
    };
    const onHostStatus = (s: HostStatus): void => {
      const sid = s.clientKey;
      if (!sid) return;
      const sig = `${s.state}|${s.pairType}|${s.rttMs ?? ''}`;
      if (lastSig.get(sid) === sig) return; // 重复相同状态：零事件（stats 轮询不刷屏）
      lastSig.set(sid, sig);
      if (s.state === 'connected') {
        if (!openSids.has(sid)) {
          openSids.add(sid);
          record({ name: 'session_start', sid });
        }
        record({ name: 'cascade_choice', sid, mode: s.pairType ?? 'p2p', ...(s.rttMs !== undefined ? { rttMs: s.rttMs } : {}) });
      } else if (s.state === 'closed' || s.state === 'failed') {
        if (openSids.delete(sid)) {
          lastSig.delete(sid);
          record({ name: 'session_end', sid, reason: s.state });
        }
      }
    };
    const startControlFn = deps.startControlPlaneFn ?? startControlPlane;
    control = startControlFn({
      log,
      getStatus: () => ({
        uptime: process.uptime(),
        deviceId: deviceId!,
        sessions: aggregateSessions(eventRing),
        services: scanner.list().length,
        mode: 'foreground',
      }),
    });
    teardowns.push(() => closeServer(control));
    const startDiscoveryFn = deps.startDiscoveryFn ?? startDiscovery;
    discovery = startDiscoveryFn({ log, getServices: () => scanner.list(), deviceId: () => deviceId! });
    teardowns.push(() => closeServer(discovery));

    // 7) HostAgent（WebRTC 主路径；构造后需 start() 才开始信令轮询）
    const hostFactory = deps.hostAgentFactory ?? ((o: HostAgentOptions) => new HostAgent(o));
    host = hostFactory({
      supabaseUrl: cfg.supabaseUrl,
      publishableKey: cfg.publishableKey,
      accessToken: () => auth.accessToken,
      deviceId,
      uid: auth.uid,
      turnFetcher: () => fetchTurnCredentials(cfg, auth.accessToken, fetchImpl),
      isPortAllowed,
      onStatus: onHostStatus, // host_status 事件已折叠进会话事件流（session_start/cascade_choice/session_end）
    });
    host.start();
    teardowns.push(() => host.stop());

    // 8) 每 relay 一条 TunnelClient（兜底路径；帧路由按 ruling #2 不在本任务，仅接重连日志）
    const tunnelFactory = deps.tunnelFactory ?? (() => new TunnelClient());
    const tunnelToken = createHmac('sha256', cfg.tunnelSecret).update(deviceId).digest('hex');
    for (const relay of cfg.relays) {
      const t = tunnelFactory();
      t.onReconnect(() => {
        log.info('tunnel', '隧道断线重连成功', { ip: relay.ip });
        record({ name: 'tunnel_reconnect', sid: relay.ip }); // ruling #2：sid = relay ip
      });
      // URL 含 token，绝不进日志/stdout
      t.connect(`wss://${relay.ip}/tunnel/desktop?sid=${deviceId}&token=${tunnelToken}`);
      tunnels.push(t);
      log.info('tunnel', '隧道已发起连接', { ip: relay.ip });
    }
    teardowns.push(() => {
      for (const t of tunnels) t.close();
    });

    // 9) 配对环：每台 relay 打 URL + QR，过期自动换票重打（环内失败只 warn 不 crash）
    if (cfg.relays.length > 0) {
      pairing = startPairingLoop(
        {
          cfg,
          accessToken: () => auth.accessToken,
          relays: cfg.relays,
          deviceId,
          log,
          printTicket: (ip, url) => {
            out(`Relay ${ip} 配对链接（120s 有效，过期自动换新票）：`);
            out(url);
            printQr(url);
          },
        },
        {
          fetchImpl,
          issueTicket: deps.issuePairingTicketFn,
          pollStatus: deps.pollTicketStatusFn,
        },
      );
      teardowns.push(() => pairing?.stop());
    } else {
      log.warn('pairing', 'config.json 无 relays，跳过配对出票');
    }

    // 10) 运行期 token 周期续期：JWT ~1h 到期，10min 周期保证常驻进程（service install 场景）
    //     各 accessToken 闭包读到的永远新鲜。AuthError（冷却/硬失败）记人话日志保活进程
    //     ——隧道无需 JWT 仍工作；绝不抛错、绝不甩堆栈、绝不记令牌。
    const refreshTimer = setInterval(() => {
      void (async () => {
        try {
          const fresh = await ensureFreshTokenFn(cfg, auth);
          if (stopped) return; // stop 后在途续期落定：不写盘、不重赋值
          if (fresh !== auth) {
            auth = fresh;
            saveAuthFn(dir, auth);
            log.info('auth', '访问令牌已周期续期并重存');
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log.error('auth', msg); // AuthError 文案已含 p2p-net login 指引
          log.event('auth_refresh_failed', { err: msg });
        }
      })();
    }, deps.tokenRefreshIntervalMs ?? TOKEN_REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
    teardowns.push(() => clearInterval(refreshTimer));
  } catch (e) {
    await runTeardowns();
    log.warn('service', 'start 装配中途失败，已回退全部已启动组件', { err: e instanceof Error ? e.message : String(e) });
    throw e; // 原始错误原样传播（bin 打印人话，exit 1）
  }

  out(`p2p-net 已启动（前台模式）：控制面 http://127.0.0.1:${PORTS.CONTROL_PORT}/status，发现端点 http://127.0.0.1:${PORTS.DISCOVERY_PORT}/services`);
  log.event('start_ready', { deviceId, relays: cfg.relays.length });

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await runTeardowns();
      log.info('service', 'p2p-net start 已停止');
      log.flush();
    },
  };
}

/** loadAuth 返回 unknown：校验 AuthState 形态，畸形按未登录处理（引导重登）。 */
function asAuthState(raw: unknown): AuthState | null {
  const o = raw as Partial<AuthState> | null;
  if (typeof o !== 'object' || o === null) return null;
  if (typeof o.accessToken !== 'string' || !o.accessToken) return null;
  if (typeof o.refreshToken !== 'string' || !o.refreshToken) return null;
  if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) return null;
  if (typeof o.uid !== 'string' || !o.uid) return null;
  if (typeof o.email !== 'string' || !o.email) return null;
  return o as AuthState;
}

function closeServer(srv: ServerLike): Promise<void> {
  return new Promise((resolve) => {
    try {
      srv.close(() => resolve());
    } catch {
      resolve();
    }
  });
}
