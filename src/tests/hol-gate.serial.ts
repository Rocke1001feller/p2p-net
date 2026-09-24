/**
 * HOL 门禁（spec D2 验收的 loopback CI 跳线）：4 通道池下，16MiB 大传输期间 1KB 探测的排队增量 p95 ≤ 500ms。
 * 判定口径预注册（本文件头注释即契约）：窗口内探测（big done 前完成）≥10 次才统计；
 * 增量 = 探测(doneAt-sendAt) - idle 基线 p50；大响应 chunk 全落同一通道（粘滞断言）。
 *
 * 阈值修订记录（2026-09-24，controller ruling；修订数值先于修订后首跑定案——防「调到绿」）：
 * 原预注册 50ms 移植自 v3 bench 安静机口径。实测本开发机常态桌面负载（scrcpy/编辑器等常驻）下，
 * 本工作负载自身调度争用即达 150-250ms（controller 接管后常态负载串行实测 167ms；agent-82 并行套件三轮 165/190/242ms）；安静窗口 46ms。
 * 真实积压型回归信号 ≥1000ms（反向验证 R2：pickDc 破坏+慢速排空 → p95=1058ms FAIL，门禁确咬）。
 * 500ms 在噪声上限（~250ms）与信号下限（~1000ms）之间取 ≥2× 双边余量。
 * 性能声明的权威验收归 Task 13 真机对比；本门禁只做回归跳线，不背性能证明。
 * 本测试 CPU 竞争敏感，须串行单跑（package.json test:serial；并行套件由 test:parallel 承载）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HostAgent } from '../host.js';
import { Peer } from '../peer.js';
import { decodeBinFrame } from '../frames.js';
import { roomFor, type SigMessage, type IceCandidateLike } from '../signaling/protocol.js';
import type { PollResult } from '../signaling/client.js';

class MemSignaling {
  private nextId = 1;
  private boxes = new Map<string, Array<{ id: number; sender: string; payload: SigMessage }>>();
  async send(room: string, sender: string, msg: SigMessage): Promise<void> {
    const rows = this.boxes.get(room) ?? [];
    rows.push({ id: this.nextId++, sender, payload: msg });
    this.boxes.set(room, rows);
  }
  async poll(room: string, cursor: number): Promise<PollResult> {
    const rows = (this.boxes.get(room) ?? []).filter((r) => r.id > cursor);
    return { msgs: rows, cursor: rows.length ? rows[rows.length - 1].id : cursor };
  }
  async purgeExpired(): Promise<void> {}
}

async function until(fn: () => boolean, ms = 20000, what = ''): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function closeServer(server: http.Server): void {
  server.close();
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)];
}
function p50(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

test('HOL 门禁：16MiB 大传输期间 1KB 探测排队增量 p95≤500ms（loopback 跳线）；大响应粘滞单通道', async () => {
  // 本地 http：/size/<n> 流式（16KiB/5ms，拉长传输窗口）；/small 立即 1KB
  const server = http.createServer((req, res) => {
    const m = /^\/size\/(\d+)/.exec(req.url ?? '');
    if (m) {
      const total = Number(m[1]);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(total) });
      let sent = 0;
      const t = setInterval(() => {
        if (sent >= total) { clearInterval(t); res.end(); return; }
        const n = Math.min(16384, total - sent);
        res.write(Buffer.alloc(n, 'x'));
        sent += n;
      }, 5);
      return;
    }
    const body = Buffer.alloc(1024, 's');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    res.end(body);
  });
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));

  const UID = 'uid-hol';
  const hostRoom = roomFor(UID, 'desk-hol');
  const phoneRoom = roomFor(UID, 'phone-hol');
  const sig = new MemSignaling();
  const agent = new HostAgent({
    supabaseUrl: 'http://unused.invalid', publishableKey: 'pk-hol', accessToken: () => null,
    deviceId: 'desk-hol', uid: UID,
    turnFetcher: async () => ({ iceServers: [] }),
    signaling: sig, pollMs: 25,
  });
  agent.start();

  const client = new Peer([], {});
  let clientSid = '';
  const pendingClientIce: IceCandidateLike[] = [];
  const offer = await client.connectAsClient({
    onChannel: () => {},
    onIce: (cand) => { if (clientSid) void sig.send(hostRoom, 'phone-hol', { type: 'ice', sid: clientSid, cand, from: 'phone-hol' }); },
    onStatus: () => {},
  }, { poolSize: 4 });
  clientSid = offer.sid;
  await sig.send(hostRoom, 'phone-hol', { type: 'offer', sid: offer.sid, sdp: { type: offer.sdp.type, sdp: offer.sdp.sdp }, from: 'phone-hol' });

  let clientCursor = 0;
  let answerSeen = false;
  const pump = setInterval(() => {
    void (async () => {
      const { msgs, cursor } = await sig.poll(phoneRoom, clientCursor);
      clientCursor = cursor;
      for (const row of msgs) {
        const m = row.payload;
        if (m.type === 'answer' && m.sdp) {
          await client.acceptAnswer(m.sid, m.sdp);
          answerSeen = true;
          for (const c of pendingClientIce.splice(0)) await client.addIce(c);
        } else if (m.type === 'ice' && m.cand) {
          if (answerSeen) await client.addIce(m.cand);
          else pendingClientIce.push(m.cand);
        }
      }
    })();
  }, 20);
  pump.unref?.();

  // client 侧 reassembly：4 通道全挂（二进制 v2 + base64 兼容），req 恒从 pool[0] 发
  interface Accum { sendAt: number; headAt?: number; doneAt?: number; bytes: number; ch: Set<number> }
  const accs = new Map<number, Accum>();
  const onFrame = (chIdx: number) => (ev: { data: unknown }) => {
    const raw = ev.data;
    const eat = (id: number, fn: (a: Accum) => void) => {
      const a = accs.get(id);
      if (!a) return;
      a.ch.add(chIdx);
      fn(a);
    };
    if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
      const bf = decodeBinFrame(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
      if (bf?.k === 'res-chunk') eat(bf.id, (a) => {
        if (bf.data) a.bytes += bf.data.byteLength;
        if (bf.done) a.doneAt = Date.now();
      });
      return;
    }
    const m = JSON.parse(String(raw));
    if (m.k === 'res-head') eat(m.id, (a) => { a.headAt = Date.now(); });
    else if (m.k === 'res-chunk') eat(m.id, (a) => {
      if (m.dataB64) a.bytes += Buffer.from(m.dataB64, 'base64').byteLength;
      if (m.done) a.doneAt = Date.now();
    });
  };
  offer.channels.pool.forEach((ch, i) => {
    (ch as unknown as { binaryType: string }).binaryType = 'arraybuffer';
    ch.onmessage = onFrame(i);
  });
  const proxy0 = offer.channels.proxy;

  const shoot = (id: number, path: string): void => {
    accs.set(id, { sendAt: Date.now(), bytes: 0, ch: new Set() });
    proxy0.send(JSON.stringify({ k: 'req', id, port, method: 'GET', path, headers: {} }));
  };

  try {
    await until(() => proxy0.readyState === 'open', 20000, 'proxy0 open');

    // 1) idle 基线：10 次串行 1KB
    const base: number[] = [];
    for (let i = 0; i < 10; i++) {
      shoot(1000 + i, '/small');
      await until(() => accs.get(1000 + i)?.doneAt !== undefined, 5000, 'baseline probe done');
      base.push(accs.get(1000 + i)!.doneAt! - accs.get(1000 + i)!.sendAt);
    }
    const baseP50 = p50(base);

    // 2) 大传输（16MiB，不 await）+ 窗口内 30 次 1KB 探测（100ms 间隔）
    shoot(1, '/size/16777216');
    await until(() => accs.get(1)?.headAt !== undefined, 10000, 'big head');
    const probes: { sendAt: number; doneAt: number }[] = [];
    let skippedAfterDone = 0;
    for (let i = 0; i < 30; i++) {
      const id = 2000 + i;
      shoot(id, '/small');
      await until(() => accs.get(id)?.doneAt !== undefined || accs.get(1)?.doneAt !== undefined, 10000, 'probe or big done');
      const a = accs.get(id)!;
      if (a.doneAt !== undefined && accs.get(1)?.doneAt === undefined) probes.push({ sendAt: a.sendAt, doneAt: a.doneAt });
      else if (a.doneAt !== undefined) skippedAfterDone += 1; // big 已完成后的探测：剔除并计数
      if (accs.get(1)?.doneAt !== undefined && accs.get(1)!.bytes >= 16777216) break;
    }
    await until(() => accs.get(1)?.doneAt !== undefined, 30000, 'big done');

    // 3) 判定（预注册口径）
    assert.ok(probes.length >= 10, `窗口内有效探测不足（${probes.length} 次，剔除 ${skippedAfterDone} 次）——门禁形同虚设`);
    const deltas = probes.map((p) => p.doneAt - p.sendAt - baseP50);
    const gate = p95(deltas);
    assert.ok(gate <= 500, `HOL 门禁失败：大传输期 1KB 探测排队增量 p95=${gate}ms > 500ms（基线 p50=${baseP50}ms，样本 ${probes.length}）`);
    assert.equal(accs.get(1)!.bytes, 16777216, '大传输字节完整');
    assert.equal(accs.get(1)!.ch.size, 1, `大响应 chunk 跨通道（粘滞破坏）：落在 ${[...accs.get(1)!.ch].join(',')}`);
  } finally {
    clearInterval(pump);
    client.close();
    agent.stop();
    closeServer(server);
  }
});
