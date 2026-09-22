/**
 * 运行时配置加载器——本模块是全端唯一的配置来源（spec §3 关键决定）。
 *
 * /config.json 由 `p2p-net init` 在 VPS 上写入（与 PWA 静态资产同目录、同源自服务），
 * 内容形如：{ "supabaseUrl": "https://x.supabase.co", "publishableKey": "sb_…", "relays": [{ "url": "https://1.2.3.4" }] }。
 * publishable key 公开可用，安全边界在 RLS + Edge Function。
 *
 * 失败语义（Review Focus #5）：缺失/损坏必须抛 ConfigError（文案带修复指引），
 * 由 shell 渲染成可操作错误页，绝不允许白屏。
 */

/** 运行时配置（= VPS 上 /config.json 的字段全集）。 */
export interface RuntimeConfig {
  supabaseUrl: string;
  publishableKey: string;
  relays: { url: string }[];
}

/** 配置缺失/损坏专用错误：message 永远含"怎么办"，不带堆栈 jargon。 */
export class ConfigError extends Error {
  constructor(detail: string) {
    super(`config.json 缺失或损坏（${detail}）。请确认该 VPS 由 p2p-net init 初始化（init 会在站点根写入 config.json）；已初始化过就重跑一次 p2p-net init。`);
    this.name = 'ConfigError';
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** 手写字段校验（zod-free）：任何字段缺失/畸形都翻译成 ConfigError。 */
function validate(raw: unknown): RuntimeConfig {
  if (!isRecord(raw)) throw new ConfigError('载荷不是 JSON 对象');
  const { supabaseUrl, publishableKey, relays } = raw;
  if (typeof supabaseUrl !== 'string' || !supabaseUrl) throw new ConfigError('缺 supabaseUrl');
  try { new URL(supabaseUrl); } catch { throw new ConfigError('supabaseUrl 不是合法 URL'); }
  if (typeof publishableKey !== 'string' || !publishableKey) throw new ConfigError('缺 publishableKey');
  if (!Array.isArray(relays)) throw new ConfigError('缺 relays 数组');
  for (const r of relays) {
    if (!isRecord(r) || typeof r.url !== 'string' || !r.url) throw new ConfigError('relays 条目缺 url');
  }
  return { supabaseUrl, publishableKey, relays: relays as { url: string }[] };
}

/**
 * 拉取并校验同源 /config.json。每次调用都真实请求（cache: 'no-store'，不 memo）——
 * 需要复用结果的调用方（cloud.ts）自行缓存，避免缓存把"损坏"状态钉死。
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  let res: Response;
  try {
    res = await fetch('/config.json', { cache: 'no-store' });
  } catch {
    throw new ConfigError('网络不可达');
  }
  if (!res.ok) throw new ConfigError(`HTTP ${res.status}`);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new ConfigError('非法 JSON');
  }
  return validate(raw);
}
