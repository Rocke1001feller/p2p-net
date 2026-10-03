# PeerToPeer-net 仓库迁移手术实施计划（v0.3.0 重根 + 晋级制就位）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 p2p-net 历史以 v0.3.0 为根重写后迁入新仓库 ai-baymax-dabai/PeerToPeer-net，main 降级为 v0.3.x（11 提交），34 个未验收存量降入 `legacy/pre-discipline` 分支并打好两波晋升分界 tag，为晋级制纪律就位。

**Architecture:** 旧 origin 定格推送 → 全新 clone 中 `git filter-repo` graft 重根 → main 指针降到 v0.3.3、legacy 分支挂存量、commit-map 机械换算出分界 tag → 推入新仓库 → 独立 clone 做主干验证（npm test 全链）。旧工作区仓库（daemon 所在）除一笔定格提交外零改动。

**Tech Stack:** git 2.50.1、git-filter-repo（pip3 --user 安装）、GitHub（web UI 做建仓/改名/分支保护两处人工步）。

**Spec:** `docs/superpowers/specs/2026-10-03-promotion-gate-design.md`（§2 迁移手术即本计划；spec 须与本计划同读）

## Global Constraints

- 旧工作区仓库 `/Users/separationofconcerns/Documents/EnduraBlitz/PeerToPeer-net`（daemon 运行处）：除 Task 1 的定格提交外**零改动**；严禁在其中执行 filter-repo。
- filter-repo 只允许在全新 clone（`~/Documents/EnduraBlitz/p2p-migration/fresh`）内执行。
- 新仓库必须**空初始化**（不勾 README / .gitignore / license），否则首推冲突。
- 对旧 origin（Rocke1001feller/p2p-net）只做 fast-forward push，**永不 force push**。
- 一切数量以 `git rev-list --count` 实数为准；本计划锚定值（2026-10-03 晚）：v0.3.0..v0.3.3 = 11、v0.3.3..origin/main = 17、origin/main..main 定格后 = 17、携带总量 45、legacy 34、新 main 11。
- 锚点 SHA（重写前）：`v0.3.0 = 29be1ff54187e03706c9695a8416e248ceaf165c`、`旧 origin/main = 0dc806ee681f0560913e74bbb259d9b69359307d`、`旧 main 尖 = 70b79654f7c17f6eeea3cf71c4a691a203a40f8b`（Task 1 后 main 尖会 +1，以 manifest 记录为准）。
- 新仓首推后默认分支自动为 main。

## Review Focus

1. **main 残留未验收存量**（降级步骤漏跑）→ 期望 main = v0.3.3、共 11 提交。Task 5 用双计数钉死。
2. **legacy/wave1 分界 tag 打错位置**（手工填 sha 误指到 tip）→ 必须经 commit-map 机械换算旧 origin/main 的重写像；Task 5 用「两侧各 17」对称计数钉死。
3. **filter-repo 误跑在旧工作区**（历史被当场重写）→ Task 3 强制全新 clone，Task 4 执行前打印 `pwd` 断言路径含 `p2p-migration/fresh`。
4. **新仓库被初始化文件污染**（README 导致拒推）→ Task 2 用户步骤写明零初始化；Task 6 push 成功本身即验证。
5. **tag 清单漂移**（该删的 v0.1/v0.2 未删或该留的 5 个丢失）→ Task 4 断言 `git tag -l` 恰为 5 个。

---

### Task 1: 归档前定格（旧仓最后一笔 docs 提交）

**Files:**
- Commit: `.zcodeignore`、`docs/superpowers/specs/2026-10-03-promotion-gate-design.md`、`docs/superpowers/plans/2026-10-03-repo-migration-surgery.md`、`ios-cdp.tmp.mjs`（均为未跟踪新文件）

**Interfaces:** Produces 定格后的旧 main 尖 SHA（Task 2 写入 manifest，Task 3/4 用它校验克隆与换算）。

- [ ] **Step 1: 确认工作区只有预期的 4 个未跟踪文件**

Run: `git -C /Users/separationofconcerns/Documents/EnduraBlitz/PeerToPeer-net status --porcelain=v1`
Expected: 恰好 4 行 `??`，分别为 `.zcodeignore`、`docs/superpowers/specs/2026-10-03-promotion-gate-design.md`、`docs/superpowers/plans/2026-10-03-repo-migration-surgery.md`、`ios-cdp.tmp.mjs`；若出现其他条目，停下向用户报告，不得自行处置。

- [ ] **Step 2: 定格提交**

```bash
cd /Users/separationofconcerns/Documents/EnduraBlitz/PeerToPeer-net
git add .zcodeignore docs/superpowers/specs/2026-10-03-promotion-gate-design.md docs/superpowers/plans/2026-10-03-repo-migration-surgery.md ios-cdp.tmp.mjs
git commit -m "docs: 归档前定格——晋级制 spec/迁移计划 + .zcodeignore + ios-cdp.tmp.mjs 随行存档"
```

- [ ] **Step 3: 验证定格计数**

Run: `git rev-list --count v0.3.0..main && git rev-list --count origin/main..main && git status --porcelain | wc -l`
Expected: `45`、`17`、`0`（任何偏差 → 停下报告）。

### Task 2: 安装 git-filter-repo + 建 manifest + 新仓库就位

**Files:**
- Create: `~/Documents/EnduraBlitz/p2p-migration/manifest.txt`

**Interfaces:** Produces `manifest.txt`（锚点 SHA + 期望计数）；后续任务的换算与校验全部读它。

- [ ] **Step 1: 安装 git-filter-repo（pip3 --user，本机无 Homebrew）**

```bash
pip3 install --user git-filter-repo
export PATH="$HOME/Library/Python/3.9/bin:$PATH"
git filter-repo --version
```
Expected: 打印版本号（如 `2.4x`）。失败则 `python3 -m pip install --user git-filter-repo` 重试。

- [ ] **Step 2: 建迁移工作区与 manifest**

```bash
mkdir -p ~/Documents/EnduraBlitz/p2p-migration
cd /Users/separationofconcerns/Documents/EnduraBlitz/PeerToPeer-net
{
  echo "anchor_v030=$(git rev-parse v0.3.0)"
  echo "anchor_old_origin_main=$(git rev-parse origin/main)"
  echo "anchor_old_main_tip=$(git rev-parse main)"
  echo "expect_total_kept=$(git rev-list --count v0.3.0..main)"
  echo "expect_main_after=$(git rev-list --count v0.3.0..v0.3.3)"
  echo "expect_legacy=$(git rev-list --count v0.3.3..main)"
  echo "expect_wave1_gap=$(git rev-list --count v0.3.3..origin/main)"
  echo "expect_wave2_gap=$(git rev-list --count origin/main..main)"
} > ~/Documents/EnduraBlitz/p2p-migration/manifest.txt
cat ~/Documents/EnduraBlitz/p2p-migration/manifest.txt
```
Expected: `expect_total_kept=45`、`expect_main_after=11`、`expect_legacy=34`、`expect_wave1_gap=17`、`expect_wave2_gap=17`。

- [ ] **Step 3: 核验新仓库存在且为空（gh 自动化，失败回退手动建仓）**

Run: `git ls-remote https://github.com/ai-baymax-dabai/PeerToPeer-net.git 2>&1 | head -5`
Expected: 空输出（仓库存在且无 ref）。
若输出 `Repository not found` → gh 建仓（2026-10-03 用户增补：gh 已打通）：

```bash
/opt/local/bin/gh repo create ai-baymax-dabai/PeerToPeer-net --private
git ls-remote https://github.com/ai-baymax-dabai/PeerToPeer-net.git 2>&1 | head -5
```
Expected: 建仓成功，ls-remote 输出为空。
gh 失败才回退【用户物理步，约 1 分钟】：浏览器 `github.com/organizations/ai-baymax-dabai/repositories/new` → Repository name 填 `PeerToPeer-net` → 选 **Private** → **三个初始化勾选（README/.gitignore/license）全部不勾** → Create repository。

### Task 3: 旧 origin 定格推送 + 全新克隆

**Interfaces:** Consumes manifest 锚点；Produces `~/Documents/EnduraBlitz/p2p-migration/fresh`（重根现场）。

- [ ] **Step 1: 定格推送旧 origin（fast-forward）**

```bash
cd /Users/separationofconcerns/Documents/EnduraBlitz/PeerToPeer-net
git push origin main
```
Expected: `0dc806e..70b7965…`（或 Task 1 后的实际尖）fast-forward，17 个对象组。**禁止 --force。**

- [ ] **Step 2: 全新克隆到迁移工作区**

```bash
git clone https://github.com/Rocke1001feller/p2p-net.git ~/Documents/EnduraBlitz/p2p-migration/fresh
cd ~/Documents/EnduraBlitz/p2p-migration/fresh
```

- [ ] **Step 3: 校验克隆与 manifest 一致**

Run: `git rev-list --count v0.3.0..main && git rev-parse main && grep anchor_old_main_tip ~/Documents/EnduraBlitz/p2p-migration/manifest.txt`
Expected: 计数 = manifest 的 `expect_total_kept`（45）；`rev-parse main` 与 manifest `anchor_old_main_tip` 完全一致。

### Task 4: filter-repo 重根（只在 fresh clone 内）

- [ ] **Step 1: 断言当前目录是迁移现场（防跑错仓）**

```bash
export PATH="$HOME/Library/Python/3.9/bin:$PATH"
cd ~/Documents/EnduraBlitz/p2p-migration/fresh
pwd | grep -q "p2p-migration/fresh" || { echo "FATAL: 不在迁移现场"; exit 1; }
git remote -v
```
Expected: pwd 校验通过；remote origin 指向 Rocke1001feller/p2p-net。

- [ ] **Step 2: graft + 重根**

```bash
git replace --graft $(grep anchor_v030 ~/Documents/EnduraBlitz/p2p-migration/manifest.txt | cut -d= -f2)
git filter-repo --force
```
Expected: filter-repo 报告重写 45 个提交；`origin` remote 被 filter-repo 自动移除（`git remote -v` 为空）。

- [ ] **Step 3: 验证重根结果**

```bash
git cat-file -p v0.3.0 | head -4
git rev-list --count HEAD
git tag -l
git cat-file -t v0.3.3
```
Expected 逐条：① v0.3.0 的 commit 对象**无 parent 行**；② 计数 = 45；③ tag 恰为 5 个：`golden-2026-09-27  v0.3.0  v0.3.1  v0.3.2  v0.3.3`（v0.1.0/v0.2.0/v0.2.1 已随丢弃历史消失）；④ `tag`（annotated tag 对象保留且已重指向）。

- [ ] **Step 4: 从 commit-map 机械换算锚点**

```bash
FRESH=~/Documents/EnduraBlitz/p2p-migration/fresh
M=~/Documents/EnduraBlitz/p2p-migration/manifest.txt
TIP_OLD=$(grep anchor_old_main_tip $M | cut -d= -f2)
W1_OLD=$(grep anchor_old_origin_main $M | cut -d= -f2)
TIP_NEW=$(awk -v o="$TIP_OLD" '$1==o{print $2}' $FRESH/.git/filter-repo/commit-map)
W1_NEW=$(awk -v o="$W1_OLD" '$1==o{print $2}' $FRESH/.git/filter-repo/commit-map)
echo "TIP_NEW=$TIP_NEW" | tee -a $M
echo "W1_NEW=$W1_NEW" | tee -a $M
git -C $FRESH cat-file -t $TIP_NEW && git -C $FRESH cat-file -t $W1_NEW
```
Expected: 两个新 SHA 非空、均解析为 `commit`，且已追加进 manifest。

### Task 5: 降级 main + 立归档分支与分界 tag

**Interfaces:** Consumes `TIP_NEW`/`W1_NEW`；Produces 新仓三条 ref：`main`（11 提交）、`legacy/pre-discipline`（34 提交存量）、tag `legacy/wave1`（晋升分界）。

- [ ] **Step 1: 先立 legacy（此刻 HEAD 还在重写后的旧 main 尖）**

```bash
cd ~/Documents/EnduraBlitz/p2p-migration/fresh
git checkout -b legacy/pre-discipline
```

- [ ] **Step 2: 降级 main 到 v0.3.3 并切回**

```bash
git branch -f main v0.3.3
git checkout main
git tag legacy/wave1 $(grep W1_NEW ~/Documents/EnduraBlitz/p2p-migration/manifest.txt | cut -d= -f2)
```

- [ ] **Step 3: 双计数 + 对称计数验证**

Run: `git rev-list --count v0.3.0..main && git rev-list --count v0.3.3..legacy/pre-discipline && git rev-list --count v0.3.3..legacy/wave1 && git rev-list --count legacy/wave1..legacy/pre-discipline`
Expected: `11`、`34`、`17`、`17`（两侧各 17 = 分界 tag 精确落在旧 origin/main 位置）。

### Task 6: 推入新仓库

- [ ] **Step 1: 挂新 remote 并断言目标**

```bash
cd ~/Documents/EnduraBlitz/p2p-migration/fresh
git remote add neworigin https://github.com/ai-baymax-dabai/PeerToPeer-net.git
git remote get-url neworigin | grep -q "ai-baymax-dabai/PeerToPeer-net" || { echo "FATAL: 目标不对"; exit 1; }
```

- [ ] **Step 2: 三连推（空仓首推）**

```bash
git push neworigin main
git push neworigin legacy/pre-discipline
git push neworigin --tags
```
Expected: 三次全部成功，无 rejected/冲突。

- [ ] **Step 3: 远端 ref 清单验证**

Run: `git ls-remote neworigin | awk '{print $2}' | sort`
Expected: 恰 8 条：`refs/heads/legacy/pre-discipline`、`refs/heads/main`、`refs/tags/golden-2026-09-27`、`refs/tags/legacy/wave1`、`refs/tags/v0.3.0`、`refs/tags/v0.3.1`、`refs/tags/v0.3.2`、`refs/tags/v0.3.3`（annotated tag 的 `^{}` 行不计）。

### Task 7: 新仓主干独立验证（L0 本地冒烟）

- [ ] **Step 1: 独立 clone 新仓并校验主干**

```bash
git clone https://github.com/ai-baymax-dabai/PeerToPeer-net.git ~/Documents/EnduraBlitz/p2p-migration/verify
cd ~/Documents/EnduraBlitz/p2p-migration/verify
git rev-list --count v0.3.0..HEAD
git log --oneline -1
```
Expected: `11`；log 顶 = v0.3.3 的重写像（`release: v0.3.3——v0.3.x 增量包收口` 类似文案，hash 为新值）。

- [ ] **Step 2: L0 全链跑绿**

```bash
N=$(ls -d ~/.nvm/versions/node/v* | sort -V | tail -1)/bin
export PATH="$N:$PATH"
npm ci && npm test
```
Expected: `lint:twins`、`lint:docs`、`test:parallel`、`test:serial`、`test:parity` 全绿退出 0。失败 → 停下取证报告（不得带病继续）。

### Task 8: 用户两步 GitHub 设置 + 收尾

- [ ] **Step 1: 旧仓改名归档（gh 自动化，失败回退手动）**

```bash
/opt/local/bin/gh repo rename p2p-net-archive --repo Rocke1001feller/p2p-net --yes
git ls-remote https://github.com/Rocke1001feller/p2p-net-archive.git HEAD
```
Expected: 改名确认；ls-remote 可达（GitHub 旧名自动重定向，任何时刻做都不破坏 clone）。
gh 失败才回退【用户物理步】：Settings → General → Repository name 改为 `p2p-net-archive`。
随后可选：旧工作区执行 `git remote set-url origin https://github.com/Rocke1001feller/p2p-net-archive.git`，使命名与实指一致。

- [ ] **Step 2: 新仓仅 squash + 分支保护（gh api 自动化，失败回退手动）**

```bash
GH=/opt/local/bin/gh
$GH api -X PATCH repos/ai-baymax-dabai/PeerToPeer-net \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F delete_branch_on_merge=true --silent
$GH api -X PUT repos/ai-baymax-dabai/PeerToPeer-net/branches/main/protection --input - <<'EOF'
{"required_status_checks":null,"enforce_admins":false,"required_pull_request_reviews":{"required_approving_review_count":0,"dismiss_stale_reviews":false},"restrictions":null,"allow_force_pushes":false,"allow_deletions":false,"required_linear_history":false}
EOF
$GH api repos/ai-baymax-dabai/PeerToPeer-net --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'
```
Expected: 命令退出 0；jq 回显 `allow_squash_merge:true, allow_merge_commit:false, allow_rebase_merge:false, delete_branch_on_merge:true`。
参数依据（台账 ruling）：enforce_admins=false + required_approving_review_count=0——单人研发：PR 形状强制、无需他人批准、管理员保留紧急直通。
gh 失败才回退【用户物理步，约 2 分钟】：Settings → General → Pull Requests 仅勾 **Allow squash merging**；Rules → Rulesets（或 Branches → Add rule）：pattern `main`，勾 **Require a pull request before merging**、**Block force pushes**。

- [ ] **Step 3: 收尾清单（agent 自查）**

逐项打勾并输出到对话：① 旧工作区仓库与 daemon 全程未被改动（`git -C 旧仓 rev-parse main` 仍为定格尖）；② manifest.txt 与 fresh clone 保留（commit-map 是 wave-1 晋升的换算资产）；③ verify clone 结果绿；④ 范围界定：spec §2 步骤 6（worktree 车间建立、`ios-cdp.tmp.mjs` 收编为 `e2e/tools/cdp-drive.mjs`、AGENTS.md iPhone 条目修正）**不在本计划**——它们是晋升的载体与内容，随「第一波晋升」计划执行（该计划另写，含 PR + squash + 战役档案 + 分支保护下的门禁首次实战）。
