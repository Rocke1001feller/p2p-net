/** 工作台 console 兜底选择（2026-09-26 console-hijack 修复）：
 *  桌面未自述 console 时，优先「上次成功启动的端口」（仍在服务清单内），否则回退清单首个 /s/ 服务。
 *  背景：清单按端口序，任意低位端口新监听者（如本机 vite dev server）会把「首个服务」抢成自己，
 *  手机端工作台 iframe 被劫持到错误应用 → 白屏。last-good 记忆让选择粘性到真正的工作台。 */
export interface ConsoleService {
  port: number;
  url?: string;
}

/** 兜底端口：lastGood 在清单内 → lastGood；否则首个带 /s/ 的服务；空清单 → null。 */
export function pickFallbackPort(services: ConsoleService[], lastGood: number | null): number | null {
  if (lastGood !== null && services.some((s) => s.port === lastGood)) return lastGood;
  const first = services.find((s) => (s.url || '').includes('/s/'));
  return first ? first.port : null;
}

const LAST_GOOD_KEY = 'p2p.lastConsolePort';

/** 最小存储面（生产 = localStorage；隐私模式/不可用全静默回 null）。 */
export interface PickStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readLastGoodPort(storage: PickStorage): number | null {
  try {
    const n = Number(storage.getItem(LAST_GOOD_KEY));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeLastGoodPort(storage: PickStorage, port: number): void {
  try {
    storage.setItem(LAST_GOOD_KEY, String(port));
  } catch {
    /* 写不进（隐私模式等）静默：下次回退清单首个，不影响本次会话 */
  }
}
