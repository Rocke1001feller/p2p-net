/** ~/.p2p-net 本地配置/凭据存储（Task 13 产出，Task 14/17/20 消费）。
 *  原子写统一走 writeFileSync(tmp) → chmod 0600 → renameSync：
 *  tmp 先建后 chmod 再改名，任何时刻读者看到的要么是旧文件要么是新文件，绝无半截内容；
 *  0600 显式 chmod 不依赖 umask。
 *  config.json 含 tunnelSecret（plan 裁决：它是 start 运行时拼隧道 token 的凭证，必须随
 *  0600 配置持久化）；auth.json 由 Task 14 写入（含 accessToken/refreshToken，0600 是硬要求）。
 *  Supabase Access Token / service_role / VPS 密码 / turnSecret 绝不落本地盘。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface AppConfig {
  supabaseUrl: string;
  publishableKey: string;
  /** 隧道共享密钥（start 运行时 HMAC(tunnelSecret, deviceId) 拼隧道 token）。0600 落盘，不进日志/stdout。 */
  tunnelSecret: string;
  relays: { ip: string }[];
  deviceId?: string;
  /** 升级轮（W2-6，可选段，缺省全开）：relay 暖场会话后台原位升级直连。 */
  upgradeWheel?: { enabled?: boolean; warmMs?: number; observeMs?: number; maxAttempts?: number };
}

/** 本地配置缺失/损坏时的统一错误：message 必带可操作的下一步。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const CONFIG_FILE = 'config.json';
const AUTH_FILE = 'auth.json';

export function loadConfig(dir: string): AppConfig {
  const p = join(dir, CONFIG_FILE);
  if (!existsSync(p)) throw new ConfigError(`缺少配置 ${p}：请先运行 p2p-net init`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new ConfigError(`配置 ${p} 不是合法 JSON，请重跑 p2p-net init 重建（原因：${(e as Error).message}）`);
  }
  const o = raw as Partial<AppConfig> | null;
  if (
    typeof o !== 'object' || o === null ||
    typeof o.supabaseUrl !== 'string' || o.supabaseUrl === '' ||
    typeof o.publishableKey !== 'string' || o.publishableKey === '' ||
    typeof o.tunnelSecret !== 'string' || o.tunnelSecret === '' ||
    !Array.isArray(o.relays) || o.relays.some((r) => typeof (r as { ip?: unknown })?.ip !== 'string')
  ) {
    throw new ConfigError(`配置 ${p} 字段缺失或畸形（需要 supabaseUrl/publishableKey/tunnelSecret/relays），请重跑 p2p-net init 重建`);
  }
  return o as AppConfig;
}

export function saveConfig(dir: string, cfg: AppConfig): void {
  writeJson0600(join(dir, CONFIG_FILE), cfg);
}

/** 升级轮配置归一（W2-6）：config.json 可选段 + env P2P_NET_UPGRADE=0 强制关（P2P_NET_GZIP=0 先例）。
 *  只带实际存在的数值键——缺省键不出现，下游 HostAgent 用 ?? 默认值。 */
export function resolveUpgradeWheel(
  cfg: AppConfig['upgradeWheel'] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; warmMs?: number; observeMs?: number; maxAttempts?: number } {
  const enabled = env.P2P_NET_UPGRADE === '0' ? false : cfg?.enabled !== false;
  return {
    enabled,
    ...(cfg?.warmMs !== undefined ? { warmMs: cfg.warmMs } : {}),
    ...(cfg?.observeMs !== undefined ? { observeMs: cfg.observeMs } : {}),
    ...(cfg?.maxAttempts !== undefined ? { maxAttempts: cfg.maxAttempts } : {}),
  };
}

/** 登录态读取：文件缺失返回 null（未登录是正常状态，不是错误）。AuthState 见 Task 14。 */
export function loadAuth(dir: string): unknown | null {
  const p = join(dir, AUTH_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new ConfigError(`凭据 ${p} 不是合法 JSON，请重新运行 p2p-net login（原因：${(e as Error).message}）`);
  }
}

export function saveAuth(dir: string, a: unknown): void {
  writeJson0600(join(dir, AUTH_FILE), a);
}

/** 0600 原子写：tmp 同目录（rename 不跨文件系统）→ chmod → rename。 */
function writeJson0600(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
