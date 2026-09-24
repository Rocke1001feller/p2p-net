/**
 * PWA 帧账本（2026-09-23 Wave 1，spec D5/D8）：从 shell.ts :93-120 内联版抽成可测类，
 * 加双向字节计量——成本模型的 PWA 侧观测口径（与 host SessionLedger 对账）。
 *
 * Wave 1 增补（spec D9）：pathType + wire 字节。dc 段由 WebRtcSession 既有 5s stats 节拍喂
 * getStats 行（sampleWireStats，浏览器判据 candidate-pair && selected===true，落选回退
 * nominated/首个 succeeded——与 src/pathType.ts 同源的孪生判据；PWA 模块边界自带小副本，
 * 不过包边界 import src/）。tunnel 段不过 DataChannel，getStats 判不到：响应帧经
 * noteTunnelFrame 计入 wire 桶并把 pathType 记 'tunnel'。
 */

export interface HungEntry { port?: number; path: string; ms: number }

export type PathType = 'direct' | 'relay' | 'tunnel' | 'unknown';

/** src/pathType.ts classifyCandidateType 的 PWA 孪生副本（保持两侧语义逐字一致）。 */
function classifyCandidateType(ct: string | undefined): PathType {
  if (ct === 'relay') return 'relay';
  if (ct === 'host' || ct === 'srflx' || ct === 'prflx') return 'direct';
  return 'unknown';
}

export class FrameLedger {
  sent = 0;
  res = 0;
  hung = 0;
  bytesSent = 0;
  bytesRecv = 0;
  /** 传输路径（最后观测值；账本跨重连累计，pathType 反映当前/末次会话的路径）。 */
  pathType: PathType = 'unknown';
  wireBytesSent = 0;
  wireBytesRecv = 0;
  readonly inFlight = new Map<number, { port?: number; path: string; at: number }>();
  lastHung: HungEntry[] = [];
  private prevWire?: { wireSent: number; wireRecv: number };

  /** 发出记一笔；outFrame 给出时累计线字节（JSON 帧按序列化长度）。 */
  trackReq(gid: number, port: number | undefined, path: string, outFrame?: unknown): void {
    this.sent += 1;
    this.inFlight.set(gid, { port, path, at: Date.now() });
    if (outFrame !== undefined) this.bytesSent += wireBytes(outFrame);
  }

  /** 回帧销账；inFrame 给出时累计线字节（二进制帧按 6B 头 + payload）。
   *  字节计量在 delete-gate 之外（修复轮 Fix 1）：多 chunk 响应的每一帧都是线上字节
   *  （与 host meterDc 每 send 计量的对账口径），res 计数仍按请求只计一次。 */
  settleReq(gid: number, inFrame?: unknown): void {
    if (inFrame !== undefined) this.bytesRecv += wireBytes(inFrame);
    if (this.inFlight.delete(gid)) this.res += 1;
  }

  /** 把"挂了多久还没回帧"的请求摘出来（watchdog 与诊断共用）。 */
  harvestHung(now = Date.now(), hangMs = 9_000, log?: (msg: string) => void): HungEntry[] {
    const out: HungEntry[] = [];
    for (const [gid, f] of this.inFlight) {
      if (now - f.at > hangMs) {
        out.push({ port: f.port, path: f.path, ms: now - f.at });
        this.inFlight.delete(gid);
      }
    }
    if (out.length) {
      this.hung += out.length;
      this.lastHung = out.slice(0, 8);
      for (const h of out) log?.(`[frame] 无回帧 ${Math.round(h.ms / 1000)}s：:${h.port ?? '?'}${h.path}`);
    }
    return out;
  }

  /** dc 段 wire 采样（spec D9）：getStats 展平行 → 选定对累计值取增量累进；只写内存。
   *  首拍只建基线不计增量（与 host 侧同一口径）；pc 重建计数回退时负增量钳零。 */
  sampleWireStats(rows: any[]): void {
    const pairs = rows.filter((s) => s?.type === 'candidate-pair' && (s.selected === true || s.state === 'succeeded'));
    const pair = pairs.find((p) => p.selected === true) ?? pairs.find((p) => p.nominated) ?? pairs[0];
    if (!pair) return;
    const loc = rows.find((s) => s?.type === 'local-candidate' && s.id === pair.localCandidateId);
    const rem = rows.find((s) => s?.type === 'remote-candidate' && s.id === pair.remoteCandidateId);
    // 双侧规则（F8 真机实证，与 src/pathType.ts 孪生保持一致）：任一端 relay 即过 TURN——
    // 只看本端会把「手机 prflx ↔ 桌面 relay」的同一条对误判成直连（门禁自然臂全程如此）。
    const locType = classifyCandidateType(loc?.candidateType);
    const remType = classifyCandidateType(rem?.candidateType);
    const pathType = locType === 'relay' || remType === 'relay' ? 'relay'
      : locType !== 'unknown' ? locType
      : remType;
    const wireSent = pair.bytesSent ?? 0;
    const wireRecv = pair.bytesReceived ?? 0;
    if (this.prevWire) {
      this.wireBytesSent += Math.max(0, wireSent - this.prevWire.wireSent);
      this.wireBytesRecv += Math.max(0, wireRecv - this.prevWire.wireRecv);
    }
    if (pathType !== 'unknown') this.pathType = pathType;
    this.prevWire = { wireSent, wireRecv };
  }

  /** tunnel 段归类（spec D9）：隧道响应帧计入 wire 桶并把路径记为 'tunnel'
   *  （隧道段走网关 HTTP 无 ICE 对，getStats 判不到；帧字节即该段可测的 wire 口径）。 */
  noteTunnelFrame(inFrame?: unknown): void {
    this.pathType = 'tunnel';
    if (inFrame !== undefined) this.wireBytesRecv += wireBytes(inFrame);
  }
}

/** 帧线字节估算：二进制帧（v2 协议 6B 头）按 6+payload；其余按 JSON 序列化长度；不可序列化 → 0。 */
export function wireBytes(m: any): number {
  const d = m?.data;
  if (d instanceof Uint8Array) return 6 + d.byteLength;
  try { return JSON.stringify(m).length; } catch { return 0; }
}

