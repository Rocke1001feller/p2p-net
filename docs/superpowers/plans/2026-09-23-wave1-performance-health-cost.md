# Wave 1 性能·健康·成本 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 v0.1.0 基线上完成二期 Wave 1：二进制帧砍掉 base64 33% 字节税、proxy 4 通道池治队头阻塞、consent 看门狗 + N4 阈值治 15min 周期死亡、stall 诚实徽章、成本成为一等指标；真机门禁四指标全面对比基线。

**Architecture:** 帧协议 v2（控制帧仍 JSON 文本；`res-chunk`/`ws-msg` 数据体改二进制帧，编解码同构实现在 `src/frames.ts`，经 `src/browser.ts` barrel 共享给 PWA，单一事实源）；proxy 通道池（浏览器建 `proxy0..3`，req 全走 proxy0，host 按 id/wid 粘滞把 res 路由到最小 bufferedAmount 通道）；健康双驱动（徽章 = 心跳新鲜 AND 数据面有进展；stallSuspect 三条件示警）；consent 看门狗兜底 werift 0.24.4 #69（签名检测 → 就地复活 → 上限后交控制面）；帧账本进 `:19727/status` 与 events.jsonl（成本埋点）。

**Tech Stack:** Node 20+ / TypeScript（`tsx --test`）、werift ^0.24.4、浏览器原生 RTCPeerConnection、Supabase Edge Function（Deno）、coturn（relay VPS 49.233.155.13）、Android 蜂窝真机。

**Spec:** `docs/superpowers/specs/2026-09-23-wave1-performance-health-cost-design.md`（D1-D9 设计决策与证据分级的唯一事实源；本计划逐任务实现之）

## Global Constraints

- 简单鲁棒，严控复杂度：不引入三通道级联、决策引擎、ws 信令长连（spec §2 批判吸收清单）。
- 帧协议变更双端同批发布；PWA 与 host 互为 sha256 对账（实验纪律）。
- 一切因果结论分级标注【实测/推断/未验证】；实验预注册，A-B-A 反转优先。
- TDD：每任务失败测试先行；`npm test` 全绿才许提交。
- **跑 `npm test` 前必须停掉常驻 host**（端口 19727/19728 冲突），跑完立即恢复并确认手机回连（2026-09-23 教训：忘恢复致手机 30min 重连空转）。
- 密钥纪律：VPS 密码、Supabase access token、TURN secret、用户 JWT 一律用 `$ENV_VAR` 引用、当场从用户会话获取，**绝不写进任何进 git 的文件**（含本计划、e2e 报告）。
- 真机门禁：Wave 1 结束时跑 60min 浸泡 + 蜂窝真人实测，四指标对比基线（p90=53ms / stall 16 次 587s / 15min 周期 / 字节量），报告落 `e2e/`。
- 基线锚点（一切对比不得另起口径）：host done 时延 p50=4ms/p90=53ms（蜂窝 TURN）；22min 真人实测 468 请求零错误、1.3MB 隧道流量；大 JSON 期 1KB 请求排队 39s。
- **开发纪律（2026-09-23 二轮迭代新增，二期起生效）**：每 Task 的最后 Commit 步骤替换为——在 `wave1/task-N-<slug>` 分支 commit → 自检合并门禁三件套（①问题陈述：解决了什么问题、证据分级；②本仓实测记录；③`npm test` 全绿）→ squash merge 回 main；禁 force push main。动网络路径的 Task（1/2/3/4/7/8/9/13）实测记录必须含真机或真 relay 证据；纯内部重构（5/6/11/12/14）可 loopback+单测。不存在「可直接吸收」：外部证据只有假设强弱之别，落点 Task 实测归档后才许在 spec §2 移入「已实测」。成本优化不得破 v0.1.0 四指标基线（D9 底线）。

## Review Focus

1. **新旧端互操作窗口**：v0.1.0 PWA（SW/CacheStorage 缓存命中）遇到 v2 host 的二进制帧时，旧端 `JSON.parse` 二进制载荷静默丢帧，表现为「升级后全 504」。合理期望：双端同批发布 + 部署后强刷验证 + 新端对旧 JSON 帧保持解码兼容。属主：Task 2/3（测试：旧 JSON 帧在新解码器下照常工作；Task 13 步骤含 sha256 对账与强刷）。
2. **werift 私有字段漂移**：consent 看门狗读 `iceTransports[0].connection` 属未文档化接口；werift 升级/降级致字段缺失时，看门狗必须零副作用跳过，绝不能把 host 搞崩。属主：Task 8（测试：无 `iceTransports` 的 stub pc 挂看门狗 = 完全无操作）。
3. **tunnel 模式误参与**：`cascade.mode==='tunnel'` 时不走 DataChannel——stall 判定、池路由、二进制帧全部不得作用于 tunnel 段（tunnel 仍 JSON/HTTP 网关）。属主：Task 4（测试：路由器只消费 dc 帧，tunnel 分流在 session.ts 层不经过它）、Task 6（测试：`ctrlAlive=false` 时 stallSuspect 恒 false）。
4. **多客户端串台**：host 多 PeerSession 并存，帧账本 / reqDc 粘滞映射 / 看门狗全部按会话隔离——A 客户端的响应不得路由到 B 客户端的通道，账本不得互相累计。属主：Task 4/5（测试：两会话各自建池，响应落各自通道，账本独立）。
5. **SW 回收重启后的误判**：SW 被浏览器回收重启后其 pending Map 清空，shell 侧 inflightSw 仍非空——此时链路本身健康与否未知，stall 黄灯不得仅凭「在途非零 + 静默」点亮（必须 ctrlAlive 为前提）。属主：Task 6（测试：`inFlight>0 且 silentMs 超阈但 ctrlAlive=false` → false）。

---

### Task 1: TURN 凭据改单 UDP（spec D4）+ coturn 15min 死亡取证（spec D3 取证臂）

**Files:**
- Modify: `supabase/functions/turn-credentials/index.ts:41-53`
- Create: `e2e/n3-turn-transport-and-coturn-forensics.md`

**Interfaces:**
- Consumes: edge function 现有契约（POST + 用户 JWT → `{iceServers, username, credential, ttlSeconds}`）；relay VPS SSH（凭据在用户会话，用 `$VPS_PW` 引用）
- Produces: 默认每个 host 的 TURN urls 仅含 `turn:<h>:3478?transport=udp` 一条；env `TURN_TRANSPORT=udp|tcp|both` 可选（`both` 为毒药档，仅供 A/B 复核 v3 的 33% 结论）

- [ ] **Step 1: 取证先行（不改代码）——coturn 侧 15min 死亡对齐**

登 relay VPS 拉配置与日志，对齐基线报告（`e2e/real-service-soak.md` 4 次掉线时刻、真人实测 15min 周期）：

```bash
sshpass -p "$VPS_PW" ssh -o StrictHostKeyChecking=no ubuntu@49.233.155.13 \
  'grep -iE "lifetime|max-allocate|external-ip" /etc/turnserver.conf; \
   echo "$0" | sudo -S journalctl -u coturn --since "-24h" 2>/dev/null | grep -iE "expired|refresh|allocation|delete" | tail -80' <<< "$VPS_PW"
```

看点：① allocation lifetime（默认 600s）与死亡周期（~900s ≈ 1.5×lifetime）的关系；② 死亡时刻日志是否有 `allocation ... deleted/expired` 而无对应 refresh；③ `external-ip` 是否配置（coturn 运维纪律）。结论分级写入报告（【实测】=日志直接对齐；【推断】=时间相关但无 allocation 记录）。

- [ ] **Step 2: 留改前证据（契约断言，预期双 transport）**

```bash
JWT="$USER_JWT"  # 用户会话提供（PWA 登录态 access_token）
curl -s -X POST "$SUPABASE_URL/functions/v1/turn-credentials" \
  -H "authorization: Bearer $JWT" -H "apikey: $PUBLISHABLE_KEY" \
  | jq '[.iceServers[].urls[] | select(startswith("turn:"))]'
# 预期（改前）：每 host 两条 —— turn:<h>:3478?transport=udp 与 turn:<h>:3478?transport=tcp
```

- [ ] **Step 3: 改代码（`supabase/functions/turn-credentials/index.ts` 第 41-53 行整体替换为）**

```ts
  const ttl = 3600 * 6;
  const username = `${Math.floor(Date.now() / 1000) + ttl}:${uid.slice(0, 8)}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  // Wave 1（spec D4）：默认只发单 UDP。v3 三臂实测（n=6）：UDP-only 6/6、TCP-only 5/6、
  // both 2/6=33% —— 双 transport 同发是成功率毒药。TURN_TRANSPORT 仅为 A/B 复核保留。
  const transport = (Deno.env.get("TURN_TRANSPORT") ?? "udp").toLowerCase();
  const turnUrls = (h: string): string[] =>
    transport === "both"
      ? [`turn:${h}:3478?transport=udp`, `turn:${h}:3478?transport=tcp`]
      : [`turn:${h}:3478?transport=${transport === "tcp" ? "tcp" : "udp"}`];
  const iceServers = hosts.flatMap((h) => [
    { urls: [`stun:${h}:3478`] },
    { urls: turnUrls(h), username, credential },
  ]);
  return json(200, {
    iceServers,
    username,
    credential,
    ttlSeconds: ttl,
  });
```

- [ ] **Step 4: 部署**

```bash
SUPABASE_ACCESS_TOKEN="$SUPABASE_TOKEN" supabase functions deploy turn-credentials
# 未 link 时先：SUPABASE_ACCESS_TOKEN="$SUPABASE_TOKEN" supabase link --project-ref <ref>
#（ref = supabaseUrl 的子域，见 ~/.p2p-net 或 init 时配置；token 在用户会话，不落盘）
```

- [ ] **Step 5: 部署后契约断言（同 Step 2 的 curl）**

预期：每 host 仅 `turn:<h>:3478?transport=udp` 一条；`stun:` 条目不变。断言失败即回查 Step 3/4，不得放过。

- [ ] **Step 6: 报告落盘并 commit**

`e2e/n3-turn-transport-and-coturn-forensics.md`：取证发现（分级）+ 改前/改后 curl 输出 + 待 Task 13 真机复核项（TURN 段建连成功率 vs v3 的 both=33%）。

```bash
git add supabase/functions/turn-credentials/index.ts e2e/n3-turn-transport-and-coturn-forensics.md
git commit -m "feat(turn): turn-credentials 默认只发单 UDP transport（v3 实测双 transport 成功率 33%）+ coturn 取证"
```

---

### Task 2: 帧协议 v2（host 侧）—— res-chunk / ws-msg 二进制帧

**Files:**
- Modify: `src/frames.ts`（新增二进制编解码、`WsMsgFrame.dataBin`、`isWsMsg` 放宽）
- Modify: `src/bridge/http.ts:17-42,119-141`（`DcLike` 加 `binaryOk`、`dcSendBin`、`sendChunk` 统一口）
- Modify: `src/bridge/ws.ts:43-52,87-90`（`dataBin` 入站、二进制出站）
- Modify: `src/host.ts:125-171`（`asDataPlaneDc` 包装 + wireChannel 二进制入站分发）
- Test: `src/tests/frames.test.ts`、`src/tests/bridge.test.ts`

**Interfaces:**
- Consumes: 现有 `TunnelFrame` JSON 协议（控制帧不变）
- Produces（后续任务依赖的精确签名）:
  ```ts
  export const BIN_RES_CHUNK = 0x01;
  export const BIN_WS_MSG = 0x02;
  export interface ResChunkBinFrame { k: 'res-chunk'; id: number; data?: Uint8Array; done?: boolean }
  export interface WsMsgBinFrame { k: 'ws-msg'; wid: number; data: Uint8Array }
  export function encodeResChunkBin(id: number, data: Uint8Array | null, done: boolean): Uint8Array
  export function encodeWsMsgBin(wid: number, data: Uint8Array): Uint8Array
  export function isBinFrame(buf: Uint8Array): boolean
  export function decodeBinFrame(buf: Uint8Array): ResChunkBinFrame | WsMsgBinFrame | null
  export function chunkU8(buf: Uint8Array): Uint8Array[]
  // bridge/http.ts
  export interface DcLike { send(data: string | Buffer | Uint8Array): void; readonly bufferedAmount: number; readonly readyState?: string; binaryOk?: boolean }
  export async function dcSendBin(dc: DcLike, u8: Uint8Array): Promise<void>
  // host.ts
  export function asDataPlaneDc(dc: RTCDataChannel): DcLike  // binaryOk:true 的透传包装
  ```

线格式（Uint8Array 同构编解码，Node `Buffer` 与浏览器 `ArrayBuffer` 皆可喂入；与 JSON 的区分：JSON 首字节恒为 `'{'`=0x7B，二进制 kind 为 0x01/0x02）：

```
res-chunk: [0x01][id u32be 4B][flags 1B，bit0=done][payload…]
ws-msg:    [0x02][wid u32be 4B][payload…]
```

- [ ] **Step 1: 写失败测试（追加到 `src/tests/frames.test.ts`）**

```ts
import { encodeResChunkBin, encodeWsMsgBin, decodeBinFrame, isBinFrame, chunkU8 } from '../frames.js';

test('二进制 res-chunk 往返：含 payload / 仅 done', () => {
  const payload = new Uint8Array([1, 2, 3, 250]);
  assert.deepEqual(decodeBinFrame(encodeResChunkBin(42, payload, false)), { k: 'res-chunk', id: 42, data: payload });
  assert.deepEqual(decodeBinFrame(encodeResChunkBin(42, null, true)), { k: 'res-chunk', id: 42, done: true });
});

test('二进制 ws-msg 往返 + 大 id 无符号（>2^31）', () => {
  const payload = new Uint8Array([0, 159, 146, 150]);
  assert.deepEqual(decodeBinFrame(encodeWsMsgBin(7, payload)), { k: 'ws-msg', wid: 7, data: payload });
  const f = decodeBinFrame(encodeResChunkBin(0xf0000001, null, true));
  assert.equal(f?.k, 'res-chunk');
  assert.equal((f as { id: number }).id, 0xf0000001);
});

test('decodeBinFrame 拒垃圾：JSON 文本 / 短帧 / 未知 kind → null', () => {
  assert.equal(decodeBinFrame(new TextEncoder().encode('{"k":"res-chunk","id":1}')), null);
  assert.equal(decodeBinFrame(new Uint8Array([1, 2])), null);
  assert.equal(decodeBinFrame(new Uint8Array([9, 0, 0, 0, 1, 0])), null);
  assert.equal(isBinFrame(new TextEncoder().encode('{"k":"ping"}')), false);
});

test('chunkU8 边界：16384 / 16385 字节，原始字节不经过 base64', () => {
  const exact = new Uint8Array(16384).fill(7);
  assert.equal(chunkU8(exact).length, 1);
  const over = new Uint8Array(16385).fill(9);
  const pieces = chunkU8(over);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].length, 16384);
  assert.equal(pieces[1].length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/tests/frames.test.ts`
Expected: FAIL — `encodeResChunkBin is not a function`（导出尚不存在）

- [ ] **Step 3: 实现 `src/frames.ts` 新增段（追加到文件末尾；`WsMsgFrame` 与 `isWsMsg` 同步修改）**

```ts
/** ---- 帧协议 v2：二进制数据帧（控制帧仍 JSON；双端同批发布，spec D1） ----
 * 砍 base64 33% 字节税 + 双端编解码 CPU（v3 tc-cost 实测 TURN 字节因子 1.68：线字即成本）。
 * 二进制 kind 与 JSON 的区分：JSON 文本首字节恒为 '{'(0x7B)。
 */
export const BIN_RES_CHUNK = 0x01;
export const BIN_WS_MSG = 0x02;

export interface ResChunkBinFrame { k: 'res-chunk'; id: number; data?: Uint8Array; done?: boolean }
export interface WsMsgBinFrame { k: 'ws-msg'; wid: number; data: Uint8Array }

export function encodeResChunkBin(id: number, data: Uint8Array | null, done: boolean): Uint8Array {
  const body = data ?? new Uint8Array(0);
  const out = new Uint8Array(6 + body.length);
  out[0] = BIN_RES_CHUNK;
  out[1] = (id >>> 24) & 0xff; out[2] = (id >>> 16) & 0xff; out[3] = (id >>> 8) & 0xff; out[4] = id & 0xff;
  out[5] = done ? 1 : 0;
  out.set(body, 6);
  return out;
}

export function encodeWsMsgBin(wid: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + data.length);
  out[0] = BIN_WS_MSG;
  out[1] = (wid >>> 24) & 0xff; out[2] = (wid >>> 16) & 0xff; out[3] = (wid >>> 8) & 0xff; out[4] = wid & 0xff;
  out.set(data, 5);
  return out;
}

/** 首字节判别：是否二进制数据帧（不够长/未知 kind → false，调用方走 JSON 路径）。 */
export function isBinFrame(buf: Uint8Array): boolean {
  return buf.length >= 5 && (buf[0] === BIN_RES_CHUNK || buf[0] === BIN_WS_MSG);
}

export function decodeBinFrame(buf: Uint8Array): ResChunkBinFrame | WsMsgBinFrame | null {
  if (!isBinFrame(buf)) return null;
  const id = ((buf[1] * 0x1000000) + (buf[2] << 16) + (buf[3] << 8) + buf[4]) >>> 0;
  if (buf[0] === BIN_RES_CHUNK) {
    if (buf.length < 6) return null;
    const done = (buf[5] & 1) === 1;
    const data = buf.length > 6 ? buf.subarray(6) : undefined;
    return { k: 'res-chunk', id, ...(data ? { data } : {}), ...(done ? { done: true } : {}) };
  }
  return { k: 'ws-msg', wid: id, data: buf.subarray(5) };
}

/** 大 buffer → ≤16384B 原始字节分片（二进制帧用；顺序拼接可还原）。 */
export function chunkU8(buf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < buf.length; i += CHUNK_SIZE) out.push(buf.subarray(i, i + CHUNK_SIZE));
  return out;
}
```

`WsMsgFrame` 加 `dataBin`（二进制入站的归一化载体），`isWsMsg` 放宽：

```ts
export interface WsMsgFrame { k: 'ws-msg'; wid: number; text?: string; dataB64?: string; dataBin?: Uint8Array }
// isWsMsg 改为：
export function isWsMsg(x: unknown): x is WsMsgFrame {
  return shape(x, 'ws-msg') && hasNum(x, 'wid') &&
    (hasStr(x, 'text') || hasStr(x, 'dataB64') || (x as { dataBin?: unknown }).dataBin instanceof Uint8Array);
}
```

- [ ] **Step 4: 实现桥接出站（`src/bridge/http.ts`）**

`DcLike` 加 `binaryOk`（隧道 DcLike 无此标记 → 自动落 legacy base64 路径，tunnel 模式零影响）：

```ts
export interface DcLike {
  send(data: string | Buffer | Uint8Array): void;
  readonly bufferedAmount: number;
  readonly readyState?: string;
  /** 数据面能力标记：true = 对端会解二进制帧（WebRTC 双端同批）；缺省 = legacy base64 JSON（tunnel）。 */
  binaryOk?: boolean;
}
```

`dcSendBin` 与统一 chunk 出口（复用同一背压阈值与 setImmediate 让出纪律）：

```ts
/** 二进制帧出站：背压与让出语义同 dcSend。 */
export async function dcSendBin(dc: DcLike, u8: Uint8Array): Promise<void> {
  if (dc.readyState !== undefined && dc.readyState !== 'open') return;
  while (dc.bufferedAmount > BACKPRESSURE_BYTES) await sleep(10);
  dc.send(u8);
  await new Promise<void>((r) => setImmediate(r));
}

/** res-chunk 统一出口：binaryOk 走二进制帧，否则 legacy base64 JSON（tunnel/旧端）。 */
async function sendChunk(dc: DcLike, id: number, data: Buffer | null, done: boolean): Promise<void> {
  if (dc.binaryOk) return dcSendBin(dc, encodeResChunkBin(id, data, done));
  if (data !== null) await dcSend(dc, { k: 'res-chunk', id, dataB64: data.toString('base64'), ...(done ? { done: true } : {}) });
  else await dcSend(dc, { k: 'res-chunk', id, done: true });
}
```

`doReq` 的全部 res-chunk 出站改经 `sendChunk`：400/502 错误体（`Buffer.from(text,'utf8')` + done）、204/304 收尾（null + done）、body 流（逐 `chunkU8` 片 + 收尾 null+done）。body 循环改为：

```ts
      let sentBytes = 0;
      for await (const chunk of res) {
        for (const piece of chunkU8(chunk as Buffer)) {
          sentBytes += piece.length;
          await sendChunk(dc, id, Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength), false);
        }
      }
      this.ctrls.delete(id);
      await sendChunk(dc, id, null, true);
```

- [ ] **Step 5: 实现 ws 桥双向（`src/bridge/ws.ts`）**

入站 `isWsMsg` 分支加 `dataBin`（host 从二进制帧解出的归一化形态）：

```ts
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (frame.text !== undefined) ws.send(frame.text);
        else if (frame.dataB64 !== undefined) ws.send(Buffer.from(frame.dataB64, 'base64'));
        else if (frame.dataBin !== undefined) ws.send(Buffer.from(frame.dataBin.buffer, frame.dataBin.byteOffset, frame.dataBin.byteLength));
      }
```

出站 `'message'` 处理器：

```ts
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) void dcSend(dc, { k: 'ws-msg', wid: frame.wid, text: data.toString('utf8') });
      else if (dc.binaryOk) void dcSendBin(dc, encodeWsMsgBin(frame.wid, data));
      else void dcSend(dc, { k: 'ws-msg', wid: frame.wid, dataB64: data.toString('base64') });
    });
```

- [ ] **Step 6: host wireChannel 接二进制（`src/host.ts`）**

新增导出（Task 5 会扩展为带账本计量的版本）：

```ts
/** 数据面 DC 适配：标记二进制能力（桥据此走帧协议 v2），背压读数透传。 */
export function asDataPlaneDc(dc: RTCDataChannel): DcLike {
  return {
    binaryOk: true,
    get bufferedAmount() { return dc.bufferedAmount; },
    get readyState() { return dc.readyState; },
    send(data) { dc.send(typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)); },
  };
}
```

`wireChannel` 的 `label.startsWith('proxy')` 分支：入口先建 `const bdc = asDataPlaneDc(dc)`，`onmessage` 首行加二进制分发，其后所有 `this.httpBridge.handle(dc, …)` / `this.wsBridge.handle(dc, …)` / 错误帧 `dcSend(dc, …)` 一律改用 `bdc`：

```ts
      dc.onmessage = (ev) => {
        const raw = ev.data;
        if (typeof raw !== 'string' && isBinFrame(raw as Buffer)) {
          const bf = decodeBinFrame(raw as Buffer);
          // host 只消费二进制 ws-msg（浏览器上行）；res-chunk 方向为协议异常，丢弃。
          if (bf?.k === 'ws-msg') void this.wsBridge.handle(bdc, { k: 'ws-msg', wid: bf.wid, dataBin: bf.data });
          return;
        }
        const m = decodeFrame(raw);
        // ……（其后逻辑不变，dc → bdc）
      };
```

- [ ] **Step 7: 写桥二进制测试（追加到 `src/tests/bridge.test.ts`）**

```ts
class FakeBinDc implements DcLike {
  binaryOk = true;
  frames: Array<any | Uint8Array> = [];
  bufferedAmount = 0;
  readyState = 'open';
  send(data: string | Buffer | Uint8Array): void {
    this.frames.push(typeof data === 'string' ? JSON.parse(data) : new Uint8Array(data.buffer ?? data, (data as Buffer).byteOffset ?? 0, (data as Buffer).byteLength ?? (data as Uint8Array).length));
  }
}

test('binaryOk 通道：res-chunk 走二进制帧（无 base64 税），拼接还原原始字节', async () => {
  const big = Buffer.alloc(40000, 0xab); // 多片（>16384）
  const { server, port } = await startHttpServer();
  // startHttpServer 的 /echo 回显：POST 40000B → 原样返回
  const dc = new FakeBinDc();
  const bridge = new HttpBridge();
  await bridge.handle(dc, { k: 'req', id: 1, port, method: 'POST', path: '/echo', headers: {}, bodyB64: big.toString('base64') });
  closeServer(server);
  const head = dc.frames.find((f) => !(f instanceof Uint8Array) && f.k === 'res-head');
  assert.ok(head, 'res-head 仍是 JSON 文本帧');
  const chunks = dc.frames.filter((f): f is Uint8Array => f instanceof Uint8Array).map((u8) => decodeBinFrame(u8)!);
  assert.ok(chunks.length >= 3, '40000B 至少 2 数据片 + 1 done');
  assert.ok(chunks.every((c) => c.k === 'res-chunk' && c.id === 1));
  const body = Buffer.concat(chunks.filter((c) => c.data).map((c) => Buffer.from(c.data!)));
  assert.deepEqual(body, big);
  assert.equal(chunks.at(-1)!.done, true);
});

test('无 binaryOk 的通道（tunnel 形态）：仍走 legacy base64 JSON（向后兼容）', async () => {
  const { server, port } = await startHttpServer();
  const dc = new FakeDc(); // 既有 stub：send JSON.parse(String(data))
  const bridge = new HttpBridge();
  await bridge.handle(dc, { k: 'req', id: 2, port, method: 'GET', path: '/', headers: {} });
  closeServer(server);
  const chunk = dc.frame((f: any) => f.k === 'res-chunk' && f.dataB64);
  assert.ok(chunk, 'legacy 通道必须仍是 base64 文本帧');
});
```

（`closeServer`/`startHttpServer`/`FakeDc` 用该文件既有设施；`decodeBinFrame` 从 `../frames.js` 导入。）

- [ ] **Step 8: 跑测试确认通过 + 全量回归**

Run: `npx tsx --test src/tests/frames.test.ts src/tests/bridge.test.ts`（先停常驻 host）
Expected: PASS；随后 `npm test` 全绿。

- [ ] **Step 9: Commit**

```bash
git add src/frames.ts src/bridge/http.ts src/bridge/ws.ts src/host.ts src/tests/frames.test.ts src/tests/bridge.test.ts
git commit -m "feat(frames): 帧协议 v2 host 侧——res-chunk/ws-msg 二进制帧，砍 base64 33% 字节税（spec D1）"
```

---

### Task 3: 帧协议 v2（PWA 侧）——二进制入站解码 + ws 上行二进制

**Files:**
- Modify: `pwa/src/signaling-web.ts:48-59,109-121,200-217`（`handleChannelMessage`、dc `binaryType`、send 的 ws 二进制支路）
- Modify: `pwa/src/shell.ts:304-340`（`onDcFrame`：`m.data` 直传、ws `dataBin`→`dataB64` 边界转换）
- Modify: `pwa/src/sw.ts:77-93`（`onPortMsg`：`m.data` Uint8Array 直enqueue）
- Test: `pwa/src/signaling-web.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `decodeBinFrame / encodeWsMsgBin / isBinFrame`（经 `p2p-net/browser` barrel，frames.ts 单一事实源）；`ResChunkBinFrame` / `WsMsgBinFrame` 归一化形态
- Produces:
  ```ts
  export function handleChannelMessage(data: string | ArrayBuffer, sinks: { onProof: () => void; onFrame: (m: unknown) => void }): void
  ```
  shell/SW 消费的归一化帧：res-chunk 体在 `m.data: Uint8Array`；ws 二进制在 `m.data: Uint8Array`（signaling-web 解出的 `WsMsgBinFrame.data`，shell 边界转 `dataB64` 喂 iframe——shim 协议不动）。

- [ ] **Step 1: 写失败测试（追加到 `pwa/src/signaling-web.test.ts`）**

```ts
import { handleChannelMessage } from './signaling-web.js';
import { encodeResChunkBin, encodeWsMsgBin } from 'p2p-net/browser';

test('二进制帧入站：res-chunk/ws-msg 记活性并上交，Uint8Array 体不丢字节', () => {
  let proofs = 0;
  const frames: any[] = [];
  const sinks = { onProof: () => { proofs += 1; }, onFrame: (m: unknown) => frames.push(m) };
  const payload = new Uint8Array([5, 6, 7, 251]);
  handleChannelMessage(encodeResChunkBin(9, payload, false).buffer as ArrayBuffer, sinks);
  handleChannelMessage(encodeWsMsgBin(3, payload).buffer as ArrayBuffer, sinks);
  assert.equal(proofs, 2);
  assert.equal(frames[0].k, 'res-chunk');
  assert.equal(frames[0].id, 9);
  assert.deepEqual(frames[0].data, payload);
  assert.equal(frames[1].k, 'ws-msg');
  assert.equal(frames[1].wid, 3);
  assert.deepEqual(frames[1].data, payload);
});

test('二进制垃圾帧：不记活性、不上交；JSON 文本路径不受影响', () => {
  let proofs = 0;
  const frames: any[] = [];
  const sinks = { onProof: () => { proofs += 1; }, onFrame: (m: unknown) => frames.push(m) };
  handleChannelMessage(new Uint8Array([1, 2]).buffer as ArrayBuffer, sinks);
  handleChannelMessage(JSON.stringify({ k: 'res-head', id: 1, status: 200, headers: {} }), sinks);
  assert.equal(proofs, 1, '仅 JSON 合法帧记活性');
  assert.equal(frames.length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test pwa/src/signaling-web.test.ts`
Expected: FAIL — `handleChannelMessage is not a function`

- [ ] **Step 3: 实现 `pwa/src/signaling-web.ts`**

import 行加：

```ts
import { decodeBinFrame, encodeWsMsgBin } from 'p2p-net/browser';
```

`handleProxyMessage` 之后新增：

```ts
/** 通道入站统一解码（帧协议 v2）：字符串走 JSON；ArrayBuffer 走二进制帧。
 *  任何合法帧都先记活性证明——批量传输期数据在流本身就是活着的证据。 */
export function handleChannelMessage(data: string | ArrayBuffer, sinks: { onProof: () => void; onFrame: (m: unknown) => void }): void {
  if (typeof data === 'string') return handleProxyMessage(data, sinks);
  const bf = decodeBinFrame(new Uint8Array(data));
  if (!bf) return;
  sinks.onProof();
  sinks.onFrame(bf);
}
```

`connect()` 里 dc 创建后：`dc.binaryType = 'arraybuffer';`（必须在 onmessage 之前；浏览器默认 blob 会让二进制帧无法同步解码）。`dc.onmessage` 改用 `handleChannelMessage`：

```ts
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev) => {
      handleChannelMessage(ev.data, {
        onProof: () => { this.lastPongAt = Date.now(); },
        onFrame: (m) => this.opts.onFrame(m),
      });
    };
```

`send()` 加 ws 上行二进制支路（在 JSON 序列化之前；复用既有 8MiB/5s 背压纪律）：

```ts
  async send(frame: unknown): Promise<void> {
    const dc = this.dc;
    if (!dc || dc.readyState !== 'open') return;
    // ws 上行二进制体：直接上二进制帧（省 33% 线税 + 双端编解码 CPU）
    const f = frame as { k?: string; wid?: number; dataB64?: string };
    if (f.k === 'ws-msg' && typeof f.dataB64 === 'string') {
      if (!(await this.waitSendSlot(dc))) return;
      dc.send(encodeWsMsgBin(f.wid!, b64ToU8(f.dataB64)));
      return;
    }
    const s = JSON.stringify(frame);
    if (!(await this.waitSendSlot(dc))) return;
    dc.send(s);
  }

  /** 背压等待（8MiB，5s 封顶）：黑洞通道只涨不落，超时即认通道已死（2026-09-12 语义不变）。 */
  private async waitSendSlot(dc: RTCDataChannel): Promise<boolean> {
    const deadline = Date.now() + 5_000;
    while (dc.bufferedAmount > 8 * 1024 * 1024) {
      if (Date.now() > deadline) {
        this.opts.onStatus({ state: 'off', pairType: null });
        this.teardown();
        return false;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return true;
  }
```

文件级 helper（与 sw.ts 的 `b64u8` 同语义，模块私有）：

```ts
function b64ToU8(b: string): Uint8Array {
  const bin = atob(b);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
```

- [ ] **Step 4: shell / SW 消费归一化帧**

`pwa/src/shell.ts` 的 `onDcFrame`（:304 起）：`pendingFetch` 支路改为双形态兼容：

```ts
      if (m.data instanceof Uint8Array) pf.chunks.push(m.data);
      else if (m.dataB64) pf.chunks.push(u8FromB64(m.dataB64));
```

ws 帧进 iframe 前做边界转换（`dataBin`→`dataB64`；线税已省，此处只是 shell↔iframe 的 shim 协议保持不变）：

```ts
  if (typeof m.k === 'string' && m.k.startsWith('ws-')) {
    const port = Math.floor(m.wid / WID_BASE);
    const n = m.wid % WID_BASE;
    const tab = tabs.get(port);
    const orig = tab?.wids.get(n);
    if (!tab || orig === undefined) return;
    const out = m.data instanceof Uint8Array ? { ...m, data: undefined, dataB64: b64FromU8(m.data) } : m;
    tab.iframe.contentWindow?.postMessage({ __p2pnet: true, ...out, wid: orig }, location.origin);
  }
```

并加 helper：`function b64FromU8(u8: Uint8Array): string { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }`

`pwa/src/sw.ts` 的 `onPortMsg` res-chunk 分支：

```ts
  } else if (m.k === 'res-chunk' && p.ctrl) {
    if (m.data) p.ctrl.enqueue(m.data instanceof Uint8Array ? m.data : new Uint8Array(m.data));
    else if (m.dataB64) p.ctrl.enqueue(b64u8(m.dataB64));
    if (m.done) { p.ctrl.close(); pending.delete(m.id); }
  }
```

- [ ] **Step 5: 跑测试确认通过 + 全量回归 + PWA 构建**

Run: `npx tsx --test pwa/src/signaling-web.test.ts` → PASS；`npm test` 全绿；`npm run build:pwa` 成功。
sha256 对账留证（Review Focus #1）：`shasum -a 256 pwa-dist/assets/*.js | sort > /tmp/wave1-task3-pwa-sha256.txt`，部署验证归 Task 13。

- [ ] **Step 6: Commit**

```bash
git add pwa/src/signaling-web.ts pwa/src/shell.ts pwa/src/sw.ts pwa/src/signaling-web.test.ts
git commit -m "feat(frames): 帧协议 v2 PWA 侧——二进制入站解码 + ws 上行二进制（spec D1，双端同批）"
```

---

### Task 4: proxy 通道池（spec D2 解读 a：req 恒 proxy0，res/ws 按 id/wid 粘滞落最闲通道）

**Files:**
- Create: `src/pool.ts`
- Create: `pwa/src/poolRouter.ts`
- Modify: `src/browser.ts:16`（barrel 加 `export * from './pool.js';`）
- Modify: `src/bridge/http.ts:56-69,113,126,130`（HttpBridge 加 `onSettled` + `settle()`，四处 `ctrls.delete` 收口）
- Modify: `src/host.ts:97-171`（PeerSession 池注册 + req/ws 出站选路）
- Modify: `src/peer.ts:233-258`（`connectAsClient` 加 `opts.poolSize`）
- Modify: `pwa/src/signaling-web.ts:109-121,201-217,250-263`（4 通道 + PoolRouter 出站路由）
- Test: `src/tests/pool.test.ts`、`pwa/src/poolRouter.test.ts`、`src/tests/pool-host.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `asDataPlaneDc(dc): DcLike`（`src/bridge/http.ts`）；Task 3 的 `handleProxyMessage(data: string | ArrayBuffer, sinks)` 与 `waitSendSlot(dc)`（`pwa/src/signaling-web.ts`）。
- Produces（Task 5/9/11 依赖）：
  ```ts
  // src/pool.ts
  export interface PooledChannel { readonly bufferedAmount: number; readonly readyState?: string }
  export const PROXY_POOL_SIZE: 4
  export function pickLeastBufferedIdx(chs: readonly (PooledChannel | undefined)[]): number
  export function proxyLabelIdx(label: string): number
  // pwa/src/poolRouter.ts
  export class PoolRouter { constructor(chs: () => readonly PooledChannel[]); channelFor(frame: any): number }
  // src/bridge/http.ts HttpBridge 增员
  onSettled?: (id: number) => void
  // src/peer.ts connectAsClient 第二参
  opts?: { poolSize?: number } → channels: { proxy; pool: RTCDataChannel[]; ctrl }
  // src/host.ts PeerSession 私有成员（Task 5 直接扩展）
  private readonly pool: DcLike[]; private readonly reqDc: Map<number, DcLike>; private readonly widDc: Map<number, DcLike>
  ```

**语义定案（spec D2 解读 a，勿自由发挥）：**
- **req / req-abort 恒走 proxy0**：请求面单通道保序，多通道绝不重排请求。
- **res-head/res-chunk 出站选路**：host 在 req 到达时从池中选「open 且 bufferedAmount 最小」的通道，按 `reqDc: id→dc` 粘滞到该请求终结（`onSettled` 清理）——同一响应的 chunk 永不跨通道。
- **ws-open 选路 + wid 粘滞**：`widDc: wid→dc`，ws-msg/ws-close 跟随；ws-close 删映射。
- **旧端兼容**：新 PWA（4 通道）+ 旧 host（0.1.0，`label.startsWith('proxy')` 每条独立处理）→ req 仍只从 proxy0 到达，res 回 proxy0，无收益但功能正常；新 host + 旧 PWA → 池只有 1 条，pickLeastBufferedIdx 恒 0，行为等同旧版。

- [ ] **Step 1: 写失败测试——纯函数两侧**

`src/tests/pool.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLeastBufferedIdx, proxyLabelIdx, PROXY_POOL_SIZE } from '../pool.js';

test('pickLeastBufferedIdx：open 通道中 bufferedAmount 最小者', () => {
  assert.equal(pickLeastBufferedIdx([{ bufferedAmount: 5 }, { bufferedAmount: 0 }, { bufferedAmount: 3 }]), 1);
  assert.equal(pickLeastBufferedIdx([{ bufferedAmount: 0, readyState: 'closed' }, { bufferedAmount: 9 }]), 1);
  assert.equal(pickLeastBufferedIdx([]), -1);
  assert.equal(pickLeastBufferedIdx([{ bufferedAmount: 0, readyState: 'closed' }]), -1);
  // host 按 label 下标注册，稀疏数组留洞不得炸
  const sparse: ({ bufferedAmount: number } | undefined)[] = [];
  sparse[2] = { bufferedAmount: 1 };
  assert.equal(pickLeastBufferedIdx(sparse), 2);
  // readyState 缺省（DcLike 为可选字段）视为可选中
  assert.equal(pickLeastBufferedIdx([{ bufferedAmount: 7 }]), 0);
});

test('proxyLabelIdx：proxy→0、proxyN→N、非法→-1', () => {
  assert.equal(proxyLabelIdx('proxy'), 0);
  assert.equal(proxyLabelIdx('proxy0'), 0);
  assert.equal(proxyLabelIdx('proxy3'), 3);
  assert.equal(proxyLabelIdx('ctrl'), -1);
  assert.equal(proxyLabelIdx('proxyx'), -1);
  assert.equal(proxyLabelIdx('proxy99'), -1);
});

test('PROXY_POOL_SIZE 钉死 4（spec D2）', () => assert.equal(PROXY_POOL_SIZE, 4));
```

`pwa/src/poolRouter.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { PoolRouter } from './poolRouter.js';

const ch = (amt: number, state = 'open') => ({ bufferedAmount: amt, readyState: state });

test('req / req-abort 恒走 proxy0（请求面单通道保序）', () => {
  const r = new PoolRouter(() => [ch(0), ch(0)]);
  assert.equal(r.channelFor({ k: 'req', id: 1 }), 0);
  assert.equal(r.channelFor({ k: 'req-abort', id: 1 }), 0);
});

test('ws-open 选最闲并按 wid 粘滞；ws-close 删映射后重选', () => {
  const chs = [ch(5000), ch(0), ch(100)];
  const r = new PoolRouter(() => chs);
  assert.equal(r.channelFor({ k: 'ws-open', wid: 7 }), 1);
  chs[2].bufferedAmount = -1; // 之后即使 pool[2] 更闲也不漂移
  assert.equal(r.channelFor({ k: 'ws-msg', wid: 7 }), 1);
  assert.equal(r.channelFor({ k: 'ws-close', wid: 7 }), 1);
  assert.equal(r.channelFor({ k: 'ws-open', wid: 7 }), 2); // close 后映射已删，重新选
});

test('全通道非 open → ws-open 回落 0（调用方兜底 dcs[0]）', () => {
  const r = new PoolRouter(() => [ch(0, 'closed'), ch(0, 'closed')]);
  assert.equal(r.channelFor({ k: 'ws-open', wid: 1 }), 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/tests/pool.test.ts pwa/src/poolRouter.test.ts`
Expected: FAIL（`Cannot find module '../pool.js'` / `'./poolRouter.js'`）

- [ ] **Step 3: 实现纯函数两侧 + barrel**

`src/pool.ts`：

```ts
/**
 * proxy 通道池（2026-09-23 Wave 1，spec D2）：队头阻塞（HOL）治理的同构纯函数层。
 * Node host 与 PWA 共用（经 browser.ts barrel 出包）——通道对象只依赖最小结构
 * （bufferedAmount/readyState），werift RTCDataChannel 与浏览器原生均满足。
 */

/** 池化选路所需的最小通道结构。 */
export interface PooledChannel {
  readonly bufferedAmount: number;
  readonly readyState?: string;
}

/** 池大小钉死 4（spec D2）：1 条请求面 + 3 条余量，真机标定前不再拍脑袋加通道。 */
export const PROXY_POOL_SIZE = 4;

/** open 通道中 bufferedAmount 最小者的下标；无可选通道 → -1。稀疏数组留洞跳过。 */
export function pickLeastBufferedIdx(chs: readonly (PooledChannel | undefined)[]): number {
  let best = -1;
  let bestAmt = Infinity;
  for (let i = 0; i < chs.length; i++) {
    const c = chs[i];
    if (!c) continue;
    if (c.readyState !== undefined && c.readyState !== 'open') continue;
    if (c.bufferedAmount < bestAmt) { bestAmt = c.bufferedAmount; best = i; }
  }
  return best;
}

/** 通道 label → 池下标：'proxy'（0.1.0 单通道兼容）→ 0，'proxyN' → N；非法/越界 → -1。 */
export function proxyLabelIdx(label: string): number {
  if (label === 'proxy') return 0;
  const m = /^proxy(\d+)$/.exec(label);
  if (!m) return -1;
  const n = Number(m[1]);
  return n >= 0 && n < 16 ? n : -1;
}
```

`pwa/src/poolRouter.ts`：

```ts
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
```

`src/browser.ts` 在 `export * from './frames.js';` 一行之后加：

```ts
export * from './pool.js';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/tests/pool.test.ts pwa/src/poolRouter.test.ts` → 全 PASS。

- [ ] **Step 5: 写失败测试——host 侧池选路（含 Review Focus #4 两会话隔离）**

`src/tests/pool-host.test.ts`（stubDc 工厂仿 `src/tests/bridge.test.ts` 的 FakeDc；`until` 仿 `host.integration.test.ts`）：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { RTCDataChannel } from 'werift';
import { PeerSession } from '../host.js';

function stubDc(): { dc: RTCDataChannel; sent: (string | Uint8Array)[]; state: { bufferedAmount: number } } {
  const sent: (string | Uint8Array)[] = [];
  const state = { bufferedAmount: 0 };
  const dc = {
    readyState: 'open',
    onmessage: null as null | ((ev: { data: unknown }) => void),
    send(d: string | Uint8Array) { sent.push(typeof d === 'string' ? d : new Uint8Array(d)); },
    close() { /* noop */ },
  } as unknown as RTCDataChannel;
  Object.defineProperty(dc, 'bufferedAmount', { get: () => state.bufferedAmount });
  return { dc, sent, state };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function feedReq(dc: RTCDataChannel, id: number, port = 1): void {
  dc.onmessage!({ data: JSON.stringify({ k: 'req', id, port, method: 'GET', path: '/', headers: {} }) });
}

test('res 帧落最闲通道而非到达通道；onSettled 后 reqDc 清空', async () => {
  const s = new PeerSession(undefined, () => true);
  const a = stubDc(); const b = stubDc(); const c = stubDc();
  s.wireChannel(a.dc, 'proxy'); s.wireChannel(b.dc, 'proxy1'); s.wireChannel(c.dc, 'proxy2');
  a.state.bufferedAmount = 500_000; // 到达通道最忙 → res 应选 b/c
  feedReq(a.dc, 1);                 // port 1：localhost ECONNREFUSED → 502 两帧
  await until(() => b.sent.length + c.sent.length >= 2);
  assert.equal(a.sent.length, 0, 'res 不得回到达通道');
  await until(() => (s as any).reqDc.size === 0);
});

test('ws-open 选最闲并粘滞；ws-close 删映射', async () => {
  const s = new PeerSession(1, () => true);
  const a = stubDc(); const b = stubDc();
  s.wireChannel(a.dc, 'proxy'); s.wireChannel(b.dc, 'proxy1');
  a.state.bufferedAmount = 500_000;
  const open = { k: 'ws-open', wid: 7, path: '/', port: 1 };
  a.dc.onmessage!({ data: JSON.stringify(open) });
  await until(() => b.sent.length >= 1); // open-err（port 1 无 ws 服务）落 b
  assert.deepEqual([...(s as any).widDc.keys()], [7]);
  a.dc.onmessage!({ data: JSON.stringify({ k: 'ws-close', wid: 7, code: 1000 }) });
  assert.equal((s as any).widDc.size, 0);
});

test('两会话隔离：A 的选路与计数不污染 B（Review Focus #4）', async () => {
  const s1 = new PeerSession(undefined, () => true);
  const s2 = new PeerSession(undefined, () => true);
  const a1 = stubDc(); const a2 = stubDc();
  s1.wireChannel(a1.dc, 'proxy'); s2.wireChannel(a2.dc, 'proxy');
  feedReq(a1.dc, 1);
  await until(() => a1.sent.length >= 2);
  assert.equal(a2.sent.length, 0);
  assert.equal((s2 as any).reqDc.size, 0);
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npx tsx --test src/tests/pool-host.test.ts`
Expected: FAIL（`(s as any).reqDc` undefined、res 回到达通道）

- [ ] **Step 7: 实现——HttpBridge `onSettled` + `settle()` 收口**

`src/bridge/http.ts` HttpBridge 类（:56-69）改为：

```ts
export class HttpBridge {
  private ctrls = new Map<number, AbortController>();
  /**
   * 请求生命周期终结回调（正常 done / req-abort / 错误殊途同归）：
   * 宿主据此清 req→通道粘滞映射（Task 4）与帧账本 resDone（Task 5）。
   */
  onSettled?: (id: number) => void;

  /** ctrls 删除的唯一收口：任何路径终结都必须经此，漏一处就会泄漏粘滞映射。 */
  private settle(id: number): void {
    this.ctrls.delete(id);
    this.onSettled?.(id);
  }

  /** 帧入口：处理 req / req-abort；其余帧（ws 系列、ping）交还调用方路由。 */
  async handle(dc: DcLike, frame: unknown): Promise<void> {
    if (isReq(frame)) return this.doReq(dc, frame);
    if (isReqAbort(frame)) {
      const ctrl = this.ctrls.get(frame.id);
      if (ctrl) {
        ctrl.abort();
        this.settle(frame.id);
      }
    }
  }
```

其后三处 `this.ctrls.delete(id);`（:113 NO_BODY_STATUS 分支、:126 正常完成、:130 catch）全部替换为 `this.settle(id);`。`abortAll()`（:144-147）保持 `ctrls.clear()` 不逐个回调——会话 dispose 时 reqDc 随会话整体销毁，无需逐 id 通知（加注释说明）。

- [ ] **Step 8: 实现——PeerSession 池注册与选路**

`src/host.ts` import 区（:18 之后）加：

```ts
import { pickLeastBufferedIdx, proxyLabelIdx } from './pool.js';
```

`PeerSession` 字段（:105 `private readonly isPortAllowed?` 之后）加：

```ts
  /**
   * proxy 通道池（spec D2）：按 label 下标注册（'proxy'→0、'proxyN'→N）。
   * req/req-abort 入站恒在 proxy0（PWA 侧路由保证）；res/ws-* 出站按 id/wid 粘滞选最闲——
   * 同一响应/同一条 WS 的帧永不跨通道（保序），不同请求可并发占满池。
   */
  private readonly pool: DcLike[] = [];
  private readonly reqDc = new Map<number, DcLike>();
  private readonly widDc = new Map<number, DcLike>();
```

构造器（:108-112）末尾加：

```ts
    this.httpBridge.onSettled = (id) => this.reqDc.delete(id);
```

加私有方法（`portAllowed` 之后）：

```ts
  /** 池化选路：open 通道中 bufferedAmount 最小者；池空/全灭 → 回落到达通道。 */
  private pickDc(fallback: DcLike): DcLike {
    const idx = pickLeastBufferedIdx(this.pool);
    return (idx >= 0 ? this.pool[idx] : undefined) ?? fallback;
  }
```

`wireChannel` 的 proxy 分支（Task 2 后形态：`if (label.startsWith('proxy'))` + `const bdc = asDataPlaneDc(dc)` + 二进制入站分发）整体改为：

```ts
    const poolIdx = proxyLabelIdx(label);
    if (poolIdx >= 0) {
      const bdc = asDataPlaneDc(dc);
      this.pool[poolIdx] = bdc;
      dc.onmessage = (ev) => {
        const raw = ev.data;
        if (raw instanceof Buffer || raw instanceof Uint8Array) {
          // Task 2 二进制入站：PWA ws 上行（encodeWsMsgBin）——跟随 wid 粘滞通道
          const bf = decodeBinFrame(raw instanceof Uint8Array && !Buffer.isBuffer(raw) ? Buffer.from(raw) : raw as Buffer);
          if (bf && isWsMsg(bf)) {
            void this.wsBridge.handle(this.widDc.get(bf.wid) ?? bdc, bf);
          }
          return;
        }
        const m = decodeFrame(raw as string);
        if (!m) return;
        if (isReq(m)) {
          // §5.3 白名单强制：先校验再触达 localhost——PWA 不得借 host 打任意端口。
          if (!this.portAllowed(m.port)) {
            console.error(`[p2p-net] req 拒绝：端口 ${m.port} 不在白名单（id=${m.id} ${m.method} ${m.path}）`);
            void dcSend(bdc, { k: 'res-head', id: m.id, status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
            void dcSend(bdc, { k: 'res-chunk', id: m.id, dataB64: Buffer.from(`bridge error: port ${m.port} not in allowlist`, 'utf8').toString('base64'), done: true });
            return;
          }
          dbg('req', m.method, 'port=' + m.port, m.path);
          const out = this.pickDc(bdc);
          this.reqDc.set(m.id, out);
          void this.httpBridge.handle(out, m);
          return;
        }
        if (isReqAbort(m)) { dbg('req-abort', m.id); void this.httpBridge.handle(bdc, m); return; }
        if (isWsOpen(m)) {
          const port = m.port ?? this.wsPort;
          if (typeof port === 'number' && !this.portAllowed(port)) {
            console.error(`[p2p-net] ws-open 拒绝：端口 ${port} 不在白名单（wid=${m.wid} ${m.path}）`);
            void dcSend(bdc, { k: 'ws-close', wid: m.wid, code: 4403, reason: `port ${port} not in allowlist` });
            return;
          }
          const out = this.pickDc(bdc);
          this.widDc.set(m.wid, out);
          void this.wsBridge.handle(out, m);
          return;
        }
        if (isWsMsg(m) || isWsClose(m)) {
          const out = this.widDc.get(m.wid) ?? bdc;
          if (isWsClose(m)) this.widDc.delete(m.wid);
          void this.wsBridge.handle(out, m);
          return;
        }
        onServiceFrame?.(dc, m);
      };
      return;
    }
```

注意 `decodeBinFrame`/`isWsMsg` 复用 host.ts :21 既有 frames import（Task 2 已加 `decodeBinFrame`；`isWsMsg` 本就在 :21 import 列表里）。

- [ ] **Step 9: 实现——`peer.ts connectAsClient` 加 `opts.poolSize`**

:233-258 的签名与通道创建改为：

```ts
  /** offerer 侧（集成测的假客户端用；生产浏览器侧用原生 RTCPeerConnection，不走这里） */
  async connectAsClient(handlers: PeerHandlers, opts: { poolSize?: number } = {}): Promise<{
    sid: string;
    sdp: SdpLike;
    channels: { proxy: RTCDataChannel; pool: RTCDataChannel[]; ctrl: RTCDataChannel };
  }> {
    const sid = Math.random().toString(36).slice(2, 10);
    this.dispose();
    this.curSid = sid;
    this.remoteSet = false;
    this.iceQueue = makeIceQueue();
    this.lastStats = { pairType: null };
    this.statusCb = handlers.onStatus;
    const pc = this.pc = this.newPc();
    // proxy 通道池（spec D2）：label 与 PWA 对齐——首条恒 'proxy'（0.1.0 兼容），其后 'proxy1..N-1'
    const n = Math.max(1, Math.min(16, opts.poolSize ?? 1));
    const pool: RTCDataChannel[] = [];
    for (let i = 0; i < n; i++) pool.push(pc.createDataChannel(i === 0 ? 'proxy' : `proxy${i}`));
    const ctrl = this.createCtrl();
    pc.ondatachannel = (ev) => handlers.onChannel(ev.channel, ev.channel.label);
    pc.onicecandidate = (ev) => {
      const c = ev.candidate as ( undefined | { toJSON?: () => IceCandidateLike });
      if (!c) return;
      handlers.onIce(typeof c.toJSON === 'function' ? c.toJSON() : (c as unknown as IceCandidateLike));
    };
    pc.onconnectionstatechange = () => { void this.refreshStats().then(() => this.emitStatus()); this.scheduleStats(); };
    await pc.setLocalDescription(await pc.createOffer());
    this.remoteSet = true; // offerer：此后到达的远端候选由 werift 内部缓冲
    return { sid, sdp: pc.localDescription!, channels: { proxy: pool[0]!, pool, ctrl } };
  }
```

- [ ] **Step 10: 跑 host 侧测试确认通过 + 全量回归**

Run: `npx tsx --test src/tests/pool-host.test.ts` → PASS；`npm test` 全绿（既有 `host.integration.test.ts` 的假客户端解构 `channels.proxy/ctrl` 不受影响）。

- [ ] **Step 11: PWA 侧接线——4 通道 + PoolRouter**

`pwa/src/signaling-web.ts`：

① :13 import 行加 `PROXY_POOL_SIZE`；新增 `import { PoolRouter } from './poolRouter.js';`

② 字段（:63 `private dc` 附近）：

```ts
  private dc: RTCDataChannel | null = null;   // = dcs[0] 别名：isOpen / 心跳回退 / teardown 兼容锚点
  private dcs: RTCDataChannel[] = [];
  private router: PoolRouter | null = null;
```

③ connect() 的单通道创建段（Task 3 后形态的 `const dc = this.dc = pc.createDataChannel('proxy'); … dc.onmessage = …`）替换为：

```ts
    // proxy 通道池（spec D2）：req 恒走 proxy0；res/ws 由 host 按 id/wid 粘滞选最闲。
    // 每条通道都是活性证明来源——任何通道回帧都刷 lastPongAt（handleProxyMessage 语义不变）。
    const dcs: RTCDataChannel[] = [];
    for (let i = 0; i < PROXY_POOL_SIZE; i++) {
      const ch = pc.createDataChannel(i === 0 ? 'proxy' : `proxy${i}`);
      ch.binaryType = 'arraybuffer'; // Task 3：host asDataPlaneDc 的二进制入站
      ch.onmessage = (ev) => {
        handleProxyMessage(ev.data, {
          onProof: () => { this.lastPongAt = Date.now(); },
          onFrame: (m) => this.opts.onFrame(m),
        });
      };
      dcs.push(ch);
    }
    const dc = this.dc = dcs[0]!;
    this.dcs = dcs;
    this.router = new PoolRouter(() => this.dcs);
    dc.onopen = () => {
      this.lastPongAt = Date.now();
      this.opts.onStatus({ state: 'connected', pairType: null });
      void this.refreshStats();
    };
    dc.onclose = () => this.opts.onStatus({ state: 'off', pairType: null });
```

④ send()（Task 3 后形态）首行 `const dc = this.dc;` 替换为路由选择，其余不变：

```ts
  /** proxy 池出站（背压 8MiB，POC dcSend 同语义）：req→proxy0；ws-open/msg/close 按 PoolRouter 粘滞。 */
  async send(frame: unknown): Promise<void> {
    const idx = this.router?.channelFor(frame) ?? 0;
    const dc = this.dcs[idx] ?? this.dc;
    if (!dc || dc.readyState !== 'open') return;
    // …（Task 3 的 ws-msg 二进制分支与 waitSendSlot 调用原样保留，仅 dc 来源改变）
```

⑤ teardown() 的 `if (this.dc) { … }` 段替换为：

```ts
    for (const ch of this.dcs) { try { ch.close(); } catch { /* 忽略 */ } }
    this.dcs = [];
    this.dc = null;
    this.router = null;
```

- [ ] **Step 12: 全量回归 + PWA 构建**

Run: `npm test` 全绿；`npm run build:pwa` 成功。

- [ ] **Step 13: Commit**

```bash
git add src/pool.ts src/browser.ts src/bridge/http.ts src/host.ts src/peer.ts src/tests/pool.test.ts src/tests/pool-host.test.ts pwa/src/poolRouter.ts pwa/src/poolRouter.test.ts pwa/src/signaling-web.ts
git commit -m "feat(pool): proxy 4 通道池——req 走 proxy0、res/ws 按 id/wid 粘滞落最小 bufferedAmount 通道（spec D2）"
```

---

### Task 5: 帧账本 + 字节计量（spec D5/D8：成本一等指标）

**Files:**
- Create: `pwa/src/frameLedger.ts`
- Modify: `src/host.ts:37-41,97-112,327-347`（SessionLedger + PeerSession 计量 + HostStatus.ledger + dataPlaneSnapshot）
- Modify: `src/cli/start.ts:236,243-249`（session_end 带 bytesUp/bytesDown；getStatus 加 dataPlane）
- Modify: `pwa/src/shell.ts:93-120,252-267,294-301,304-340,1039-1044`（内联账本换 FrameLedger 类 + 字节计量）
- Test: `src/tests/ledger-host.test.ts`、`pwa/src/frameLedger.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `reqDc`/`onSettled`（resDone 计数点）；Task 2 的 `asDataPlaneDc`（计量包装叠加其上）。
- Produces（Task 12/13 依赖）：
  ```ts
  // src/host.ts
  export interface SessionLedger { req: number; resDone: number; bytesSent: number; bytesRecv: number }
  export function makeLedger(): SessionLedger
  // HostStatus 增员：ledger?: SessionLedger
  // HostAgent 增员：dataPlaneSnapshot(): { totals: SessionLedger; sessions: number }
  // pwa/src/frameLedger.ts
  export class FrameLedger { sent; res; hung; bytesSent; bytesRecv; readonly inFlight: Map<number,{port?:number;path:string;at:number}>; lastHung: HungEntry[]; trackReq(gid, port, path, outFrame?); settleReq(gid, inFrame?); harvestHung(now?, hangMs?, log?): HungEntry[] }
  export function wireBytes(m: any): number
  // /status 响应增员：dataPlane: { totals: SessionLedger; sessions: number } | null
  ```

**口径定案：** 字节视角 = host 进程。`bytesSent`（host→客户端，下行）→ `session_end.bytesUp`；`bytesRecv`（客户端→host，上行）→ `bytesDown`（与 events.ts :27-28 既有字段对齐，字段无需改）。PWA 侧 tunnel 模式走网关 HTTP 不进 dc 账本（注释声明）。

- [ ] **Step 1: 写失败测试——PWA FrameLedger 纯类**

`pwa/src/frameLedger.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameLedger, wireBytes } from './frameLedger.js';

test('trackReq/settleReq 计数与字节；未知 gid 销账不计', () => {
  const l = new FrameLedger();
  const req = { k: 'req', id: 1, port: 3000, method: 'GET', path: '/', headers: {} };
  l.trackReq(1, 3000, '/', req);
  assert.equal(l.sent, 1);
  assert.equal(l.bytesSent, JSON.stringify(req).length);
  l.settleReq(1, { k: 'res-chunk', id: 1, data: new Uint8Array(100) });
  assert.equal(l.res, 1);
  assert.equal(l.bytesRecv, 106); // 二进制帧 = 6B 头 + payload
  l.settleReq(999, { k: 'res-chunk', id: 999 });
  assert.equal(l.res, 1);
});

test('harvestHung 超阈摘除 + lastHung + log 回调', () => {
  const l = new FrameLedger();
  const logs: string[] = [];
  l.trackReq(1, 3000, '/slow');
  const out = l.harvestHung(Date.now() + 10_000, 9_000, (m) => logs.push(m));
  assert.equal(out.length, 1);
  assert.equal(out[0].path, '/slow');
  assert.equal(l.hung, 1);
  assert.equal(l.lastHung.length, 1);
  assert.equal(l.inFlight.size, 0);
  assert.equal(logs.length, 1);
});

test('wireBytes：Uint8Array → 6+len；JSON → 序列化长度；环形 → 0', () => {
  assert.equal(wireBytes({ data: new Uint8Array(10) }), 16);
  assert.equal(wireBytes({ k: 'pong', t: 1 }), JSON.stringify({ k: 'pong', t: 1 }).length);
  const cyc: any = {}; cyc.self = cyc;
  assert.equal(wireBytes(cyc), 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test pwa/src/frameLedger.test.ts`
Expected: FAIL（`Cannot find module './frameLedger.js'`）

- [ ] **Step 3: 实现 `pwa/src/frameLedger.ts`**

```ts
/**
 * PWA 帧账本（2026-09-23 Wave 1，spec D5/D8）：从 shell.ts :93-120 内联版抽成可测类，
 * 加双向字节计量——成本模型的 PWA 侧观测口径（与 host SessionLedger 对账）。
 */

export interface HungEntry { port?: number; path: string; ms: number }

export class FrameLedger {
  sent = 0;
  res = 0;
  hung = 0;
  bytesSent = 0;
  bytesRecv = 0;
  readonly inFlight = new Map<number, { port?: number; path: string; at: number }>();
  lastHung: HungEntry[] = [];

  /** 发出记一笔；outFrame 给出时累计线字节（JSON 帧按序列化长度）。 */
  trackReq(gid: number, port: number | undefined, path: string, outFrame?: unknown): void {
    this.sent += 1;
    this.inFlight.set(gid, { port, path, at: Date.now() });
    if (outFrame !== undefined) this.bytesSent += wireBytes(outFrame);
  }

  /** 回帧销账；inFrame 给出时累计线字节（二进制帧按 6B 头 + payload）。 */
  settleReq(gid: number, inFrame?: unknown): void {
    if (this.inFlight.delete(gid)) {
      this.res += 1;
      if (inFrame !== undefined) this.bytesRecv += wireBytes(inFrame);
    }
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
}

/** 帧线字节估算：二进制帧（v2 协议 6B 头）按 6+payload；其余按 JSON 序列化长度；不可序列化 → 0。 */
export function wireBytes(m: any): number {
  const d = m?.data;
  if (d instanceof Uint8Array) return 6 + d.byteLength;
  try { return JSON.stringify(m).length; } catch { return 0; }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test pwa/src/frameLedger.test.ts` → PASS。

- [ ] **Step 5: 写失败测试——host 侧 SessionLedger 与 dataPlaneSnapshot**

`src/tests/ledger-host.test.ts`（stubDc/until/feedReq 复用 `pool-host.test.ts` 同款写法，就地再写一遍——测试各自独立）：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { RTCDataChannel } from 'werift';
import { HostAgent, PeerSession, makeLedger } from '../host.js';

function stubDc(): { dc: RTCDataChannel; sent: (string | Uint8Array)[] } {
  const sent: (string | Uint8Array)[] = [];
  const dc = {
    readyState: 'open', bufferedAmount: 0,
    onmessage: null as null | ((ev: { data: unknown }) => void),
    send(d: string | Uint8Array) { sent.push(typeof d === 'string' ? d : new Uint8Array(d)); },
    close() { /* noop */ },
  } as unknown as RTCDataChannel;
  return { dc, sent };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('PeerSession 账本：req/resDone 计数 + 双向字节；会话间隔离（Review Focus #4）', async () => {
  const s1 = new PeerSession(undefined, () => true);
  const s2 = new PeerSession(undefined, () => true);
  const a = stubDc(); const b = stubDc();
  s1.wireChannel(a.dc, 'proxy'); s2.wireChannel(b.dc, 'proxy');
  a.dc.onmessage!({ data: JSON.stringify({ k: 'req', id: 1, port: 1, method: 'GET', path: '/', headers: {} }) });
  await until(() => a.sent.length >= 2); // 502 两帧
  await until(() => s1.ledger.resDone === 1);
  assert.equal(s1.ledger.req, 1);
  assert.ok(s1.ledger.bytesSent > 0, '出站字节已计');
  assert.ok(s1.ledger.bytesRecv > 0, '入站字节已计');
  assert.deepEqual({ ...s2.ledger }, makeLedger(), 's2 账本零污染');
});

test('HostAgent.dataPlaneSnapshot 求和全部活跃会话', () => {
  const agent = new HostAgent({
    supabaseUrl: '', publishableKey: '', accessToken: () => null,
    deviceId: 'desk', uid: 'u', turnFetcher: async () => ({ iceServers: [] }),
  });
  const s1 = new PeerSession(); const s2 = new PeerSession();
  s1.ledger.req = 3; s1.ledger.bytesSent = 100; s1.ledger.bytesRecv = 40;
  s2.ledger.req = 1; s2.ledger.bytesSent = 7; s2.ledger.bytesRecv = 5; s2.ledger.resDone = 1;
  (agent as any).sessions.set('k1', s1);
  (agent as any).sessions.set('k2', s2);
  const snap = agent.dataPlaneSnapshot();
  assert.equal(snap.sessions, 2);
  assert.deepEqual(snap.totals, { req: 4, resDone: 1, bytesSent: 107, bytesRecv: 45 });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npx tsx --test src/tests/ledger-host.test.ts`
Expected: FAIL（`ledger` / `makeLedger` / `dataPlaneSnapshot` 不存在）

- [ ] **Step 7: 实现——host.ts SessionLedger + 计量 + HostStatus.ledger + dataPlaneSnapshot**

① import 区（:18）改为 `import { asDataPlaneDc, dcSend, HttpBridge, type DcLike } from './bridge/http.js';`（`asDataPlaneDc` 为 Task 2 既有导出）。

② `HostStatus`（:37-41）加字段：

```ts
export type HostStatus = LinkStatus & {
  deviceId: string;
  /** 会话归属的客户端 deviceId（SigMessage.from）——事件流 sid 的事实来源（Task 19 ruling #1）。 */
  clientKey: string;
  /** 会话帧账本快照（Wave 1，spec D5/D8）：终态事件带最终字节量。 */
  ledger?: SessionLedger;
};
```

③ `PeerSession` 定义（:97）之前加：

```ts
/** 会话帧账本（spec D5/D8，成本一等指标）：req 计数 / 完成计数 / 双向线字节。 */
export interface SessionLedger {
  req: number;
  resDone: number;
  bytesSent: number;
  bytesRecv: number;
}

export function makeLedger(): SessionLedger {
  return { req: 0, resDone: 0, bytesSent: 0, bytesRecv: 0 };
}
```

④ PeerSession 字段区加 `readonly ledger = makeLedger();`；构造器的 `onSettled` 赋值（Task 4）扩展为：

```ts
    this.httpBridge.onSettled = (id) => {
      this.reqDc.delete(id);
      this.ledger.resDone += 1;
    };
```

⑤ 加私有计量包装（`pickDc` 之后）：

```ts
  /** 出站计量包装：asDataPlaneDc 之上叠 bytesSent 累计（每会话独立账本；DcLike.binaryOk 透传）。 */
  private meterDc(dc: RTCDataChannel): DcLike {
    const base = asDataPlaneDc(dc);
    const ledger = this.ledger;
    return {
      ...base,
      send: (data) => {
        ledger.bytesSent += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
        base.send(data);
      },
    };
  }
```

⑥ wireChannel 池注册行（Task 4 的 `const bdc = asDataPlaneDc(dc);`）改为 `const bdc = this.meterDc(dc);`；`dc.onmessage` 首行加入站计量：

```ts
      dc.onmessage = (ev) => {
        const raw = ev.data;
        this.ledger.bytesRecv += typeof raw === 'string' ? Buffer.byteLength(raw) : (raw as Buffer).byteLength;
```

⑦ isReq 分支 `dbg('req', …)` 之后加 `this.ledger.req += 1;`。

⑧ `onSessionStatus`（:336）与 `expireSession`（:345）的 `onStatus` 调用都带账本快照：

```ts
    this.opts.onStatus?.({ ...s, deviceId: this.opts.deviceId, clientKey, ledger: { ...session.ledger } });
```

```ts
    this.opts.onStatus?.({ ...session.lastStatus, state: 'failed', deviceId: this.opts.deviceId, clientKey, ledger: { ...session.ledger } });
```

⑨ HostAgent 加（`sessionCount` getter 附近，:349-352）：

```ts
  /** 数据面计量快照（/status 与成本观测，spec D5/D8）：全部活跃会话账本求和。 */
  dataPlaneSnapshot(): { totals: SessionLedger; sessions: number } {
    const totals = makeLedger();
    for (const s of this.sessions.values()) {
      totals.req += s.ledger.req;
      totals.resDone += s.ledger.resDone;
      totals.bytesSent += s.ledger.bytesSent;
      totals.bytesRecv += s.ledger.bytesRecv;
    }
    return { totals, sessions: this.sessions.size };
  }
```

- [ ] **Step 8: 实现——start.ts 事件与 /status 接线**

`src/cli/start.ts` :

① :236 session_end 改为：

```ts
          // bytesUp/bytesDown 视角 = host 进程：bytesSent=host→客户端（下行）记 bytesUp，
          // bytesRecv=客户端→host（上行）记 bytesDown（events.ts :27-28 既有字段，语义注释对齐）。
          record({ name: 'session_end', sid, reason: s.state, ...(s.ledger ? { bytesUp: s.ledger.bytesSent, bytesDown: s.ledger.bytesRecv } : {}) });
```

② getStatus（:243-249）加 dataPlane（`host` 变量声明在闭包之前、:258 赋值，此处安全）：

```ts
      getStatus: () => ({
        uptime: process.uptime(),
        deviceId: deviceId!,
        sessions: aggregateSessions(eventRing),
        services: scanner.list().length,
        mode: 'foreground',
        dataPlane: host?.dataPlaneSnapshot?.() ?? null, // 旧进程/启动早期为 null，status.ts 容错省略
      }),
```

- [ ] **Step 9: 跑 host 侧测试确认通过**

Run: `npx tsx --test src/tests/ledger-host.test.ts src/tests/pool-host.test.ts` → 全 PASS。

- [ ] **Step 10: PWA shell.ts 换用 FrameLedger + 字节计量**

① :37 import 后加 `import { FrameLedger } from './frameLedger.js';`

② :93-120 内联账本（`const frameLedger = {…}` + `trackReq`/`settleReq`/`harvestHung` 三函数）整体替换为：

```ts
const frameLedger = new FrameLedger();
/** 帧账本（语义同 2026-09-12 内联版；字节计量为 Wave 1 增量，spec D5/D8）。 */
function trackReq(gid: number, port: number | undefined, path: string, outFrame?: unknown): void {
  frameLedger.trackReq(gid, port, path, outFrame);
}
function settleReq(gid: number, inFrame?: unknown): void {
  frameLedger.settleReq(gid, inFrame);
}
/** 把"挂了多久还没回帧"的请求摘出来（watchdog 与诊断共用） */
function harvestHung(): HungEntry[] {
  return frameLedger.harvestHung(Date.now(), SW_HANG_MS, log);
}
```

（`HungEntry` 类型经 `import { FrameLedger, type HungEntry } from './frameLedger.js';` 引入。）

③ onSwReq 的 dc 分支（:266）改为先构帧再记账：

```ts
  const frame = { k: 'req' as const, id: gid, port: m.port, method: m.method, path: m.path, headers: m.headers, bodyB64: m.bodyB64 ?? null };
  trackReq(gid, m.port, m.path, frame);   // 帧账本：发出记一笔（含线字节），回帧销账
  await cascade.send(frame);
```

（原 :256 的 `trackReq(gid, m.port, m.path);` 删除——tunnel 分支提前 return 不记账：隧道段走网关 HTTP，不进 dc 账本。）

④ fetchVia（:299-300）同款：

```ts
  const frame = { k: 'req' as const, id: gid, port, method: 'GET', path, headers: { accept: 'application/json' }, bodyB64: null };
  trackReq(gid, port, path, frame);
  await cascade.send(frame);
```

⑤ onDcFrame :307 `settleReq(m.id);` 改为 `settleReq(m.id, m);`

⑥ __p2pNetDebug（:1039-1044）frames 段加字节：

```ts
  frames: {
    sent: frameLedger.sent,
    res: frameLedger.res,
    hung: frameLedger.hung,
    bytesSent: frameLedger.bytesSent,
    bytesRecv: frameLedger.bytesRecv,
    lastHung: frameLedger.lastHung,
  },
```

- [ ] **Step 11: 全量回归 + PWA 构建**

Run: `npm test` 全绿；`npm run build:pwa` 成功。

- [ ] **Step 12: Commit**

```bash
git add src/host.ts src/cli/start.ts src/tests/ledger-host.test.ts pwa/src/frameLedger.ts pwa/src/frameLedger.test.ts pwa/src/shell.ts
git commit -m "feat(ledger): 帧账本+字节计量——/status dataPlane 与 events.jsonl session_end 带 bytes（成本一等指标，spec D5/D8）"
```

#### Task 5 增补（2026-09-23 二轮迭代）：路径类型 + wire 字节进账本（spec D9 测量支柱）

> 动机：容量方程（D9）的中继率/字节因子两大参数全仓无实测。账本只记应用字节，不知每会话走的是 direct/relay/tunnel 哪条路、线上实际跑了多少 wire 字节。本增补给账本加 `pathType` 与 `wireBytesSent/wireBytesRecv`，方法照抄 v3 tc-accounting（【外部实测+源码取证】，移植参考 `DevAnyWhere-v3/cores/devanywhere-net/packages/core/src/status.ts:1-25` + `facts.ts:430-489`）。
>
> 判据（werift 侧，勿想当然）：candidate-pair 行**无 selected 字段**；选定对 = `state==='succeeded'`（nominated 者亦在其中，多对时优先取 nominated）；`localCandidateId → local-candidate.candidateType`：`relay`→中继，`host/srflx/prflx`→直连。PWA 浏览器侧用标准 `selected===true`。

**Files:**
- Create: `src/pathType.ts`
- Modify: `src/host.ts`（会话建池后启动 5s 采样器；session_end 落 pathType/wire 字节）
- Modify: `src/cli/start.ts`（`/status` dataPlane 透出 pathType/wireBytes）
- Modify: `pwa/src/frameLedger.ts`（PWA 侧 getStats 采样 + tunnel 帧归类）
- Test: `src/tests/pathType.test.ts`

**Interfaces:**
- Consumes: Task 5 既有 `frameLedger`（host/pwa 两侧）、`session.events`。
- Produces: `classifyCandidateType(ct: string|undefined): PathType`；`selectedPairStats(stats: unknown[]): { pathType: PathType; wireSent: number; wireRecv: number }`；ledger 新字段 `pathType: 'direct'|'relay'|'tunnel'|'unknown'`、`wireBytesSent: number`、`wireBytesRecv: number`（Task 12/13 直接消费：字节因子 = wire 增量 ÷ 应用字节增量；Task 13 真机门禁记录路径占比）。

- [ ] **Step 13: 失败测试——三型路径分类 + tunnel 归类**

`src/tests/pathType.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCandidateType, classifyVia, selectedPairStats } from '../pathType.js';

const pair = (over: object) => ({ type: 'candidate-pair', id: 'p1', state: 'succeeded', localCandidateId: 'l1', bytesSent: 1000, bytesReceived: 2000, ...over });
const local = (candidateType: string) => ({ type: 'local-candidate', id: 'l1', candidateType });

test('classifyCandidateType: relay→relay, host/srflx/prflx→direct, 其他→unknown', () => {
  assert.equal(classifyCandidateType('relay'), 'relay');
  assert.equal(classifyCandidateType('host'), 'direct');
  assert.equal(classifyCandidateType('srflx'), 'direct');
  assert.equal(classifyCandidateType('prflx'), 'direct');
  assert.equal(classifyCandidateType(undefined), 'unknown');
});

test('selectedPairStats: 无 selected 字段，取 state==succeeded 的对（werift 判据）', () => {
  const stats = [pair({}), local('relay')];
  const r = selectedPairStats(stats);
  assert.equal(r.pathType, 'relay');
  assert.equal(r.wireSent, 1000);
  assert.equal(r.wireRecv, 2000);
});

test('selectedPairStats: 多对 succeeded 时优先 nominated', () => {
  const stats = [
    pair({ id: 'p1', localCandidateId: 'l1', bytesSent: 1, bytesReceived: 1 }),
    pair({ id: 'p2', localCandidateId: 'l2', nominated: true, bytesSent: 9, bytesReceived: 9 }),
    local('relay'),
    { type: 'local-candidate', id: 'l2', candidateType: 'srflx' },
  ];
  const r = selectedPairStats(stats);
  assert.equal(r.pathType, 'direct');
  assert.equal(r.wireSent, 9);
});

test('selectedPairStats: 无 succeeded 对 → unknown，不崩', () => {
  const r = selectedPairStats([{ type: 'candidate-pair', id: 'p1', state: 'in-progress' }]);
  assert.equal(r.pathType, 'unknown');
  assert.equal(r.wireSent, 0);
});

test('tunnel 帧（via:tunnel）归类为 tunnel，不进 getStats 判定', () => {
  assert.equal(classifyVia('tunnel'), 'tunnel');
  assert.equal(classifyVia('dc'), 'unknown');
  assert.equal(classifyVia(undefined), 'unknown');
});
```

- [ ] **Step 14: 跑测试确认失败**

Run: `npx tsx --test src/tests/pathType.test.ts`
Expected: FAIL（`../pathType.js` 不存在）

- [ ] **Step 15: 实现 pathType.ts + host 采样器（5s 节拍，快照路径禁 I/O）**

`src/pathType.ts`：

```ts
export type PathType = 'direct' | 'relay' | 'tunnel' | 'unknown';

export function classifyCandidateType(ct: string | undefined): PathType {
  if (ct === 'relay') return 'relay';
  if (ct === 'host' || ct === 'srflx' || ct === 'prflx') return 'direct';
  return 'unknown';
}

// 帧级归类：隧道网关转发的帧带 via:'tunnel'，与 getStats 判定正交（tunnel 段不过 DataChannel）
export function classifyVia(via: string | undefined): PathType {
  return via === 'tunnel' ? 'tunnel' : 'unknown';
}

// werift candidate-pair 无 selected 字段：选定对 = state==='succeeded'（nominated 优先）
export function selectedPairStats(stats: any[]): { pathType: PathType; wireSent: number; wireRecv: number } {
  const pairs = stats.filter((s) => s?.type === 'candidate-pair' && s.state === 'succeeded');
  const nominated = pairs.find((p) => p.nominated);
  const pair = nominated ?? pairs[0];
  if (!pair) return { pathType: 'unknown', wireSent: 0, wireRecv: 0 };
  const loc = stats.find((s) => s?.type === 'local-candidate' && s.id === pair.localCandidateId);
  return {
    pathType: classifyCandidateType(loc?.candidateType),
    wireSent: pair.bytesSent ?? 0,
    wireRecv: pair.bytesReceived ?? 0,
  };
}
```

host 侧采样（`src/host.ts` 会话内）：

```ts
// 会话建立后启动；getStats 累计值→增量累进 ledger；pc 关闭时 clearInterval
const wireTimer = setInterval(async () => {
  try {
    const stats = await pc.getStats();
    const cur = selectedPairStats([...stats.values()]);
    if (prevWire) {
      frameLedger.wireBytesSent += Math.max(0, cur.wireSent - prevWire.wireSent);
      frameLedger.wireBytesRecv += Math.max(0, cur.wireRecv - prevWire.wireRecv);
    }
    if (cur.pathType !== 'unknown') frameLedger.pathType = cur.pathType;
    prevWire = cur;
  } catch { /* 采样失败零副作用，下拍再来 */ }
}, 5000);
```

PWA 侧（`pwa/src/frameLedger.ts`）：同样 5s 节拍，浏览器判据 `candidate-pair && selected===true`；tunnel 转发的响应帧（`via:'tunnel'`）把对应字节计入 tunnel 桶且 pathType 记 'tunnel'。

纪律：采样器只写内存账本；`/status` 快照与 events.jsonl 落盘走既有路径，**快照路径不新增任何 I/O**。

- [ ] **Step 16: 跑测试确认通过 + 全量回归**

Run: `npx tsx --test src/tests/pathType.test.ts` 通过；`npm test` 全绿（先停常驻 host，跑完恢复）。

- [ ] **Step 17: Commit（走开发纪律：独立分支 + squash 合并，见 Global Constraints）**

```bash
git add src/pathType.ts src/host.ts src/cli/start.ts src/tests/pathType.test.ts pwa/src/frameLedger.ts
git commit -m "feat(ledger): pathType+wire 字节进账本——getStats 选定对增量法（werift 无 selected 字段，state==succeeded 判据），spec D9 测量支柱"
```

---

### Task 6: stallSuspect 三条件黄灯（spec D5：徽章双驱动，stall 期如实示警）

**Files:**
- Create: `pwa/src/stall.ts`
- Modify: `pwa/src/ui.ts:68-103`（`setStall` 导出 + setStatus connected 分支尊重 stallOn）
- Modify: `pwa/src/shell.ts:38-43,348-358,1029-1045`（import + watchdog interval 驱动 + debug 出口）
- Test: `pwa/src/stall.test.ts`

**Interfaces:**
- Consumes: `cascade.isOpen`（心跳新鲜度在内的诚实版）、`inflightSw.size`、`liveness.silentFor()`（均为 shell.ts 既有）。
- Produces：
  ```ts
  // pwa/src/stall.ts
  export interface StallInput { ctrlAlive: boolean; inFlight: number; silentMs: number; thresholdMs?: number }
  export function stallSuspect(input: StallInput): boolean
  // pwa/src/ui.ts 增员
  export function setStall(on: boolean): void
  ```

**语义定案（spec D5）：** 绿灯（模式徽章，诚实落点）与黄灯（stall 示警）**双驱动并存**：`ctrlAlive && inFlight>0 && silentMs>5s` → 圆点琥珀。tunnel 模式 `ctrlAlive` 恒 false（隧道段无 dc 静默概念，SW 单请求超时兜底——Review Focus #3）；心跳超 LIVENESS 后 `isOpen=false` → `ctrlAlive=false`，那是「死」走拆连，不是 stall（Review Focus #5 两灯不混）。

- [ ] **Step 1: 写失败测试**

`pwa/src/stall.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { stallSuspect } from './stall.js';

test('三条件全真才亮：ctrlAlive ∧ inFlight>0 ∧ silentMs>阈值', () => {
  assert.equal(stallSuspect({ ctrlAlive: true, inFlight: 3, silentMs: 6_000 }), true);
  assert.equal(stallSuspect({ ctrlAlive: false, inFlight: 3, silentMs: 6_000 }), false); // tunnel/链路死：不归 stall
  assert.equal(stallSuspect({ ctrlAlive: true, inFlight: 0, silentMs: 60_000 }), false); // 空闲链路永不亮
  assert.equal(stallSuspect({ ctrlAlive: true, inFlight: 1, silentMs: 4_999 }), false); // 阈值内（慢但未疑）
  assert.equal(stallSuspect({ ctrlAlive: true, inFlight: 1, silentMs: 5_001 }), true);
});

test('thresholdMs 可覆盖（真机标定）；默认 5s', () => {
  assert.equal(stallSuspect({ ctrlAlive: true, inFlight: 1, silentMs: 2_000, thresholdMs: 1_000 }), true);
  assert.equal(stallSuspect({ ctrlAlive: true, inFlight: 1, silentMs: 6_000, thresholdMs: 10_000 }), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test pwa/src/stall.test.ts`
Expected: FAIL（`Cannot find module './stall.js'`）

- [ ] **Step 3: 实现 stall.ts + ui.ts setStall + shell.ts 接线**

`pwa/src/stall.ts`：

```ts
/**
 * stallSuspect（2026-09-23 Wave 1，spec D5）：徽章双驱动的「疑似卡顿」判定。
 *
 * 要灭掉的谎言（60min 浸泡实录）：链路自报 connected、ctrl 心跳 5s 一拍正常、
 * 徽章绿油油——但数据面已 587s 零回帧，用户以为"好好的"，其实在干等。
 * 三条件全真才亮黄灯：① 控制面活着（非 tunnel 且心跳新鲜）；② 有在途请求；
 * ③ 数据面全局静默超阈（默认 5s：短于 WEDGE 60s 判死线，长于正常首帧排队）。
 * 缺一不亮：心跳死了是「断」不是「卡」（走拆连）；空闲链路静默是常态。
 */
export interface StallInput {
  /** 控制面活着（cascade.isOpen：dc open 且心跳新鲜；tunnel 模式调用方恒传 false）。 */
  ctrlAlive: boolean;
  /** 在途请求数（inflightSw.size）。 */
  inFlight: number;
  /** 数据面全局静默时长 ms（liveness.silentFor()）。 */
  silentMs: number;
  /** 静默阈值（默认 5s；URL 参数真机标定可改）。 */
  thresholdMs?: number;
}

export function stallSuspect({ ctrlAlive, inFlight, silentMs, thresholdMs = 5_000 }: StallInput): boolean {
  return ctrlAlive && inFlight > 0 && silentMs > thresholdMs;
}
```

`pwa/src/ui.ts`（`let lastMode` :68 之后）加：

```ts
/** stall 黄灯（spec D5）：徽章照常诚实落点，圆点转琥珀——"疑似卡顿"与"模式"两个维度并存。 */
let stallOn = false;

export function setStall(on: boolean): void {
  if (on === stallOn) return; // 3s 一拍重入：状态没变就不重绘
  stallOn = on;
  if (on) {
    const dot = $('connDot');
    dot.style.background = '#B26A00'; // 琥珀：绿（健康）与红（断）之间的「疑似卡顿」
    dot.className = 'dot breath';
  }
  // 熄灭不在这里画色：恢复由下一次 setStatus（pong 到达即触发 connected）全权重建
}

/** setStatus 内部读取：connected 分支画完模式色后，stallOn 覆盖为琥珀。 */
export function isStallOn(): boolean {
  return stallOn;
}
```

`setStatus` 的 connected 分支末尾（:88 `$('btnDisconnect').classList.remove('hidden');` 之前）加：

```ts
    if (stallOn) dot.style.background = '#B26A00'; // stall 示警优先级高于模式色（双驱动交汇点）
```

`pwa/src/shell.ts`：

① ui import（:38-43）加 `setStall`；新增 `import { stallSuspect } from './stall.js';`

② 抽一个判定函数（`dataPlaneWedged` :342-346 之后）：

```ts
/** stall 示警（spec D5）：tunnel 段 ctrlAlive 恒 false——隧道无 dc 静默概念，SW 超时兜底。 */
function checkStall(): boolean {
  return stallSuspect({
    ctrlAlive: cascade?.mode !== 'tunnel' && (cascade?.isOpen ?? false),
    inFlight: inflightSw.size,
    silentMs: liveness.silentFor(),
  });
}
```

③ watchdog interval（:348-358）首行加 `setStall(checkStall());`

④ __p2pNetDebug（:1029-1045）返回对象加 `stall: checkStall(),`

- [ ] **Step 4: 跑测试确认通过 + 全量回归 + PWA 构建**

Run: `npx tsx --test pwa/src/stall.test.ts` → PASS；`npm test` 全绿；`npm run build:pwa` 成功。

- [ ] **Step 5: Commit**

```bash
git add pwa/src/stall.ts pwa/src/stall.test.ts pwa/src/ui.ts pwa/src/shell.ts
git commit -m "feat(health): stallSuspect 三条件黄灯——徽章双驱动，stall 期如实示警（spec D5）"
```

---

### Task 7: consent 失效复现脚本（spec D3 前置取证：先拿到失败证据，再写看门狗）

**Files:**
- Create: `scripts/consent-expiry-repro.mjs`
- Create: `e2e/n3-consent-repro.md`（运行后落报告）

**Interfaces:**
- Consumes: `werift` ^0.24.4（仓既有依赖，含 `iceFilterStunResponse` PeerConfig 注入点）；`--watchdog` 时动态 import `../src/consent-watchdog.js`（**Task 8 才存在**——本任务运行时该文件不存在属预期，脚本报「未实现」并继续跑无看门狗臂）。
- Produces: `e2e/consent-expiry-baseline.jsonl`（逐 500ms NDJSON 采样）；`e2e/n3-consent-repro.md` 分级结论（Task 8 验证臂复用同一脚本）。

**移植定案：** 逐字移植 v3 `scripts/werift-consent-expiry-repro.mjs`（275 行，预注册 H5：阶段 A 基线 5s → B 注入丢 STUN 40s → C 恢复 40s），三处适配：① import 从 `@devanywhere-net/node` 改为动态 `await import('../src/consent-watchdog.js')`（tsx 把 .js 解析到 .ts）；② 落盘默认 `e2e/consent-expiry-baseline.jsonl`；③ `--field-shape` 臂保留（issue #69 现场签名：bufferedAmount 钉死 ~257KiB 零进展）。

- [ ] **Step 1: 写脚本**

`scripts/consent-expiry-repro.mjs`（完整内容）：

```js
#!/usr/bin/env node
/**
 * consent-expiry-repro.mjs —— werift RFC 7675 consent 到期「静默黑洞」复现（spec D3 前置取证）
 * 逐字移植自 v3 scripts/werift-consent-expiry-repro.mjs（2026-09-16 三轮实录），适配本仓路径。
 *
 * 预注册（开跑前固定）：
 *   假设 H5：【consent 到期 → ICE 静默丢包 → DataChannel 假健康永久黑洞】
 *   唯一变量：responder 侧 iceFilterStunResponse 是否丢弃入站 STUN Binding 请求
 *     - 阶段 A（基线，5s）：正常转发
 *     - 阶段 B（注入，40s）：responder 丢弃全部入站 STUN → initiator 的 consent 请求无响应
 *     - 阶段 C（恢复，40s）：responder 恢复响应 → 观察是否自愈
 *   判定阈值：
 *     - 阶段 B 末：initiator ice.state==='failed' 且 consentFresh===false，
 *       且 A→B 交付停止增长，且 dcA.readyState==='open'（假健康）→ 起因链成立【实测-注入】
 *     - 阶段 C 末：应用数据仍不恢复 → 「不可自愈」成立【实测-注入】
 *   装置：本机 loopback 两枚 RTCPeerConnection（无公网/netem/VPN 依赖）；逐 500ms NDJSON 到 --out
 *   控制：--inject-ms / --recover-ms / --base-ms / --out；--field-shape 加现场形状上传臂
 *   --watchdog：A 侧挂 src/consent-watchdog（Task 8 实现后验证复活；此前报「未实现」并继续）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RTCPeerConnection } from 'werift';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const OUT = argOf('out', 'e2e/consent-expiry-baseline.jsonl');
const INJECT_MS = Number(argOf('inject-ms', '40000'));
const RECOVER_MS = Number(argOf('recover-ms', '40000'));
const BASE_MS = Number(argOf('base-ms', '5000'));
const WATCHDOG = process.argv.includes('--watchdog');
const FIELD_SHAPE = process.argv.includes('--field-shape');
const FIELD_MB = Number(argOf('field-mib', '32'));
const FIELD_DEADLINE_MS = Number(argOf('field-ms', '60000'));
const FIELD_CHUNK = 16 * 1024;
const FIELD_GATE = 256 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const gate = { allow: true, phase: 'setup' };

function iceOf(pc) {
  try { return pc.iceTransports?.[0]?.connection ?? null; } catch { return null; }
}

function snapshot(pc, tag, counters) {
  const ice = iceOf(pc);
  const pair = ice?.nominated;
  return {
    t: Date.now(), tag, phase: gate.phase,
    iceState: ice?.state ?? null,
    consentFresh: ice?.consentFresh ?? null,
    hasConsentLoop: !!ice?.queryConsentHandle,
    gen: ice?.generation ?? null,
    pair: pair ? {
      sent: pair.packetsSent, recv: pair.packetsReceived,
      reqSent: pair.requestsSent, rspRecv: pair.responsesReceived,
      consentSent: pair.consentRequestsSent,
      rttMs: Math.round((pair.rtt ?? 0) * 1000),
    } : null,
    dc: counters.dc,
    recv: counters.recv,
  };
}

async function main() {
  const log = [];
  const counters = { dc: {}, recv: {} };

  const pcA = new RTCPeerConnection({ iceServers: [] });
  const pcB = new RTCPeerConnection({ iceServers: [], iceFilterStunResponse: () => gate.allow });

  const dcA = pcA.createDataChannel('ordered', { ordered: true });
  const dcsB = [];
  pcA.onicecandidate = (e) => { if (e.candidate) void pcB.addIceCandidate(e.candidate).catch(() => {}); };
  pcB.onicecandidate = (e) => { if (e.candidate) void pcA.addIceCandidate(e.candidate).catch(() => {}); };
  pcB.ondatachannel = (ev) => { dcsB.push(ev.channel); };

  const stats = { aSent: 0, aToB: 0, bSent: 0, bToA: 0 };

  const offer = await pcA.createOffer();
  await pcA.setLocalDescription(offer);
  await pcB.setRemoteDescription(offer);
  const answer = await pcB.createAnswer();
  await pcB.setLocalDescription(answer);
  await pcA.setRemoteDescription(answer);

  await new Promise((r, j) => {
    const t = setTimeout(() => j(new Error(`连接 15s 未建（A=${pcA.connectionState} B=${pcB.connectionState}）`)), 15_000);
    const done = () => { if (pcA.connectionState === 'connected' && pcB.connectionState === 'connected') { clearTimeout(t); r(); } };
    pcA.onconnectionstatechange = done;
    pcB.onconnectionstatechange = done;
    done();
  });
  await sleep(500);

  const dcB = dcsB[0];
  if (!dcB) throw new Error('B 侧未收到 datachannel');
  dcB.onmessage = () => { stats.aToB += 1; };
  dcA.onmessage = () => { stats.bToA += 1; };

  const timer = setInterval(() => {
    try { dcA.send('A'.repeat(200)); stats.aSent += 1; } catch { /* closed */ }
    try { dcB.send('B'.repeat(200)); stats.bSent += 1; } catch { /* closed */ }
  }, 50);

  const sample = () => {
    for (const [pc, tag] of [[pcA, 'A'], [pcB, 'B']]) {
      log.push(snapshot(pc, tag, {
        dc: { A: { readyState: dcA.readyState, buffered: dcA.bufferedAmount }, B: { readyState: dcB.readyState, buffered: dcB.bufferedAmount } },
        recv: { ...stats },
      }));
    }
  };

  let detachWatchdog;
  if (WATCHDOG) {
    try {
      const { attachConsentWatchdog } = await import('../src/consent-watchdog.js');
      detachWatchdog = attachConsentWatchdog(pcA, {
        intervalMs: 3000,
        onEvent: (e) => console.log(`[watchdog] ${e.kind} 第 ${e.revives} 次（iceState=${e.iceState} consentFresh=${e.consentFresh}）`),
      });
      console.log('[watchdog] 已挂（interval 3000ms）');
    } catch (e) {
      console.log(`[watchdog] src/consent-watchdog 尚未实现（Task 8 前属预期）：${e.message}——继续跑无看门狗臂`);
    }
  }
  const sampler = setInterval(sample, 500);
  sample();
  console.log(`[setup] A↔B connected=${pcA.connectionState} dcA=${dcA.readyState} dcB=${dcB.readyState}`);

  gate.phase = 'A';
  await sleep(BASE_MS);
  const aBase = { ...stats };
  console.log(`[phase A 结束] A→B：发 ${aBase.aSent} 帧 / 达 ${aBase.aToB} 帧；B→A：发 ${aBase.bSent} 帧 / 达 ${aBase.bToA} 帧`);

  gate.phase = 'B';
  gate.allow = false;
  console.log(`[phase B 开始] responder 丢弃入站 STUN（${INJECT_MS}ms）；consent 预期在 ~30s 后到期`);
  await sleep(INJECT_MS);
  const iceA = iceOf(pcA);
  const bEnd = { ...stats };
  console.log(`[phase B 结束] A.ice.state=${iceA?.state} A.consentFresh=${iceA?.consentFresh} ` +
    `dcA.readyState=${dcA.readyState} buffered=${dcA.bufferedAmount}\n` +
    `             阶段 B 期间：A→B 发 ${bEnd.aSent - aBase.aSent} 帧 / 达 ${bEnd.aToB - aBase.aToB} 帧；` +
    `B→A 发 ${bEnd.bSent - aBase.bSent} 帧 / 达 ${bEnd.bToA - aBase.bToA} 帧`);

  gate.phase = 'C';
  gate.allow = true;
  console.log(`[phase C 开始] 恢复 STUN 响应（${RECOVER_MS}ms）；观察是否自愈`);
  await sleep(RECOVER_MS);
  const iceA2 = iceOf(pcA);
  const cEnd = { ...stats };
  console.log(`[phase C 结束] A.ice.state=${iceA2?.state} A.consentFresh=${iceA2?.consentFresh}\n` +
    `             阶段 C 期间：A→B 发 ${cEnd.aSent - bEnd.aSent} 帧 / 达 ${cEnd.aToB - bEnd.aToB} 帧；` +
    `B→A 发 ${cEnd.bSent - aBase.bSent} 帧 / 达 ${cEnd.bToA - bEnd.bToA} 帧`);

  detachWatchdog?.();

  let fieldResult = null;
  if (FIELD_SHAPE) {
    gate.phase = 'E';
    const total = FIELD_MB * 1024 * 1024;
    const startAt = Date.now();
    const deadline = startAt + FIELD_DEADLINE_MS;
    const before = stats.aToB;
    let sentBytes = 0;
    let wedgedAt = null;
    console.log(`[phase E 开始] 现场形状上传：${FIELD_MB}MiB / 16KiB 帧 / 背压门 256KiB / 上限 ${FIELD_DEADLINE_MS}ms`);
    while (sentBytes < total) {
      while (dcA.bufferedAmount > FIELD_GATE) {
        if (Date.now() > deadline) { wedgedAt = Date.now(); break; }
        await sleep(20);
      }
      if (wedgedAt) break;
      try { dcA.send('x'.repeat(FIELD_CHUNK)); stats.aSent += 1; } catch { break; }
      sentBytes += FIELD_CHUNK;
    }
    await sleep(5000);
    fieldResult = {
      payloadTarget: total, payloadSent: sentBytes,
      deliveredFrames: stats.aToB - before,
      bufferedFinal: dcA.bufferedAmount,
      wedged: wedgedAt !== null,
      elapsedMs: Date.now() - startAt,
      iceState: iceOf(pcA)?.state ?? null,
      consentFresh: iceOf(pcA)?.consentFresh ?? null,
    };
    console.log(`[phase E 结束] ${JSON.stringify(fieldResult)}`);
  }

  clearInterval(sampler);
  clearInterval(timer);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, log.map((l) => JSON.stringify(l)).join('\n') + '\n');
  console.log(`[落盘] ${OUT}（${log.length} 拍）`);

  const verdict = {
    at: nowIso(),
    watchdog: WATCHDOG,
    fieldShape: fieldResult,
    phaseB_iceState: iceA?.state ?? null,
    phaseB_consentFresh: iceA?.consentFresh ?? null,
    phaseB_dcOpen: dcA.readyState === 'open',
    phaseB_aToB_delivered: bEnd.aToB - aBase.aToB,
    phaseB_aToB_sent: bEnd.aSent - aBase.aSent,
    phaseC_iceState: iceA2?.state ?? null,
    phaseC_aToB_delivered: cEnd.aToB - bEnd.aToB,
    phaseC_aToB_sent: cEnd.aSent - bEnd.aSent,
  };
  console.log('[判定] ' + JSON.stringify(verdict));
  await pcA.close();
  await pcB.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
```

- [ ] **Step 2: 运行基线臂（无看门狗，~85s）**

Run: `npx tsx scripts/consent-expiry-repro.mjs --out e2e/consent-expiry-baseline.jsonl`
Expected（预注册判定）：
- 阶段 B 末：`A.ice.state=failed`、`A.consentFresh=false`、`dcA.readyState=open`（假健康）、A→B 交付 ≈ 0（远小于发出）；
- 阶段 C 末：A→B 交付仍 ≈ 0（不可自愈）。
若未复现（werift 行为与 v3 取证版本有出入）：如实记录实际输出，结论改为「本仓 werift 版本未复现」，Task 8 看门狗改为纯防御性挂载并在报告中降权、加重 Task 1 coturn 侧证据权重。**不许为了让结论成立而改脚本。**

- [ ] **Step 3: 写报告并 Commit**

`e2e/n3-consent-repro.md`：粘贴 `[判定]` JSON 与三段 phase 输出，按仓规分级【实测-注入】，对照 v3 `docs/benchmark/upload-stall-69-2026-09-16.md` 的同签名（buffered 钉死/交付停/DC 假 open）。

```bash
git add scripts/consent-expiry-repro.mjs e2e/consent-expiry-baseline.jsonl e2e/n3-consent-repro.md
git commit -m "test(health): consent 失效复现取证——werift #69 静默黑洞基线证据（spec D3 前置）"
```

---

### Task 8: ICE consent 看门狗（spec D3：werift 0.24.4 #69 授权死信兜底）

**Files:**
- Create: `src/consent-watchdog.ts`
- Modify: `src/peer.ts:85-102,113,245`（opts.consent + 挂载 + dispose 拆离 + give-up 上报）
- Test: `src/tests/consent-watchdog.test.ts`
- Modify: `e2e/n3-consent-repro.md`（验证臂补记）

**Interfaces:**
- Consumes: Task 7 的 `scripts/consent-expiry-repro.mjs --watchdog`（验证臂）；werift `iceTransports[0].connection` 未文档化字段（特性检测 + try/catch，缺失即零副作用）。
- Produces：
  ```ts
  // src/consent-watchdog.ts
  export interface IceTransportLike { state?; consentFresh?; queryConsentHandle?; generation?; queryConsent?; setState? }
  export interface IceTransportsOwner { iceTransports?: Array<{ connection?: IceTransportLike }> }
  export interface ConsentWatchdogEvent { kind: 'revive' | 'give-up'; atMs: number; iceState: string | null; consentFresh: boolean | null; revives: number }
  export function consentExpired(ice: IceTransportLike | null | undefined, everEstablished: boolean): boolean
  export function reviveConsent(ice: IceTransportLike | null | undefined): boolean
  export function attachConsentWatchdog(pc: IceTransportsOwner, opts?: { intervalMs?; maxRevives?; healthyResetMs?; onEvent? }): () => void
  // src/peer.ts constructor opts 增员：consent?: { intervalMs?: number; maxRevives?: number; healthyResetMs?: number }
  ```

**移植定案：** 逐字移植 v3 `packages/node/src/transport/consent-watchdog.ts`（170 行，含全部实测教训注释——那些注释就是证据本身，一字不删）。默认值用 v3 三轮实录调好的：`intervalMs=3000 / maxRevives=5 / healthyResetMs=60_000`。两个关键语义不得简化：① `everEstablished` 闩锁（建链中途 `consentFresh=false` 是「尚未新鲜」不是「已过期」，公网现场 11 次误报的教训）；② 复活顺序契约（先 `setState('connected')` 把 state 从终态拉回，再 `queryConsent()`）。

**spec D3 文字的两处演进说明（以 v3 实测为准，非偏离 spec）：**
1. spec 写「ICE restart」——v3 实测证实 restart 路径只 stop 不 start（`resetNominatedPair`/`setRemoteParams` 都不重开同意循环，见看门狗文件头注释 §4），真正有效的复活是**就地 `queryConsent()`**；本任务按移植版落地。
2. spec 写「双侧都修」——v3 语境双端皆 werift；本仓 PWA 侧是**浏览器原生 ICE**（consent 由浏览器 RFC 7675 实现维护，无 werift #69 缺陷），需要我们负责的只有 host（werift）一侧 + Task 1 的 coturn 侧取证。「一侧复活被另一侧拖死」的最终判据 = Task 13 的「无固定周期回收」真机观测。

- [ ] **Step 1: 写失败测试**

`src/tests/consent-watchdog.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachConsentWatchdog, consentExpired, reviveConsent, type IceTransportLike } from '../consent-watchdog.js';
import { Peer } from '../peer.js';

test('consentExpired 真值表（含 everEstablished 闩锁语义）', () => {
  assert.equal(consentExpired(null, true), false);
  assert.equal(consentExpired(undefined, true), false);
  // failed 恒算死：werift 全文件唯一置 failed 的路径就是 consent 到期（ice.js:316）
  assert.equal(consentExpired({ state: 'failed' }, false), true);
  // closed 不算死（正常关闭）
  assert.equal(consentExpired({ state: 'closed', consentFresh: false }, true), false);
  // 建链中途的 consentFresh=false 是「尚未新鲜」不是「已过期」（公网现场 11 次误报的教训）
  assert.equal(consentExpired({ state: 'connected', consentFresh: false }, false), false);
  // 建立之后掉新鲜 = 黑洞
  assert.equal(consentExpired({ state: 'connected', consentFresh: false }, true), true);
  assert.equal(consentExpired({ state: 'connected', consentFresh: true }, true), false);
});

test('reviveConsent 顺序契约：先 setState(connected) 再 queryConsent；非 failed 不 setState', () => {
  const calls: string[] = [];
  const ice: IceTransportLike = {
    state: 'failed',
    setState(s) { calls.push(`setState:${s}`); this.state = s; },
    queryConsent() { calls.push('queryConsent'); },
  };
  assert.equal(reviveConsent(ice), true);
  assert.deepEqual(calls, ['setState:connected', 'queryConsent']);

  const calls2: string[] = [];
  const ice2: IceTransportLike = { state: 'connected', setState(s) { calls2.push(`setState:${s}`); }, queryConsent() { calls2.push('queryConsent'); } };
  assert.equal(reviveConsent(ice2), true);
  assert.deepEqual(calls2, ['queryConsent']);

  assert.equal(reviveConsent(null), false);
  assert.equal(reviveConsent({}), false); // 无 queryConsent 方法：特性检测拒绝
});

test('看门狗：consent 死→revive；上限到→give-up；无 iceTransports 零副作用（Review Focus #2）', async () => {
  // 无 iceTransports（非 werift 实现 / stub pc）：30ms 内零事件零副作用
  const ev0: string[] = [];
  const d0 = attachConsentWatchdog({}, { intervalMs: 5, onEvent: (e) => ev0.push(e.kind) });
  await new Promise((r) => setTimeout(r, 30));
  d0();
  assert.deepEqual(ev0, []);

  // 必死链路（revive 救不回：consentFresh 恒 false），maxRevives=2 → revive,revive,give-up
  const ice: IceTransportLike = {
    state: 'connected', consentFresh: false,
    setState(s) { this.state = s; },
    queryConsent() { /* 对端真死：救不回 */ },
  };
  const evs: { kind: string; revives: number }[] = [];
  const d1 = attachConsentWatchdog({ iceTransports: [{ connection: ice }] }, {
    intervalMs: 5, maxRevives: 2, healthyResetMs: 1_000_000,
    onEvent: (e) => evs.push({ kind: e.kind, revives: e.revives }),
  });
  await new Promise((r) => setTimeout(r, 60));
  d1();
  assert.deepEqual(evs.map((e) => e.kind), ['revive', 'revive', 'give-up']);
  assert.deepEqual(evs.map((e) => e.revives), [1, 2, 2]);
});

test('healthyResetMs 闩锁：复活后持续健康未超窗不归零（病态链路不被无限复活）', async () => {
  const ice: IceTransportLike = {
    state: 'connected', consentFresh: true,
    setState(s) { this.state = s; },
    queryConsent() { this.consentFresh = true; },
  };
  const revives: number[] = [];
  const d = attachConsentWatchdog({ iceTransports: [{ connection: ice }] }, {
    intervalMs: 5, maxRevives: 99, healthyResetMs: 1_000,
    onEvent: (e) => { if (e.kind === 'revive') revives.push(e.revives); },
  });
  // 每 ~15ms 杀一次 consent（模拟 30s 周期的病态链路）；healthyResetMs=1s 窗口内 revives 只增不减
  const killer = setInterval(() => { ice.consentFresh = false; }, 15);
  await new Promise((r) => setTimeout(r, 100));
  clearInterval(killer); d();
  assert.ok(revives.length >= 2, `样本不足：${revives.join(',')}`);
  for (let i = 1; i < revives.length; i++) assert.ok(revives[i] > revives[i - 1], `revives 被重置：${revives.join(',')}`);
});

test('Peer 接线：建 pc 即挂看门狗；give-up 上报 failed（走宽限/终态链路）', async () => {
  const mkPc = () => ({
    connectionState: 'connected' as const,
    localDescription: null,
    ondatachannel: null, onicecandidate: null, oniceconnectionstatechange: null, onconnectionstatechange: null,
    async setRemoteDescription() {}, async setLocalDescription() {},
    async createOffer() { return { type: 'offer', sdp: '' }; },
    async createAnswer() { return { type: 'answer', sdp: '' }; },
    async addIceCandidate() {},
    createDataChannel() { return { readyState: 'open', send() {}, close() {} }; },
    async getStats() { return new Map(); },
    close() { (this as any).connectionState = 'closed'; },
    // 必死 ice：consentFresh 恒 false
    iceTransports: [{ connection: { state: 'connected', consentFresh: false, setState(s: string) { (this as any).state = s; }, queryConsent() {} } }],
  });
  const peer = new Peer([], { pcFactory: mkPc as any, consent: { intervalMs: 5, maxRevives: 1, healthyResetMs: 1_000_000 } });
  const statuses: string[] = [];
  await peer.acceptOffer('s1', { type: 'offer', sdp: '' }, {
    onChannel: () => {}, onIce: () => {}, onStatus: (s) => statuses.push(s.state),
  });
  await new Promise((r) => setTimeout(r, 60));
  peer.close();
  assert.ok(statuses.includes('failed'), `give-up 未上报 failed：${statuses.join(',')}`);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/tests/consent-watchdog.test.ts`
Expected: FAIL（`Cannot find module '../consent-watchdog.js'`）

- [ ] **Step 3: 实现 `src/consent-watchdog.ts`——逐字移植 v3**

将 `/Users/separationofconcerns/Documents/TryEverything/DevAnyWhere-v3/cores/devanywhere-net/packages/node/src/transport/consent-watchdog.ts` 的 **170 行全文**（含顶部机制注释、`IceTransportLike`/`IceTransportsOwner`/`ConsentWatchdogEvent`/`ConsentWatchdogOptions` 四接口、`consentExpired`/`reviveConsent`/`attachConsentWatchdog` 三函数）逐字复制到 `src/consent-watchdog.ts`，仅改文件头注释首行：

```ts
 * ICE 同意（RFC 7675 consent freshness）看门狗 —— werift 0.24.4 #69「上行背压排空停滞」的根因兜底。
 * （2026-09-23 自 v3 devanywhere-net 逐字移植，spec D3；实测依据：v3 docs/benchmark/upload-stall-69-2026-09-16.md
 *   与本仓 e2e/n3-consent-repro.md 复现证据）
```

其余一字不动（`everEstablished` 闩锁、复活顺序契约、healthyResetMs 语义、默认值 3000/5/60000 都是三轮实录换来的，删改即倒退）。

- [ ] **Step 4: 跑测试确认通过（Peer 接线用例此时仍败）**

Run: `npx tsx --test src/tests/consent-watchdog.test.ts`
Expected: 前 4 个用例 PASS；`Peer 接线` 用例 FAIL（`consent` opts 不存在、give-up 不上报）

- [ ] **Step 5: peer.ts 接线**

① import 区（:12 之后）加：

```ts
import { attachConsentWatchdog, type ConsentWatchdogEvent, type IceTransportsOwner } from './consent-watchdog.js';
```

② constructor opts 类型（:85-88）加字段：

```ts
    private opts: { transport?: 'all' | 'relay'; pcFactory?: () => PcLike; consent?: { intervalMs?: number; maxRevives?: number; healthyResetMs?: number } } = {},
```

③ 字段区（:83 `private lastStats` 之后）加：

```ts
  private detachConsent?: () => void;
```

④ dispose()（:99-102）首行加：

```ts
    if (this.detachConsent) { this.detachConsent(); this.detachConsent = undefined; }
```

⑤ 加两个私有方法（dispose 之后）：

```ts
  /** ICE consent 看门狗（spec D3）：pc 建好即挂；stub pc 无 iceTransports → 看门狗内部零副作用。 */
  private armConsentWatchdog(pc: PcLike): void {
    this.detachConsent?.();
    this.detachConsent = attachConsentWatchdog(pc as unknown as IceTransportsOwner, {
      intervalMs: this.opts.consent?.intervalMs,
      maxRevives: this.opts.consent?.maxRevives,
      healthyResetMs: this.opts.consent?.healthyResetMs,
      onEvent: (e) => this.onConsentEvent(e),
    });
  }

  private onConsentEvent(e: ConsentWatchdogEvent): void {
    if (e.kind === 'revive') {
      // 复活是可观测的异常事件（正常链路永不触发），进 stderr 留证据
      console.error(`[p2p-net] ICE consent 复活第 ${e.revives} 次（iceState=${e.iceState} consentFresh=${e.consentFresh}）——werift #69 兜底生效`);
      return;
    }
    // give-up：复活上限已到，链路真的死了——走既有失败链路（宽限→expireSession→session_end）
    console.error(`[p2p-net] ICE consent 复活 ${e.revives} 次仍死——上报 failed`);
    this.statusCb?.({ state: 'failed', ...this.lastStats });
  }
```

⑥ 两处 `const pc = this.pc = this.newPc();`（acceptOffer :113、connectAsClient :245）之后各加一行 `this.armConsentWatchdog(pc);`

- [ ] **Step 6: 跑测试确认通过 + 全量回归**

Run: `npx tsx --test src/tests/consent-watchdog.test.ts` → 全 PASS；`npm test` 全绿。

- [ ] **Step 7: 复跑 repro 验证臂（~85s）**

Run: `npx tsx scripts/consent-expiry-repro.mjs --watchdog --out e2e/consent-expiry-watchdog.jsonl`
Expected（预注册判定）：阶段 B 出现 `[watchdog] revive 第 1 次`；阶段 B/C 期间 A→B 交付恢复增长；`phaseC_aToB_delivered` 显著大于 0（对照 Task 7 基线的 ≈0）。若 revive 后仍不恢复：回 systematic-debugging Phase 1（先看 JSONL 里 `hasConsentLoop` 与 `iceState` 形态，不许直接改阈值）。

- [ ] **Step 8: 补记报告并 Commit**

`e2e/n3-consent-repro.md` 追加「验证臂」一节：watchdog 臂 `[判定]` JSON + 与基线臂的对照表（阶段 B/C 交付帧数），结论分级【实测-注入】。

```bash
git add src/consent-watchdog.ts src/peer.ts src/tests/consent-watchdog.test.ts e2e/consent-expiry-watchdog.jsonl e2e/n3-consent-repro.md
git commit -m "feat(health): ICE consent 看门狗——兜底 werift 0.24.4 #69 授权死信（spec D3，v3 逐字移植）"
```

---

### Task 9: N4 活性阈值（spec D7：15s/3 拍判死 + 事件驱动硬失效 0ms + 参数入 config 可真机标定）

**Files:**
- Create: `pwa/src/livenessConfig.ts`
- Modify: `pwa/src/signaling-web.ts:22-31,33-46,77-82,147-152,153-159,165-175`（liveness 实例化 + emitPcStatus failed 0ms 拆连）
- Modify: `pwa/src/dataPlaneLiveness.ts:12,17-34`（WEDGE_MS 入 constructor）
- Modify: `pwa/src/session.ts:30-52,165-183`（CascadeOptions.liveness 透传）
- Modify: `pwa/src/shell.ts:37,82,419-429`（livenessFromQuery + 注入）
- Test: `pwa/src/livenessConfig.test.ts`、Modify: `pwa/src/dataPlaneLiveness.test.ts`

**Interfaces:**
- Consumes: Task 6 的 stallSuspect（「慢」已分流给黄灯，判死窗口才敢收）、Task 8 的 consent-watchdog（host 侧黑洞兜底）、handleProxyMessage 的 onProof（**任何数据面回帧都续命**——批量传输期心跳被饿死不会误判，这是 15s 窗口不重演 2026-09-23 误判死亡螺旋的底气）。
- Produces：
  ```ts
  // pwa/src/livenessConfig.ts
  export interface LivenessConfig { pingMs: number; livenessMs: number; wedgeMs: number }
  export const DEFAULT_LIVENESS: LivenessConfig  // { pingMs: 5000, livenessMs: 15000, wedgeMs: 60000 }
  export function livenessFromQuery(q: URLSearchParams): LivenessConfig
  // SessionOptions / CascadeOptions 增员：liveness?: Partial<Pick<LivenessConfig, 'pingMs' | 'livenessMs'>>
  // DataPlaneLiveness 增员：constructor(wedgeMs?: number)
  ```

**语义定案（spec D7，含与 commit a038d8d 的关系）：** 45s 窗口是「LIVENESS 看门狗 = 唯一黑洞检测手段」时代的妥协（代价：真黑洞检测晚 45s、绿点谎言窗口长）。新世界三件套把它收回 15s：① `emitPcStatus` 收到 pc `'failed'` **0ms 拆连上报 off**（真黑洞由 ICE 事件秒级捕获，不再等心跳窗口）；② 任何数据面回帧都刷 `lastPongAt`（传输期不误判）；③ stall 黄灯 5s 示警（用户侧「慢」与「死」不再混）。回退旋钮：URL `?liveness=45` 真机标定。

- [ ] **Step 1: 写失败测试**

`pwa/src/livenessConfig.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIVENESS, livenessFromQuery } from './livenessConfig.js';

test('默认值钉死（spec D7）：ping 5s / liveness 15s(3拍) / wedge 60s', () => {
  assert.deepEqual({ ...DEFAULT_LIVENESS }, { pingMs: 5_000, livenessMs: 15_000, wedgeMs: 60_000 });
});

test('URL 标定：?ping=&liveness=&wedge=（秒）覆盖；非法/缺省回落默认', () => {
  assert.deepEqual(livenessFromQuery(new URLSearchParams('liveness=45')), { pingMs: 5_000, livenessMs: 45_000, wedgeMs: 60_000 });
  assert.deepEqual(livenessFromQuery(new URLSearchParams('ping=2&wedge=30')), { pingMs: 2_000, livenessMs: 15_000, wedgeMs: 30_000 });
  assert.deepEqual(livenessFromQuery(new URLSearchParams('liveness=-3&ping=abc')), { ...DEFAULT_LIVENESS });
  assert.deepEqual(livenessFromQuery(new URLSearchParams('')), { ...DEFAULT_LIVENESS });
});
```

`pwa/src/dataPlaneLiveness.test.ts` 追加：

```ts
test('constructor 自定义 wedgeMs（N4 真机标定）；缺省 = WEDGE_MS', () => {
  const a = new DataPlaneLiveness(1_000);
  a.noteFrame(0);
  assert.equal(a.wedged(1, 1_500), true);
  const b = new DataPlaneLiveness();
  b.noteFrame(0);
  assert.equal(b.wedged(1, 1_500), false);
  assert.equal(b.wedged(1, 61_000), true);
});
```

（若该文件既有用例用 `new DataPlaneLiveness()` 无参构造，保持兼容——wedgeMs 有默认值。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test pwa/src/livenessConfig.test.ts pwa/src/dataPlaneLiveness.test.ts`
Expected: FAIL（`Cannot find module './livenessConfig.js'`；`new DataPlaneLiveness(1_000)` 参数不存在）

- [ ] **Step 3: 实现 livenessConfig.ts + dataPlaneLiveness.ts 改造**

`pwa/src/livenessConfig.ts`：

```ts
/**
 * N4 活性阈值（2026-09-23 Wave 1，spec D7）：判死参数入 config，URL 可真机标定。
 *
 * 为什么敢把 LIVENESS 从 45s 收回 15s（commit a038d8d 的 45s 是旧世界妥协）：
 *  ① pc 'failed' 事件 0ms 拆连（signaling-web emitPcStatus）——真黑洞由 ICE 层秒级上报；
 *  ② 任何数据面回帧都刷 lastPongAt（handleProxyMessage onProof）——传输期心跳被饿死不误判；
 *  ③ stall 黄灯（stall.ts）5s 示警——「慢」与「死」在用户侧分开，不再需要靠长窗口遮羞。
 * 15s = 3 拍心跳；仍拿不准时 ?liveness=45 现场标定，用真机数据说话。
 */
export interface LivenessConfig {
  /** ctrl 心跳周期（ms）。 */
  pingMs: number;
  /** 心跳断供判死窗口（ms）。 */
  livenessMs: number;
  /** 数据面全局静默判死窗口（ms，dataPlaneLiveness）。 */
  wedgeMs: number;
}

export const DEFAULT_LIVENESS: LivenessConfig = { pingMs: 5_000, livenessMs: 15_000, wedgeMs: 60_000 };

/** URL ?ping=&liveness=&wedge=（秒）覆盖——真机标定专用，不进生产默认。 */
export function livenessFromQuery(q: URLSearchParams): LivenessConfig {
  const sec = (name: string, dflt: number): number => {
    const v = Number(q.get(name));
    return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : dflt;
  };
  return {
    pingMs: sec('ping', DEFAULT_LIVENESS.pingMs),
    livenessMs: sec('liveness', DEFAULT_LIVENESS.livenessMs),
    wedgeMs: sec('wedge', DEFAULT_LIVENESS.wedgeMs),
  };
}
```

`pwa/src/dataPlaneLiveness.ts`：

```ts
export class DataPlaneLiveness {
  private lastProofAt = 0;

  /** wedgeMs 入 constructor（N4，spec D7）：缺省 WEDGE_MS；URL ?wedge= 真机标定由 shell 注入。 */
  constructor(private readonly wedgeMs: number = WEDGE_MS) {}

  // noteOpen / noteFrame / silentFor 不变；wedged 改用 this.wedgeMs：
  wedged(inflight: number, now = Date.now()): boolean {
    if (inflight <= 0) return false;
    return now - this.lastProofAt > this.wedgeMs;
  }
}
```

- [ ] **Step 4: signaling-web.ts 实例化 + 事件驱动硬失效**

① import 加 `import { DEFAULT_LIVENESS, type LivenessConfig } from './livenessConfig.js';`

② SessionOptions（:22-31）加：

```ts
  /** N4 活性阈值（spec D7）：缺省 DEFAULT_LIVENESS；真机标定由 shell 经 URL 注入。 */
  liveness?: Partial<Pick<LivenessConfig, 'pingMs' | 'livenessMs'>>;
```

③ :33-46 的 `LIVENESS_MS` 常量与长注释替换为实例字段（注释精简，论证挪 livenessConfig.ts）：

```ts
  private readonly pingMs: number;
  private readonly livenessMs: number;

  constructor(private readonly opts: SessionOptions) {
    this.pingMs = opts.liveness?.pingMs ?? DEFAULT_LIVENESS.pingMs;
    this.livenessMs = opts.liveness?.livenessMs ?? DEFAULT_LIVENESS.livenessMs;
  }
```

（原 `constructor(private readonly opts: SessionOptions) {}` :77 删除合并。）

④ isOpen getter（:81）`LIVENESS_MS` → `this.livenessMs`；pingTimer（:147-152）`PING_MS` → `this.pingMs`（`PING_MS` 常量删除）；watchdog（:154-159）`LIVENESS_MS` → `this.livenessMs`。

⑤ emitPcStatus 的 'failed' 分支（:169-170）改：

```ts
    } else if (st === 'failed') {
      // N4 事件驱动硬失效（spec D7）：pc 自报 failed = ICE 层已判死，0ms 拆连上报 off，
      // shell 立即走指数退避重连。旧行为只报 failed 不拆——没有任何人触发重连，
      // 界面停在「连接失败」干等 SW 45s 超时（真黑洞恢复被拖一个数量级）。
      this.opts.onStatus({ state: 'off', pairType: null });
      this.teardown();
    }
```

- [ ] **Step 5: session.ts / shell.ts 透传**

`pwa/src/session.ts`：

① import 加 `import type { LivenessConfig } from './livenessConfig.js';`
② CascadeOptions（:30-52）加 `liveness?: Partial<Pick<LivenessConfig, 'pingMs' | 'livenessMs'>>;`
③ tryWebRtc 的 WebRtcSession 构造（:165-183）加一行 `liveness: this.opts.liveness,`

`pwa/src/shell.ts`：

① import 加 `import { livenessFromQuery } from './livenessConfig.js';`
② :82 `const liveness = new DataPlaneLiveness();` 改为：

```ts
const LIVE = livenessFromQuery(Q); // N4 真机标定旋钮（?ping=&liveness=&wedge=）
const liveness = new DataPlaneLiveness(LIVE.wedgeMs);
```

③ CascadeSession 构造（:419-429）加一行 `liveness: LIVE,`

- [ ] **Step 6: 跑测试确认通过 + 全量回归 + PWA 构建**

Run: `npx tsx --test pwa/src/livenessConfig.test.ts pwa/src/dataPlaneLiveness.test.ts` → PASS；`npm test` 全绿；`npm run build:pwa` 成功。

- [ ] **Step 7: Commit**

```bash
git add pwa/src/livenessConfig.ts pwa/src/livenessConfig.test.ts pwa/src/dataPlaneLiveness.ts pwa/src/dataPlaneLiveness.test.ts pwa/src/signaling-web.ts pwa/src/session.ts pwa/src/shell.ts
git commit -m "feat(health): N4 活性阈值——15s(3拍)判死+事件驱动硬失效0ms+参数入 config 可真机标定（spec D7）"
```

---

### Task 10: 隧道响应 gzip 流式压缩（spec D6：实验档 P2P_NET_GZIP，预注册 A/B）

**Files:**
- Create: `e2e/compression-ab-prereg.md`
- Modify: `src/frames.ts:20-25`（ResHeadFrame 加 `enc?: 'gzip'`）
- Modify: `src/bridge/http.ts:14-30,102-128`（createGzip + gzipEligible + res-head 带 enc + body 源换管道）
- Modify: `pwa/src/sw.ts:23-27,77-93`（PendingEntry 加 gz + DecompressionStream 解码支路）
- Test: Modify: `src/tests/bridge.test.ts`（追加 gzip 用例）

**Interfaces:**
- Consumes: Task 3 的 sw.ts 二进制/base64 双路径（gzip 支路叠加其上，不改既有路径）；`bridge.test.ts` 既有 `startHttpServer`/`FakeDc`/`closeServer` 设施。
- Produces：
  ```ts
  // frames.ts ResHeadFrame 增员：enc?: 'gzip'
  // sw.ts PendingEntry 增员：gz?: WritableStreamDefaultWriter<Uint8Array>
  // env：P2P_NET_GZIP=1（host 进程；缺省关，A/B 后凭数据定默认）
  ```

**语义定案（spec D6）：** 唯一变量 = `P2P_NET_GZIP` env；`>16KB && 文本类 && 无 content-encoding` 才压（小响应/已压/二进制不值当——wasm 例外列入因 devanywhere-ui 带 wasm）；`DecompressionStream` 缺失（老浏览器）时 host 的 enc 字段被 SW 忽略、按未压缩解析会炸——**所以 gzip 支路以 res-head 协商为准：SW 只在 `m.enc==='gzip'` 且本地支持时才走解码**，不支持则进原路径会产出坏流——为防此情况，host 侧 gzipEligible 另加一道 req 帧 headers 声明（`x-p2p-gzip: 1`）检查：SW 发 req 时若支持 DecompressionStream 就带该头，host 只对声明过的请求压缩。**双端协商，缺一不可。**

- [ ] **Step 1: 写预注册文档（开跑前固定判定标准）**

`e2e/compression-ab-prereg.md`：

```markdown
# 压缩 A/B 预注册（spec D6，2026-09-23 开跑前固定，不许后改）

- 假设 H6：大 payload（≥16KB 文本类）期，1KB 探测排队时延 p50 降 ≥30%，且中继线字节量降 ≥20%。
- 唯一变量：host 进程 env P2P_NET_GZIP（off / on）。
- 设计：A(off) → B(on) → A(反转) 三段，真机蜂窝强制 TURN（?transport=relay）；
  每段跑同一 payload 清单（devanywhere-ui 首屏 + /size/1MiB ×3），记录：探测 p50/p95、
  /status dataPlane.totals.bytesSent 增量、__p2pNetDebug().frames.bytesRecv 增量。
- 判定：两假设同时成立 → 默认开（下版本改 DEFAULT）；任一不成立 → 保持实验档关闭。
- 撤退线：任一指标劣化 >5%（含小请求路径）→ 立即关并记结论。
- 执行窗口：Task 13 真机门禁同一连接窗口内完成（不重开连接）。
```

- [ ] **Step 2: 写失败测试（bridge.test.ts 追加）**

`src/tests/bridge.test.ts` 追加（复用该文件既有 `startHttpServer`/`FakeDc`/`closeServer`/`until` 设施；`gunzipSync` 从 `node:zlib` 导入）：

```ts
test('gzip 实验：flag on + 声明头 + 大 JSON → enc:gzip 且可还原；flag off 恒等不压', async () => {
  const big = JSON.stringify({ data: 'x'.repeat(40 * 1024) });
  const server = await startHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(big)) });
    res.end(big);
  });
  try {
    // flag on + req 带 x-p2p-gzip: 1 → 压缩
    process.env.P2P_NET_GZIP = '1';
    const dc = new FakeDc();
    const bridge = new HttpBridge();
    await bridge.handle(dc, { k: 'req', id: 1, port: server.port, method: 'GET', path: '/', headers: { 'x-p2p-gzip': '1' } });
    await until(() => dc.frames.some((f) => f.k === 'res-chunk' && f.done));
    const head = dc.frames.find((f) => f.k === 'res-head');
    assert.equal(head.enc, 'gzip');
    const gz = Buffer.concat(dc.frames.filter((f) => f.k === 'res-chunk' && f.dataB64).map((f) => Buffer.from(f.dataB64, 'base64')));
    assert.equal(gunzipSync(gz).toString('utf8'), big);

    // 同 flag 但 req 无声明头 → 不压（双端协商，缺一不可）
    const dc2 = new FakeDc();
    await bridge.handle(dc2, { k: 'req', id: 2, port: server.port, method: 'GET', path: '/', headers: {} });
    await until(() => dc2.frames.some((f) => f.k === 'res-chunk' && f.done));
    assert.equal(dc2.frames.find((f) => f.k === 'res-head').enc, undefined);

    // flag off → 恒等不压
    delete process.env.P2P_NET_GZIP;
    const dc3 = new FakeDc();
    await bridge.handle(dc3, { k: 'req', id: 3, port: server.port, method: 'GET', path: '/', headers: { 'x-p2p-gzip': '1' } });
    await until(() => dc3.frames.some((f) => f.k === 'res-chunk' && f.done));
    assert.equal(dc3.frames.find((f) => f.k === 'res-head').enc, undefined);
    const plain = Buffer.concat(dc3.frames.filter((f) => f.k === 'res-chunk' && f.dataB64).map((f) => Buffer.from(f.dataB64, 'base64')));
    assert.equal(plain.toString('utf8'), big);
  } finally {
    delete process.env.P2P_NET_GZIP;
    closeServer(server.server);
  }
});

test('gzip 实验：小响应（<16KB）不压', async () => {
  process.env.P2P_NET_GZIP = '1';
  const server = await startHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '2' });
    res.end('{}');
  });
  try {
    const dc = new FakeDc();
    await new HttpBridge().handle(dc, { k: 'req', id: 1, port: server.port, method: 'GET', path: '/', headers: { 'x-p2p-gzip': '1' } });
    await until(() => dc.frames.some((f) => f.k === 'res-chunk' && f.done));
    assert.equal(dc.frames.find((f) => f.k === 'res-head').enc, undefined);
  } finally {
    delete process.env.P2P_NET_GZIP;
    closeServer(server.server);
  }
});
```

（若既有 `startHttpServer` 返回形态不是 `{ port, server }`，按该文件实际设施签名调整解构——执行者以文件现状为准，断言语义不变。）

- [ ] **Step 3: 跑测试确认失败**

Run: `npx tsx --test src/tests/bridge.test.ts`
Expected: 新增 2 用例 FAIL（无 `enc` 字段）

- [ ] **Step 4: 实现——frames.ts + http.ts**

`src/frames.ts` ResHeadFrame（:20-25）加：

```ts
  /** Wave 1 实验（spec D6）：body 经 gzip 流式压缩（双端协商：req 带 x-p2p-gzip:1 且 env P2P_NET_GZIP=1）。 */
  enc?: 'gzip';
```

`src/bridge/http.ts`：

① :14 后加 `import { createGzip, gunzipSync } from 'node:zlib';`（gunzipSync 只测试用——不，生产文件不引测试工具；**只加 `import { createGzip } from 'node:zlib';`**，测试文件自己引 gunzipSync）

② :30 STRIP_RES_HEADERS 之后加：

```ts
/**
 * gzip 实验（spec D6，预注册 e2e/compression-ab-prereg.md）：P2P_NET_GZIP=1 且满足全部条件才压——
 * >16KB（小响应不值当）、文本/wasm 类（二进制已压）、上游未自带 content-encoding、
 * 且 req 帧带 x-p2p-gzip:1 声明（双端协商：SW 不支持 DecompressionStream 时绝不可压）。
 */
const GZIP_MIN_BYTES = 16 * 1024;
const GZIP_TYPES = /^(text\/|application\/(json|javascript|xml|x-javascript|typescript|wasm)|image\/svg\+xml)/;

function gzipEligible(resHeaders: http.IncomingHttpHeaders, reqHeaders: Record<string, string> | undefined): boolean {
  if (process.env.P2P_NET_GZIP !== '1') return false;
  const declared = Object.entries(reqHeaders ?? {}).some(([k, v]) => k.toLowerCase() === 'x-p2p-gzip' && v === '1');
  if (!declared) return false;
  const len = Number(resHeaders['content-length'] ?? 0);
  if (!(len > GZIP_MIN_BYTES)) return false;
  if (!GZIP_TYPES.test(String(resHeaders['content-type'] ?? ''))) return false;
  if (resHeaders['content-encoding']) return false;
  return true;
}
```

③ doReq 内（:102 `const rh` 之前）加 `const gz = gzipEligible(res.headers, frame.headers);`；res-head 帧（:109）改：

```ts
      await dcSend(dc, { k: 'res-head', id, status: res.statusCode ?? 502, headers: rh, ...(gz ? { enc: 'gzip' as const } : {}) });
```

④ body 循环（:120）改源：

```ts
      const src: NodeJS.ReadableStream = gz ? res.pipe(createGzip()) : res;
      for await (const chunk of src) {
        for (const piece of chunkB64(chunk as Buffer)) {
          sentBytes += piece.length;
          await dcSend(dc, { k: 'res-chunk', id, dataB64: piece });
        }
      }
```

（`x-p2p-gzip` 不在 STRIP_REQ_HEADERS 清单，会透传进 localhost 请求——无害自定义头；若想更净可加入 STRIP 清单，本任务不动它。）

- [ ] **Step 5: 实现——sw.ts 声明头 + DecompressionStream 支路**

① PendingEntry（:23-27）加字段：

```ts
  /** gzip 解码支路（spec D6）：res-head.enc==='gzip' 且本地支持 DecompressionStream 时建立。 */
  gz?: WritableStreamDefaultWriter<Uint8Array>;
```

② proxy() 发 req 帧处（headers 构建点）加声明头：

```ts
    if (typeof DecompressionStream !== 'undefined') headers['x-p2p-gzip'] = '1'; // spec D6 双端协商声明
```

（headers 对象在 req 帧组装处既有；若该处是透传 e.request.headers 的 Record，在其后补一行即可。）

③ onPortMsg 的 res-head 分支（:80-88），在 noBody 特判之后、原 stream 路径之前插入：

```ts
    if (m.enc === 'gzip' && typeof DecompressionStream !== 'undefined') {
      // gzip 流式解码（spec D6）：压缩字节写 ds.writable；解码后字节经 reader 逐段 enqueue
      const ds = new DecompressionStream('gzip');
      const stream = new ReadableStream<Uint8Array>({
        start(c) { p.ctrl = c; },
        cancel() { try { port && port.postMessage({ k: 'req-abort', id: m.id }); } catch { /* port 已死 */ } },
      });
      p.gz = ds.writable.getWriter();
      p.resolve(new Response(stream, { status: m.status, headers: m.headers }));
      const reader = ds.readable.getReader();
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length) p.ctrl?.enqueue(value);
          }
          p.ctrl?.close();
          pending.delete(m.id);
        } catch {
          try { p.ctrl?.error(new Error('gzip decode failed')); } catch { /* 已终结 */ }
          pending.delete(m.id);
        }
      })();
      return;
    }
```

④ res-chunk 分支（:89-92）改：

```ts
  } else if (m.k === 'res-chunk' && (p.ctrl || p.gz)) {
    const u8 = m.data instanceof Uint8Array ? m.data : m.dataB64 ? b64u8(m.dataB64) : null;
    if (p.gz) {
      // writer 内部排队保序：write/close 顺序到达，无需 await
      if (u8) void p.gz.write(u8);
      if (m.done) void p.gz.close().catch(() => { /* 解码器自清理 */ });
    } else if (p.ctrl) {
      if (u8) p.ctrl.enqueue(u8);
      if (m.done) { p.ctrl.close(); pending.delete(m.id); }
    }
  }
```

- [ ] **Step 6: 跑测试确认通过 + 全量回归 + PWA 构建**

Run: `npx tsx --test src/tests/bridge.test.ts` → 全 PASS；`npm test` 全绿；`npm run build:pwa` 成功。

- [ ] **Step 7: Commit**

```bash
git add src/frames.ts src/bridge/http.ts src/tests/bridge.test.ts pwa/src/sw.ts e2e/compression-ab-prereg.md
git commit -m "feat(perf): 隧道响应 gzip 流式压缩（实验档 P2P_NET_GZIP 双端协商，预注册 A/B，spec D6）"
```

---

### Task 11: HOL 门禁集成测试（spec D2 验收：大传输期 1KB 探测排队增量 p95 ≤ 50ms）

**Files:**
- Test: Create: `src/tests/hol-gate.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `decodeBinFrame`（client 侧二进制 reassembly）；Task 4 的 `connectAsClient(handlers, { poolSize: 4 })` 返回 `channels.pool`；`host.integration.test.ts` 的 `MemSignaling`/`until`/`closeServer` 设施（就地复写同构版本，测试文件各自独立）。
- Produces: CI 常驻门禁——任何让「大传输饿死小请求」的回归（池选路失效/粘滞失效/背压回退）在此被拦。

**判定口径（预注册，移植 v3 bench/scenarios/hol-blocking.mjs）：** 窗口内（大传输进行中）的探测才算数，big done 之后完成的一律剔除并计数；有效探测 <10 次 = 测试失败（窗口不足，门禁形同虚设）；排队增量 = 探测往返 - idle 基线 p50；**p95(增量) ≤ 50ms**（loopback 门禁；真机 39s→目标对比归 Task 13）。

- [ ] **Step 1: 写测试并先验证它在旧行为下失败（拆掉池即可回归复现）**

`src/tests/hol-gate.test.ts`：

```ts
/**
 * HOL 门禁（spec D2 验收）：4 通道池下，16MiB 大传输期间 1KB 探测的排队增量 p95 ≤ 50ms。
 * 判定口径预注册（本文件头注释即契约）：窗口内探测（big done 前完成）≥10 次才统计；
 * 增量 = 探测(doneAt-sendAt) - idle 基线 p50；大响应 chunk 全落同一通道（粘滞断言）。
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

test('HOL 门禁：16MiB 大传输期间 1KB 探测排队增量 p95≤50ms；大响应粘滞单通道', async () => {
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
    assert.ok(gate <= 50, `HOL 门禁失败：大传输期 1KB 探测排队增量 p95=${gate}ms > 50ms（基线 p50=${baseP50}ms，样本 ${probes.length}）`);
    assert.equal(accs.get(1)!.bytes, 16777216, '大传输字节完整');
    assert.equal(accs.get(1)!.ch.size, 1, `大响应 chunk 跨通道（粘滞破坏）：落在 ${[...accs.get(1)!.ch].join(',')}`);
  } finally {
    clearInterval(pump);
    client.close();
    agent.stop();
    closeServer(server);
  }
});
```

- [ ] **Step 2: 跑测试确认通过（当前代码即应过——它是门禁，不是新功能）**

Run: `npx tsx --test src/tests/hol-gate.test.ts`
Expected: PASS（Task 4 池化 + Task 2 二进制已就位）。**反向验证**（一次性，不提交）：把 `pool-host` 选路临时改回恒到达通道（`pickDc` 直接 `return fallback;`），门禁必须 FAIL（p95 暴增）——验证它真能拦住回归后还原。若正向就 FAIL：回 Phase 1 查选路/粘滞（不许先调阈值）。

- [ ] **Step 3: 全量回归 + Commit**

Run: `npm test` 全绿。

```bash
git add src/tests/hol-gate.test.ts
git commit -m "test(perf): HOL 门禁集成测试——大传输期 1KB 请求排队增量 p95≤50ms（spec D2 验收）"
```

---

### Task 12: 成本模型文档 + status 暴露数据面字节量（spec D8：成本一等指标的观测闭环）

**Files:**
- Create: `docs/cost-model.md`
- Modify: `src/cli/status.ts:22-29,72-77`（StatusBody 加 dataPlane + 打印行 + fmtBytes）
- Test: Modify: `src/tests/status.test.ts`（追加 dataPlane 渲染用例）

**Interfaces:**
- Consumes: Task 5 的 `/status dataPlane: { totals: SessionLedger; sessions: number } | null`。
- Produces：用户可见 `p2p-net status` 流量行；`docs/cost-model.md` 为成本决策单一事实源（Task 13 对账节直接引用其口径）。

- [ ] **Step 1: 写失败测试（status.test.ts 追加，复用该文件既有 deps/fetchImpl 注入写法）**

```ts
test('dataPlane 存在时打印数据面流量行；缺字段（旧进程）省略', async () => {
  const lines: string[] = [];
  const code = await runStatus({
    fetchImpl: (async () => new Response(JSON.stringify({
      uptime: 60, deviceId: 'desk-x', sessions: { active: 1, byMode: { relay: 1 }, avgRttMs: 53 },
      services: 2, mode: 'foreground',
      dataPlane: { totals: { req: 40, resDone: 40, bytesSent: 2 * 1024 * 1024, bytesRecv: 1024 * 1024 }, sessions: 1 },
    }), { status: 200 })) as typeof fetch,
    out: (l) => lines.push(l),
  });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes('数据面流量') && l.includes('上行 2.0 MiB') && l.includes('下行 1.0 MiB')), lines.join('\n'));

  const lines2: string[] = [];
  await runStatus({
    fetchImpl: (async () => new Response(JSON.stringify({ uptime: 60, deviceId: 'd', sessions: 0, services: 0 }), { status: 200 })) as typeof fetch,
    out: (l) => lines2.push(l),
  });
  assert.ok(!lines2.some((l) => l.includes('数据面流量')), '旧进程无 dataPlane → 不打该行');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/tests/status.test.ts`
Expected: 新用例 FAIL（无「数据面流量」行）

- [ ] **Step 3: 实现 status.ts**

① StatusBody（:22-29）加：

```ts
  /** Wave 1（spec D8）：数据面计量快照；旧进程无此字段 → 容错省略该行。 */
  dataPlane?: { totals?: { req?: number; resDone?: number; bytesSent?: number; bytesRecv?: number }; sessions?: number } | null;
```

② :75 `发现服务` 行之后加：

```ts
  const dp = body.dataPlane;
  const sent = dp?.totals?.bytesSent;
  const recv = dp?.totals?.bytesRecv;
  if (typeof sent === 'number' && typeof recv === 'number') {
    // 视角 = 本机（host）：bytesSent=发往客户端=上行；与 events.jsonl 的 bytesUp 同义
    out(`数据面流量：上行 ${fmtBytes(sent)} / 下行 ${fmtBytes(recv)}（${dp?.sessions ?? 0} 活跃会话累计）`);
  }
```

③ 文件尾加：

```ts
/** 字节量人话化：≥1MiB → X.X MiB；≥1KiB → X.X KiB；否则 N B。 */
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/tests/status.test.ts` → 全 PASS。

- [ ] **Step 5: 写 `docs/cost-model.md`**

```markdown
# cost-model.md — p2p-net 成本模型（2026-09-23 Wave 1，spec D8）

> 单一事实源：成本怎么估、在哪测、红线在哪。改动必须带实测证据（分级【实测-*/推理】）。

## 1. 计费字节：relay 线字节因子 1.68【实测-注入（v3 tc-cost）】

每 1 B 应用数据经过 TURN 中继 ≈ **1.68 B** 线字节（RTP/DTLS/SCTP/ICE/UDP 四层封装税）。
直连（p2p host/srflx）不过中继，**不计费字节** —— 直连率就是利润率。

## 2. 单 VPS 容量账（bj2 档，30 Mbps 按带宽计费）

固定带宽月出量公式【实测-外部 v3 tc-cost】：月线字节 = 带宽 × 31,557,600s ÷ 12 × 利用率 u。
30 Mbps × u50% ≈ **4.9 TB/月线字节** ≈ **2.9 TB/月应用字节**（÷1.68）；对照档：5M→0.8TB、100M→16.4TB 线字节。
吞吐天花板 = 出口带宽档（5Mbps 档实测封顶 0.32 MiB/s【实测-外部】）——按带宽计费的节点，
瞬时并发吞吐先天封顶，容量规划看带宽档不看流量包。
结论：中继是**兜底**不是常态——常态化中继 1 个重度用户（2 GB/月应用字节）约耗 0.07% 容量；
真正吃容量的是「直连率塌陷 × 大文件传输」的组合。

## 3. 观测口径（Wave 1 落地）

| 层 | 口径 | 位置 |
|---|---|---|
| 进程 | `dataPlane.totals.bytesSent/bytesRecv`（活跃会话求和） | `GET 127.0.0.1:19727/status` / `p2p-net status` |
| 会话 | `session_end.bytesUp/bytesDown`（host 视角：Up=发往客户端） | `~/.p2p-net/logs/events.jsonl` |
| PWA | `__p2pNetDebug().frames.bytesSent/bytesRecv`（dc 线字节估算） | 手机端 console |
| 中继 | VPS 网卡字节（vnstat/ifconfig）÷ 应用字节 → 对账 1.68 因子 | coturn VPS |

## 4. 基线（v0.1.0 实测）

60min 真机蜂窝浸泡（混合直连/中继）：应用字节量见 `e2e/real-service-soak.md`；
轻交互段 22min ≈ 1.3 MB。**Wave 1 复测基线由 Task 13 报告刷新。**

## 5. 红线推演（什么组合会亏穿）

单 VPS 月成本 C 元、4.9 TB 线字节容量（30Mbps@u50%）：容纳 N 个「纯中继中度用户」
（500 MB/月应用）≈ 4900÷1.68÷0.5 ≈ 5800 人——**纯中继也能活**；亏穿点是「直连率塌陷
（蜂窝↔家宽实测可低至 0【实测-外部】）且人均大文件（>2 GB/月）」。所以运营北极星指标 =
**直连率**（events.jsonl 的 pathType 分布，Task 5 增补起按接入类型分桶），其次才是人均字节。

## 6. 容量方程 v1（spec D9：10 万用户近乎免费的量化回答）

> 方程：**VPS 成本 = 在线数 ×（中继率+隧道率）× 会话带宽 × 字节因子**；信令成本单列。
> 所有参数带证据分级；估算必须带误差带，禁止单点拍脑袋数字。

### 6.1 参数现状表

| 参数 | 现值 | 证据分级 | 标定落点 |
|---|---|---|---|
| 字节因子（TURN） | 1.68；砍 base64 后预期 ≈1.26 | 【实测-外部 v3 tc-cost】，本仓复测中 | Task 5 增补 wire 账 + Task 13 真机复测 |
| 字节因子（隧道） | ≈1.17-1.20；砍 base64 后 desktop 腿 -23% | 【实测-外部】 | 同上 |
| 字节因子（p2p 直连） | 0（不过中继，不计费字节） | 【实测-外部】 | — |
| 会话带宽 | 50-100 kbps/在线 | 【弱证据 n=2】，禁止当结论 | Task 5 起分路径实测积累 |
| 中继率 | 云↔云 0%、家宽无 VPN 0%、蜂窝↔家宽 ≈2/3（联通）-100%（电信多出口 NAT） | 【实测-外部】，N≥20 前不信点估计 | Task 5 增补 pathType 分桶；Wave 2 直连率矩阵 |
| VPS 单价/计费方向 | 部署者自查：方向差 2×【实测-外部】、时长差 3×【推断】= 最大不确定项 | 【未验证-本仓】 | cost-model.md 随账单迭代 |
| 信令成本 | 轮询制 1.25-3.3 QPS/在线 | 【实测-外部+算术】 | 三期 ws 长连（实测 QPS/在线≈0.0099） |

### 6.2 10 万用户部署形态推演（10 万注册 / 10% 并发 = 1 万峰值在线）

每在线用户月中继线字节 = 会话带宽 × 在线时长 × 中继率 × 1.68。

| 情形 | 参数 | 线字节/在线·月 | 总量（1 万在线） | 30Mbps VPS 台数（4.9TB/台） | 月账单区间* | 单位成本 |
|---|---|---|---|---|---|---|
| 中心 | 50kbps × 8h/天 × 中继率 2/3 | ≈6.1 GB | ≈61 TB | ≈13 台 | ¥2k-4k | **¥0.2-0.4/在线·月** |
| 悲观 | 100kbps × 24h/天 × 中继率 100%（蜂窝全塌） | ≈54 GB | ≈544 TB | ≈111 台 | ¥1.7w-3.3w | **¥1.7-3.3/在线·月** |

\* VPS 单价按 ¥150-300/台/月（30Mbps 按带宽计费档）估，**部署者必须按自购账单替换**；
误差带来源：计费方向 2×、在线时长口径 3×、会话带宽弱证据 2×。
带宽峰值校核：中心情形 1万×50kbps×2/3≈333Mbps ≤ 13台×30Mbps=390Mbps（偏紧，u 口径误差带内）；
悲观情形 ≈1Gbps ≤ 111×30=3.3Gbps ✓。
**量化锚（草案）**：单位成本 ≤¥4/在线·月（外部参考 v3 门禁同值）——中心与悲观情形均不破锚；
折算每千注册用户每月成本 ≈ ¥20-40（中心）/ ¥170-330（悲观）。
底线：任何成本优化不得压破 v0.1.0 四指标基线。

### 6.3 信令上限（部署规模天花板）

轮询制 1 万在线 = 1.25-3.3 万 QPS，Supabase 任一公开档位均打不住【实测-外部+算术】。
**二期口径**：单环境部署规模上限 = 所购 Supabase 档位 QPS 上限 ÷ 3.3 QPS/在线（部署者自算）；
10 万用户形态的信令 = 三期必答题（ws 长连，单机万级并发已实测【实测-外部】）。

### 6.4 待 Wave 2 标定清单

单机饱和压测（搬 v3 压测方法论：healthz 采样真值、爬坡 200/s/台、多机多出口）；
蜂窝×家宽×运营商直连率矩阵（N≥20）；NAT 类型 facts；级联顺序成本复审
（隧道 0.933 元/GB vs TURN 1.344 元/GB【实测-外部】，v0.1.0 现状 TURN 先于隧道）；
「暖场通道」relay→direct 后台升级（WebRTC 需自研 upgrade 轮）。
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/status.ts src/tests/status.test.ts docs/cost-model.md
git commit -m "docs+feat(cost): 成本模型文档 + status 暴露数据面字节量（spec D8）"
```

---

### Task 13: 真机蜂窝门禁（Wave 1 全部价值的最终验收：四指标对比 + Go/No-Go）

**Files:**
- Create: `e2e/wave1-realdevice-gate.md`

**Interfaces:**
- Consumes: Task 1-12 全部产物（帧协议 v2 / 通道池 / 账本 / stall 黄灯 / consent 看门狗 / N4 阈值 / gzip 实验 / 成本口径）；基线文档 `e2e/real-service-soak.md`、`e2e/human-live-2026-09-23.md`（v0.1.0 数字：p90=53ms、stall 16 次/587s、15min 回收周期）。
- Produces: Wave 1 Go/No-Go 判定与四指标对比表（进 CHANGELOG 与 0.2.0 发布决策）。

**预注册判定（开跑前固定，不许后改）：**

| 指标 | v0.1.0 基线 | Wave 1 目标 | 判定 |
|---|---|---|---|
| 大 payload 期 1KB 请求排队时延 | 39s（真人实录） | p95 < 5s | 核心 Go 条件 |
| 60min 强制 TURN stall 事件 | 16 次 / 最长 587s | ≤4 次且每次 ≤60s | 核心 Go 条件 |
| 假健康绿点（用户可见谎言） | 存在（stall 587s 绿灯） | 0 次（黄灯如实示警） | 核心 Go 条件 |
| TURN 段建连 10 次成功率 | 33%（v3 both 实录） | ≥70% | 核心 Go 条件 |
| TURN 60min 会话回收周期 | ~15min | 无固定周期回收（consent 看门狗生效） | 观察指标 |
| 中继线字节/应用字节 | 未测 | 对账 1.68±30% | 成本口径 |

- [ ] **Step 1: 本机构建与安装（干净环境验证打包物）**

```bash
npm test                                  # 296+ 全绿（含 Wave 1 新增）
npm run build:pwa
npm pack                                  # rocke1001feller-p2p-net-0.2.0.tgz
npm i -g ./rocke1001feller-p2p-net-0.2.0.tgz
p2p-net version                           # 0.2.0
p2p-net start                             # 本机 host 常驻（P2P_NET_DEBUG=1 另开终端跟日志）
```

- [ ] **Step 2: PWA 部署到 VPS A 类入口 + sha256 对账（Review Focus #1）**

```bash
export VPS_PW='（从用户保管处取，不落盘）'
sshpass -p "$VPS_PW" rsync -az --delete pwa-dist/ ubuntu@49.233.155.13:/opt/p2p-net/pwa/
shasum -a 256 pwa-dist/assets/*.js | sort > /tmp/wave1-gate-local.sha256
sshpass -p "$VPS_PW" ssh ubuntu@49.233.155.13 'cd /opt/p2p-net/pwa && sha256sum assets/*.js | sort' > /tmp/wave1-gate-remote.sha256
diff /tmp/wave1-gate-local.sha256 /tmp/wave1-gate-remote.sha256 && echo "PWA 对账一致"
```

手机端强刷：清站点数据（SW 注销 + CacheStorage 清空）后重新打开入口 URL——**杜绝旧 SW/旧资产污染 Wave 1 验收。**

- [ ] **Step 3: 强制 TURN 60min 浸泡（核心场景）**

手机蜂窝（关 WiFi）开 `?transport=relay` 强制中继；正常使用 devanywhere-ui（Files/Editor/Terminal 全点）；每 5min 采样一次：

```bash
curl -s http://127.0.0.1:19727/status | jq .dataPlane   # host 侧（本机另开终端周期跑）
# 手机 console：__p2pNetDebug()（frames/stall/inflightSw）
```

记录：stall 事件次数与时长（黄灯出现=记一次，恢复=结束）、会话回收（重连）时间点是否呈周期、/status 字节量曲线。

- [ ] **Step 4: 真人实测 20min（大 payload 期排队时延）**

浸泡同一窗口内：发起大文件传输（Files 大目录/大文件下载），传输期间真人连续点轻量操作（目录切换/文件打开），记录主观体感 + `__p2pNetDebug().frames` 的 hung 记录；对照 v0.1.0 的「39s 无响应」实录。

- [ ] **Step 5: 压缩 A/B（执行 Task 10 预注册）**

同一连接窗口：A（host 无 env 重启）→ B（`P2P_NET_GZIP=1 p2p-net start`）→ A（反转）。按 `e2e/compression-ab-prereg.md` 记录两指标，填判定。

- [ ] **Step 6: TURN 段建连 10 次成功率**

手机强制 `?transport=relay` 下 10 次冷启动连接（每次清站点数据重进），记成功/失败与耗时分布；对照基线 33%。

- [ ] **Step 7: 报告与 Go/No-Go**

`e2e/wave1-realdevice-gate.md`：四指标对比表（基线 vs 实测，逐条分级【实测-真机】）+ 压缩 A/B 结论 + Go/No-Go 判定（四条核心条件全过 = Go；任一不过 = 回 systematic-debugging，不许带伤发布）。coturn 侧字节对账（VPS `vnstat` 窗口增量 ÷ host 账本增量）。

**报告必含两条成本门禁数据（2026-09-23 二轮迭代新增，spec 退出门禁 #9）：**

1. **路径占比**：本次真机各会话的 direct/relay/tunnel 归属与占比——数据源 = Task 5 增补的账本字段（`/status` dataPlane 的 `pathType` + events.jsonl `session_end.pathType`），强制 relay 浸泡臂之外须另留一段**自然级联窗口**（不加 `?transport=relay`）采集真实路径分布；这是 D9 容量方程中继率参数的本仓首个实测点（N=1 起步，禁止外推当结论）。
2. **字节因子复测**：VPS `vnstat` 窗口线字节增量 ÷ host 账本同期应用字节增量，对照外部实测 1.68；二进制帧（Task 2/3）落地后预期 ≈1.26（-25%）。tx/rx 分开记（方向差 2×【实测-外部】）。复测值回填 `docs/cost-model.md` §6.1 参数现状表（分级随之从【实测-外部】升级为【实测-本仓】）。

```bash
git add e2e/wave1-realdevice-gate.md docs/cost-model.md
git commit -m "test(e2e): Wave 1 真机蜂窝门禁——四指标对比 + 路径占比/字节因子复测 + Go/No-Go（spec §验收）"
```

---

### Task 14: 收尾——CHANGELOG / ROADMAP 核销 / 0.2.0 版本位（不发布）

**Files:**
- Create: `CHANGELOG.md`
- Modify: `docs/ROADMAP.md:11`（加 Wave 1 完成节）
- Modify: `package.json:3`（version 0.1.0 → 0.2.0）

- [ ] **Step 1: 写 `CHANGELOG.md`**

```markdown
# CHANGELOG

## 0.2.0（Unreleased）—— Wave 1 性能与健康

### 性能
- proxy 4 通道池：req 恒 proxy0 保序，res/ws 按 id/wid 粘滞落最小 bufferedAmount 通道（HOL 门禁：大传输期 1KB 探测排队增量 p95≤50ms）
- 帧协议 v2：res-chunk/ws-msg 二进制出站（省 33% base64 线税 + 双端编解码 CPU），旧端自动回退
- TURN 单 UDP 端口 3478 收敛（析取 coturn 实测：多端口段不增建连率）
- 隧道响应 gzip 流式压缩（实验档 `P2P_NET_GZIP`，双端协商，预注册 A/B 定默认）

### 健康
- ICE consent 看门狗：werift 0.24.4 #69 授权死信兜底（复活上限 5 次，give-up 走会话终态）
- stallSuspect 三条件黄灯：链路自报健康但数据面静默 >5s 即琥珀示警，绿点谎言归零
- N4 活性阈值：LIVENESS 45s→15s（3 拍）+ pc failed 事件 0ms 拆连（旧行为无人触发重连）
- 帧账本 + 字节计量：`/status dataPlane`、`p2p-net status` 流量行、`events.jsonl session_end` 带 bytesUp/Down

### 成本
- `docs/cost-model.md`：relay 线字节因子 1.68、单 VPS 容量账、直连率=利润率、观测口径与红线推演

### 验收
- `e2e/wave1-realdevice-gate.md`：真机蜂窝四指标对比（Task 13 落盘后链接数字）
```

- [ ] **Step 2: ROADMAP.md 加 Wave 1 完成节**

在 `## 二期候选（已登记）`（:11）之前插入：

```markdown
## Wave 1（0.2.0）性能与健康——已完成项核销

> 2026-09-23 立项（spec/plan 见 `docs/superpowers/`），验收见 `e2e/wave1-realdevice-gate.md`。

- [x] 队头阻塞优化（proxy 通道池 + 帧协议 v2 二进制 + TURN 端口收敛）
- [x] 绿点假象治理（stallSuspect 黄灯 + pc failed 0ms 拆连 + N4 阈值收回 15s）
- [x] TURN/NAT 路径回收（ICE consent 看门狗，werift #69 兜底）
- [x] 帧账本 + 字节计量（成本一等指标；`docs/cost-model.md`）
- [x] 隧道响应 gzip 实验（A/B 结论：见 `e2e/wave1-realdevice-gate.md`，定默认后更新此行）
```

- [ ] **Step 3: package.json version 0.1.0 → 0.2.0（不发布）**

`package.json:3` 改 `"version": "0.2.0"`。**不执行 npm publish**——发布决策归用户（Task 13 Go 之后另起发布流程，纪律同 v0.1.0）。

- [ ] **Step 4: 终验 + Commit**

```bash
npm test   # 全量终验全绿
git add CHANGELOG.md docs/ROADMAP.md package.json
git commit -m "chore(release): Wave 1 收尾——0.2.0 版本位（不发布）"
```

---

## 任务依赖与执行顺序

```
Task 1（TURN 收敛，独立）──┐
Task 2（帧协议 v2 host）──→ Task 3（v2 PWA）──→ Task 4（通道池）──→ Task 5（账本）──→ Task 12（成本/status）
                                                          │                │
                                                          ├──→ Task 11（HOL 门禁）
Task 6（stall 黄灯，独立可并行 4/5）──────────────────────┤
Task 7（consent 复现）──→ Task 8（看门狗）────────────────┤
Task 9（N4 阈值，依赖 6/8 语义）──────────────────────────┤
Task 10（gzip 实验，依赖 2/3）────────────────────────────┴──→ Task 13（真机门禁）──→ Task 14（收尾）
```

允许并行的工作流：{1}、{2→3→4→5→12} 主线、{6}、{7→8}、{10} 可在主线推进时并行；9 需在 6/8 后；11 需在 4 后；13 必须最后（全量依赖）；14 在 13 后。

## 计划自审记录（撰写者留痕）

- **Spec 覆盖**：D1（帧协议 v2）→Task 2/3；D2（通道池）→Task 4/11；D3（consent 看门狗 + coturn 取证）→Task 1（取证臂）/7/8；D4（TURN 单 UDP）→Task 1；D5（健康双驱动：帧账本 + stall 黄灯）→Task 5/6；D6（gzip 实验）→Task 10；D7（N4 阈值）→Task 9；D8（成本一等指标）→Task 5/12；退出门禁（spec §5 四指标）→Task 13；收尾→Task 14。无缺口。
- **占位符扫描**：全部代码步骤含完整可写代码；仅两处「执行者以现状为准」声明（bridge.test.ts 的 startHttpServer 返回形态、status.test.ts 的 deps 写法）——均为追加用例时对既有设施签名的合理容差，非占位符。
- **类型一致性**：`SessionLedger`/`makeLedger`/`dataPlaneSnapshot`（Task 5 产、Task 12 消）；`PooledChannel`/`pickLeastBufferedIdx`/`proxyLabelIdx`/`PROXY_POOL_SIZE`（Task 4 产、Task 4/11 消）；`enc?: 'gzip'`（Task 10 产消同任务）；`IceTransportsOwner`（Task 8 产、peer.ts 消）；`LivenessConfig`（Task 9 产、session/shell 消）。已逐一推演。
- **Review Focus 挂钩**：#1 PWA 构建/部署漂移→Task 3 Step 5 与 Task 13 Step 2 的 sha256 对账；#2 非 werift 零副作用→Task 8 测试用例 3；#3/#5 tunnel 与死/卡边界→Task 6 测试与注释；#4 两会话隔离→Task 4/5 测试。
- **2026-09-23 二轮迭代**：spec §2 重写为假设/已实测/避免三级（废除「可直接吸收」）；新增 D9 容量方程（映射：Task 5 增补 pathType/wire 字节进账本 → Task 12 §6 参数现状表与 10 万用户推演 → Task 13 Step 7 路径占比+字节因子复测回填）；开发纪律（独立分支 + squash 合并 + 门禁三件套）入 Global Constraints；修正 cost-model 容量账错误（30Mbps@u50%：2.9TB 线字节→4.9TB 线字节≈2.9TB 应用字节，§5 红线人数 3400→5800 联动修正）。新增类型 `PathType`/`classifyCandidateType`/`classifyVia`/`selectedPairStats`（Task 5 增补产、Task 12/13 消），与既有 `SessionLedger` 字段命名已对齐推演。另：D9 覆盖映射已并入上文 Spec 覆盖链（Task 5 增补→12§6→13 Step7），占位符扫描复检通过（tunnel 归类测试已落实名断言）。
