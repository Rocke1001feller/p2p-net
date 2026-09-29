# 仓库中途修正：清洁 + 目录整理 + 双机实测（设计定稿）

- 日期：2026-09-29
- 状态：用户已逐节批准（2026-09-29 会话反馈）
- 作者：Rocke1001feller + Kimi Code（brainstorming 流程产出）
- 坐标：初心 = `docs/superpowers/specs/2026-09-22-p2p-net-design.md`；里程碑 = v0.3.2（W-A 根因根治）、v0.3.3（真机验证稳定点，另有 `golden-2026-09-27`）

---

## 1. 背景与病灶

反复实验（Wave 1/2、W-A/W-B 战役、P1 多服务工作台）留下了系统性的**「多处单点真相」失守**：同一事实在多处各说各话且均已过时。勘察确认代码本体干净（无死模块、无真实 TODO 残留、e2e 数据全部有主、ports.json 与代码一致），问题集中在文档层与少量断带代码。

核心证据（详单见 §5）：

- 版本真相四处失守：package.json=0.3.3 / `src/index.ts:9`='0.1.0'（零消费者）/ CHANGELOG 止于 0.2.0 / `bin.ts:31` 帮助文本写「七层」（实现已八层）；
- ROADMAP 双轨分叉：根 `ROADMAP.md` 与 `docs/ROADMAP.md` 同一批事项状态相反，且各有对方没有的条目；
- 活文档引用行号已漂移（`docs/ROADMAP.md` R4-1 引用 `shell.ts:810-818` 现已是别的代码）；
- 历史档案（spec/e2e/reports）与活文档混放，读者无法分辨「这还作数吗」。

## 2. 用户裁定（本方案的硬约束）

1. **ROADMAP 单源 = 根目录 `ROADMAP.md`**：用 `docs/ROADMAP.md` 的完成态反向更新根文件（勾掉已完成项、迁入二期候选与 v0.4.x 登记），然后**删除 `docs/ROADMAP.md`**。设备生命周期命令（uninstall/version/update 等）确认为规划的一部分，保留登记。
2. **CHANGELOG 按 release tag 逐条精写**（v0.2.1 / v0.3.0 / v0.3.1 / v0.3.2 / v0.3.3 + Unreleased）。
3. **先清洁后 review**：清洁把文档与代码对齐后，再 review v0.3.3..HEAD 的 16 个 P1 commit。
4. 清洁完成后追加：**任务一 目录结构与文件整理**；**任务二 全量双机真机测试（Android + iPhone）**，测试中把 CloudCLI 角色替换为 [devanywhere-ui](https://github.com/ai-baymax-dabai/devanywhere-ui)。

## 3. 范围与非目标

**在范围内**：文档（活文档纠错、档案定性）、断带代码（死导出/重复测试/契约死端口/误跟踪文件）、版本真相链、防退化 CI、目录整理、双机实测。

**非目标（明确不碰）**：

- v0.3.3..HEAD 的 16 个 P1 commit 的行为与逻辑——那是后续 **review 对象**，不是清洁对象；
- e2e/ 战役档案、docs/superpowers/ 历史 spec/plan/report 的**正文内容**——只加头注定性，原文不改（史料价值 = 里程碑证据链）；
- `.superpowers/` 本机档案（未跟踪，属本机状态，不进仓库卫生议题）；
- 任何行为变更——清洁批次的验收线是 `npm test` 全绿且零逻辑 diff。

## 4. 文档分类法（清洁的判据框架）

| 类别 | 判定 | 处理 | 本仓实例 |
|---|---|---|---|
| 活文档 | 仍指导当下行为 | 必须改对；错了就是 bug | README.md、ROADMAP.md（根）、CHANGELOG.md、docs/cost-model.md、docs/concepts-direct-relay-tunnel.md、docs/superpowers/lessons.md、scripts/bench/README.md |
| 历史档案 | 写完即冻结的一次性记录 | 加「历史快照」头注，**正文不改不删** | e2e/ 全部、docs/superpowers/specs+plans+reports、docs/prototypes/ |
| 已取代 | 被后续决策推翻 | 头注标注指向继任者 | （本轮暂无纯此类的文件；spec 2026-09-22 属「历史快照但仍是设计源头」，仅标注布局段脱节） |

**删 vs 标的判据**：还在指导行为→改对；只记录过去→标注冻结；既不指导行为、无史料价值、且结论已被存档吸收→删（仅 `scripts/spike/` 一次性工件与 `reports/…agent_swarm 原始 XML` 命中此类，删除前需二次确认结论已存档）。

## 5. 清洁执行方案（L1→L5，每层独立 commit、独立验收）

### L1 版本真相收口（commit: `docs: 版本真相收口`）

- CHANGELOG.md 按 tag 补录 v0.2.1、v0.3.0、v0.3.1、v0.3.2、v0.3.3 五条 + Unreleased（含 9-28 P1 工作台 16 commit 摘要），素材来自 release commit 与 e2e 战役档案，逐条精写；
- `src/cli/bin.ts:31` 帮助文本「七层」→八层（与 doctor.ts 实现对齐）；
- 删除 `src/index.ts:9` 的 `P2P_NET_VERSION = '0.1.0'` 死导出（零消费者；如需版本号一律读 package.json）；
- README.md:11 「MVP 阶段不需要」措辞更新；README 补 `P2P_NET_GZIP=0` 配置文档（CHANGELOG 与 `src/bridge/http.ts:46` 已有，唯独用户面向文档缺失）。

### L2 ROADMAP 单源化（commit: `docs: ROADMAP 单源化——根目录为唯一事实源`）

- 逐条对账根 ROADMAP.md × docs/ROADMAP.md：
  - 根文件未勾的 4 项（队头阻塞/绿点假象/TURN 回收/LIVENESS 复评）按 docs 侧核销为 Wave 1 已完成；
  - 根文件:10 虚构的「p2p-net bench 命令」表述修正（bench 是 scripts/bench/ 脚本，非 CLI 子命令）；
  - docs 侧独有内容迁入根文件：Wave 1 核销段、二期 R2-1..R2-6（含 SSO 粗设计）、v0.4.x R4-1..R4-4、OPS-1（已闭环）、三期备忘；
  - 回填两项已交付：R4-1 候选方向①已实现（commit 036ffe7，真机验证 b6a0fa3）、R2-4 多 Server 聚合 UI 已由 9-28 P1 工作台交付主体；
  - 根文件独有的有效条目保留：设备生命周期命令（uninstall/version/update）、dva-* 测试矩阵、网络质量 case 库、PWA 主屏引导；
  - `docs/capacity-plan-100k.md` 悬空引用：条目保留但去掉死链（或注明「文档未建档」）；
  - **行号引用改符号引用**（如 `shell.ts:810-818` → 函数名），防再漂移；
- 删除 `docs/ROADMAP.md`，docs/ 内指向它的引用（spec 2026-09-22 §13 等）改指根 ROADMAP.md。

### L3 档案定性标注（commit: `docs: 历史档案定性标注`）

- docs/superpowers/specs、plans、reports 与 e2e/ 各 md 顶部加一行头注：`> 历史快照（YYYY-MM-DD 定格）：记录当时状态，不代表当前行为；现状以 README/ROADMAP/CHANGELOG 为准。`；
- spec 2026-09-22 头注额外注明：§3 目录布局（lib/→src/）与 §7 `contracts/frames.md` 引用已与现状脱节，布局以 package.json `files` 为准；
- docs/prototypes/ 三件套标注为产品原型档案（product-model-v1.md 含 9-28 裁决，标「半活：结论已入 P1 spec」）。

### L4 冗余清除（commit: `chore: 冗余清除`）

- 合并 `src/signaling/protocol.test.ts` 与 `src/signaling/tests/protocol.test.ts` 双份测试为单文件（保留新用例，去重 roomFor/parseRoom）；
- `contracts/ports.json` 删除 DOCS_PORT=19729 死端口（仅被 scanner NEVER 集合引用，无服务监听）；同步清理 scanner 引用与 parity 断言；
- `git rm --cached supabase/.temp/cli-latest`（实际删除该被跟踪文件）+ `.temp/` 入 .gitignore；
- 删除 `scripts/spike/` 全套一次性工件（10 件）——前提：结论已存档于 `e2e/wave2-upgrade-wheel-spike-2026-09-26.md` §0（已确认登记为 throwaway）；删除前再核对一遍报告引用；
- 重生成 `pwa/package-lock.json`（消除旧名 `p2p-net@0.1.0` 条目）；
- 工作树散落物（不入 git，本地处理）：5 个 `*.tgz` 与 3 个 `bench-samples-*.jsonl` 移入本机归档目录或删除（可由 `npm pack` 再生，npm registry 已有正式包）。

### L5 防退化机制（commit: `ci: 文档防漂移断言`）

- 新增 `scripts/docs-guard.mjs`，挂入 `npm test` 链（沿用 lint:twins 先例）：
  1. 版本一致性：package.json.version == CHANGELOG 最新条目 == git 最新 tag 前缀；
  2. Markdown 死链检查：仓内相对链接必须存在（档案区内对历史外仓路径豁免）；
  3. ROADMAP 对账：CHANGELOG 每个 release 的关键条目在 ROADMAP 有勾选或登记（宽松断言，先警告模式）；
  4. 活文档禁引行号：README/ROADMAP/CHANGELOG 中 `*.ts:\d+` 形态的引用报警（引导用符号引用）。

## 6. 任务一：目录结构与文件整理（清洁完成后）

现状结论：git 跟踪的根目录文件已是标准集（8 件），**乱象 = 未跟踪产物 + 部分目录语义不清**。方案：

1. 清理未跟踪散落物（见 L4 末条）；
2. 目录语义在 README 加「仓库布局」一节固化：`src/`（库+CLI 源码）、`pwa/`（PWA 源）/`pwa-dist/`（构建产物，gitignore）、`contracts/`（契约单一事实源）、`assets/`（service 模板）、`node-init/`（VPS 资产）、`supabase/`（DDL+functions）、`scripts/`（工具脚本，bench/ 在册）、`e2e/`（真机战役档案）、`docs/`（长期文档 + superpowers 档案）；
3. 不做大规模目录搬家（e2e/、scripts/ 命名已约定俗成且被大量档案引用，移动会破坏史料链接）——**整理 = 清散落 + 定语义，不是重排**。

## 7. Review 阶段（清洁之后、目录整理之前）

- 对象：`git log v0.3.3..HEAD` 的 16 个 commit（P1 多服务工作台：产品模型、侧栏树、启动台、review C1-C3/I4-I6 修复）；
- 基线：清洁后的活文档（README/ROADMAP/CHANGELOG）+ P1 spec/plan（docs/superpowers/ 9-28 两份）；
- 产出：review 报告入 `docs/superpowers/reports/`，发现的问题立项登记进根 ROADMAP.md。

## 8. 任务二：全量双机真机测试（Android + iPhone）

- **被测服务替换**：代码中 CloudCLI 仅 3 处（根 ROADMAP 条目、历史报告、`pwa/src/serviceSnapshot.test.ts` 夹具）——夹具改名 devanywhere-ui；运营动作为：Server 机上 clone 并运行 `github.com/ai-baymax-dabai/devanywhere-ui`，使其出现在服务清单并作为双机实测的主要访问对象；
- **范围**：P1 多服务工作台全量（设备页启动台、侧栏树、hide/unhide、默认服务链、重连探活、stopSession 状态机、多设备分组渲染）+ 既有级联回归（p2p/tunnel/TURN）；
- **通道**：Android 沿用已实证 harness（adb reverse + CDP + autotest）；iPhone 走 Safari（手动 + 既有 ice-restart 探针经验），无 adb 等价物，需用户配合操作；
- **前置**：清洁 L1-L5 完成、Review 发现的高危项已修、目录整理完成；
- **产出**：战役档案入 `e2e/`，结论回填 ROADMAP。

## 9. 验收标准

- 每层清洁后 `npm test` 全绿、零行为 diff（L4 的测试合并除外，测试总数只增不减或等价合并）；
- 清洁完成后：版本真相单源、ROADMAP 单文件、零悬空引用（docs-guard 绿）、档案全部有头注；
- 全部完成后：根目录 `git status` 干净且无散落物；双机实测档案入档。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| ROADMAP 合并丢条目 | 逐条对账清单进 commit message；git 历史兜底 |
| 删 spike 工件丢信息 | 删除前核对 spike 报告 §0 引用闭环；报告中结论优先于原始工件 |
| pwa 锁文件重生成漂移 | 重生成后 `npm --prefix pwa run build` 验证 |
| docs-guard 误报阻塞开发 | 首版宽松（警告不 fail），稳定后再收紧 |
| 清洁与后续 review 交织 | 严格分批 commit；清洁批次零行为变更，review 发现另行立项 |
