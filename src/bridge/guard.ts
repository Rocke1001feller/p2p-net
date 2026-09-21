/**
 * 端口白名单强制（spec §5.3 安全洞补洞）：req / ws-open 帧分发进桥之前的唯一校验点。
 * 库层缺省放行（向后兼容）；CLI/daemon 装配侧必须注入 isPortAllowed（Task 17 编排）。
 */

export class PortNotAllowedError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`port ${port} is not in the allowlist; add it via p2p-net config or --allow-port`);
    this.name = 'PortNotAllowedError';
    this.port = port;
  }
}

export function assertPortAllowed(isPortAllowed: ((port: number) => boolean) | undefined, port: number): void {
  if (!isPortAllowed) return;
  if (!isPortAllowed(port)) throw new PortNotAllowedError(port);
}
