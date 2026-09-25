/** 隧道腿计量（F10：/status 对隧道腿失明——隧道是最贵路径（VPS 流量计费），
 *  host 侧账本此前只有 WebRTC 会话，隧道字节完全不可见）。
 *
 *  口径纪律（与 PeerSession 对齐，偏差如实标注）：
 *  - 字节 = JSON 帧串长度（ws 帧头/压缩开销不计；PeerSession 的 bytes 同为 JSON 口径，
 *    其 wireBytes 来自 getStats——隧道腿无 getStats，wire≈JSON 帧长是可达的最真近似）；
 *  - req/resDone 语义与 PeerSession 相同：入站 req 帧计数，出站 res-chunk done=true 计完成；
 *  - 进程期累计不清零：隧道腿无 host 侧会话生命周期（relay 把多客户端复用进一条链路），
 *    与 dataPlaneSnapshot「活跃会话求和」口径不同——调用方注释必须写明。
 */

import { isReq, isResChunk } from '../frames.js';
import { makeLedger, type SessionLedger } from '../host.js';

export class TunnelMeter {
  readonly ledger: SessionLedger = { ...makeLedger(), pathType: 'tunnel' };

  /** 入站（relay→host 的已解析帧）：字节按重序列化长度计；req 帧计数。 */
  recordInbound(frame: unknown): void {
    // 帧来自 TunnelClient 的 JSON.parse，重序列化不会抛（无循环引用）
    const n = Buffer.byteLength(JSON.stringify(frame));
    this.ledger.bytesRecv += n;
    this.ledger.wireBytesRecv += n;
    if (isReq(frame)) this.ledger.req += 1;
  }

  /** 出站（桥→dc shim 的 JSON 串）：字节全计；res-chunk done=true 计完成。 */
  recordOutbound(data: string): void {
    this.ledger.bytesSent += Buffer.byteLength(data);
    this.ledger.wireBytesSent += Buffer.byteLength(data);
    try {
      const f: unknown = JSON.parse(data);
      if (isResChunk(f) && f.done === true) this.ledger.resDone += 1;
    } catch {
      // 非法出站串（dcSend 只产合法 JSON，此处纯防御）：字节已计，不增计数不抛错
    }
  }
}
