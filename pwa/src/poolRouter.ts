/**
 * PWA 侧出站通道路由（spec D2 解读 a）：
 * - req / req-abort → 恒 proxy0（请求面单通道保序，多通道绝不重排请求）；
 * - ws-open → 此刻最闲通道，并按 wid 粘滞（同一条 WS 的帧永不跨通道，保序）；
 * - ws-msg / ws-close → 跟随 wid 粘滞；ws-close 删映射。
 * res 帧走哪条由 host 决定（host 按 id 粘滞），PWA 入站四通道全挂同一 onFrame 即可。
 */
import { pickLeastBufferedIdx, type PooledChannel } from 'p2p-net/browser';

export class PoolRouter {
  /** wid → 池下标（ws-open 时建立，ws-close 时删除）。 */
  private readonly widCh = new Map<number, number>();

  constructor(private readonly chs: () => readonly PooledChannel[]) {}

  /** 该帧应走的池下标；调用方对越界兜底 dcs[0]。 */
  channelFor(frame: any): number {
    const k = frame?.k;
    if (k === 'req' || k === 'req-abort') return 0;
    if (k === 'ws-open') {
      const idx = pickLeastBufferedIdx(this.chs());
      const pick = idx >= 0 ? idx : 0;
      this.widCh.set(frame.wid as number, pick);
      return pick;
    }
    if (k === 'ws-msg' || k === 'ws-close') {
      const idx = this.widCh.get(frame.wid as number) ?? 0;
      if (k === 'ws-close') this.widCh.delete(frame.wid as number);
      return idx;
    }
    return 0; // ping/pong 等控制帧不路由（ctrl 通道专走），防御性回落
  }
}
