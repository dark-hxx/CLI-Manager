# CLI-Manager 项目迁移计划：WSL → Windows

> 生成时间：2026-08-17
> 状态：待执行
> 目标：将项目主开发环境从 WSL 迁移到 Windows，以后用 Windows Codex CLI 开发

---

## 1. 背景与目标

### 现状
- 代码主仓库位于 WSL：`\\wsl.localhost\Ubuntu-24.04\mnt\demo\CLI-Manager`
- 当前分支：`fix/opencode-session-resume-clipboard`（V1.3.7 修复分支，有未提交修改）
- 已在 Windows 构建过安装包（通过 robocopy 拷贝到 `D:\Program\soft\code\CLI-Manager-src`）

### 用户目标
- **彻底迁移到 Windows 目录**开发
- **以后使用 Windows 上的 Codex CLI** 进行日常开发
- 不再依赖 WSL 环境

### 关键有利条件
Windows 构建副本（`D:\Program\soft\code\CLI-Manager-src`）**已经是 WSL 仓库的完全等价克隆**：
- ✅ git 历史完整（含 `.git` 目录，远程配置、user.name/email 都继承）
- ✅ 13 个已修改文件 + 8 个 untracked 新文件全部到位
- ✅ 与 WSL 文件 Hash 完全一致（已验证）
- ✅ Windows 版 `node_modules` 已装好（772 packages）
- ✅ `src-tauri/target` 构建缓存已有（5GB，Release 已构建过）
- ✅ 已验证可构建出 V1.3.7 安装包

---

## 2. 方案选择

| 方案 | 描述 | 评价 |
|---|---|---|
| **A. Windows 副本直接转正** | 在现有 Windows 副本上配置远程→commit→push，直接成为主仓库 | ✅ **推荐** |
| B. 先 push WSL，再 Windows clone | 损失已装好的依赖和构建缓存 | ❌ 浪费 |
| C. 保持双环境 | 不再符合用户"彻底迁移"意图 | ❌ 排除 |

**采用方案 A。**

---

## 3. 迁移步骤明细

### 步骤 1：配置 git（Windows 副本已有远程，验证即可）

```powershell
cd D:\Program\soft\code\CLI-Manager-src
git remote -v
# 预期:
#   origin    https://github.com/unixcs/CLI-Manager.git
#   upstream  https://github.com/dark-hxx/CLI-Manager.git
```

> Windows 副本的 `.git` 是从 WSL 直接复制的，远程配置已存在，无需再添加。

### 步骤 2：审查未提交内容

```powershell
git status --short --branch
# 预期看到:
#   M  CHANGELOG.md / README.md / README.zh-CN.md / docs/功能清单.md
#   M  package.json / package-lock.json
#   M  src-tauri/Cargo.toml / Cargo.lock / tauri.conf.json
#   M  src-tauri/src/commands/opencode_hook.rs
#   M  src/components/XTermTerminal.tsx
#   M  src/lib/historyResumeCommand.ts
#   M  src/terminal/browser/TerminalCliContext.ts
#   ?? .trellis/tasks/08-16-fix-opencode-session-resume-clipboard/
#   ?? .trellis/workspace/fengx/
#   ?? README-TRANSFER.md
#   ?? docs/开发环境与构建流程.md
#   ?? scripts/{historyResumeCommand,openCodeTuiClipboard,opencodeHook}.test.mjs
#   ?? src-tauri/resources/opencode/
#   ?? src/terminal/browser/OpenCodeTuiClipboard.ts
```

### 步骤 3：commit 全部修改

```powershell
git add .
git commit -m "fix: resolve OpenCode session ID, history resume, and TUI clipboard"
```

### 步骤 4：push 到 fork

```powershell
git push origin fix/opencode-session-resume-clipboard
```

### 步骤 5：更新 CHANGELOG 所需的交接文档

确保 `README-TRANSFER.md` 的交接信息中补充"已迁移到 Windows"。

### 步骤 6：验证构建完整性

```powershell
node --test scripts/*.test.mjs   # 前端已有 test
npx tsc --noEmit                 # 类型检查
npm run tauri build              # 构建安装包（如需要）
```

### 步骤 7：清理 WSL 仓库（可选，确认后执行）

```bash
# 在用户确认代码已安全迁移后，WSL 仓库可删除
sudo rm -rf /mnt/demo/CLI-Manager
```

---

## 4. 迁移后开发工作流（Windows Codex CLI）

```powershell
cd D:\Program\soft\code\CLI-Manager-src

# 1. 检查分支状态
git status --short --branch

# 2. 使用 Codex CLI 修改代码 / 运行测试
# Codex 在交互中直接执行

# 3. 前端测试
node --test scripts/*.test.mjs

# 4. 类型检查
npx tsc --noEmit

# 5. Rust 检查
cd src-tauri && cargo check && cargo test

# 6. 构建 Windows 安装包
cd .. && npm run tauri build

# 7. 提交与推送
git add .
git commit -m "feat: ..."
git push origin <branch>
```

---

## 5. 环境对照（迁移后唯一环境 = Windows）

### 开发/构建所需工具（均已就绪）

| 工具 | 版本/位置 | 状态 |
|---|---|---|
| Node.js | v22.22.2 | ✅ |
| npm | 10.2.4 | ✅ |
| Rust | 1.97.1 | %USERPROFILE%\.cargo\bin\ |
| MSVC | VS Build Tools 2022 + 14.44 | ✅ |
| Windows SDK | 10.0.26100 | ✅ |
| WebView2 | 151.x | ✅ |
| Codex CLI | 当前环境 | ✅ |

### 不再需要的环境（WSL）

| 组件 | 说明 |
|---|---|
| WSL 中的 Node/npm | 不再使用 |
| WSL 中的代码副本 | 迁移完成后删除 |
| WSL 中的 Linux 依赖 | 不再使用 |

### 应保留的环境

| 组件 | 说明 |
|---|---|
| WSL 虚拟磁盘 | 可保留（有其他用途），代码删除即可 |
| Git 远程 (fork) | 作为版本控制中心 |

---

## 6. 风险评估

| 风险 | 影响 | 缓解 |
|---|---|---|
| push 前 `.git` 元数据问题 | 低 | 已确认 `.git` 结构完整 |
| 文件行尾转换 (LF↔CRLF) | 低 | commit 时 git 自动处理 |
| WSL 仓库中的 .trellis/workspace 未提交文件 | 低 | 已包含在 git add . 中 |
| Windows target/ 构建缓存过期 | 低 | 重新 npm run tauri build 即可增量重编译 |
| 需确认 fork 分支是否已存在同名分支 | 中 | push 前 git ls-remote origin 检查 |

---

## 7. 执行清单

- [ ] 确认 `git remote -v` 正确
- [ ] 确认 `git status` 无意外文件
- [ ] `git add . && git commit`
- [ ] `git ls-remote origin` 检查远程分支状态
- [ ] `git push origin fix/opencode-session-resume-clipboard`
- [ ] 验证安装包可构建（增量即可）
- [ ] 用户在 Windows 上打开 Codex CLI 验证开发流程
- [ ] （可选）清理 WSL 旧仓库

---

## 8. 后续迭代版本发布流程（Windows Only）

```
[Windows Codex CLI] 修改 → 测试 → commit → push
            ↓
[Windows 同一环境] npm run tauri build
            ↓
       MSI/EXE → installers/
            ↓
     安装验证 → PR → 发布
```

**不再有跨环境同步的步骤。**

---

## 9. 附录：当前 Windows 构建副本的关键事实

```
路径:     D:\Program\soft\code\CLI-Manager-src
git提交:  77a2af3f (master / fix/... 分支均在此)
远程:     origin=https://github.com/unixcs/CLI-Manager.git
          upstream=https://github.com/dark-hxx/CLI-Manager.git
git用户名: feng <unixcs@qq.com>
未提交:   13 个修改文件 + 8 个新增(untracked)
依赖:     node_modules (0.72GB, Windows 版)
构建缓存: src-tauri/target (5.07GB, Release)
安装包:   installers/CLI-Manager_1.3.7_x64_en-US.msi
          installers/CLI-Manager_1.3.7_x64-setup.exe
```

---

## 10. Review 评审与补充（2026-08-17 复核）

> 本段由 WSL Codex 复核上次 Windows Codex 整理的迁移计划后追加。整体方向正确（方案 A：Windows 副本直接转正），**但该 Plan 基于旧快照，存在几项必须先修正/补充的问题**。修正后的完整执行顺序见 §10.3，Windows-only 的后续固化规划见 §10.4。

### 10.1 评审结论

- ✅ **方案选型正确**：A（Windows 副本直接转正）是最省事的迁移方式。
- ✅ **远程/环境信息基本准确**：Windows 副本（`D:\Program\soft\code\CLI-Manager-src`）已有完整 `.git`、远程、依赖与构建缓存。
- ⚠️ **必须补充/修正后才能执行**，否则 Windows 那边拉到的将是**基于旧 base 的修复分支**，与当前 GitHub 最新 master 脱节。

### 10.2 发现的问题

#### P0（阻断，必须先处理）

1. **未合并 8/17 最新 upstream/master**  
   当前 WSL master 与本地 `fix/opencode-session-resume-clipboard` 都停在 `77a2af3f`。而 `upstream/master`（`dark-hxx/CLI-Manager`）已推进到 `5fbeac83`（22 个 commit 领先），其中包含 `V1.3.7 release`、`remote-handoff` 等一批 8/17 新提交。  
   **用户已明确要求保证修复基于 GitHub 最新代码。迁移前必须先合并 upstream/master。**

2. **合并 upstream 必然产生冲突**  
   本地未提交修改与 upstream 改动重叠于至少以下文件：  
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src/components/XTermTerminal.tsx`
   - `src/lib/historyResumeCommand.ts`
   
   必须先 `git merge upstream/master` 并解决冲突，再提交推送。

3. **WSL Codex 的 JSONL 会话文件不能直接作为 Windows Codex 的"无缝接手"**  
   该文件是事件日志，meta 中带 `forked_from_id` 与 `history_base`，且引用的 base 线程文件在当前 `~/.codex/sessions` 下不存在；即使把 JSONL 复制到 Windows，也很难直接 `resume`。正确做法是**以 Markdown 接手文档 + Git 仓库为唯一真相源**（接手文档见 `docs/接手文档-Windows-Codex.md`）。

#### P1（应补入 plan）

4. **untracked 数量已过期**  
   Plan 写的是 `13 modified + 8 untracked`；实际当前为 **13 modified + 16 untracked 文件**（含 README-TRANSFER、接手文档、两个 docs 新文档、.trellis 等）。  
   第 3 步 `git add .` 会把本迁移计划、交接文档及 `.trellis` 内部文件也一并提交，需与用户确认是否全部入库（建议保留，便于追溯）。

5. **缺少 Windows 副本的 `upstream` 远程检查**  
   Plan 仅验证 `git remote -v` 有 origin；合并 upstream 还需要确认 Windows 副本也有 `upstream` remote，或至少能 fetch `dark-hxx/CLI-Manager`。

6. **缺少 `docs/开发环境与构建流程.md` 的同步更新步骤**  
   该文档仍写着 **"WSL = 开发主战场，Windows = 构建农场"**，与迁移后 Windows-only 流程矛盾。迁移完成后需同步改为 Windows-only 说明。

#### P2（建议补充）

7. **缺少 Windows 副本 push 前验证**  
   应在 Windows 上先确认：`git status --short --branch` 干净、`node_modules` 为最新、`src-tauri/target` 可增量构建、`upstream` remote 可用。

8. **缺少回滚/失败预案**  
   建议 push 前先在 Windows 或 WSL 建一个备份引用：  
   ```bash
   git tag backup/2026-08-17-before-migration master
   ```
   避免 push 后发现错误无法回退。

9. **步骤 7（删除 WSL 仓库）前置条件不足**  
   必须满足：Windows 构建通过、安装包验证通过、GitHub fork 分支已推送成功。三者全部完成后才允许删除 WSL 仓库。

10. **缺少"后续完整规划"内容**  
    用户在对话中总结的 Windows-only 固化流程与 Git 同步策略未完整写进 Plan，已补入 §10.4。

### 10.3 修正后的执行顺序（推荐）

按此顺序执行，避免遗漏：

```powershell
########## 第 1 阶段：WSL（一次性，固化 + 合并最新 base） ##########
# 1. 拉取上游最新 master
git fetch upstream
git fetch origin

# 2. 确认当前状态（13 modified + 16 untracked，分支 fix/opencode-session-resume-clipboard）
git status --short --branch

# 3. 合并 upstream/master 到当前分支（会冲突，需手动解决）
git merge upstream/master
#    冲突文件重点：package.json、src-tauri/tauri.conf.json、
#    src/components/XTermTerminal.tsx、src/lib/historyResumeCommand.ts
#    解决后：
git add .
git commit -m "merge: sync upstream master 2026-08-17"

# 4. 验证（前端测试 + 类型检查；Rust 可选）
node --test scripts/*.test.mjs
npx tsc --noEmit

# 5. 提交所有未提交改动（确认 .trellis / README-TRANSFER / 迁移计划 是否入库）
git add .
git commit -m "fix: resolve OpenCode session ID, history resume, and TUI clipboard"

# 6. 推送到 fork
git push origin fix/opencode-session-resume-clipboard
```

```powershell
########## 第 2 阶段：Windows（主环境接管） ##########
# 7. 进入 Windows 副本
cd D:\Program\soft\code\CLI-Manager-src

# 8. 确认远程
git remote -v
# 需要同时有 origin 与 upstream（缺少 upstream 时补加）

# 9. 拉取并切到最新分支
git fetch origin
git fetch upstream
git checkout fix/opencode-session-resume-clipboard
git pull origin fix/opencode-session-resume-clipboard

# 10. 依赖更新（lock 可能变化）
npm install

# 11. 完整验证
node --test scripts/*.test.mjs
npx tsc --noEmit
cd src-tauri && cargo check && cargo test
cd ..

# 12. 构建安装包
npm run tauri build

# 13. 安装验证（手动）
#   - OpenCode Hook 需重装（Agent Capabilities → OpenCode → 重装/更新 Hook）
#   - Session ID / 历史恢复 / 复制粘贴（详见接手文档 §6）
```

```powershell
########## 第 3 阶段：收尾（确认后执行） ##########
# 14. 确认 Windows 验证通过后，更新 docs/开发环境与构建流程.md 为 Windows-only
# 15. 可选：WSL 侧建备份 tag
# 16. 可选：删除 WSL 仓库（需先通过 §10.2 P2-9 前置条件）
```

### 10.4 后续完整规划（Windows-only 固化流程）

以下内容整合自用户与 WSL Codex 的后续规划对话，是迁移完成后长期维护的固化约定：

#### 核心思路

不需要"移动文件夹"；只要保证 **Git 仓库是唯一真相源**。WSL 只做一次性导出角色，之后不再参与日常开发。

#### 第 1 步：WSL 把当前状态固化并 push（一次性）

1. commit 当前全部改动。
2. push 到 fork `unixcs/CLI-Manager` 的 `fix/opencode-session-resume-clipboard`。
3. 确认未纳入版本控制的文件是否入库。

#### 第 2 步：Windows 做一次干净的"接管拉取"

```powershell
cd D:\Program\soft\code\CLI-Manager-src
git fetch origin
git fetch upstream
git checkout fix/opencode-session-resume-clipboard
git pull origin fix/opencode-session-resume-clipboard
```

确认开发环境：`rustc --version`、`cargo --version`、`node --version`。

#### 第 3 步：Windows 建立完整闭环

之后全部操作都在 Windows：

```powershell
npm install                    # 依赖
npm run tauri dev              # 开发+热调试
npm run tauri build            # 出正式 EXE/MSI
node --test scripts/*.test.mjs # 跑测试
npx tsc --noEmit               # 前端类型检查
cd src-tauri && cargo check    # Rust 检查
cd .. && cargo test
```

改完代码 → 直接编译 → 装 EXE → 自行验证：

```powershell
git add .
git commit -m "fix: ..."
git push origin fix/opencode-session-resume-clipboard
```

#### 第 4 步：Git 同步策略（避免再乱）

- ✅ 所有代码提交都从 Windows 推送到 GitHub fork。
- ✅ 上游更新后在 Windows 处理 merge：
  ```powershell
  git fetch upstream
  git merge upstream/master
  ```
- ✅ 谁在 GitHub 上 push，谁就是当前真相源。
- ❌ 不要在 WSL 里再直接改代码（除非必须，也要先 pull 最新）。

#### 第 5 步：关于迁移后的"上下文丢失"

- 代码 commit/push 后，代码本身就是上下文。
- `README-TRANSFER.md` 与 `docs/接手文档-Windows-Codex.md` 是给 Windows Codex 的完整上下文。
- 三个 Bug 的根因、修复思路、验证步骤、已知坑都写在这些文档里。
