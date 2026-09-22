/** p2p-net login：交互式邮箱+密码登录，凭据经 saveAuth 0600 落 auth.json。
 *  （Controller 裁决 #1：plan 漏分配 login 命令，T17 补——没有它 auth.json 无从产生，start/E2E 全死。）
 *
 *  秘密纪律：密码只进 prompt 答案与 loginWithPassword 入参（secret 提问不回显）；
 *  成功输出只含邮箱，绝不含 token/密码；失败 AuthError 人话上抛由 bin 打印（exit 1）。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { loginWithPassword } from '../server/auth.js';
import { loadConfig, saveAuth } from '../server/store.js';
import { prompt } from './init/prompt.js';

export interface RunLoginDeps {
  configDir?: string;
  promptFn?: (question: string, opts?: { secret?: boolean }) => Promise<string>;
  loginFn?: typeof loginWithPassword;
  loadConfigFn?: typeof loadConfig;
  saveAuthFn?: typeof saveAuth;
  out?: (line: string) => void;
}

export async function runLogin(deps: RunLoginDeps = {}): Promise<void> {
  const dir = deps.configDir ?? join(homedir(), '.p2p-net');
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const loginFn = deps.loginFn ?? loginWithPassword;
  const saveAuthFn = deps.saveAuthFn ?? saveAuth;
  const out = deps.out ?? ((line: string) => console.log(line));

  // 未 init → ConfigError「缺少配置 … 请先运行 p2p-net init」直接上抛
  const cfg = loadConfigFn(dir);

  // 未注入 promptFn 时自建 readline（生产交互路径）；注入路径不碰 stdio
  const rl = deps.promptFn ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = deps.promptFn ?? ((q: string, o?: { secret?: boolean }) => prompt(rl!, q, o));
  try {
    const email = (await ask('账号邮箱: ')).trim();
    const password = await ask('密码: ', { secret: true });
    const auth = await loginFn(cfg, email, password);
    saveAuthFn(dir, auth);
    out(`登录成功：${auth.email}（凭据已 0600 保存；下一步 p2p-net start）`);
  } finally {
    rl?.close();
  }
}
