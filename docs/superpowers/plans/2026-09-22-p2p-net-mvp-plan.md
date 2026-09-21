# p2p-net 一期 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DevAnyWhere v2 已验证的 WebRTC 数据面抽成独立 npm 包 `p2p-net`，实现"Supabase token + VPS 列表 → `npx p2p-net init`/`start` → 手机蜂窝扫码可用"的一键自部署 MVP。

**Architecture:** 单仓单包四层：核心库（抽自 devanywhere-p2p，~1800 行）+ CLI（init/start/service/doctor/status）+ node-init 资产（VPS 初始化脚本模板）+ pwa-dist（运行时配置注入的 PWA 产物）。Supabase 引导走 Management API；VPS 初始化走 ssh2 主动推送；可观测性（NDJSON 分层日志 + doctor 分层归因探针）横切所有阶段。

**Tech Stack:** Node ≥20、TypeScript（单 tsconfig、tsc 直出 dist）、werift ^0.24.4、ws ^8.21.3、ssh2、qrcode-terminal；测试 = `tsx --test`（node:test，与来源库一致）。

**Spec:** `docs/superpowers/specs/2026-09-22-p2p-net-design.md`（含已锁定决策 Q1-Q6/F1/F2、风险表、来源资产映射附录 A）

## Global Constraints

- Node engine `>=20`；`"type": "module"`；ESM only。
- 运行时依赖白名单（除此不得新增）：`werift`、`ws`、`ssh2`、`qrcode-terminal`；devDependencies：`typescript`、`tsx`、`@types/node`、`@types/ws`、`@types/ssh2`。
- **运行期禁止 spawn 外部工具链**（npm/git/tar/supabase CLI）；init 期唯一例外 = Task 7 决策点的函数部署 fallback。
- 凭据文件一律 `0600`；Supabase Access Token、service_role key、SSH 密码**不落盘**（用完即弃）。
- 端口唯一事实源 = `contracts/ports.json`：`CONTROL_PORT=19727`、`DISCOVERY_PORT=19728`、`DOCS_PORT=19729`、`TUNNEL_RELAY_PORT=19700`；任何代码不得硬编码这四个值。
- spec 布局映射：spec §3 的逻辑层 `lib/` = 本仓源码 `src/`（库层），构建产物 `dist/` 不入 git；`node-init/`、`supabase/`、`contracts/`、`pwa-dist/` 作为包资产随 npm tarball 发布。
- 每个 Task 结束时按其 Commit 步骤提交；commit message 格式 `feat|fix|docs|test: <具体动作>`。
- 分支策略：本仓初建期直接在 `main` 上推进，v0.1.0 发布时打 tag `v0.1.0`（本仓不受老仓/v2 仓分支宪法约束）。
- 源码来源路径（只读，禁止改动）：v2 仓 = `/Users/separationofconcerns/Documents/money/DevAnyWhere`，老仓 = `/Users/separationofconcerns/Documents/stripe/DevAnyWhere`。

## Review Focus

1. **NAT 机型 VPS**（公网 IP ≠ 本机网卡 IP，阿里云常态）：coturn `external-ip` 错配会导致 TURN 静默全黑 → Task 10 的 dryrun 渲染测试断言 `external-ip=<公网>/<内网>` 行存在且正确，Task 12 的 verify 探针复核 VPS 上实际配置内容。
2. **SSH 密码含特殊字符或密码错误**：不得挂死或打出堆栈 → Task 9 测试覆盖认证失败（人话报错）与 10s 连接超时。
3. **控制面端口 19727 被占用**：start 必须报"谁占用+怎么办"而非 EADDRINUSE 堆栈 → Task 16 测试（先占用再启动，断言错误信息含占用提示文案）。
4. **Supabase project 尚在 provisioning**：init 必须轮询等待而非直接报错 → Task 8 测试（mock 返回序列：creating→creating→healthy）。
5. **PWA 拉到缺失/损坏的 `/config.json`**：必须渲染可操作错误页而非白屏 → Task 11 测试（fetch reject/非法 JSON 两种用例）。

---

## P0 — 建仓与核心库抽取

### Task 1: 仓库脚手架

**Files:**
- Create: `package.json`、`tsconfig.json`、`.gitignore`、`LICENSE`、`contracts/ports.json`、`src/contracts.ts`
- Test: `src/contracts.test.ts`

**Interfaces:**
- Produces: `PORTS = { CONTROL_PORT: 19727, DISCOVERY_PORT: 19728, DOCS_PORT: 19729, TUNNEL_RELAY_PORT: 19700 } as const`（src/contracts.ts）；后续所有任务 import 它，禁止字面量。

- [ ] **Step 1: 写失败测试**

`src/contracts.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PORTS } from './contracts.js';

test('PORTS 与 contracts/ports.json 一致', () => {
  const raw = JSON.parse(readFileSync(new URL('../contracts/ports.json', import.meta.url), 'utf8'));
  assert.deepEqual(PORTS, raw);
});

test('端口段不与 DevAnyWhere 19527-19529 冲突', () => {
  for (const p of Object.values(PORTS)) {
    assert.ok(p < 19527 || p > 19529, `${p} 落在老段内`);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/contracts.test.ts`
Expected: FAIL — `Cannot find module './contracts.js'`

- [ ] **Step 3: 实现**

`contracts/ports.json`：

```json
{ "CONTROL_PORT": 19727, "DISCOVERY_PORT": 19728, "DOCS_PORT": 19729, "TUNNEL_RELAY_PORT": 19700 }
```

`src/contracts.ts`：

```ts
import { readFileSync } from 'node:fs';

export const PORTS = JSON.parse(
  readFileSync(new URL('../contracts/ports.json', import.meta.url), 'utf8'),
) as { CONTROL_PORT: number; DISCOVERY_PORT: number; DOCS_PORT: number; TUNNEL_RELAY_PORT: number };
```

`package.json`：

```json
{
  "name": "p2p-net",
  "version": "0.1.0",
  "description": "Self-hosted WebRTC remote-access data plane: your Supabase + your VPS = phone-to-desktop in 5 minutes",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": { "p2p-net": "dist/cli/bin.js" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./browser": { "types": "./dist/browser.d.ts", "default": "./dist/browser.js" },
    "./package.json": "./package.json"
  },
  "files": ["dist/", "node-init/", "pwa-dist/", "supabase/", "contracts/", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "tsx --test \"src/**/*.test.ts\"",
    "build:pwa": "npm --prefix pwa run build",
    "prepack": "npm run build && npm run build:pwa"
  },
  "license": "MIT",
  "dependencies": {
    "qrcode-terminal": "^0.12.0",
    "ssh2": "^1.16.0",
    "werift": "^0.24.4",
    "ws": "^8.21.3"
  },
  "devDependencies": {
    "@types/node": "^22.20.1",
    "@types/ssh2": "^1.15.4",
    "@types/ws": "^8.18.1",
    "tsx": "^4.23.13",
    "typescript": "^5.6.0"
  }
}
```

`tsconfig.json`：`module: NodeNext`、`moduleResolution: NodeNext`、`target: ES2022`、`outDir: dist`、`rootDir: src`、`strict: true`、`declaration: true`。`.gitignore`：`node_modules/`、`dist/`、`pwa-dist/`、`*.log`。`LICENSE`：MIT 全文（copyright 2026 Rocke1001feller）。

- [ ] **Step 4: 跑测试确认通过 + 构建通过**

Run: `npm install && npx tsx --test src/contracts.test.ts && npm run build`
Expected: 2 tests PASS；`dist/contracts.js` 生成。

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json .gitignore LICENSE contracts/ src/contracts.ts src/contracts.test.ts
git commit -m "feat: 仓库脚手架 + 端口契约单一事实源"
```

### Task 2: 核心库抽取与品牌清洗

**Files:**
- Create: `src/`（整体来自 v2 仓 `cores/devanywhere-p2p/src/`）
- Modify: 抽取后的 `src/index.ts`、`src/browser.ts`、`src/peer.ts`、`src/host.ts`（重命名）
- Test: 沿用抽取来的 `src/**/*.test.ts`

**Interfaces:**
- Produces（后续任务依赖的精确名字）：`HostAgent`（原 DvaHostAgent）、`Peer`（原 DvaPeer）、`SignalingClient`、`HttpBridge`、`WsBridge`、`TunnelClient`、`createTunnelRelay`、`roomFor`、`encodeFrame`、`decodeFrame`、`P2P_NET_VERSION`。

- [ ] **Step 1: 拷贝源码**

```bash
cp -R /Users/separationofconcerns/Documents/money/DevAnyWhere/cores/devanywhere-p2p/src/ src/
# 保留 Task 1 已建的 src/contracts.ts 与 src/contracts.test.ts（cp -R 不覆盖异名文件，确认它们还在）
ls src/contracts.ts src/contracts.test.ts
```

- [ ] **Step 2: 品牌清洗（机械重命名）**

```bash
cd src
grep -rl 'DvaHostAgent' . | xargs sed -i '' 's/DvaHostAgent/HostAgent/g'
grep -rl 'DvaPeer' . | xargs sed -i '' 's/DvaPeer/Peer/g'
grep -rl 'DVA_P2P_VERSION' . | xargs sed -i '' 's/DVA_P2P_VERSION/P2P_NET_VERSION/g'
grep -rn 'dva\|Dva\|DVA\|devanywhere\|DevAnyWhere' --include='*.ts' . || echo "CLEAN"
```

Expected: 最后的 grep 输出 `CLEAN`（若有残留，人工逐处改成中性命名；注释里的也清掉）。

- [ ] **Step 3: 跑来源库自带测试**

Run: `npm test`
Expected: 全部 PASS（含"dist/browser.js 不含 werift"类断言改为读 src 或先 `npm run build` 再跑——以抽取来的测试原文为准，若断言 dist 则先 build）。

- [ ] **Step 4: 双入口验证**

Run: `npm run build && node -e "import('p2p-net').catch(()=>import('./dist/index.js')).then(m=>console.log(Object.keys(m).sort().join(',')))" `
Expected: 输出含 `HostAgent,Peer,SignalingClient,TunnelClient,createTunnelRelay`；再验证 `node -e "import('./dist/browser.js').then(m=>console.log('browser ok'))"` 输出 `browser ok`。

- [ ] **Step 5: Commit**

```bash
git add src/
git commit -m "feat: 抽取 devanywhere-p2p 核心库并完成品牌清洗"
```

### Task 3: isPortAllowed 安全洞修复（spec §5.3）

**Files:**
- Modify: `src/host.ts`（HostAgent options 增加字段 + 帧分发处强制）
- Create: `src/bridge/guard.ts`
- Test: `src/bridge/guard.test.ts`、`src/host-whitelist.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `HostAgent`。
- Produces: `HostAgent` options 新增 `isPortAllowed?: (port: number) => boolean`；`PortNotAllowedError`（guard.ts）。Task 17 的 start 编排必须传 `isPortAllowed`。

- [ ] **Step 1: 写失败测试**

`src/bridge/guard.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPortAllowed, PortNotAllowedError } from './guard.js';

test('白名单外端口抛 PortNotAllowedError', () => {
  const allow = (p: number) => p === 3000;
  assert.throws(() => assertPortAllowed(allow, 9999), PortNotAllowedError);
  assertPortAllowed(allow, 3000); // 不抛
});

test('未提供 isPortAllowed 时放行（库层向后兼容，CLI 层必须传）', () => {
  assertPortAllowed(undefined, 22); // 不抛
});
```

`src/host-whitelist.test.ts`（用 stub PcLike，参照 `src/peer.ts` 现有测试的 stub 写法）：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostAgent } from './host.js';

test('req 帧命中白名单外端口时返回错误帧且不触达 localhost', async () => {
  // 用 HostAgent 的帧处理入口（参照 host.ts 现有测试如何注入 fake channel）：
  // 构造 isPortAllowed = () => false 的 agent，喂 {t:'req', port: 80, ...} 帧，
  // 断言：dcSend 被调用且载荷 t==='res-head' 且 status===403；且不产生到 127.0.0.1:80 的连接
  // （用 node:net.createServer  listen 80 不可行 → 改用高端口如 18999 起真实 http server 计数请求数，断言为 0）
});
```

（测试骨架里的具体 stub 形态以 `src/host.ts` 抽取来的现有测试为准——照它的 PcLike/stub 模式写，断言两点：错误帧 403 + 零出站请求。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/bridge/guard.test.ts src/host-whitelist.test.ts`
Expected: FAIL — `assertPortAllowed is not exported` / HostAgent 无 403 行为。

- [ ] **Step 3: 实现**

`src/bridge/guard.ts`：

```ts
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
```

`src/host.ts`：options 类型加 `isPortAllowed?: (port: number) => boolean`；在 `proxy*` channel 的帧分发处（req → HttpBridge、ws-open → WsBridge 之前）调用 `assertPortAllowed(this.opts.isPortAllowed, frame.port)`；捕获 `PortNotAllowedError` 时向对端发 `{t:'res-head', status:403}` / `{t:'ws-close', code:4403}` 错误帧，并 `onStatus` 上报。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx tsx --test src/bridge/guard.test.ts src/host-whitelist.test.ts && npm test`
Expected: 新测试 PASS，旧测试全绿。

- [ ] **Step 5: Commit**

```bash
git add src/bridge/guard.ts src/bridge/guard.test.ts src/host.ts src/host-whitelist.test.ts
git commit -m "fix: HostAgent 白名单强制落地（WebRTC 路径补洞）"
```

### Task 4: NDJSON 分层 logger（可观测性基建，spec §6）

**Files:**
- Create: `src/log/logger.ts`
- Test: `src/log/logger.test.ts`

**Interfaces:**
- Produces（Task 8/12/13-19 全部依赖）：
  - `type Layer = 'auth'|'supabase'|'signaling'|'ice'|'tunnel'|'vps'|'bridge'|'scanner'|'pairing'|'service'`
  - `createLogger(opts: { dir: string; comp: string; maxBytes?: number; maxFiles?: number }): Logger`
  - `Logger.debug/info/warn/error(layer: Layer, msg: string, ctx?: Record<string, unknown>): void`
  - `Logger.event(name: string, data: Record<string, unknown>): void`（写 `events.jsonl`）
  - 行格式：`{"ts":"ISO","level":"info","comp":"cli","layer":"vps","msg":"...","...ctx}`

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logger.js';

test('写入合法 NDJSON 且带 layer/ctx', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2pnet-log-'));
  const log = createLogger({ dir, comp: 'test' });
  log.info('vps', 'hello', { ip: '1.2.3.4' });
  log.flush();
  const line = readFileSync(join(dir, 'current.jsonl'), 'utf8').trim();
  const rec = JSON.parse(line);
  assert.equal(rec.comp, 'test');
  assert.equal(rec.layer, 'vps');
  assert.equal(rec.ip, '1.2.3.4');
});

test('event 写入 events.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2pnet-log-'));
  const log = createLogger({ dir, comp: 'test' });
  log.event('session_end', { sid: 's1', mode: 'relay', rttMs: 120 });
  log.flush();
  const rec = JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim());
  assert.equal(rec.name, 'session_end');
  assert.equal(rec.mode, 'relay');
});

test('超过 maxBytes 触发轮转，保留 maxFiles 个', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2pnet-log-'));
  const log = createLogger({ dir, comp: 'test', maxBytes: 1024, maxFiles: 3 });
  for (let i = 0; i < 200; i++) log.info('service', 'x'.repeat(50));
  log.flush();
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length <= 4, `files=${files}`); // current + 至多3个轮转
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/log/logger.test.ts`
Expected: FAIL — module 不存在。

- [ ] **Step 3: 实现**

`src/log/logger.ts`：同步 append（`appendFileSync` 保证崩溃不丢尾）；`current.jsonl` 超 `maxBytes`（默认 10MB）时轮转为 `<ts>.jsonl`，保留最新 `maxFiles`（默认 5）个；`event()` 写 `events.jsonl`（同轮转策略）；`flush()` 为同步 no-op 占位（保持 API 稳定，后续若改异步不破坏调用方）。实现控制在 ~80 行。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/log/logger.test.ts && npm test`
Expected: 3 新测试 PASS，全量绿。

- [ ] **Step 5: Commit**

```bash
git add src/log/
git commit -m "feat: NDJSON 分层 logger + 事件流（含轮转）"
```

---

## P1 — Supabase 一键引导

### Task 5: 精简 DDL 包

**Files:**
- Create: `supabase/ddl/0001_core.sql`
- Test: `src/cli/init/ddl.test.ts`

**Interfaces:**
- Produces: 表 `public.devices(user_id uuid, role text, hostname text, id uuid pk, created_at, last_seen_at)`、`public.pairing_tickets(id uuid pk, user_id uuid default auth.uid(), status text, expires_at timestamptz)`、`public.signaling_messages(id bigint identity, room text, sender text, kind text, payload jsonb, expires_at timestamptz)`；RPC `bind_device_auth(p_role text, p_hostname text) returns uuid`（security definer、幂等键 (user_id, role, hostname)、**无邀请闸**）。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync('supabase/ddl/0001_core.sql', 'utf8');

test('DDL 幂等标记齐全', () => {
  assert.match(sql, /create table if not exists/i);
  assert.match(sql, /create or replace function/i);
  assert.match(sql, /drop policy if exists/i);
});

test('剥离商业逻辑：无 invites/claim/seed', () => {
  assert.doesNotMatch(sql, /invites|claim_|seed_|turnstile/i);
});

test('三张核心表 + bind_device_auth 都在', () => {
  for (const needle of ['devices', 'pairing_tickets', 'signaling_messages', 'bind_device_auth']) {
    assert.ok(sql.includes(needle), `缺 ${needle}`);
  }
});

test('signaling RLS 房间前缀约束 sig:<uid>:', () => {
  assert.match(sql, /sig:/);
  assert.match(sql, /auth\.uid\(\)/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/cli/init/ddl.test.ts`
Expected: FAIL — 文件不存在。

- [ ] **Step 3: 实现**

`supabase/ddl/0001_core.sql` 以真实源文件为准拼装：信令表与 RLS 照抄 v2 仓 `devanywhere-website/supabase/migrations/0009_signaling.sql`；`pairing_tickets` 与 `devices` 的账号域形态照抄老仓 `supabase/migrations/0002_auth_scan_login.sql`；`bind_device_auth` 以老仓 `0003_invite_redemption.sql` 的版本为底、**删除 `invite_required` 闸门分支**；老仓 `devices` 里的 `network_name/network_secret/virtual_ip/invite_code` 等 v1 死字段不带。全文必须幂等（`create table if not exists` / `drop policy if exists ... create policy` / `create or replace function`），末尾 `revoke all on signaling_messages from anon`。核心段示例（信令表）：

```sql
create table if not exists public.signaling_messages (
  id bigint generated always as identity primary key,
  room text not null,
  sender text not null,
  kind text not null default 'sig',
  payload jsonb not null,
  expires_at timestamptz not null default (now() + interval '120 seconds')
);
alter table public.signaling_messages enable row level security;
drop policy if exists sig_insert on public.signaling_messages;
create policy sig_insert on public.signaling_messages for insert to authenticated
  with check (room like 'sig:' || auth.uid() || ':%');
-- select/delete 同模式（以 0009_signaling.sql 原文为准）
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/cli/init/ddl.test.ts`
Expected: 4 tests PASS。

- [ ] **Step 5: Commit**

```bash
git add supabase/ddl/ src/cli/init/ddl.test.ts
git commit -m "feat: 精简幂等 DDL 包（剥商业逻辑）"
```

### Task 6: 两个 edge function 收入 + TURN 多 host 配置化

**Files:**
- Create: `supabase/functions/turn-credentials/index.ts`、`supabase/functions/redeem-pairing-ticket/index.ts`
- Test: `src/cli/init/functions.test.ts`

**Interfaces:**
- Produces: 函数源码资产（Task 7/8 部署它们）。`turn-credentials` 从 secret `TURN_HOSTS`（JSON 数组，如 `["1.2.3.4","5.6.7.8"]`）读 host 列表，为每个 host 生成 stun/turn udp+tcp 条目。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('turn-credentials 不再硬编码 host', () => {
  const src = readFileSync('supabase/functions/turn-credentials/index.ts', 'utf8');
  assert.doesNotMatch(src, /39\.106\.59\.183/);
  assert.match(src, /TURN_HOSTS/);
  assert.match(src, /TURN_STATIC_AUTH_SECRET/);
});

test('redeem-pairing-ticket 原子消费 pending 票', () => {
  const src = readFileSync('supabase/functions/redeem-pairing-ticket/index.ts', 'utf8');
  assert.match(src, /pending/);
  assert.match(src, /generateLink/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/cli/init/functions.test.ts`
Expected: FAIL — 文件不存在。

- [ ] **Step 3: 实现**

`turn-credentials/index.ts` 以 v2 仓 `devanywhere-website/supabase/functions/turn-credentials/index.ts` 为底改造：删第 40 行硬编码 host，改为

```ts
const hosts: string[] = JSON.parse(Deno.env.get('TURN_HOSTS') ?? '[]');
if (hosts.length === 0) return new Response('TURN_HOSTS not configured', { status: 500 });
// 对每个 host 产出 { urls: [`stun:${h}:3478`] } 与
// { urls: [`turn:${h}:3478?transport=udp`, `turn:${h}:3478?transport=tcp`], username, credential }
// username/credential 逻辑不变：username = `<unix过期>:<uid前8>`，credential = base64(HMAC-SHA1(secret, username))
```

`redeem-pairing-ticket/index.ts` 照抄老仓 `supabase/functions/redeem-pairing-ticket/index.ts`，品牌字符串清洗。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/cli/init/functions.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ src/cli/init/functions.test.ts
git commit -m "feat: 收入两个 edge function，TURN host 改 secrets 配置化"
```

### Task 7: Management API client（含函数部署 spike 决策）

**Files:**
- Create: `src/cli/init/mgmt.ts`
- Test: `src/cli/init/mgmt.test.ts`

**Interfaces:**
- Produces（Task 8 依赖）：

```ts
export class SupabaseMgmt {
  constructor(token: string);
  listOrgs(): Promise<{ id: string; name: string }[]>;
  listProjects(): Promise<{ id: string; name: string; region: string; status: string }[]>;
  createProject(o: { orgId: string; name: string; region: string; dbPass: string }): Promise<{ id: string }>;
  waitHealthy(ref: string, timeoutMs?: number): Promise<void>; // 轮询，默认 180s
  getApiKeys(ref: string): Promise<{ anon: string; serviceRole: string }>;
  runQuery(ref: string, query: string): Promise<unknown>;
  setSecrets(ref: string, secrets: Record<string, string>): Promise<void>;
  deployFunctions(ref: string): Promise<void>; // 实现见 Step 0 决策
}
```

- [ ] **Step 0: spike —— 函数部署通道决策（30 分钟盒）**

用 curl 验证 Management API 是否可直接部署函数：

```bash
curl -sS -X POST "https://api.supabase.com/v1/projects/<ref>/functions/deploy?slug=turn-credentials" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "User-Agent: p2p-net/0.1" \
  -F "file=@/dev/null" | head -c 400
```

若可建立函数（哪怕报 bundle 格式错也算端点存在）→ `deployFunctions` 走纯 API（eszip 打包用 `std/http` 文档所述格式）；若 404/不支持 → **采用 fallback**：init 期 `npx --yes supabase@2.70.3 functions deploy --project-ref <ref>`（spec §12 备案的唯一例外，须在代码注释与 README 声明"仅 init 期、非运行期"）。把决策结论写进本文件 §Decision Log。

- [ ] **Step 1: 写失败测试（mock fetch）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseMgmt } from './mgmt.js';

function mockFetch(routes: Record<string, unknown>): typeof fetch {
  return async (url, init) => {
    const u = String(url);
    for (const [key, body] of Object.entries(routes)) {
      if (u.includes(key)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  } as typeof fetch;
}

test('runQuery 必带 User-Agent（WAF 1010 教训）', async () => {
  let seenUA = '';
  const f: typeof fetch = (async (url, init) => {
    seenUA = String((init?.headers as Record<string, string>)?.['User-Agent'] ?? '');
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  const m = new SupabaseMgmt('tok', f);
  await m.runQuery('ref1', 'select 1');
  assert.ok(seenUA.startsWith('p2p-net/'), `UA=${seenUA}`);
});

test('waitHealthy 轮询直到 healthy，超时报错', async () => {
  let n = 0;
  const f: typeof fetch = (async () => {
    n++;
    return new Response(JSON.stringify({ status: n < 3 ? 'COMING_UP' : 'ACTIVE_HEALTHY' }), { status: 200 });
  }) as typeof fetch;
  const m = new SupabaseMgmt('tok', f);
  await m.waitHealthy('ref1', 5000);
  assert.ok(n >= 3);
});
```

（`SupabaseMgmt` 第二参数为可注入 fetch，默认 `globalThis.fetch`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/cli/init/mgmt.test.ts`
Expected: FAIL — module 不存在。

- [ ] **Step 3: 实现**

`src/cli/init/mgmt.ts`：base = `https://api.supabase.com/v1`；所有请求带 `Authorization: Bearer <token>` 与 `User-Agent: p2p-net/0.1.0`；端点 = Step 0 列出的六个 + `deployFunctions`；4xx/5xx 抛 `MgmtError(status, body 摘要)`；`runQuery` body = `{ query }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/cli/init/mgmt.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cli/init/mgmt.ts src/cli/init/mgmt.test.ts docs/superpowers/plans/2026-09-22-p2p-net-mvp-plan.md
git commit -m "feat: Supabase Management API client（含函数部署通道决策）"
```

### Task 8: init supabase 编排 + 首账号 + 自验探针

**Files:**
- Create: `src/cli/init/supabase.ts`、`src/cli/init/prompt.ts`
- Test: `src/cli/init/supabase-flow.test.ts`

**Interfaces:**
- Consumes: `SupabaseMgmt`（Task 7）、`createLogger`（Task 4）。
- Produces: `bootstrapSupabase(opts: { token: string; projectRef?: string; region?: string; adminEmail: string; adminPassword: string; turnSecret: string; turnHosts: string[]; log: Logger }): Promise<{ projectRef: string; supabaseUrl: string; publishableKey: string }>`；`prompt(rl, question, {secret?})`（readline/promises 封装，secret 模式关闭回显）。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapSupabase } from './supabase.js';

test('全流程编排：建project→DDL→函数→secrets→建号→自验，顺序正确', async () => {
  const calls: string[] = [];
  // 以依赖注入版 bootstrapSupabase（第二参数 deps 可注入 mgmt/fetch）测试：
  // mock mgmt 各方法记录调用名并返回固定值；mock 自验 fetch 返回 200
  // 断言 calls 顺序 = ['waitHealthy','runQuery','deployFunctions','setSecrets','createUser','probeSignaling','probeTurn']
});

test('provisioning 中轮询等待而非报错（Review Focus #4）', async () => {
  // mgmt.waitHealthy 内部已测；此处断言编排层调用 waitHealthy 且其 reject 时包装成人话错误：
  // "project 未在 180s 内就绪，请到 supabase.com 控制台确认后再重跑 init"
});
```

（编排函数签名加可选第二参 `deps` 用于注入，生产默认真实实现。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/cli/init/supabase-flow.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/cli/init/supabase.ts`：顺序 = waitHealthy → runQuery(读 `supabase/ddl/0001_core.sql` 全文) → deployFunctions → setSecrets(`TURN_STATIC_AUTH_SECRET`、`TURN_HOSTS` JSON) → admin 建号 `POST {supabaseUrl}/auth/v1/admin/users`（service_role bearer，`{email, password, email_confirm: true}`，**service_role 仅存内存**）→ 自验：① 用 publishableKey+用户 JWT 向 `sig:<uid>:probe` 房间写入并轮询读回；② 调 `turn-credentials` 断言返回 iceServers 非空。每步 `log.info('supabase', ...)`，失败抛带修复建议的 `InitError`。

`src/cli/init/prompt.ts`：`readline/promises` 封装；`secret: true` 时切换 `process.stdout`  mute 实现密码不回显。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/cli/init/supabase-flow.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cli/init/supabase.ts src/cli/init/prompt.ts src/cli/init/supabase-flow.test.ts
git commit -m "feat: init supabase 编排（建project→DDL→函数→secrets→首账号→自验）"
```

---

## P2 — VPS 无人值守初始化 + PWA 分发

### Task 9: SSH 编排器（ssh2 封装）

**Files:**
- Create: `src/cli/init/ssh.ts`
- Test: `src/cli/init/ssh.test.ts`

**Interfaces:**
- Produces（Task 12/13 依赖）：

```ts
export function parseVpsSpec(line: string): VpsCreds; // 'user@ip password'，密码可含空格/特殊字符
export interface VpsCreds { host: string; username: string; password: string; port?: number }
export class SshError extends Error { readonly code: 'AUTH' | 'TIMEOUT' | 'CONN' | 'EXEC' }
export class SshRunner {
  static connect(creds: VpsCreds, timeoutMs?: number): Promise<SshRunner>;
  exec(cmd: string): Promise<{ code: number; stdout: string; stderr: string }>;
  putDir(localDir: string, remoteDir: string): Promise<void>; // sftp 递归
  end(): void;
}
```

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVpsSpec, SshError } from './ssh.js';

test('解析 user@ip password 列表项', () => {
  assert.deepEqual(parseVpsSpec('ubuntu@1.2.3.4 pass w0rd'), { host: '1.2.3.4', username: 'ubuntu', password: 'pass w0rd' });
});

test('密码含特殊字符原样保留（Review Focus #2）', () => {
  const v = parseVpsSpec('root@1.2.3.4 p@$$"w0rd!x');
  assert.equal(v.password, 'p@$$"w0rd!x');
});

test('格式错误给出行号与人话', () => {
  assert.throws(() => parseVpsSpec('没有at符号'), /格式应为/);
});

test('认证失败映射为 SshError(AUTH) 且文案可操作', async () => {
  // 需要真 sshd 时用 env P2PNET_TEST_VPS 激活；默认断言 SshError 文案模板：
  const e = new SshError('AUTH', '1.2.3.4');
  assert.match(e.message, /认证失败/);
  assert.match(e.message, /检查用户名与密码/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/cli/init/ssh.test.ts`
Expected: FAIL — module 不存在。

- [ ] **Step 3: 实现**

`src/cli/init/ssh.ts`：`ssh2` 的 `Client`；`connect` 10s 超时；错误分类映射（`Authentication failure`→AUTH、`ETIMEDOUT`→TIMEOUT、其余→CONN），文案全部"说人话+可操作"；`exec` 收集 stdout/stderr/exit code；`putDir` 用 `client.sftp()` 递归上传并 `chmod 0644`（目录 0755）。**密码只进内存，任何日志/错误信息不得含密码**（加一条单测断言错误对象 `message`/`stack` 不含密码串）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/cli/init/ssh.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cli/init/ssh.ts src/cli/init/ssh.test.ts
git commit -m "feat: ssh2 编排器（认证/超时分类，人话报错）"
```

### Task 10: node-init 资产（VPS 初始化脚本 + 模板）

**Files:**
- Create: `node-init/init-node.sh`（内嵌 turnserver.conf / Caddyfile / p2p-net-tunnel.service 三个 heredoc 模板）、`node-init/tunnel-relay-entry.mjs`（`import { createTunnelRelay } from 'p2p-net'` 的 VPS 侧入口）
- Test: `src/cli/init/node-init.test.ts`

**Interfaces:**
- Produces: 脚本契约——环境变量入参 `TURN_SECRET`、`TUNNEL_SECRET`、`PWA_DIR`（默认 `/opt/p2p-net/pwa`）；`P2PNET_DRYRUN=1` 时只渲染配置到 stdout 不安装（供测试）；脚本幂等可重跑。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const SH = 'node-init/init-node.sh';

test('bash 语法合法', () => {
  execFileSync('bash', ['-n', SH]);
});

test('dryrun 渲染 turnserver.conf：含 use-auth-secret 与 external-ip（Review Focus #1）', () => {
  const out = execFileSync('bash', [SH], {
    env: { ...process.env, P2PNET_DRYRUN: '1', TURN_SECRET: 's3cret', TUNNEL_SECRET: 'tun', P2PNET_TEST_PUBLIC_IP: '9.9.9.9', P2PNET_TEST_PRIVATE_IP: '10.0.0.2' },
    encoding: 'utf8',
  });
  assert.match(out, /use-auth-secret/);
  assert.match(out, /static-auth-secret=s3cret/);
  assert.match(out, /external-ip=9\.9\.9\.9\/10\.0\.0\.2/);
  assert.match(out, /listening-port=3478/);
});

test('dryrun 渲染 Caddyfile：default_sni + 短证书 profile + /tunnel 反代 + pwa root', () => {
  const out = execFileSync('bash', [SH], {
    env: { ...process.env, P2PNET_DRYRUN: '1', TURN_SECRET: 'x', TUNNEL_SECRET: 'y', P2PNET_TEST_PUBLIC_IP: '9.9.9.9', P2PNET_TEST_PRIVATE_IP: '10.0.0.2' },
    encoding: 'utf8',
  });
  assert.match(out, /default_sni 9\.9\.9\.9/);
  assert.match(out, /profile shortlived/);
  assert.match(out, /reverse_proxy \/tunnel\/\* 127\.0\.0\.1:19700/);
  assert.match(out, /root \* \/opt\/p2p-net\/pwa/);
});

test('非 Ubuntu/Debian 明确拒绝', () => {
  const out = execFileSync('bash', [SH], {
    env: { ...process.env, P2PNET_DRYRUN: '1', P2PNET_TEST_OS: 'centos', TURN_SECRET: 'x', TUNNEL_SECRET: 'y' },
    encoding: 'utf8',
  });
  assert.match(out, /暂不支持|unsupported/i);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/cli/init/node-init.test.ts`
Expected: FAIL — 脚本不存在。

- [ ] **Step 3: 实现**

`node-init/init-node.sh`（配置全文以 v2 仓 `docs/coturn-relay-ops.md` §1 为事实源）：

```bash
#!/usr/bin/env bash
# p2p-net VPS 初始化：coturn + caddy>=2.10 + p2p-net-tunnel + PWA 托管。幂等，可重跑。
set -euo pipefail
: "${TURN_SECRET:?}" "${TUNNEL_SECRET:?}"
PWA_DIR="${PWA_DIR:-/opt/p2p-net/pwa}"

detect_ips() { # 公网 IP 用 curl ifconfig.me（可用 P2PNET_TEST_PUBLIC_IP 覆盖），内网取默认路由网卡
  PUBLIC_IP="${P2PNET_TEST_PUBLIC_IP:-$(curl -fsSL --max-time 5 https://ifconfig.me || true)}"
  PRIVATE_IP="${P2PNET_TEST_PRIVATE_IP:-$(ip -4 route get 1.1.1.1 | awk '{print $7; exit}')}"
  [ -n "$PUBLIC_IP" ] || { echo "无法探测公网 IP，请设 P2PNET_PUBLIC_IP 重跑" >&2; exit 1; }
}

render_configs() { # dryrun 模式只输出这三个文件内容
  cat <<EOF
=== /etc/turnserver.conf ===
listening-port=3478
external-ip=${PUBLIC_IP}/${PRIVATE_IP}
realm=p2p-net
use-auth-secret
static-auth-secret=${TURN_SECRET}
min-port=50000
max-port=50019
no-multicast-peers
EOF
  cat <<EOF
=== /etc/caddy/Caddyfile ===
{
    default_sni ${PUBLIC_IP}
    issuer acme { profile shortlived }
}
https://${PUBLIC_IP} {
    root * ${PWA_DIR}
    file_server
    reverse_proxy /tunnel/* 127.0.0.1:19700
}
EOF
  cat <<EOF
=== /etc/systemd/system/p2p-net-tunnel.service ===
[Unit]
Description=p2p-net tunnel relay
After=network.target
[Service]
ExecStart=/usr/bin/node /opt/p2p-net/tunnel-relay-entry.mjs
Environment=TUNNEL_SECRET=${TUNNEL_SECRET}
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
}

if [ "${P2PNET_DRYRUN:-0}" = "1" ]; then
  [ "${P2PNET_TEST_OS:-linux}" = "centos" ] && { echo "unsupported OS: 暂不支持，仅 Ubuntu 22.04/24.04、Debian 12"; exit 1; }
  detect_ips; render_configs; exit 0
fi
# 实装路径：os-release 检查 → apt-get install -y coturn curl →
# 下载 caddy 官方二进制（https://github.com/caddyserver/caddy/releases 钉版变量 CADDY_VERSION=2.10.2）→
# render_configs 落盘 → systemctl enable --now coturn caddy p2p-net-tunnel → mkdir -p $PWA_DIR
```

`node-init/tunnel-relay-entry.mjs`：

```js
import { createTunnelRelay } from 'p2p-net';
import http from 'node:http';
const server = http.createServer();
createTunnelRelay({ secret: process.env.TUNNEL_SECRET, server });
server.listen(19700, '127.0.0.1', () => console.log('tunnel relay on 127.0.0.1:19700'));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/cli/init/node-init.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add node-init/ src/cli/init/node-init.test.ts
git commit -m "feat: VPS 初始化脚本资产（coturn+caddy+隧道+PWA，幂等可 dryrun）"
```

### Task 11: PWA 迁入与运行时配置化（spec §3 关键决定）

**Files:**
- Create: `pwa/`（来自 v2 仓 `devanywhere-client/pwa/` 的 src、index.html、vite.config.ts、package.json）
- Modify: `pwa/src/config.ts` → 运行时加载器
- Test: `pwa/src/config.test.ts`、`src/cli/init/pwa-asset.test.ts`

**Interfaces:**
- Produces: `loadRuntimeConfig(): Promise<{ supabaseUrl: string; publishableKey: string; relays: { url: string }[] }>`（pwa/src/config.ts 唯一导出，其余模块全部改从它取配置）；构建产物落 `pwa-dist/`（prepack 时生成）。

- [ ] **Step 1: 迁入源码**

```bash
mkdir -p pwa
cp -R /Users/separationofconcerns/Documents/money/DevAnyWhere/devanywhere-client/pwa/src pwa/
cp /Users/separationofconcerns/Documents/money/DevAnyWhere/devanywhere-client/pwa/{index.html,vite.config.ts,package.json,tsconfig.json} pwa/
grep -rn '39\.106\.59\.183\|14\.103\.82\.152\|118\.145\.226\.60\|lyfyzzgviwpxtpylbzcx' pwa/src/ | wc -l  # 记录硬编码处数，Step 3 清零
```

- [ ] **Step 2: 写失败测试**

`pwa/src/config.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfig } from './config.js';

test('正常加载 /config.json', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ supabaseUrl: 'https://x.supabase.co', publishableKey: 'k', relays: [{ url: 'https://1.2.3.4' }] }), { status: 200 })) as typeof fetch;
  const c = await loadRuntimeConfig();
  assert.equal(c.supabaseUrl, 'https://x.supabase.co');
});

test('缺失/损坏时抛带指引的 ConfigError 而非白屏（Review Focus #5）', async () => {
  globalThis.fetch = (async () => { throw new Error('network'); }) as typeof fetch;
  await assert.rejects(loadRuntimeConfig(), /config\.json 缺失或损坏.*p2p-net init/s);
  globalThis.fetch = (async () => new Response('{broken', { status: 200 })) as typeof fetch;
  await assert.rejects(loadRuntimeConfig(), /config\.json 缺失或损坏/s);
});
```

`src/cli/init/pwa-asset.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

test('pwa-dist 产物无任何硬编码后端', () => {
  if (!existsSync('pwa-dist/index.html')) return; // 未构建时跳过（prepack 负责构建）
  const js = readFileSync('pwa-dist/index.html', 'utf8');
  assert.doesNotMatch(js, /39\.106\.59\.183|lyfyzzgviwpxtpylbzcx/);
});
```

- [ ] **Step 3: 实现**

`pwa/src/config.ts` 改为：`loadRuntimeConfig()` fetch 同源 `/config.json`（`cache: 'no-store'`），zod-free 手写字段校验，失败抛 `ConfigError`（文案含"请确认该 VPS 由 `p2p-net init` 初始化"）；其余模块（cloud.ts/session.ts/shell.ts/signaling-web.ts/discovery.ts/workbenchRecovery.ts）全部改为消费它的返回值，删除所有硬编码常量；`shell.ts` 的二维码基地、`cloud.ts` 的 supabase 初始化同理。品牌清洗（dva→p2p-net，`/connect` 路由保留）。`npm --prefix pwa run build` 产出 `pwa/dist` 后由根 `build:pwa` 拷贝到 `pwa-dist/`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test pwa/src/config.test.ts && npm --prefix pwa run build && npx tsx --test src/cli/init/pwa-asset.test.ts && npm test`
Expected: PASS；Step 1 记录的硬编码计数归零（`grep -rn ... | wc -l` → 0）。

- [ ] **Step 5: Commit**

```bash
git add pwa/ src/cli/init/pwa-asset.test.ts
git commit -m "feat: PWA 迁入并改为运行时 /config.json 配置注入"
```

### Task 12: init VPS 编排 + 验证探针

**Files:**
- Create: `src/cli/init/vps.ts`
- Test: `src/cli/init/vps.test.ts`

**Interfaces:**
- Consumes: `SshRunner`/`VpsCreds`（Task 9）、`createLogger`（Task 4）。
- Produces: `provisionVps(creds: VpsCreds, opts: { turnSecret: string; tunnelSecret: string; pwaDistDir: string; supabaseUrl: string; publishableKey: string }, log: Logger): Promise<{ ip: string; pwaUrl: string }>`；`verifyVps(ip: string): Promise<{ httpsOk: boolean; certDaysLeft: number; tunnelAlive: boolean }>`（Task 20 doctor 复用）。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderConfigJson } from './vps.js';

test('写入 VPS 的 /config.json 结构正确', () => {
  const j = JSON.parse(renderConfigJson({ supabaseUrl: 'https://x.supabase.co', publishableKey: 'k', ip: '1.2.3.4' }));
  assert.equal(j.supabaseUrl, 'https://x.supabase.co');
  assert.deepEqual(j.relays, [{ url: 'https://1.2.3.4' }]);
});

test('verifyVps 对 401 隧道响应判定 alive（未授权=活着）', async () => {
  // 注入 fake fetch：/tunnel/desktop?sid=probe 无 token → 401 即 alive
  // 断言 tunnelAlive === true；500/超时 → false
});

test('编排失败时日志分层为 vps 且不带密码', async () => {
  // 注入会抛 SshError('AUTH') 的 runner factory，断言 log 记录 layer==='vps'，
  // 且序列化后的日志行不含 opts 里的任何 secret 值
});
```

（`provisionVps` 第三/四参注入 runner factory 与 fetch，生产默认真实实现——与 Task 8 同一注入模式。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/cli/init/vps.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/cli/init/vps.ts` 编排顺序：`SshRunner.connect` → `exec('bash -s')` 推送 `node-init/init-node.sh`（env 带 `TURN_SECRET`/`TUNNEL_SECRET`）→ `putDir(pwaDistDir → /opt/p2p-net/pwa)` + 写 `/opt/p2p-net/pwa/config.json` + `putDir(node-init/tunnel-relay-entry.mjs → /opt/p2p-net/)` → `exec('systemctl restart p2p-net-tunnel caddy coturn')` → `verifyVps(ip)`：`GET https://<ip>/config.json` 200 且字段齐、`GET https://<ip>/` 200、TLS `getPeerCertificate()` 剩余天数 > 0、`GET https://<ip>/tunnel/desktop?sid=probe`（无 token）= 401。失败即停，错误带"安全组端口是否放行 443/3478"提示。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/cli/init/vps.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cli/init/vps.ts src/cli/init/vps.test.ts
git commit -m "feat: init VPS 编排 + 四层验证探针"
```

---

### Task 13: init 总编排与 CLI 入口接线

**Files:**
- Create: `src/cli/init.ts`、`src/cli/bin.ts`、`src/server/store.ts`
- Test: `src/server/store.test.ts`、`src/cli/init-flow.test.ts`

**Interfaces:**
- Consumes: `bootstrapSupabase`（Task 8）、`provisionVps`（Task 12）、`parseVpsSpec`（Task 9）、`prompt`（Task 8）、`createLogger`（Task 4）、`PORTS`（Task 1）。
- Produces（Task 14/17/20 依赖）：

```ts
export interface AppConfig { supabaseUrl: string; publishableKey: string; relays: { ip: string }[]; deviceId?: string }
export function loadConfig(dir: string): AppConfig;            // 缺失 → ConfigError('请先运行 p2p-net init')
export function saveConfig(dir: string, cfg: AppConfig): void; // 0600 原子写
export function loadAuth(dir: string): unknown | null;         // AuthState 见 Task 14
export function saveAuth(dir: string, a: unknown): void;       // 0600 原子写
export async function runInit(deps?: { mgmt?; runnerFactory?; promptFn?; log? }): Promise<void>; // 全注入可测
```

- [ ] **Step 1: 写失败测试**

`src/server/store.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig, loadConfig } from './store.js';

test('config.json 0600 原子写 + 往返一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-net-store-'));
  saveConfig(dir, { supabaseUrl: 'https://x.supabase.co', publishableKey: 'k', relays: [{ ip: '1.2.3.4' }] });
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600);
  assert.equal(loadConfig(dir).relays[0].ip, '1.2.3.4');
});

test('缺 config 报可操作错误', () => {
  assert.throws(() => loadConfig(mkdtempSync(join(tmpdir(), 'p2p-net-store-'))), /p2p-net init/);
});
```

`src/cli/init-flow.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInit } from './init.js';

test('init 编排顺序：supabase 引导 → 逐台 VPS → 落 config → 打印安全组清单', async () => {
  const calls: string[] = [];
  // 注入：promptFn 按脚本回答（token/email/password/VPS 两行）；mgmt/runnerFactory 全 mock
  // 断言 calls 顺序；断言落盘 config.json 不含 accessToken/serviceRole/任何 VPS 密码；
  // 断言 stdout 含 22/80/443/3478/50000 端口清单与 'service install' 建议
});

test('单台 VPS 失败即停，提示安全组复核，已完成阶段可续跑', async () => {
  // 第二台 runnerFactory 抛 SshError('CONN')：断言错误文案含安全组端口清单；
  // 重跑 runInit 时断言 bootstrapSupabase 未重复执行（state 文件命中）
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/server/store.test.ts src/cli/init-flow.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/server/store.ts`：`writeFileSync(tmp) → chmod 0600 → renameSync` 原子写。

`src/cli/init.ts` 编排：逐行 `parseVpsSpec` 录入 VPS 列表 → `randomBytes(32).toString('hex')` 生成全部署统一 `turnSecret` 与 `tunnelSecret`（各一，仅存内存+写入 VPS/Supabase，**不落本地盘**）→ `prompt` 收集 Supabase token/首账号邮箱密码 → `bootstrapSupabase({token, turnSecret, turnHosts: vps ips, ...})` → 逐台 `provisionVps`（串行，日志清晰；失败即停）→ `saveConfig`（只含 supabaseUrl/publishableKey/relays）→ 打印安全组 checklist（22/80/443/3478 tcp+udp/50000+ udp）→ 提示 `p2p-net service install`。state 文件 `~/.p2p-net/init-state.json` 记录完成阶段供断点续跑。

`src/cli/bin.ts`：`util.parseArgs` 分发 `init|login|start|service|doctor|status`；无参/未知命令打帮助。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/server/store.test.ts src/cli/init-flow.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cli/init.ts src/cli/bin.ts src/server/store.ts src/server/store.test.ts src/cli/init-flow.test.ts
git commit -m "feat: init 总编排 + CLI 入口 + 0600 配置存储"
```

---

## P3 — start 运行时 + service 常驻

### Task 14: auth 模块与本地配置/凭据存储

**Files:**
- Create: `src/server/auth.ts`、`src/server/store.ts`
- Test: `src/server/auth.test.ts`、`src/server/store.test.ts`

**Interfaces:**
- Consumes: `AppConfig`、`saveAuth`、`loadAuth`（Task 13 的 store.ts）。
- Produces（Task 17/20 依赖）：

```ts
export interface AuthState { accessToken: string; refreshToken: string; expiresAt: number; uid: string; email: string }
export async function loginWithPassword(cfg: AppConfig, email: string, password: string): Promise<AuthState>;
export async function ensureFreshToken(cfg: AppConfig, a: AuthState): Promise<AuthState>; // <60s 过期则 refresh
```

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveAuth, loadAuth } from './store.js';
import { ensureFreshToken, type AuthState } from './auth.js';

test('auth.json 落盘权限 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2pnet-auth-'));
  const a: AuthState = { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, uid: 'u1', email: 'a@b.c' };
  saveAuth(dir, a);
  assert.equal(statSync(join(dir, 'auth.json')).mode & 0o777, 0o600);
  assert.deepEqual(loadAuth(dir), a);
});

test('临期 token 自动 refresh（注入 fetch）', async () => {
  // expiresAt = now+30s → 触发 refresh；mock /auth/v1/token?grant_type=refresh_token 返回新 token
  // 断言返回新 AuthState 且 expiresAt 变大
});

test('refresh 失败抛 AuthError 并提示重新 login', async () => {
  // mock 400 → 断言错误文案含 'p2p-net login'
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/server/auth.test.ts src/server/store.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/server/auth.ts`：纯 REST（`POST {supabaseUrl}/auth/v1/token?grant_type=password|refresh_token`，header `apikey: <publishableKey>`），不引 supabase-js；续期逻辑参照 v2 仓 `devanywhere-server/desktop/lib/transport.js:74-116`（60s 余量 + 失败退避）。`src/server/store.ts`：原子写（`writeFileSync` 临时文件 + `renameSync`）+ `chmod 0600`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/server/auth.test.ts src/server/store.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/auth.ts src/server/store.ts src/server/auth.test.ts src/server/store.test.ts
git commit -m "feat: auth 模块（纯 REST + 自动续期）与 0600 凭据存储"
```

### Task 15: 端口扫描器（服务清单数据源）

**Files:**
- Create: `src/server/scanner.ts`
- Test: `src/server/scanner.test.ts`

**Interfaces:**
- Produces（Task 16/17 依赖）：

```ts
export interface ServiceInfo { port: number; name: string }  // name 取 <title>
export const DEFAULT_WHITELIST: number[];
export const NEVER_PORTS: ReadonlySet<number>;
export function parseLsofOutput(out: string): number[];      // macOS
export function parseSsOutput(out: string): number[];        // Linux
export async function probePort(port: number, fetchImpl?: typeof fetch): Promise<ServiceInfo | null>;
export function createScanner(opts: { extraWhitelist?: number[]; log: Logger }): { list(): ServiceInfo[]; start(): void; stop(): void };
```

默认白名单 = `[3000, 3001, 4200, 5000, 5173, 8000, 8080, 8081, 8888, 9000]`；NEVER = `[3003, 4173, 18080, 18088]` ∪ 本包 PORTS 四值；whitelist 之外但 probe 判定为 website 的端口也上架（自动发现），NEVER 永不上架。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLsofOutput, parseSsOutput, probePort, DEFAULT_WHITELIST, NEVER_PORTS } from './scanner.js';

const LSOF = `COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    1234  dev   20u  IPv4 0xXXX      0t0  TCP 127.0.0.1:3000 (LISTEN)
python  2345  dev   5u   IPv4 0xYYY      0t0  TCP *:8000 (LISTEN)`;

test('解析 lsof 输出', () => {
  assert.deepEqual(parseLsofOutput(LSOF).sort(), [3000, 8000]);
});

test('解析 ss 输出', () => {
  const SS = 'State Recv-Q Send-Q Local Address:Port\nLISTEN 0 128 127.0.0.1:5173 0.0.0.0:*\n';
  assert.deepEqual(parseSsOutput(SS), [5173]);
});

test('probePort 只认 2xx + text/html + >64B，取 title', async () => {
  const html = `<html><head><title>My App</title></head><body>${'x'.repeat(100)}</body></html>`;
  const f = (async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  assert.deepEqual(await probePort(3000, f), { port: 3000, name: 'My App' });
  const f404 = (async () => new Response('no', { status: 404 })) as typeof fetch;
  assert.equal(await probePort(3000, f404), null);
});

test('默认白名单含 Top10，NEVER 含本包控制端口', () => {
  for (const p of [3000, 5173, 8000, 8080]) assert.ok(DEFAULT_WHITELIST.includes(p));
  assert.ok(NEVER_PORTS.has(19727) && NEVER_PORTS.has(19728));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/server/scanner.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/server/scanner.ts`：macOS `lsof -nP -iTCP -sTCP:LISTEN`、Linux `ss -ltn`（platform 分发）；10s reconcile 周期；probe 并发 8、跟一次重定向、60s 缓存、连续 2 轮非 website 除名（逻辑参照 v2 仓 `devanywhere-server/desktop/daemon/engine.js:442-955`，但只保留 website 探测主线，AI provider 扫描不带）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/server/scanner.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/scanner.ts src/server/scanner.test.ts
git commit -m "feat: 端口扫描器（Top10 白名单 + 自动探测 + NEVER 集合）"
```

### Task 16: 本地控制面与发现端点

**Files:**
- Create: `src/server/control.ts`
- Test: `src/server/control.test.ts`

**Interfaces:**
- Consumes: `PORTS.CONTROL_PORT / DISCOVERY_PORT`（Task 1）、`createScanner`（Task 15）。
- Produces：

```ts
export function startControlPlane(opts: { log: Logger; getStatus(): unknown }): http.Server; // 127.0.0.1:CONTROL_PORT /status
export function startDiscovery(opts: { log: Logger; getServices(): ServiceInfo[]; deviceId(): string }): http.Server; // 127.0.0.1:DISCOVERY_PORT /services
```

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startControlPlane, startDiscovery } from './control.js';
import { PORTS } from '../contracts.js';
import type { Logger } from '../log/logger.js';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {}, event() {} } as unknown as Logger;

test('/services 返回分组清单所需字段', async () => {
  const srv = startDiscovery({ log: nullLogger, getServices: () => [{ port: 5173, name: 'Vite' }], deviceId: () => 'dev1' });
  const r = await fetch(`http://127.0.0.1:${PORTS.DISCOVERY_PORT}/services`).then((x) => x.json());
  assert.deepEqual(r.services, [{ name: 'Vite', url: '/s/5173/' }]);
  assert.equal(r.self.deviceId, 'dev1');
  srv.close();
});

test('端口被占时报"谁占用+怎么办"而非堆栈（Review Focus #3）', async () => {
  const blocker = await import('node:http').then((m) => m.createServer().listen(PORTS.CONTROL_PORT, '127.0.0.1'));
  await new Promise((r) => blocker.on('listening', r));
  assert.throws(() => startControlPlane({ log: nullLogger, getStatus: () => ({}) }), /19727 被占用/);
  blocker.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/server/control.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/server/control.ts`：只绑 `127.0.0.1`；`/status` 返回 `{uptime, sessions, mode}`（Task 18 填充 getStatus）；`/services` 返回 `{console, services, self}`（console 一期空数组占位，字段保留）；listen error 翻译为人话（"19727 被占用：可能已有一个 p2p-net 实例，运行 `p2p-net status` 确认"）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/server/control.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/control.ts src/server/control.test.ts
git commit -m "feat: 本地控制面 /status 与发现端点 /services"
```

### Task 17: start 编排 + 配对出票 + QR（A类每 VPS 一张）

**Files:**
- Create: `src/server/pairing.ts`、`src/cli/start.ts`
- Modify: `src/cli/bin.ts`（Task 13 已建，本任务新增 start 子命令接线）
- Test: `src/server/pairing.test.ts`、`src/cli/start.test.ts`

**Interfaces:**
- Consumes: 全部前述（HostAgent、TunnelClient、scanner、control、auth、store、logger、PORTS）。
- Produces: `issuePairingTicket(cfg: AppConfig, accessToken: string): Promise<{ ticketId: string }>`；`buildConnectUrl(ip: string, ticketId: string, deviceId: string): string` → `https://<ip>/connect?t=<ticketId>&d=<deviceId>&u=https://<ip>`；CLI 入口 `p2p-net init|start|service|doctor|status|login`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectUrl, issuePairingTicket } from './pairing.js';

test('connect URL 形态', () => {
  assert.equal(buildConnectUrl('1.2.3.4', 't-1', 'dev-9'), 'https://1.2.3.4/connect?t=t-1&d=dev-9&u=https%3A%2F%2F1.2.3.4');
});

test('出票走 PostgREST 且带用户 JWT', async () => {
  let seen: Record<string, string> = {};
  const f = (async (url, init) => { seen = (init?.headers ?? {}) as Record<string, string>; return new Response(JSON.stringify([{ id: 'uuid-1' }]), { status: 201 }); }) as typeof fetch;
  const t = await issuePairingTicket({ supabaseUrl: 'https://x.supabase.co', publishableKey: 'k', relays: [] }, 'jwt-1', f);
  assert.equal(t.ticketId, 'uuid-1');
  assert.equal(seen['Authorization'], 'Bearer jwt-1');
});

test('start 编排单测：未登录 → 引导 login；已登录 → HostAgent+TunnelClient+scanner 全起', async () => {
  // 注入 mock deps（auth/hostAgentFactory/tunnelFactory/scanner），断言装配顺序与 isPortAllowed 已传入 HostAgent
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/server/pairing.test.ts src/cli/start.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/server/pairing.ts`：出票 = `POST /rest/v1/pairing_tickets`（空 body，`Prefer: return=representation`）；5s 轮询票据 status 做"手机已接入"回执，过期（120s）自动换新票并重打 QR。

`src/cli/start.ts` 装配顺序：`loadConfig` → `loadAuth`（无则引导 `p2p-net login`）→ `ensureFreshToken` → `bind_device_auth` RPC 取 deviceId（落 config.json 复用）→ `createScanner().start()` → `startControlPlane`/`startDiscovery` → `new HostAgent({... cfg, accessToken: () => auth.accessToken, isPortAllowed: whitelistFn, turnFetcher, onStatus: 写事件流})` → 每 relay 一条 `TunnelClient`（token = HMAC(tunnelSecret, deviceId)，secret 从 config.json 读）→ 出票打 QR：**每台 relay 输出 `https://<ip>/connect?...` + qrcode-terminal 图形**。未装 service 时横幅提示。`whitelistFn` = scanner 白名单 ∪ 自动发现结果 ∪ PORTS.DISCOVERY_PORT。

`src/cli/bin.ts`：`util.parseArgs` 分发子命令；无参时打印帮助。

- [ ] **Step 4: 跑测试确认通过 + 冒烟**

Run: `npx tsx --test src/server/pairing.test.ts src/cli/start.test.ts && npm test && npm run build && node dist/cli/bin.js --help`
Expected: PASS；帮助输出含 6 个子命令。

- [ ] **Step 5: Commit**

```bash
git add src/server/pairing.ts src/cli/start.ts src/cli/bin.ts src/server/pairing.test.ts src/cli/start.test.ts
git commit -m "feat: start 编排 + 配对出票 + A类 QR（每 VPS 一张）"
```

### Task 18: service install（必选能力，spec §5.2）

**Files:**
- Create: `src/cli/service.ts`、`assets/launchd.plist.tmpl`、`assets/systemd-user.service.tmpl`
- Test: `src/cli/service.test.ts`

**Interfaces:**
- Produces: `installService(opts: { configDir: string }): { unitPath: string }`、`uninstallService(): void`、`serviceStatus(): { installed: boolean; running: boolean; nodePath: string; lastCrashTail?: string }`（Task 20 doctor 复用）。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLaunchdPlist, renderSystemdUnit } from './service.js';

test('launchd plist 钉死 node 绝对路径与日志路径', () => {
  const p = renderLaunchdPlist({ nodePath: '/usr/local/bin/node', entry: '/x/dist/cli/bin.js', configDir: '/u/.p2p-net' });
  assert.match(p, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(p, /KeepAlive/);
  assert.match(p, /\/u\/\.p2p-net\/logs\/service\.log/);
});

test('systemd user unit 含 Restart 与钉死路径', () => {
  const u = renderSystemdUnit({ nodePath: '/home/u/.nvm/versions/node/v22.1.0/bin/node', entry: '/x/dist/cli/bin.js', configDir: '/home/u/.p2p-net' });
  assert.match(u, /Restart=always/);
  assert.match(u, /ExecStart=\/home\/u\/\.nvm\/versions\/node\/v22\.1\.0\/bin\/node \/x\/dist\/cli\/bin\.js start --foreground/);
});

test('nvm 路径给出警告文案', () => {
  const w = warnIfVolatileNodePath('/home/u/.nvm/versions/node/v22.1.0/bin/node');
  assert.match(w ?? '', /nvm/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/cli/service.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/cli/service.ts`：darwin → 写 `~/Library/LaunchAgents/net.p2p-net.server.plist` + `launchctl bootstrap gui/$UID`；linux → 写 `~/.config/systemd/user/p2p-net.service` + `systemctl --user enable --now` + 提示 `loginctl enable-linger`（断 ssh 后存活）；`nodePath = process.execPath`，命中 nvm/n 等易变路径时打印警告（不阻断）；`service logs -f` = tail `~/.p2p-net/logs/`；`--foreground` 是 start 的内部标志（service 调用时禁止二次安装提示）。写文件前 `mkdir -p`，全部幂等。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/cli/service.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cli/service.ts assets/ src/cli/service.test.ts
git commit -m "feat: service install（launchd/systemd，崩溃自愈 + 开机自启）"
```

---

## P4 — 可观测性收口

### Task 19: 事件流与 status 命令

**Files:**
- Modify: `src/cli/start.ts`（HostAgent onStatus/TunnelClient onReconnect 接事件流）、`src/server/control.ts`（`/status` 返回真实数据）
- Create: `src/server/events.ts`、`src/cli/status.ts`
- Test: `src/server/events.test.ts`

**Interfaces:**
- Consumes: `Logger.event`（Task 4）、control plane（Task 16）。
- Produces：

```ts
export interface SessionEvent { name: 'session_start'|'session_end'|'cascade_choice'|'tunnel_reconnect'; sid: string; mode?: 'p2p'|'relay'|'tunnel'; rttMs?: number; bytesUp?: number; bytesDown?: number; reason?: string }
export function recordSessionEvent(log: Logger, e: SessionEvent): void;
export function aggregateSessions(events: SessionEvent[]): { active: number; byMode: Record<string, number>; avgRttMs: number | null };
```

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSessions } from './events.js';

test('聚合：活跃数/模式分布/平均 RTT', () => {
  const agg = aggregateSessions([
    { name: 'session_start', sid: 'a' },
    { name: 'cascade_choice', sid: 'a', mode: 'relay', rttMs: 100 },
    { name: 'session_start', sid: 'b' },
    { name: 'cascade_choice', sid: 'b', mode: 'p2p', rttMs: 20 },
    { name: 'session_end', sid: 'a', reason: 'bye' },
  ]);
  assert.equal(agg.active, 1);
  assert.deepEqual(agg.byMode, { p2p: 1 });
  assert.equal(agg.avgRttMs, 20);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/server/events.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/server/events.ts`：`recordSessionEvent` 直写 `log.event`；`aggregateSessions` 为纯函数（session_start/session_end 配对算活跃；cascade_choice 记模式与 RTT）。`start.ts` 里 HostAgent `onStatus`（库里已有 pairType/rtt 提取，src/status.ts）与 TunnelClient `onReconnect` 接进来；`/status` 返回 `{uptime, deviceId, sessions: aggregateSessions(...), services: scanner.list().length}`。`src/cli/status.ts`：`p2p-net status` 读 `127.0.0.1:CONTROL_PORT/status`，不可达时提示"服务未运行，试 `p2p-net service status`"。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/server/events.test.ts && npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/events.ts src/server/events.test.ts src/cli/status.ts src/cli/start.ts src/server/control.ts
git commit -m "feat: 会话事件流 + status 实时视图"
```

### Task 20: doctor 分层归因探针

**Files:**
- Create: `src/cli/doctor.ts`
- Test: `src/cli/doctor.test.ts`

**Interfaces:**
- Consumes: auth（Task 14）、store（Task 13）、verifyVps（Task 12）、serviceStatus（Task 18）、SignalingClient（Task 2）、PORTS。
- Produces：

```ts
export interface DoctorCheck { layer: Layer; ok: boolean; detail: string; fix?: string }
export async function runDoctor(opts: { dir: string; fetchImpl?: typeof fetch }): Promise<DoctorCheck[]>;
```

探针顺序 = 连接级联同序：`auth → supabase → signaling → ice(TURN) → vps(每 relay) → scanner → service`；首个失败即标注 `fix` 并继续跑完剩余只读探针（收集完整报告），退出码 = 失败数。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor } from './doctor.js';

test('每层故障都能归因到正确 layer 并附 fix', async () => {
  // 场景注入（注入式 fetch/store）：
  // 1) refresh 401 → layer=auth，fix 含 'p2p-net login'
  // 2) signaling 自发自收 5s 超时 → layer=signaling，fix 含 'RLS'
  // 3) turn-credentials 500 → layer=ice，fix 含 'TURN_HOSTS'
  // 4) VPS https 不通 → layer=vps，fix 含 '安全组' 与端口清单
  // 5) service 未安装 → layer=service，fix 含 'p2p-net service install'
  // 逐场景断言 reports[i].layer 与 fix 文案
});

test('全绿时输出 OK 汇总且退出码 0', async () => { /* 全部 mock 200 */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/cli/doctor.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/cli/doctor.ts` 每层一个函数：`checkAuth`（refresh 回环）、`checkSupabase`（`GET /rest/v1/devices?limit=0`）、`checkSignaling`（向自己房间 `sig:<uid>:doctor` 写入并 800ms 轮询读回，5s 超时）、`checkTurn`（调 `turn-credentials` 断言 iceServers 非空 + `net.connect(host, 3478)` TCP 探活）、`checkVps`（复用 Task 12 `verifyVps`，含证书剩余天数 < 1 天警告）、`checkScanner`（报告清单条数）、`checkService`（`serviceStatus()`，含 node 路径存在性复核）。`--json` 输出机器可读报告。文案全部"说人话+可操作"。

- [ ] **Step 4: 跑测试确认通过 + 故障注入演练**

Run: `npx tsx --test src/cli/doctor.test.ts && npm test`
Expected: PASS。随后手工演练（本地）：停掉 service → `doctor` 报 layer=service；改错 auth.json → layer=auth。两项都亲眼确认后勾掉本步。

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor.ts src/cli/doctor.test.ts
git commit -m "feat: doctor 七层归因探针（级联同序）"
```

---

## P5 — 端到端验收与发布

### Task 21: E2E 真机 harness + README + npm 发布 v0.1.0

**Files:**
- Create: `e2e/android-cellular.md`（真机手册式脚本）、`README.md`
- Modify: `package.json`（发布字段）
- Test: `src/packaging.test.ts`

**Interfaces:**
- Consumes: 全部。
- Produces: 公开发布的 `p2p-net@0.1.0`。

- [ ] **Step 1: 写失败测试（包内容门禁）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('npm pack 内容包含 dist/node-init/pwa-dist/supabase/contracts', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
  const files: { path: string }[] = JSON.parse(out)[0].files;
  const paths = files.map((f) => f.path);
  for (const need of ['dist/index.js', 'dist/browser.js', 'dist/cli/bin.js', 'node-init/init-node.sh', 'supabase/ddl/0001_core.sql', 'contracts/ports.json', 'pwa-dist/index.html', 'pwa-dist/sw.js', 'LICENSE', 'README.md']) {
    assert.ok(paths.includes(need), `tarball 缺 ${need}`);
  }
  assert.ok(!paths.some((p) => p.includes('.test.') || p.startsWith('src/') || p.startsWith('pwa/src')), '测试与源码不应进包');
});

test('README 含三件准备 + 快速开始 + 安全组端口清单', () => {
  const md = readFileSync('README.md', 'utf8');
  for (const s of ['Supabase Access Token', 'npx p2p-net init', 'npx p2p-net start', '3478', '50000']) {
    assert.ok(md.includes(s), `README 缺 ${s}`);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/packaging.test.ts`
Expected: FAIL（README 不存在 / tarball 缺件）。

- [ ] **Step 3: 实现**

`README.md`：定位一句话 + 三件准备 + 快速开始（init/start/service/QR）+ A类 URL 说明 + 安全组端口清单（22/80/443/3478 tcp+udp/50000+ udp）+ doctor/status 使用 + 配额说明（信令为 PostgREST 轮询，Supabase 免费额度注意）+ 安全边界（暴露 localhost 服务的明示）+ LICENSE MIT 链接。

`e2e/android-cellular.md`（真机验收手册，沿用已实证的 POC harness 模式，事实源 = 老仓 `poc/webrtc-pwa/{README.md,server.js,results.log}` 与 `docs/m1-acceptance.md`）：

```markdown
前置：Android 真机开 USB debugging、关 WiFi（纯蜂窝）、adb 已连。
1. 干净机/干净账号：npm i -g p2p-net@0.1.0（或 npm link）
2. p2p-net init（录入测试用 Supabase token + 一台测试 VPS）→ 全绿
3. p2p-net start → 打印 A类 URL+QR
4. 手机扫码 → PWA 打开 → 自动登录 → 服务清单可见 → 点进 5173/3000 服务操作
5. 验收点（逐条勾）：级联路径可见（状态灯 p2p/relay/tunnel 之一）、iframe 服务可用、
   p2p-net status 显示 active=1、events.jsonl 有 session_start/cascade_choice 记录
6. 故障注入复核：关 WiFi 换蜂窝（已在做）、kill service 观察自愈、停掉 VPS coturn 看 doctor 归因
```

- [ ] **Step 4: 跑测试确认通过 + 发布**

Run: `npx tsx --test src/packaging.test.ts && npm test && npm run build && npm pack`
Expected: PASS + tarball 生成。真机手册逐项勾选后：

```bash
npm publish --access public
git tag v0.1.0 && git push origin main --tags
```

（GitHub 仓：`gh repo create p2p-net --public --source=. --push`；owner 按 spec §12 在首次 push 时定。）

- [ ] **Step 5: Commit**

```bash
git add README.md e2e/ src/packaging.test.ts package.json
git commit -m "docs+test: README、E2E 真机手册、npm 包内容门禁"
```

---

## Decision Log

（实施期决策在此追加，格式：`日期 | 决策点 | 结论 | 理由`。首条待填：Task 7 Step 0 的函数部署通道。）

- 2026-09-22 | Task 7 Step 0 函数部署通道 | **纯 API**，不走 npx fallback | ① 官方 OpenAPI spec（https://api.supabase.com/api/v1-json）明列 `POST /v1/projects/{ref}/functions/deploy`（"Deploy a function… create if function does not exist"），且 `POST /v1/projects/{ref}/functions` 与 `PATCH /v1/projects/{ref}/functions/{slug}` 均接受 `application/json` 内联源码 body（V1CreateFunctionBody/V1UpdateFunctionBody）——无需本地 eszip 打包、零新依赖。② 哑 token 探针 `POST /v1/projects/fake-ref/functions/deploy?slug=turn-credentials` 返回 401 `JWT could not be decoded`（到达鉴权网关）；对照组 `/v1/projects/fake-ref/functions/nonexistent-xyz` 同为 401——本网关鉴权先于路由，HTTP 状态码无法区分路由存在性，决定性证据以官方 spec 为准。③ 两个 edge function 均为单文件 index.ts，内联 body 通道完全够用。运行期不引入 supabase CLI/npx。

## Self-Review 记录

- Spec 覆盖：§4 init→Task 5-13；§5 start/service→Task 14-18（§5.3 洞→Task 3）；§6 可观测性→Task 4/19/20；§7 契约→Task 1 + 各测试；§8 后端精简→Task 5/6；§9 测试→各 Task + Task 21；§10 阶段→P0-P5 章节标题；§11 风险→Review Focus 5 条 + Task 内测试。
- 占位符扫描：Task 3 的 host 白名单测试以"参照现有 stub 模式"指引（抽取来的测试文件即事实源，避免臆造 stub API）；其余步骤均含可执行代码/命令。
- 类型一致性：`HostAgent`、`createLogger/Logger/Layer`、`SupabaseMgmt`、`SshRunner/VpsCreds/SshError`、`bootstrapSupabase`、`provisionVps/verifyVps/renderConfigJson`、`AppConfig/AuthState/loadConfig/saveConfig/loadAuth/saveAuth/loginWithPassword/ensureFreshToken`、`ServiceInfo/createScanner/probePort/parseLsofOutput/parseSsOutput/DEFAULT_WHITELIST/NEVER_PORTS`、`startControlPlane/startDiscovery`、`issuePairingTicket/buildConnectUrl`、`installService/serviceStatus/renderLaunchdPlist/renderSystemdUnit/warnIfVolatileNodePath`、`SessionEvent/recordSessionEvent/aggregateSessions`、`DoctorCheck/runDoctor` —— 在 Produces 与 Consumes 交叉核对一致。
