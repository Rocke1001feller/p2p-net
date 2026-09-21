/** readline/promises 交互提问封装。secret: true 时暂时 mute 输出流，密码/token 不回显。
 *  返回值只进调用方内存——不落盘、不打日志是调用方纪律（见 init 编排注释）。
 */

import type { Interface } from 'node:readline/promises';

export async function prompt(rl: Interface, question: string, opts: { secret?: boolean } = {}): Promise<string> {
  if (!opts.secret) return rl.question(question);
  const out = (rl as unknown as { output?: NodeJS.WritableStream }).output ?? process.stdout;
  const origWrite = out.write.bind(out);
  origWrite(question);
  // mute 期间吞掉全部回显（用户键入的字符），只放行结尾换行保持光标下移
  (out as { write: unknown }).write = (chunk: unknown, encOrCb?: unknown, cb?: unknown): boolean => {
    const done = typeof encOrCb === 'function' ? encOrCb : cb;
    let ok = true;
    const s = String(chunk);
    if (s === '\n' || s === '\r\n') ok = origWrite(s);
    if (typeof done === 'function') (done as () => void)();
    return ok;
  };
  try {
    return await rl.question('');
  } finally {
    (out as { write: unknown }).write = origWrite;
  }
}
