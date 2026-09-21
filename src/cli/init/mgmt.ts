/** Supabase Management API client（spec §4 init 基建，Task 8 的 init 编排依赖本类）。
 *  函数部署通道决策（plan Decision Log 2026-09-22）：纯 API —— POST/PATCH
 *  /v1/projects/{ref}/functions[/slug] 的 application/json 内联源码通道（官方 OpenAPI
 *  spec 明列；两个 edge function 均为单文件 index.ts，无需 eszip 本地打包），
 *  init/运行期均不引入 supabase CLI / npx（spec §12 零外部工具链约束无需例外）。
 *  所有请求强制 User-Agent: p2p-net/0.1.0 —— WAF 1010 拦截无 UA 请求的事故教训，load-bearing。
 *  token 只进 Authorization 头，任何日志/错误消息不得带 token。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://api.supabase.com/v1';
const UA = 'p2p-net/0.1.0';
const HEALTHY_STATUS = 'ACTIVE_HEALTHY';
const POLL_INTERVAL_MS = 1000;
const BODY_EXCERPT_LEN = 200;

/** 包内 dist/cli/init → <pkg>/supabase/functions，源码态 src/cli/init → 仓库 supabase/functions，
 *  两级相对深度一致（package.json files 含 supabase/）。 */
const FUNCTIONS_DIR = fileURLToPath(new URL('../../../supabase/functions/', import.meta.url));

/** verify_jwt 逐函数覆盖（默认 true）：redeem-pairing-ticket 是登录前置端点
 *  （扫码兑换时还没有会话，端侧只持有 publishable key），网关 JWT 校验必须关。 */
const VERIFY_JWT: Record<string, boolean> = { 'redeem-pairing-ticket': false };

/** status=0 表示非 HTTP 失败（如本地轮询超时），body 为服务端响应摘要（截断）。 */
export class MgmtError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, detail?: string) {
    super(detail ?? `Supabase Management API HTTP ${status}: ${body}`);
    this.name = 'MgmtError';
    this.status = status;
    this.body = body;
  }
}

export class SupabaseMgmt {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(token: string, fetchImpl: typeof fetch = globalThis.fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async #request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        'User-Agent': UA,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new MgmtError(res.status, text.slice(0, BODY_EXCERPT_LEN));
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** 组织对象同时带 id（已废弃）与 slug，二者同值；对外透传 slug，供 createProject 的 organization_slug 用。 */
  async listOrgs(): Promise<{ id: string; name: string }[]> {
    const orgs = await this.#request<{ id?: string; slug?: string; name: string }[]>('GET', '/organizations');
    return orgs.map((o) => ({ id: o.slug ?? o.id ?? '', name: o.name }));
  }

  async listProjects(): Promise<{ id: string; name: string; region: string; status: string }[]> {
    const projects = await this.#request<{ id: string; name: string; region: string; status: string }[]>('GET', '/projects');
    return projects.map((p) => ({ id: p.id, name: p.name, region: p.region, status: p.status }));
  }

  async createProject(o: { orgId: string; name: string; region: string; dbPass: string }): Promise<{ id: string }> {
    const res = await this.#request<{ id: string }>('POST', '/projects', {
      organization_slug: o.orgId,
      name: o.name,
      region: o.region,
      db_pass: o.dbPass,
    });
    return { id: res.id };
  }

  /** 轮询项目状态直到 ACTIVE_HEALTHY；默认超时 180s，超时抛 MgmtError(status=0)。 */
  async waitHealthy(ref: string, timeoutMs = 180_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const p = await this.#request<{ status: string }>('GET', `/projects/${ref}`);
      if (p.status === HEALTHY_STATUS) return;
      if (Date.now() >= deadline) {
        throw new MgmtError(0, '', `waitHealthy(${ref}) ${timeoutMs}ms 内未 ${HEALTHY_STATUS}（最后状态 ${p.status}）`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  async getApiKeys(ref: string): Promise<{ anon: string; serviceRole: string }> {
    const keys = await this.#request<{ name: string; api_key?: string }[]>('GET', `/projects/${ref}/api-keys`);
    const anon = keys.find((k) => k.name === 'anon')?.api_key;
    const serviceRole = keys.find((k) => k.name === 'service_role')?.api_key;
    if (!anon || !serviceRole) {
      throw new MgmtError(0, JSON.stringify(keys.map((k) => k.name)), `api-keys 响应缺 anon/service_role`);
    }
    return { anon, serviceRole };
  }

  async runQuery(ref: string, query: string): Promise<unknown> {
    return this.#request('POST', `/projects/${ref}/database/query`, { query });
  }

  async setSecrets(ref: string, secrets: Record<string, string>): Promise<void> {
    await this.#request('POST', `/projects/${ref}/secrets`,
      Object.entries(secrets).map(([name, value]) => ({ name, value })));
  }

  /** 部署包内 supabase/functions/ 下全部函数：已存在 PATCH 更新，不存在 POST 创建（幂等）。 */
  async deployFunctions(ref: string): Promise<void> {
    const existing = new Set(
      (await this.#request<{ slug: string }[]>('GET', `/projects/${ref}/functions`)).map((f) => f.slug),
    );
    for (const slug of listLocalFunctionSlugs()) {
      const source = readFileSync(join(FUNCTIONS_DIR, slug, 'index.ts'), 'utf8');
      const verifyJwt = VERIFY_JWT[slug] ?? true;
      if (existing.has(slug)) {
        await this.#request('PATCH', `/projects/${ref}/functions/${slug}`, { name: slug, body: source, verify_jwt: verifyJwt });
      } else {
        await this.#request('POST', `/projects/${ref}/functions`, { slug, name: slug, body: source, verify_jwt: verifyJwt });
      }
    }
  }
}

function listLocalFunctionSlugs(): string[] {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
