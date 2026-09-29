# 仓库中途修正实施计划（清洁五层 + 目录整理 + Review 阶段）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以初心 spec 为坐标、v0.3.2/v0.3.3 为里程碑，清除仓库中错误/冗余/矛盾/过时的文档与代码，建立防漂移机制，然后 review v0.3.3..HEAD 的 16 个 P1 commit。

**Architecture:** 分五层清洁（L1 版本真相 → L2 ROADMAP 单源化 → L3 档案定性 → L4 冗余清除 → L5 防退化 CI），每层独立 commit、独立验收；之后接 Review 阶段（产出报告）与目录整理（清散落 + 定语义）。双机真机测试不在本计划内，清洁+review 完成后另行立项。

**Tech Stack:** TypeScript（Node 20+，tsc 直出）、零依赖 Node 脚本（沿用 twin-guard 风格）、Markdown。

**Spec:** `docs/superpowers/specs/2026-09-29-repo-hygiene-design.md`

## Global Constraints

- 每个 Task 结束前 `npm test` 必须全绿（链 = `lint:twins && test:parallel && test:serial && test:parity`）。
- 清洁批次**零行为变更**：不碰 `src/`、`pwa/src/` 的运行逻辑；Task 4 的删改仅限死代码/重复测试/契约死端口及其断言。
- 历史档案（e2e/、docs/superpowers/specs|plans|reports、docs/prototypes/）**正文不改**，只在文件顶部加一行头注；例外仅 spec 2026-09-22 中指向 `docs/ROADMAP.md` 的两处指针（Task 2 Step 4）。
- v0.3.3..HEAD 的 16 个 P1 commit 是 review 对象，任何 Task 不得修改其代码行为。
- 活文档引用代码时用符号名（函数/模块名），禁止 `文件:行号` 形态（漂移之源）。
- commit 信息沿用仓库惯例：`type(scope): 中文描述`。
- spec §5 L1 原文写「补录 v0.2.1」系笔误——CHANGELOG 已有 0.2.1/0.2.0，实际缺口为 **0.3.0 / 0.3.1 / 0.3.2 / 0.3.3 + Unreleased**，以本计划为准。

## Review Focus

1. **CHANGELOG 补录失实**：条目内容必须由 release commit 与战役档案取证，禁止凭印象写——Task 1 Step 2 要求逐条对照 `git show <tag>` 取证。
2. **ROADMAP 合并丢条目**：双轨各有独有条目——Task 2 Step 3 用关键词 grep 对账清单兜底。
3. **删 DOCS_PORT 漏改消费点**：消费点为 `contracts/ports.json`、`src/server/scanner.ts:38`、`src/server/scanner.test.ts:112`、`README.md:58` 四处（lessons.md 与 mvp-plan 为档案，不动）——Task 4b 逐一列出。
4. **删 scripts/spike/ 丢信息**：删除前必须核对 `e2e/wave2-upgrade-wheel-spike-2026-09-26.md` §0 已存档结论且报告不引用 spike 文件本体——Task 4d 设有前置核对步骤。
5. **docs-guard 误报阻塞**：首版检查 3/4 为警告模式（打印不 fail），仅检查 1/2 为硬门禁——Task 5 据此实现。

---

### Task 1: L1 版本真相收口（CHANGELOG 补录 + bin.ts + 死导出 + README）

**Files:**
- Modify: `CHANGELOG.md`（顶部插入新条目）
- Modify: `src/cli/bin.ts:31`（帮助文本）
- Modify: `src/index.ts:9`（删死导出）
- Modify: `README.md:11`（措辞）、`README.md`「配置开关」节（补 gzip 开关）

**Interfaces:**
- Consumes: 无
- Produces: CHANGELOG 最新版本条目 = `0.3.3`（Task 5 的 docs-guard 检查 1 依赖此形态：`## 0.3.3（YYYY-MM-DD）` 标题行）

- [ ] **Step 1: 取证**——逐 tag 核实补录素材：

```bash
git show v0.3.0 --stat --oneline | head -5; git log v0.2.1..v0.3.0 --oneline
git log v0.3.0..v0.3.1 --oneline; git log v0.3.1..v0.3.2 --oneline; git log v0.3.2..v0.3.3 --oneline
git log v0.3.3..HEAD --oneline   # Unreleased 素材（16 个 P1 commit）
```

预期事实锚点：v0.3.0=console-hijack 根治+W2-5 口径收口+W2-7 立项；v0.3.1=package-lock 版本同步+v0.3.x 增量包（实验徽章/隧道计量/粘性回迁/tunnel→p2p 升级，d7cc5e7）+§3.9 档案；v0.3.2=W-A 旁路采纳死亡循环根修（Fix C+B1，aae0747）+§3.10 档案；v0.3.3=版本位对齐+OPS-1 闭环（Caddy 自动续期实证）+W-B① 重连探活（036ffe7）+双机真机验证（b6a0fa3）+v0.4.x 登记。

- [ ] **Step 2: 写 CHANGELOG 条目**——在 `CHANGELOG.md` 第 3 行前（`## 0.2.1` 之上）按新→旧插入 `## Unreleased`、`## 0.3.3（2026-09-27）`、`## 0.3.2（2026-09-26）`、`## 0.3.1（2026-09-26）`、`## 0.3.0（2026-09-26）`（日期以 `git log -1 --format=%cs <tag>` 为准），每条沿用既有中文条目体（标题行 + 破折号主题 + 要点列表 + 档案/报告链接），内容以 Step 1 取证为准。

- [ ] **Step 3: bin.ts 帮助文本**——`src/cli/bin.ts:31` 的 `七层归因诊断（auth→supabase→signaling→ice→vps→scanner→service；` 改为 `八层归因诊断（auth→supabase→signaling→ice→vps→scanner→service→nat；`（与 `src/cli/doctor.ts` 实现及 README.md:75 一致）。

- [ ] **Step 4: 删死导出**——删除 `src/index.ts:9` 整行 `export const P2P_NET_VERSION = '0.1.0';` 及其前的空行。删除前先反查：`Grep "P2P_NET_VERSION"` 应仅剩本行与历史档案（档案不改）。

- [ ] **Step 5: README 两处**——① 第 11 行「（可选）**Cloudflare Pages**：Phase 2 的 PWA 托管通道，MVP 阶段不需要——」中「MVP 阶段不需要」改为「当前版本不需要」；②「配置开关」节在暖场升级轮小节后新增「### 隧道 gzip（默认开）」小节：`P2P_NET_GZIP=0` 紧急关闭开关，双端协商（SW 无 DecompressionStream 不声明、host 绝不压），依据 `src/bridge/http.ts:46`（写成符号引用「`src/bridge/http.ts`」不带行号）与 CHANGELOG 0.2.1 条目。

- [ ] **Step 6: 验证**——`npm run build && npm test` 全绿；`node -e "console.log(require('./package.json').version)"` 与 CHANGELOG 首条标题一致（人工核对）。

- [ ] **Step 7: Commit**

```bash
git add CHANGELOG.md src/cli/bin.ts src/index.ts README.md
git commit -m "docs: 版本真相收口——CHANGELOG 补录 0.3.0-0.3.3+Unreleased、doctor 八层帮助文本、删 P2P_NET_VERSION 死导出、README 补 gzip 开关"
```

### Task 2: L2 ROADMAP 单源化（根 ROADMAP.md 为唯一事实源）

**Files:**
- Rewrite: `ROADMAP.md`（根）
- Delete: `docs/ROADMAP.md`
- Modify: `docs/superpowers/specs/2026-09-22-p2p-net-design.md:6`、`:200`（仅改指向，档案正文其余不动）

**Interfaces:**
- Consumes: 无
- Produces: 单一 ROADMAP；`docs/ROADMAP.md` 不再存在（Task 5 docs-guard 死链检查依赖无残留引用）

- [ ] **Step 1: 重写根 ROADMAP.md**——保留现有头部/一期节/发布 checklist 节，按以下骨架合并（内容来源：根文件 = R，docs 文件 = D，逐条搬运并调和）：

```
# p2p-net ROADMAP
> 唯一事实源声明（2026-09-29 单源化，原 docs/ROADMAP.md 并入本文件后删除；登记/立项规则沿用）
## 一期 v0.1.0（已完成）            ← R 原文保留
## Wave 1（0.2.0）已完成核销        ← D 的 Wave 1 节（含四条 [x] 与链接）
## 二期候选（已登记）
  - R2-1 B类入口 CF Pages           ← D
  - R2-2 Windows 服务化             ← D
  - R2-3 TURN secret 轮换           ← D
  - R2-4 多 Server 聚合 UI          ← D + 回填：主体已由 2026-09-28 P1 多服务工作台交付（多设备侧栏树/启动台），状态改「主体已交付，余打磨」
  - R2-5 统一身份穿透 SSO           ← D 全文（含粗设计）
  - R2-6 Server↔Server 数据面       ← D（观望）
  - 设备生命周期命令 uninstall/version/update   ← R:28（用户确认保留登记）
  - dva-* 多平台安装测试矩阵        ← R:29
  - 网络质量测评 case 库            ← R:21
  - PWA 主屏引导 + 设备卡时间戳修复 ← R:30
## v0.4.x（已登记 2026-09-27）      ← D 的 R4-1..R4-4 + OPS-1，其中：
  - R4-1 回填：候选方向①已实现并双机真机验证（重连先探活再定夺，见 e2e 战役档案 §3.11），残余=方向②状态持久化，优先级不变
  - R4-1 内 `pwa/src/shell.ts:810-818` 行号引用 → 改符号引用「shell.ts 的 afterConnected 探活块」
  - OPS-1 保持「已闭环」全文
## 三期+（远期备忘）
  - 合并 R:35-37 与 D「三期及以后」：CloudCLI 条目改写为「devanywhere-ui（https://github.com/ai-baymax-dabai/devanywhere-ui）等更多服务清单项接入打磨」；10 万用户容量规划条目去掉 `docs/capacity-plan-100k.md` 死链（注明「文档未建档，立项时补」）；托管版/计费、服务市场、移动端 App 三条 ← D
## 发布当日 checklist（一期收尾）   ← R 原文保留（历史记录）
```

调和规则：R:17-20 四项（队头阻塞/绿点假象/TURN 回收/LIVENESS 复评）已在 D 核销——不写回二期，Wave 1 节核销即闭环；R:10 的「p2p-net bench」表述修正为「bench 脚本（scripts/bench/）」。

- [ ] **Step 2: 删除 docs/ROADMAP.md**——`git rm docs/ROADMAP.md`。

- [ ] **Step 3: 对账验证**——以下关键词在新根 ROADMAP.md 中必须各命中 ≥1 次：`R2-1 R2-2 R2-3 R2-4 R2-5 R2-6 R4-1 R4-2 R4-3 R4-4 OPS-1 uninstall 测试矩阵 case 库 devanywhere-ui 主屏 SSO Pages Windows 轮换`（用 Grep 逐一过）。

- [ ] **Step 4: 修指针**——`docs/superpowers/specs/2026-09-22-p2p-net-design.md` 第 6 行与第 200 行的 `docs/ROADMAP.md` 改为 `ROADMAP.md`（仓库根）；全仓 Grep `docs/ROADMAP` 应只剩 plans/ 历史档案内引用（档案不改，可接受——其上下文是历史施工指令）。

- [ ] **Step 5: Commit**

```bash
git add ROADMAP.md docs/superpowers/specs/2026-09-22-p2p-net-design.md
git rm docs/ROADMAP.md   # 若 Step 2 已执行则跳过
git commit -m "docs: ROADMAP 单源化——docs/ROADMAP.md 并入根文件（回填 R4-1/R2-4 已交付态），删除双轨"
```

### Task 3: L3 档案定性标注

**Files:**
- Modify（仅加头注）: `e2e/*.md`（15 份）、`docs/superpowers/specs/*.md`、`docs/superpowers/plans/*.md`、`docs/superpowers/reports/*`、`docs/prototypes/*`（3 件）
- 不加头注（活文档/豁免）: `README.md`、`ROADMAP.md`、`CHANGELOG.md`、`docs/cost-model.md`、`docs/concepts-direct-relay-tunnel.md`、`docs/superpowers/lessons.md`、`scripts/bench/README.md`、`docs/superpowers/specs/2026-09-29-repo-hygiene-design.md`、本计划文件

**Interfaces:**
- Consumes: Task 2 完成（ROADMAP 已单源）
- Produces: 无

- [ ] **Step 1: 标准头注**——对下列集合逐文件在第一行插入（原文整体上移一行，其余字节不动）：

```
> 历史快照（定格日期见文件名/文末）：记录当时状态，不代表当前行为；现状以 README / ROADMAP / CHANGELOG 为准。
```

集合 = Glob `e2e/*.md` + Glob `docs/superpowers/specs/*.md` + Glob `docs/superpowers/plans/*.md` + Glob `docs/superpowers/reports/*` + Glob `docs/prototypes/*`，扣除豁免清单（见上）。reports 下的 `.txt`（cost-deep-dive agent 原始 dump）同样加头注。

- [ ] **Step 2: 两份特殊注**——① `docs/superpowers/specs/2026-09-22-p2p-net-design.md` 头注追加一句：「注：§3 目录布局（lib/→现为 src/ 主导）与 §7 `contracts/frames.md` 引用已与现状脱节，布局以 package.json `files` 字段为准。」② `docs/superpowers/specs/` 与 `plans/` 中 2026-09-28 多服务工作台的 spec/plan 头注追加：「状态回填：已合入 main（0dc806e），未发版；Task 7 真机门禁见 ROADMAP。」

- [ ] **Step 3: 验证**——`git diff --stat` 确认每份档案仅 +1 行（特殊两份 +1 行内多句）；`npm test` 全绿（头注不影响测试，但走流程）。

- [ ] **Step 4: Commit**

```bash
git add e2e docs/superpowers docs/prototypes
git commit -m "docs: 历史档案定性标注——e2e/specs/plans/reports/prototypes 加快照头注，与活文档分层"
```

### Task 4: L4 冗余清除

**Files:**
- Modify: `src/signaling/protocol.test.ts`（并入唯一用例）
- Delete: `src/signaling/tests/protocol.test.ts`（检查 `src/signaling/tests/` 是否因此而空，空则连目录删）
- Modify: `contracts/ports.json`、`src/server/scanner.ts:38`、`src/server/scanner.test.ts:112`、`README.md:58`
- Delete: `supabase/.temp/cli-latest`（git 跟踪中）
- Modify: `.gitignore`
- Delete: `scripts/spike/`（10 件）
- Regenerate: `pwa/package-lock.json`

**Interfaces:**
- Consumes: 无
- Produces: `PORTS` 契约不再含 `DOCS_PORT`（`src/ports.ts` 的 `PortContract = typeof ports` 自动跟随，无需改）；`NEVER_PORTS` 不再含 19729

- [ ] **Step 1（4a）: 合并双份 protocol 测试**——把 `src/signaling/tests/protocol.test.ts` 的独有断言并入 `src/signaling/protocol.test.ts`：`roomFor('uid-1','dev-2')==='sig:uid-1:dev-2'` 精确形状、`parseRoom('sig:onlyone')===null`、`parseRoom('')===null`、`parseRoom('sig:u:a:b')` deviceId 含冒号、`isSigMessage('offer')===false`（字符串输入）。并入后 `git rm -r src/signaling/tests`（先 `ls src/signaling/tests/` 确认无其他文件；有则只删 protocol.test.ts）。跑 `npm run test:parallel` 验证。

- [ ] **Step 2（4b）: 删 DOCS_PORT 死端口**——四处：① `contracts/ports.json` 删 `"DOCS_PORT": 19729, `；② `src/server/scanner.ts:38` 删 `PORTS.DOCS_PORT, `；③ `src/server/scanner.test.ts:112` 数组中删 `19729`（及相应逗号）；④ `README.md:58` 的 `（19700/19727/19728/19729）` 改为 `（19700/19727/19728）`。跑 `npm test` 全绿（contracts.test.ts / constants.test.ts parity 自动跟随）。

- [ ] **Step 3（4c）: 误跟踪文件**——`git rm supabase/.temp/cli-latest`；`.gitignore` 追加一行 `supabase/.temp/`；Grep 确认无代码引用该路径。

- [ ] **Step 4（4d）: 删 spike 工件（前置核对后执行）**——先 Read `e2e/wave2-upgrade-wheel-spike-2026-09-26.md` §0，确认结论已自包含存档、报告正文不引用 `scripts/spike/` 内文件路径作为读者必需材料；再全仓 Grep `scripts/spike` 确认无活文档/代码引用（档案提及可接受）。通过后 `git rm -r scripts/spike/`。

- [ ] **Step 5（4e）: 重生成 pwa 锁文件**——`cd pwa && rm package-lock.json && npm install --package-lock-only && cd ..`；验证新锁文件无 `"p2p-net"` 旧名条目（Grep `"name": "p2p-net"` 应零命中，依赖键 `node_modules/p2p-net` 的 link 条目指向 `..` 属正常）；`npm run build:pwa` 验证构建。

- [ ] **Step 6（4f）: 本地散落物清理（不入 commit）**——`npm view @rocke1001feller/p2p-net versions` 确认 0.1.0/0.2.1/0.3.1/0.3.2/0.3.3 均在 registry（可再生产物），然后删除根目录 5 个 `*.tgz`；Grep 确认 `bench-samples` 未被 e2e/ 档案引用后删除 3 个 `bench-samples-*.jsonl`（若被引用则改为移入 `e2e/` 并在引用处留名——默认预期无引用）。`git status` 应干净。

- [ ] **Step 7: Commit**

```bash
git add src/signaling contracts/ports.json src/server README.md .gitignore pwa/package-lock.json
git commit -m "chore: 冗余清除——protocol 双份测试合并、删契约死端口 DOCS_PORT、.temp 出库、删 spike throwaway 工件、pwa 锁文件重生成"
```

### Task 5: L5 防退化机制（docs-guard）

**Files:**
- Create: `scripts/docs-guard.mjs`
- Modify: `package.json:48-52`（scripts 节）

**Interfaces:**
- Consumes: Task 1 的 CHANGELOG 标题形态（`## x.y.z（date）` 或 `## Unreleased`）、Task 2 的单 ROADMAP
- Produces: `npm run lint:docs` 命令；零依赖脚本，函数导出风格与 `scripts/twin-guard.mjs` 一致（`scanContent`/`collectTargetFiles`/CLI 入口三分）

- [ ] **Step 1: 写 scripts/docs-guard.mjs**——四项检查：

  1. **版本一致（硬门禁）**：`package.json` version 必须等于 CHANGELOG.md 中最新一条非 Unreleased 标题的版本号（正则 `/^## (\d+\.\d+\.\d+)（/m` 取首命中）。
  2. **Markdown 死链（硬门禁）**：扫全部 git 跟踪的 `.md`（`git ls-files '*.md'`），提取 `](相对路径)` 形态链接（排除 `http`、`#`、mailto），相对该 md 所在目录解析后必须存在；目录链接视作存在若目录存在。
  3. **ROADMAP 对账（警告）**：CHANGELOG 每条 release 标题版本号应在 ROADMAP.md 或 git tag 中存在对应——首版仅打印提示，不 fail。
  4. **活文档行号引用（警告）**：`README.md`/`ROADMAP.md`/`CHANGELOG.md`/`docs/cost-model.md`/`docs/concepts-direct-relay-tunnel.md` 中出现 `\w+\.ts:\d+` 形态即打印警告（引导改符号引用），不 fail。

  退出码：硬门禁命中 = 1；仅警告 = 0（警告打印到 stderr）。

- [ ] **Step 2: 接线**——`package.json` scripts 加 `"lint:docs": "node scripts/docs-guard.mjs"`，`test` 改为 `npm run lint:twins && npm run lint:docs && npm run test:parallel && npm run test:serial && npm run test:parity`。

- [ ] **Step 3: 验证正误两向**——① `npm run lint:docs` 在清洁后仓库上退出码 0；② 人工破坏验证：临时把 CHANGELOG 首条版本号改错 → 应 exit 1 → 还原；临时在某 md 加 `[x](./nope.md)` → 应 exit 1 → 还原（验证后 `git checkout -- .` 恢复）。

- [ ] **Step 4: Commit**

```bash
git add scripts/docs-guard.mjs package.json
git commit -m "ci: docs-guard 防漂移断言——版本一致+死链硬门禁，ROADMAP 对账+行号引用警告模式"
```

### Task 6: 目录整理（清散落 + 定语义）

**Files:**
- Modify: `README.md`（加「仓库布局」节）
- Modify: `.gitignore`（Task 4 已加 `supabase/.temp/`，本任务视情补 `.superpowers/`）

**Interfaces:**
- Consumes: Task 4 Step 6（散落物已清）
- Produces: 无

- [ ] **Step 1: README 加「仓库布局」节**——放在「License」节前，按 spec §6.2 的目录语义表写（src/ pwa/ pwa-dist/ contracts/ assets/ node-init/ supabase/ scripts/ e2e/ docs/ 各一行职责说明；标注 pwa-dist/ 为构建产物、dist/ 不入库）。

- [ ] **Step 2: .gitignore 增补**——追加 `.superpowers/`（本机 SDD 档案，当前靠 `.git/info/exclude` 本机排除，团队化需仓级策略）。

- [ ] **Step 3: 验证**——`git status` 干净；`ls` 根目录仅剩标准件 + 规范目录；`npm test` 全绿。

- [ ] **Step 4: Commit**

```bash
git add README.md .gitignore
git commit -m "docs: 仓库布局定语义入 README + .superpowers 入 gitignore（目录整理）"
```

### Phase B: Review v0.3.3..HEAD（清洁完成后执行，非代码任务）

- [ ] **Step 1:** `git log v0.3.3..HEAD -p` 分段精读 16 个 commit；对照 `docs/superpowers/specs/` 与 `plans/` 中 2026-09-28 P1 多服务工作台两份文档逐条核对实现与 spec 的偏差。
- [ ] **Step 2:** 重点核对已自修过的 review 点（C1/C2/C3/I4/I5/I6）是否真正闭环、有无新引入的状态机缝隙（immersive/reconnect/health-check 三条链）。
- [ ] **Step 3:** 产出 review 报告 `docs/superpowers/reports/2026-09-29-p1-workspace-review.md`（ findings 按严重度分级，附文件/符号引用）；发现的问题登记进根 `ROADMAP.md` v0.4.x 节。
- [ ] **Step 4:** Commit：`docs(review): P1 多服务工作台 16-commit 评审报告`。

### 后续（不在本计划）

双机真机全量测试（Android + iPhone，被测服务以 devanywhere-ui 替换 CloudCLI 角色）在 Review 问题闭环后另行立项出计划——需实体设备与用户配合，前置见 spec §8。
