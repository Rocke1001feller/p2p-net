/** p2p-net start 前台编排（Task 17）：把前面各任务的零件装成一台常驻前台进程。
 *
 *  装配顺序（plan 裁决，测试钉死）：
 *  loadConfig → loadAuth（无则引导 p2p-net login）→ ensureFreshToken（变更即重存 auth.json）
 *  → bind_device_auth RPC 取 deviceId（落 config.json 复用；已有 deviceId 直接复用不打 RPC）
 *  → createScanner().start() → startControlPlane/startDiscovery（只绑 127.0.0.1）
 *  → new HostAgent（isPortAllowed 白名单必传，§5.3 安全洞）
 *  → 每 relay 一条隧道链路（token = HMAC(tunnelSecret, deviceId)，secret 从 0600 config.json 读）：
 *    TunnelClient 帧 → 解析 /s/<port>/ 前缀 → 白名单闸门（与 WebRTC 桥同口径，fail-closed）
 *    → 派发进该链路专属 HttpBridge/WsBridge；重连清场，坏帧逐帧隔离不杀进程。
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

import { HttpBridge, dcSend, type DcLike } from '../bridge/http.js';
import { WsBridge } from '../bridge/ws.js';
import { PORTS } from '../contracts.js';
import { isReq, isReqAbort, isWsClose, isWsMsg, isWsOpen } from '../frames.js';
import { HostAgent, type HostAgentOptions, type HostStatus, type SessionLedger } from '../host.js';
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
  /** 数据面计量快照（Task 5，spec D5/D8+D9）：假 agent/旧装配可无此方法（/status 容错为 null）。 */
  dataPlaneSnapshot?(): { totals: SessionLedger; sessions: number; byPath: Record<string, number> };
}

/** TunnelClient 的最小装配面（含数据面接线所需的 send/isOpen）。 */
export interface TunnelClientLike {
  connect(url: string): void;
  /** 帧出口：桥的回帧（res-head/res-chunk/ws-*）经此发往 relay。 */
  send(obj: unknown): void;
  /** 当前连接是否 OPEN（dc shim 的 readyState 语义来源；断开即丢帧，relay 侧 504 兜底）。 */
  readonly isOpen: boolean;
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
const TOKEN_REFRESH_INTERVAL_MS = 10 * 60_000; // 必须小于 auth.ts 的 EXPIRY_MARGIN_MS（11min），否则出现令牌到期致聋窗口

/** 会话事件环形缓冲容量（Task 19 ruling #3）：FIFO 丢最旧；events.jsonl 写透不受其影响。 */
const EVENT_RING_CAPACITY = 2000;

/** cascade_choice 的 RTT 节流阈值（ms）：|Δrtt| ≥ 此值（vs 上次已发基线）才补发事件。 */
const RTT_EMIT_THRESHOLD_MS = 15;

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
  /** 每条隧道 = 客户端 + 其专属本地桥（桥持有在途请求/代理 socket，必须随隧道同生共死）。 */
  const tunnels: Array<{ client: TunnelClientLike; httpBridge: HttpBridge; wsBridge: WsBridge }> = [];
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
    // cascade_choice 节流（2026-09-22 评审修复）：Peer 每 ~5s 经 stats 定时器重发状态
    //   （peer.ts scheduleStats），真实网络 RTT 在整数毫秒粒度几乎每轮都变——若按原始
    //   (state|pairType|rttMs) 签名去重，稳态每会话 ~720 事件/h，~2.8h 就把该会话的
    //   session_start 挤出 2000 容量环形缓冲，aggregateSessions 因找不到 start 忽略其
    //   cascade → status 对健康会话谎报活跃 0。故只在 (a) pairType 变化，或
    //   (b) |ΔrttMs| ≥ RTT_EMIT_THRESHOLD_MS（vs 该 sid **上次已发**的 rtt，而非上次观测
    //   ——基线随发射更新，慢速爬升累计越阈也会发一次；rtt 从无到有视为建立基线发一次）
    //   时才发 cascade_choice。session_start/session_end 语义不变（openSids：同 sid 无
    //   end 不重发 start，end 只发一次）。
    //   残余风险（已知并接受）：即便节流 10-100x，多周长驻 daemon 仍可能把 start 挤出环
    //   ——MVP 接受，已记控制器台账。
    // record 单调用点（ruling #3）：写透 log.event（events.jsonl，轮转归 logger）+ 入环形缓冲
    //   喂 getStatus().sessions 实时聚合。事件只带 sid/mode/rtt/reason，token/secret 绝不进。
    const eventRing: SessionEvent[] = [];
    const openSids = new Set<string>();
    /** 逐 sid 的「上次已发」cascade 基线（仅发射时更新——节流判据，非上次观测值）。 */
    const lastCascade = new Map<string, { mode: 'p2p' | 'relay'; rttMs?: number }>();
    const record = (e: SessionEvent): void => {
      recordSessionEvent(log, e);
      if (eventRing.length >= EVENT_RING_CAPACITY) eventRing.shift(); // FIFO 丢最旧
      eventRing.push(e);
    };
    const onHostStatus = (s: HostStatus): void => {
      const sid = s.clientKey;
      if (!sid) return;
      if (s.state === 'connected') {
        const mode = s.pairType ?? 'p2p';
        const emitCascade = () => {
          record({ name: 'cascade_choice', sid, mode, ...(s.rttMs !== undefined ? { rttMs: s.rttMs } : {}) });
          lastCascade.set(sid, { mode, ...(s.rttMs !== undefined ? { rttMs: s.rttMs } : {}) });
        };
        if (!openSids.has(sid)) {
          openSids.add(sid);
          record({ name: 'session_start', sid });
          emitCascade(); // 首开必发：建立节流基线
          return;
        }
        const prev = lastCascade.get(sid);
        const modeChanged = prev?.mode !== mode; // prev 缺失（防御）按已变处理
        const rttChanged =
          s.rttMs !== undefined &&
          (prev?.rttMs === undefined || Math.abs(s.rttMs - prev.rttMs) >= RTT_EMIT_THRESHOLD_MS);
        if (modeChanged || rttChanged) emitCascade();
      } else if (s.state === 'closed' || s.state === 'failed') {
        if (openSids.delete(sid)) {
          lastCascade.delete(sid);
          // bytesUp/bytesDown 视角 = host 进程：bytesSent=host→客户端（下行）记 bytesUp，
          // bytesRecv=客户端→host（上行）记 bytesDown（events.ts :27-28 既有字段，语义注释对齐）。
          // wireBytes/pathType 同视角（getStats 选定对增量，spec D9；wireBytesUp=wireBytesSent）。
          record({
            name: 'session_end', sid, reason: s.endReason ?? s.state,
            ...(s.ledger
              ? {
                bytesUp: s.ledger.bytesSent, bytesDown: s.ledger.bytesRecv,
                wireBytesUp: s.ledger.wireBytesSent, wireBytesDown: s.ledger.wireBytesRecv,
                pathType: s.ledger.pathType,
              }
              : {}),
          });
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
        dataPlane: host?.dataPlaneSnapshot?.() ?? null, // 旧进程/启动早期为 null，status.ts 容错省略
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

    // 8) 每 relay 一条隧道链路（兜底数据面）：TunnelClient + 其专属 HttpBridge/WsBridge。
    //    relay 下发的 req/ws-open 帧 port=0、路径形如 /s/<port>/<rest>：解析端口 → 白名单
    //    闸门（与 WebRTC 桥同一 isPortAllowed，fail-closed：非法路径 400 / 越权端口 403 /
    //    ws-open-err）→ 重写 port/path 后派发给本地桥。帧处理是不可信输入边界：逐帧
    //    try/catch 隔离，坏帧只丢帧记日志，绝不杀死进程（2026-09-12 ws.close(1006) 事故教训）。
    //    断线重连时清场（abortAll/closeAll），在途请求交由 PWA/浏览器侧重试。
    const tunnelFactory = deps.tunnelFactory ?? (() => new TunnelClient());
    const tunnelToken = createHmac('sha256', cfg.tunnelSecret).update(deviceId).digest('hex');
    for (const relay of cfg.relays) {
      const t = tunnelFactory();
      const httpBridge = new HttpBridge();
      const wsBridge = new WsBridge({});
      // DcLike 适配：桥的出站帧（dcSend 产出的 JSON 串）parse 回对象经 TunnelClient.send 发 relay；
      // 背压无意义（ws 库自管缓冲，bufferedAmount 恒 0），readyState 跟随隧道连接态。
      const dc: DcLike = {
        send: (data) => {
          try {
            t.send(typeof data === 'string' ? JSON.parse(data) : data);
          } catch {
            // 非法出站帧丢弃（dcSend 只产合法 JSON，此处纯防御）
          }
        },
        bufferedAmount: 0,
        get readyState() {
          return t.isOpen ? 'open' : 'closed';
        },
      };
      const replyHttpError = (id: number, status: number, msg: string): void => {
        void dcSend(dc, { k: 'res-head', id, status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        void dcSend(dc, { k: 'res-chunk', id, dataB64: Buffer.from(msg, 'utf8').toString('base64'), done: true });
      };
      const dispatch = (frame: unknown): void => {
        if (isReq(frame)) {
          const route = parseTunnelPath(frame.path);
          if (!route) {
            replyHttpError(frame.id, 400, 'tunnel bridge: bad path（期望 /s/<port>/<rest>）');
            return;
          }
          if (!isPortAllowed(route.port)) {
            replyHttpError(frame.id, 403, 'tunnel bridge: port not allowed（端口不在白名单）');
            return;
          }
          void httpBridge.handle(dc, { ...frame, port: route.port, path: route.path });
          return;
        }
        if (isReqAbort(frame)) {
          void httpBridge.handle(dc, frame);
          return;
        }
        if (isWsOpen(frame)) {
          const route = parseTunnelPath(frame.path);
          if (!route || !isPortAllowed(route.port)) {
            void dcSend(dc, { k: 'ws-open-err', wid: frame.wid });
            return;
          }
          void wsBridge.handle(dc, { ...frame, port: route.port, path: route.path });
          return;
        }
        if (isWsMsg(frame) || isWsClose(frame)) {
          void wsBridge.handle(dc, frame);
        }
        // ping/pong/未知帧静默忽略：隧道保活在 ws 协议层，应用层 ping 无需应答
      };
      t.onFrame((frame) => {
        try {
          dispatch(frame);
        } catch (e) {
          log.warn('tunnel', '隧道帧处理异常（已隔离，进程继续）', { ip: relay.ip, err: e instanceof Error ? e.message : String(e) });
        }
      });
      t.onReconnect(() => {
        // 隧道断开期间本地在途 HTTP/WS 已不可达：清场交由客户端重试
        httpBridge.abortAll();
        wsBridge.closeAll();
        log.info('tunnel', '隧道断线重连成功', { ip: relay.ip });
        record({ name: 'tunnel_reconnect', sid: relay.ip }); // ruling #2：sid = relay ip
      });
      // URL 含 token，绝不进日志/stdout
      t.connect(`wss://${relay.ip}/tunnel/desktop?sid=${deviceId}&token=${tunnelToken}`);
      tunnels.push({ client: t, httpBridge, wsBridge });
      log.info('tunnel', '隧道已发起连接', { ip: relay.ip });
    }
    teardowns.push(() => {
      for (const link of tunnels) {
        link.httpBridge.abortAll();
        link.wsBridge.closeAll();
        link.client.close();
      }
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

/** 隧道帧路径形态：`/s/<port>/<rest>`（relay 把公网 /tunnel/s/<deviceId>/s/<port>/… 剥成此形下发）。 */
const TUNNEL_PATH_RE = /^\/s\/(\d+)(\/.*)?$/;

/** 解析隧道帧路径 → { port, rest }；rest 缺省回落 '/'。畸形路径返回 null（派发层回 400/open-err）。 */
function parseTunnelPath(p: string): { port: number; path: string } | null {
  const m = TUNNEL_PATH_RE.exec(p);
  if (!m) return null;
  return { port: Number(m[1]), path: m[2] || '/' };
}
