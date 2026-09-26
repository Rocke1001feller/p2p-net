/** 隧道会话计量——host 侧分发（2026-09-26 仪器缺口 §3.2.2 闭合，任务B 前半）。
 *
 *  PWA 级联落入隧道（wss 隧道模式）时经信令通道上报 tunnel-session start/end 帧；
 *  host 库层只负责把该帧分发到 opts.onTunnelSession，绝不落入 offer/ice 会话分支
 *  （隧道会话无 SDP 可应答、无 TURN 凭据可取、无 PeerSession 可建）。
 *  旧装配（无 onTunnelSession 回调）收到该帧必须静默忽略、轮询环不受扰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HostAgent } from '../host.js';
import type { PollResult, SigRow } from '../signaling/client.js';
import type { SigMessage } from '../signaling/protocol.js';

async function until(fn: () => boolean, ms = 3000, what = ''): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 一次性吐出给定信令帧、此后恒空的 stub（注入实现不重建，看门狗不干预）。 */
class QueueSignaling {
  sent: SigMessage[] = [];
  private queue: SigRow[];
  constructor(msgs: SigMessage[]) {
    this.queue = msgs.map((payload, i) => ({ id: i + 1, sender: 'pwa-1', payload }));
  }
  async send(_room: string, _sender: string, msg: SigMessage): Promise<void> {
    this.sent.push(msg);
  }
  async poll(): Promise<PollResult> {
    const msgs = this.queue.splice(0);
    return { msgs, cursor: msgs.length > 0 ? msgs[msgs.length - 1].id : 0 };
  }
  async purgeExpired(): Promise<void> {}
}

function makeHost(over: Record<string, unknown> = {}): HostAgent {
  return new HostAgent({
    supabaseUrl: 'https://x.supabase.co',
    publishableKey: 'k',
    accessToken: () => 't',
    deviceId: 'desk-test',
    uid: 'u-test',
    turnFetcher: async () => {
      throw new Error('turn n/a：tunnel-session 不得触发 TURN 取数');
    },
    pollMs: 5,
    ...over,
  } as ConstructorParameters<typeof HostAgent>[0]);
}

test('tunnel-session 帧分发到 onTunnelSession 且原样透传，不落 offer/ice 会话分支', async () => {
  const frame: SigMessage = { type: 'tunnel-session', sid: 'phone-t1', phase: 'start', access: 'cellular-ct', from: 'pwa-1' };
  const sig = new QueueSignaling([frame]);
  const received: SigMessage[] = [];
  let turnCalls = 0;
  const host = makeHost({
    signaling: sig,
    onTunnelSession: (m: SigMessage) => received.push(m),
    turnFetcher: async () => {
      turnCalls++;
      throw new Error('turn n/a');
    },
  });
  host.start();
  try {
    await until(() => received.length === 1, 3000, 'onTunnelSession 应被调用一次');
    assert.deepEqual(received[0], frame, '帧应原样透传（type/sid/phase/access 不加工）');
    assert.equal(turnCalls, 0, '不得进入 offer 分支取 TURN 凭据');
    assert.equal(sig.sent.length, 0, '不得应答 answer/ice（隧道帧无会话可路由）');
    assert.equal(host.dataPlaneSnapshot().sessions, 0, '不得建立 WebRTC 会话');
  } finally {
    host.stop();
  }
});

test('tunnel-session phase=end 帧同样分发（start/end 皆由装配层解释，库层不区分）', async () => {
  const sig = new QueueSignaling([{ type: 'tunnel-session', sid: 'phone-t1', phase: 'end' }]);
  const received: SigMessage[] = [];
  const host = makeHost({ signaling: sig, onTunnelSession: (m: SigMessage) => received.push(m) });
  host.start();
  try {
    await until(() => received.length === 1, 3000, 'end 帧应分发到 onTunnelSession');
    assert.equal(received[0].phase, 'end');
    assert.equal(received[0].sid, 'phone-t1');
  } finally {
    host.stop();
  }
});

test('旧装配无 onTunnelSession：tunnel-session 帧静默忽略，轮询环不受扰', async () => {
  const sig = new QueueSignaling([{ type: 'tunnel-session', sid: 'phone-t1', phase: 'start', access: 'wifi-home' }]);
  const host = makeHost({ signaling: sig });
  host.start();
  try {
    await until(() => host.signalingHealth().pollsOk >= 2, 3000, '收到隧道帧后轮询应持续推进');
    assert.equal(host.signalingHealth().consecutiveFailures, 0, '隧道帧不得被判为轮询失败');
    assert.equal(sig.sent.length, 0);
  } finally {
    host.stop();
  }
});
