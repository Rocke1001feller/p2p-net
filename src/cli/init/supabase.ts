/** init supabase 编排（spec §4.1）：waitHealthy → DDL → 函数部署 → secrets → 首账号 → 自验探针，
 *  全绿才返回 publishableKey 给上层（init 命令续跑 VPS 阶段）。
 *
 *  凭据纪律：Access Token 只进 SupabaseMgmt 的 Authorization 头；service_role key 仅存内存、
 *  用完即弃（仅用于 admin 建号一个请求），两者均不落盘、不进日志/错误消息。
 *  SupabaseMgmt 在网络层失败时抛裸 TypeError、2xx 畸形 JSON 时抛裸 SyntaxError（Task 7 已收录
 *  的 quirk），故每步 catch 全量异常并统一包装为带修复建议的 InitError。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { Logger } from '../../log/logger.js';
import { MgmtError, SupabaseMgmt } from './mgmt.js';

/** 与 SupabaseMgmt.waitHealthy 默认超时一致（错误文案引用）。 */
const HEALTHY_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_INTERVAL_MS = 500;
const BODY_EXCERPT_LEN = 200;
/** projectRef 缺省新建时的兜底 region；交互层（init 命令）会显式收集后传入。 */
const DEFAULT_REGION = 'ap-southeast-1';
const PROJECT_NAME = 'p2p-net';

/** 包内 dist/cli/init → <pkg>/supabase/ddl，源码态 src/cli/init → 仓库 supabase/ddl（同 mgmt.ts 的资产寻址先例）。 */
const DDL_FILE = new URL('../../../supabase/ddl/0001_core.sql', import.meta.url);

/** init 编排失败的统一错误：step 标识断点（续跑语义），message 必带可操作的修复建议。 */
export class InitError extends Error {
  readonly step: string;

  constructor(step: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'InitError';
    this.step = step;
  }
}

export interface BootstrapOpts {
  token: string;
  projectRef?: string;
  region?: string;
  adminEmail: string;
  adminPassword: string;
  turnSecret: string;
  turnHosts: string[];
  log: Logger;
}

/** 可选第二参：测试注入 seam。生产全部走默认值（真实 SupabaseMgmt / globalThis.fetch）。 */
export interface BootstrapDeps {
  mgmt?: SupabaseMgmt;
  fetchImpl?: typeof fetch;
  probeTimeoutMs?: number;
  probeIntervalMs?: number;
}

export interface BootstrapResult {
  projectRef: string;
  supabaseUrl: string;
  publishableKey: string;
}

export async function bootstrapSupabase(opts: BootstrapOpts, deps: BootstrapDeps = {}): Promise<BootstrapResult> {
  const mgmt = deps.mgmt ?? new SupabaseMgmt(opts.token);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const probeTimeout = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const probeInterval = deps.probeIntervalMs ?? PROBE_INTERVAL_MS;
  const log = opts.log;

  const ref = opts.projectRef ?? (await createProject(mgmt, opts, log));

  await step('waitHealthy', waitHealthyHint, async () => {
    log.info('supabase', '等待 project 就绪', { projectRef: ref });
    await mgmt.waitHealthy(ref);
  });
  log.info('supabase', 'project 已就绪', { projectRef: ref });

  await step('runQuery', 'DDL 应用失败，可在 supabase.com SQL Editor 手动执行 supabase/ddl/0001_core.sql 后重跑 init', async () => {
    const sql = readFileSync(DDL_FILE, 'utf8');
    log.info('supabase', '应用幂等 DDL 包', { projectRef: ref, bytes: sql.length });
    await mgmt.runQuery(ref, sql);
  });

  await step('deployFunctions', 'edge function 部署失败，请到 supabase.com 控制台 Functions 页确认后重跑 init', async () => {
    log.info('supabase', '部署 edge functions', { projectRef: ref });
    await mgmt.deployFunctions(ref);
  });

  await step('setSecrets', 'secrets 写入失败，请到控制台 Edge Functions → Secrets 手动设置 TURN_STATIC_AUTH_SECRET 与 TURN_HOSTS 后重跑 init', async () => {
    // 只记 secret 名字，值绝不进日志
    log.info('supabase', '写入 TURN secrets', {
      projectRef: ref,
      names: ['TURN_STATIC_AUTH_SECRET', 'TURN_HOSTS'],
      turnHostCount: opts.turnHosts.length,
    });
    await mgmt.setSecrets(ref, {
      TURN_STATIC_AUTH_SECRET: opts.turnSecret,
      TURN_HOSTS: JSON.stringify(opts.turnHosts),
    });
  });

  const keys = await step('getApiKeys', '获取 API keys 失败，请到控制台 Settings → API 确认后重跑 init', async () => {
    log.info('supabase', '获取 publishable key', { projectRef: ref });
    return mgmt.getApiKeys(ref);
  });

  const supabaseUrl = `https://${ref}.supabase.co`;

  await step('createUser', '创建首个账号失败，请到控制台 Authentication → Users 手动建号后重跑 init', async () => {
    log.info('supabase', '创建首个账号', { email: opts.adminEmail });
    const r = await reqJson(fetchImpl, 'POST', `${supabaseUrl}/auth/v1/admin/users`, {
      apikey: keys.serviceRole,
      authorization: `Bearer ${keys.serviceRole}`,
      'content-type': 'application/json',
    }, { email: opts.adminEmail, password: opts.adminPassword, email_confirm: true });
    if (r.ok) return;
    const why = errText(r);
    // init 幂等续跑：账号已存在不算失败，登录与自验会兜住密码错误
    if ((r.status === 400 || r.status === 422) && /already/i.test(why)) {
      log.info('supabase', '账号已存在（幂等续跑），跳过创建', { email: opts.adminEmail });
      return;
    }
    throw new Error(`HTTP ${r.status}: ${why}`);
  });
  // service_role 使命结束——此后只用 publishable key + 用户 JWT；keys.serviceRole 随作用域丢弃

  const session = await step('signIn', '首账号登录验证失败，请确认邮箱/密码无误且 Email 登录已启用（控制台 Authentication → Providers）', async () => {
    log.info('supabase', '首账号登录验证', { email: opts.adminEmail });
    const r = await reqJson(fetchImpl, 'POST', `${supabaseUrl}/auth/v1/token?grant_type=password`, {
      apikey: keys.anon,
      'content-type': 'application/json',
    }, { email: opts.adminEmail, password: opts.adminPassword });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${errText(r)}`);
    const jwt = r.json?.access_token;
    const uid = r.json?.user?.id;
    if (typeof jwt !== 'string' || !jwt || typeof uid !== 'string' || !uid) {
      throw new Error('登录响应缺 access_token / user.id');
    }
    return { jwt, uid };
  });
  log.info('supabase', '首账号就绪', { uid: session.uid });

  await step('probeSignaling', '信令自验失败（读写回环未通过），通常是 RLS 策略未生效——请到 supabase.com 确认 signaling_messages 策略已应用后重跑 init', async () => {
    const nonce = randomUUID();
    const room = `sig:${session.uid}:probe`;
    const authHeaders = { apikey: keys.anon, authorization: `Bearer ${session.jwt}` };
    log.info('supabase', '自验：信令写入', { room });
    const w = await reqJson(fetchImpl, 'POST', `${supabaseUrl}/rest/v1/signaling_messages`, {
      ...authHeaders,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    }, { room, sender: 'init-probe', kind: 'sig', payload: { probe: nonce } });
    if (!w.ok) throw new Error(`写入失败 HTTP ${w.status}: ${errText(w)}`);
    const deadline = Date.now() + probeTimeout;
    for (;;) {
      const q = new URLSearchParams({ room: `eq.${room}`, select: 'id,payload', order: 'id.asc' });
      const r = await reqJson(fetchImpl, 'GET', `${supabaseUrl}/rest/v1/signaling_messages?${q}`, authHeaders);
      if (!r.ok) throw new Error(`读回失败 HTTP ${r.status}: ${errText(r)}`);
      const rows = Array.isArray(r.json) ? (r.json as { payload?: { probe?: string } }[]) : [];
      if (rows.some((row) => row?.payload?.probe === nonce)) {
        log.info('supabase', '自验：信令读回成功', { room });
        return;
      }
      if (Date.now() >= deadline) throw new Error(`写入后 ${probeTimeout}ms 内未读回（房间 ${room}）`);
      await new Promise((resolve) => setTimeout(resolve, probeInterval));
    }
  });

  await step('probeTurn', 'turn-credentials 自验失败，请确认 secrets（TURN_STATIC_AUTH_SECRET/TURN_HOSTS）已生效且函数部署成功后重跑 init', async () => {
    log.info('supabase', '自验：turn-credentials');
    const r = await reqJson(fetchImpl, 'POST', `${supabaseUrl}/functions/v1/turn-credentials`, {
      apikey: keys.anon,
      authorization: `Bearer ${session.jwt}`,
      'content-type': 'application/json',
    }, {});
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${errText(r)}`);
    const ice = r.json?.iceServers;
    if (!Array.isArray(ice) || ice.length === 0) throw new Error('响应缺 iceServers 或为空');
    log.info('supabase', '自验：turn-credentials 返回 iceServers', { count: ice.length });
  });

  log.info('supabase', 'Supabase 初始化完成', { projectRef: ref, supabaseUrl });
  return { projectRef: ref, supabaseUrl, publishableKey: keys.anon };
}

/** 未指定 projectRef：取首个组织自动建 project；db 密码仅存内存（交 Supabase 托管），不落盘、不打日志。 */
async function createProject(mgmt: SupabaseMgmt, opts: BootstrapOpts, log: Logger): Promise<string> {
  return step('createProject', '无法创建 Supabase project，请到 supabase.com 确认 Access Token 权限与组织配额后重跑 init', async () => {
    log.info('supabase', '未指定 project，自动新建');
    const orgs = await mgmt.listOrgs();
    if (orgs.length === 0) {
      throw new InitError('createProject', 'Supabase 账号下没有 organization：请先到 supabase.com 创建组织，再重跑 init');
    }
    const region = opts.region ?? DEFAULT_REGION;
    const dbPass = randomBytes(24).toString('hex');
    const { id } = await mgmt.createProject({ orgId: orgs[0].id, name: PROJECT_NAME, region, dbPass });
    log.info('supabase', 'project 已创建', { projectRef: id, region });
    return id;
  });
}

function waitHealthyHint(cause: unknown): string {
  if (cause instanceof MgmtError && cause.status === 0) {
    return `project 未在 ${HEALTHY_TIMEOUT_MS / 1000}s 内就绪，请到 supabase.com 控制台确认后再重跑 init`;
  }
  return '等待 project 就绪失败，请到 supabase.com 控制台确认项目状态后重跑 init';
}

/** 单步执行 + 全量异常包装：裸 TypeError/SyntaxError 也统一收成 InitError；已包装的 InitError 原样上抛。 */
async function step<T>(name: string, hint: string | ((cause: unknown) => string), fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InitError) throw e;
    const why = (e instanceof Error ? e.message : String(e)).slice(0, BODY_EXCERPT_LEN);
    const base = typeof hint === 'function' ? hint(e) : hint;
    throw new InitError(name, `${base}（原因：${why}）`, e);
  }
}

interface ReqResult {
  ok: boolean;
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json?: any;
}

/** 数据面/认证面最小 JSON 请求助手；畸形 JSON 的 SyntaxError 不就地消化，交由 step() 统一包装。 */
async function reqJson(
  fetchImpl: typeof fetch,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<ReqResult> {
  const res = await fetchImpl(url, {
    method,
    signal: AbortSignal.timeout(10_000),
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : undefined };
}

/** 从错误响应提取人话摘要（GoTrue 的 msg/error_description、PostgREST 的 message），截断防刷屏。 */
function errText(r: ReqResult): string {
  const j = r.json;
  let s: string;
  if (j && typeof j === 'object') {
    const o = j as Record<string, unknown>;
    s = String(o.msg ?? o.error_description ?? o.message ?? JSON.stringify(j));
  } else {
    s = String(j ?? '');
  }
  return s.slice(0, BODY_EXCERPT_LEN);
}
