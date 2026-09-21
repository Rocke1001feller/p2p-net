/** SSH 编排器（spec §4 init 基建，Task 12/13 的 VPS 初始化依赖本模块）。
 *  密码卫生（Review Focus #2，load-bearing）：
 *  - 密码只进内存（connect 配置 + 本类私有字段），本模块不打任何日志；
 *  - 任何 SshError 的 message/stack 不得含密码——底层错误消息一律经 #scrub 脱敏后再进 detail；
 *  - 认证失败/超时/拒连一律映射成"说人话+可操作"的 SshError，绝不把 ssh2 裸堆栈甩给用户。
 *  连接超时双保险：ssh2 readyTimeout + 手动 setTimeout 竞速（黑洞 IP 下也保证按时返回）。
 */

import { Client, type ClientChannel, type SFTPWrapper, type Stats as SftpStats } from 'ssh2';
import { readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

const DEFAULT_TIMEOUT_MS = 10_000;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;
/** 远端 stderr/错误摘要进文案时的截断长度。 */
const EXCERPT_LEN = 300;

export interface VpsCreds {
  host: string;
  username: string;
  password: string;
  port?: number;
}

export type SshErrorCode = 'AUTH' | 'TIMEOUT' | 'CONN' | 'EXEC';

const TEMPLATES: Record<SshErrorCode, (target: string) => string> = {
  AUTH: (t) => `SSH 认证失败（${t}）：请检查用户名与密码是否正确；若 VPS 已禁用密码登录，请恢复后重跑 init`,
  TIMEOUT: (t) => `SSH 连接 ${t} 超时：请确认 VPS 已开机、IP/端口正确，且云厂商安全组/防火墙已放行 SSH 端口`,
  CONN: (t) => `SSH 无法连接 ${t}：请确认 VPS 运行中、IP/端口正确，且安全组已放行 SSH 端口`,
  EXEC: (t) => `SSH 远程执行失败（${t}）：请登录 VPS 手动执行该命令排查`,
};

/** 归类后的 SSH 错误。target 形如 `host:port`；detail 为脱敏后的底层摘要。 */
export class SshError extends Error {
  readonly code: SshErrorCode;

  constructor(code: SshErrorCode, target: string, detail?: string, options?: { cause?: unknown }) {
    super(detail ? `${TEMPLATES[code](target)}（${detail}）` : TEMPLATES[code](target), options);
    this.name = 'SshError';
    this.code = code;
  }
}

/** 解析 VPS 列表项 `user@ip 密码`：密码段允许含空格与任意特殊字符（在首个空白后原样保留）。
 *  调用方逐行读列表时传 lineNo，错误消息带行号。消息只回显 `@` 段，绝不回显密码段。 */
export function parseVpsSpec(line: string, lineNo?: number): VpsCreds {
  const where = lineNo === undefined ? '' : `（第 ${lineNo} 行）`;
  const bad = (got: string): Error =>
    new Error(`VPS 列表项格式错误${where}：格式应为 'user@ip 密码'（密码可含空格/特殊字符），收到 '${got}'`);
  const trimmed = line.trim();
  const sep = trimmed.search(/\s/);
  const head = sep < 0 ? trimmed : trimmed.slice(0, sep);
  const password = sep < 0 ? '' : trimmed.slice(sep).trimStart();
  if (!password) throw bad(head);
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(head);
  if (!m) throw bad(head);
  return { host: m[2], username: m[1], password };
}

type RawError = Error & { level?: string; code?: string | number };

/** ssh2/socket 错误 → 归类。只看 level 与消息关键字，不取任何凭据字段。 */
function classify(err: unknown): SshErrorCode {
  const e = err as RawError;
  const msg = e?.message ?? String(err);
  if (e?.level === 'client-authentication' || /authentication failure|all configured authentication methods failed/i.test(msg)) {
    return 'AUTH';
  }
  if (e?.level === 'client-timeout' || /etimedout|timed?\s*out/i.test(msg)) return 'TIMEOUT';
  return 'CONN';
}

/** 脱敏：把底层消息里万一出现的密码串抹掉后再进 SshError。 */
function scrub(text: string, secret: string): string {
  return secret ? text.split(secret).join('******') : text;
}

function excerpt(s: string): string {
  const t = s.trim();
  return t.length > EXCERPT_LEN ? `${t.slice(0, EXCERPT_LEN)}…` : t;
}

type SftpError = Error & { code?: number };

function sftpCall<T>(fn: (cb: (err: SftpError | null | undefined, out?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, out) => (err ? reject(err) : resolve(out as T)));
  });
}

export class SshRunner {
  readonly #client: Client;
  readonly #target: string;
  /** 仅用于对后续底层错误消息做脱敏，不出现在任何输出面。 */
  readonly #password: string;
  #ended = false;

  private constructor(client: Client, target: string, password: string) {
    this.#client = client;
    this.#target = target;
    this.#password = password;
  }

  static connect(creds: VpsCreds, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SshRunner> {
    const { host, username, password } = creds;
    const port = creds.port ?? 22;
    const target = `${host}:${port}`;
    return new Promise<SshRunner>((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const fail = (err: SshError) => {
        if (settled) return; // ready 后的连接层错误只吞掉，由在途 exec/putDir 各自报错
        settled = true;
        clearTimeout(timer);
        client.destroy();
        reject(err);
      };
      // 手动超时竞速：无论卡在 TCP 还是握手阶段，timeoutMs 内必返回（黑洞 IP 不挂死）
      const timer = setTimeout(() => {
        fail(new SshError('TIMEOUT', target, `等待 ${timeoutMs}ms 仍无响应`));
      }, timeoutMs);
      client.on('ready', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new SshRunner(client, target, password));
      });
      client.on('error', (err: RawError) => {
        fail(new SshError(classify(err), target, scrub(excerpt(err.message ?? String(err)), password), { cause: err }));
      });
      // 部分云镜像只开 keyboard-interactive；用密码自动应答（密码仍只在内存）
      client.on('keyboard-interactive', (_name, _instr, _lang, _prompts, finish) => {
        finish([password]);
      });
      try {
        client.connect({ host, port, username, password, readyTimeout: timeoutMs, tryKeyboard: true });
      } catch (e) {
        fail(new SshError(classify(e), target, scrub(excerpt((e as Error).message ?? String(e)), password), { cause: e }));
      }
    });
  }

  /** 执行远端命令并收集退出码/stdout/stderr；非零退出不抛错，由调用方判定。 */
  exec(cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    if (this.#ended) {
      return Promise.reject(new SshError('CONN', this.#target, '连接已关闭（end() 已调用）'));
    }
    return new Promise((resolve, reject) => {
      this.#client.exec(cmd, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          reject(this.#wrap('EXEC', `发起执行失败: ${err.message ?? String(err)}`, err));
          return;
        }
        let stdout = '';
        let stderr = '';
        let exitCode: number | null = null;
        stream.on('data', (d: Buffer | string) => {
          stdout += d.toString();
        });
        stream.stderr.on('data', (d: Buffer | string) => {
          stderr += d.toString();
        });
        // exit 按 SSH 规范是可选事件：先记码，close 时兜底 -1
        stream.on('exit', (code: number | null) => {
          exitCode = code;
        });
        stream.on('error', (e: Error) => reject(this.#wrap('EXEC', e.message ?? String(e), e)));
        stream.on('close', () => resolve({ code: exitCode ?? -1, stdout, stderr }));
      });
    });
  }

  /** sftp 递归上传本地目录：文件 0644、目录 0755（显式 chmod，不受远端 umask 影响）。 */
  async putDir(localDir: string, remoteDir: string): Promise<void> {
    if (this.#ended) throw new SshError('CONN', this.#target, '连接已关闭（end() 已调用）');
    let st;
    try {
      st = statSync(localDir);
    } catch {
      throw new SshError('EXEC', this.#target, `本地目录不存在：${localDir}`);
    }
    if (!st.isDirectory()) throw new SshError('EXEC', this.#target, `本地路径不是目录：${localDir}`);

    const sftp = await sftpCall<SFTPWrapper>((cb) => {
      this.#client.sftp((err, s) => cb(err as SftpError | undefined, s));
    }).catch((e) => {
      throw this.#wrap('EXEC', `打开 sftp 会话失败: ${(e as Error).message ?? e}`, e);
    });
    try {
      await this.#uploadDir(sftp, localDir, remoteDir);
    } catch (e) {
      if (e instanceof SshError) throw e;
      throw this.#wrap('EXEC', `上传 ${localDir} → ${remoteDir} 失败: ${(e as Error).message ?? e}`, e);
    } finally {
      sftp.end();
    }
  }

  async #uploadDir(sftp: SFTPWrapper, localDir: string, remoteDir: string): Promise<void> {
    await this.#mkdirp(sftp, remoteDir);
    for (const entry of readdirSync(localDir, { withFileTypes: true })) {
      const lp = join(localDir, entry.name);
      const rp = posix.join(remoteDir, entry.name);
      if (entry.isDirectory()) {
        await this.#uploadDir(sftp, lp, rp);
      } else if (entry.isFile()) {
        await sftpCall<void>((cb) => sftp.fastPut(lp, rp, cb));
        await sftpCall<void>((cb) => sftp.chmod(rp, FILE_MODE, cb));
      }
      // 符号链接等特殊文件跳过：VPS 初始化资产只含普通文件/目录
    }
  }

  /** mkdir -p 语义：逐级 stat，缺失才建；建后显式 chmod 0755。 */
  async #mkdirp(sftp: SFTPWrapper, dir: string): Promise<void> {
    const parts = dir.split('/').filter(Boolean);
    let cur = dir.startsWith('/') ? '' : '.';
    for (const part of parts) {
      cur = `${cur}/${part}`;
      let exists = false;
      try {
        const s = await sftpCall<SftpStats>((cb) => sftp.stat(cur, cb));
        if (!s.isDirectory()) throw new SshError('EXEC', this.#target, `远端路径已存在且不是目录：${cur}`);
        exists = true;
      } catch (e) {
        if (e instanceof SshError) throw e;
        if ((e as SftpError).code !== 2 /* SSH_FX_NO_SUCH_FILE */) throw e;
      }
      if (!exists) {
        await sftpCall<void>((cb) => sftp.mkdir(cur, { mode: DIR_MODE }, cb));
        await sftpCall<void>((cb) => sftp.chmod(cur, DIR_MODE, cb));
      }
    }
  }

  #wrap(code: SshErrorCode, detail: string, cause?: unknown): SshError {
    return new SshError(code, this.#target, scrub(excerpt(detail), this.#password), { cause });
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#client.end();
  }
}
