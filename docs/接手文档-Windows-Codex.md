# CLI-Manager：WSL Codex 对话接手文档（Windows Codex 专用）

> 生成时间：2026-08-17  
> 生成环境：WSL Codex  
> 读者：Windows Codex CLI  
> 目的：替代/补充 WSL Codex JSONL 会话文件，让 Windows Codex 拿到完整上下文并继续修复与迁移。

---

## 1. 关于 WSL Codex 会话文件（JSONL）的分析结论

### 1.1 原始文件

```
路径: \\wsl.localhost\Ubuntu-24.04\root\.codex\sessions\2026\08\17\rollout-2026-08-17T19-33-32-01a00f7f-8afc-74f0-9f5f-870d851b4aff.jsonl
大小: 约 1.25 MB
行数: 543 行（每行一个 JSON 事件）
格式: JSONL（Codex CLI 会话事件日志）
```

该文件包含 `session_meta`、`event_msg`、`response_item`、`turn_context`、`world_state`、`function_call` 等事件，**内容本身是完整的会话记录**，可以用任意 JSONL viewer 打开/搜索（Windows PowerShell 可用 `Get-Content file.jsonl | ConvertFrom-Json` 读取）。

### 1.2 能否直接"丢给 Windows Codex 无缝接手"？

**结论：不建议作为主方案。** 原因：

1. **跨机器无法直接用 `resume` 恢复**  
   Codex CLI 的 `resume` 依赖同一台机器 `~/.codex/sessions/` 下的 session 文件。跨机器恢复需要把整个 sessions 目录（含该线程及它引用的 base 线程）复制到 Windows 的 `%USERPROFILE%\.codex\sessions\`，而**仅丢这一个 JSONL 文件不够**。

2. **该会话是 fork 出来的，base 线程文件不在当前保存范围**  
   文件 meta 中带 `forked_from_id: 01a00e9b-52fb-73a0-9f77-2d64a0a88a14` 和 `history_base`。这个 base 线程文件在当前 `~/.codex/sessions` 下**已找不到**，所以即便复制文件到 Windows，Codex 也无法还原它依赖的历史上下文。

3. **路径/环境全部指向 WSL**  
   文件内的 `cwd`、Git 仓库绝对路径都是 `/mnt/demo/CLI-Manager`，模型/provider 配置也可能与 Windows 不同。跨环境用原始 session 续聊会有环境漂移。

4. **真正的价值不在 JSONL，而在"根因、改动范围、踩过的坑"**  
   这些内容已经提炼成 `README-TRANSFER.md` 和本接手文档。

### 1.3 推荐的替代方案（优先级从高到低）

| 方案 | 适用场景 | 说明 |
|---|---|---|
| **A. 本接手文档 + Git 仓库** | ✅ 推荐 | Windows Codex 读本文件 + 仓库即获得全部上下文，直接继续开发 |
| **B. 完整复制 sessions 目录到 Windows** | 想用 `codex resume` 续聊 | 需把 `/root/.codex/sessions/` 整体复制到 Windows `%USERPROFILE%\.codex\sessions\`，同时复制 provider/model 配置；但路径和环境差异仍需人工处理 |
| **C. 用 LLM 阅读 JSONL 并生成摘要** | 需要历史对话精读 | 用 `Get-Content` + LLM 总结关键决策，但不作为执行依据 |

---

## 2. 当前任务背景

### 2.1 项目

CLI-Manager：Windows 桌面应用，集中管理基于 PowerShell 的多个 CLI 工具（claude、codex、opencode 等）。  
技术栈：Tauri 2 + React 19 + TypeScript + SQLite + Zustand + Tailwind CSS 4。

### 2.2 当前分支与仓库状态（2026-08-17）

```
分支:      fix/opencode-session-resume-clipboard
本地 HEAD: 77a2af3f
master:    77a2af3f（对应 origin/master）
upstream:  dark-hxx/CLI-Manager 的 master 已推进到 5fbeac83（领先本地 22 个 commit）
远程:
  origin   https://github.com/unixcs/CLI-Manager.git
  upstream https://github.com/dark-hxx/CLI-Manager.git
```

Git 工作区现状：
- **13 个已修改文件**（含 CHANGELOG、README、package.json、Cargo、opencode_hook.rs、XTermTerminal.tsx、historyResumeCommand.ts 等）。
- **15 个 untracked 文件**（含 `README-TRANSFER.md`、`docs/开发环境与构建流程.md`、`docs/项目迁移计划-WSL到Windows.md`、`.trellis` 内容、3 个测试脚本、OpenCode hook JS、OpenCodeTuiClipboard.ts 等）。

### 2.3 已解决的三个 Bug

1. **OpenCode 标签页 Session ID 被子 Agent 覆盖**  
   → 修复于 `src-tauri/resources/opencode/cli-manager-hook.js`（Hook 状态机：root/child tombstone/TTL/环路检测）。  
   ⚠️ 新 Hook 是独立 JS 文件，**必须在 Agent Capabilities 中重装 OpenCode Hook** 才能生效。

2. **OpenCode 历史会话"继续对话"失败**  
   → 修复于 `src/lib/historyResumeCommand.ts`（新增 OpenCode 分支 + `stripOpenCodeResumeCliArgs`）。

3. **OpenCode TUI 下 Ctrl+C / Ctrl+V 复制粘贴**  
   → 新增 `src/terminal/browser/OpenCodeTuiClipboard.ts` + `XTermTerminal.tsx` 接入 + `TerminalCliContext.ts` 判定。  
   ⚠️ **重要：单元测试通过，但用户在 Windows 真机手测后反馈"复制粘贴问题仍未修复"。**  
   这是 Windows Codex 接下后**最需要继续排查的遗留问题**。

### 2.4 接下来必须做的事（按优先级）

1. **先同步 8/17 上游**：`git fetch upstream && git merge upstream/master`（会有冲突，见 §4）。
2. **继续排查 OpenCode TUI 复制粘贴**：需要 Windows 真机验证，重点怀疑 OpenCode TUI 自己的文本选择协议或按键拦截时序。
3. **执行 WSL → Windows 迁移**（迁移计划见 `docs/项目迁移计划-WSL到Windows.md`，复核修正见该文档 §10）。
4. **按 Windows-only 工作流固化后续开发**（见本文件 §5 与迁移计划 §10.4）。

---

## 3. 关键文件与改动说明

| 文件 | 作用 |
|---|---|
| `src-tauri/resources/opencode/cli-manager-hook.js` | OpenCode 插件端 Hook 状态机（Session ID 修复核心） |
| `src-tauri/src/commands/opencode_hook.rs` | 内嵌 JS 改为 `include_str!("../../resources/opencode/cli-manager-hook.js")` |
| `src/components/XTermTerminal.tsx` | OpenCode 剪贴板模块接入点 |
| `src/terminal/browser/OpenCodeTuiClipboard.ts` | OpenCode 专用 Ctrl+C / Ctrl+V 处理 |
| `src/terminal/browser/TerminalCliContext.ts` | `isOpenCodeTerminalContext()` 判定（sessionTool 优先） |
| `src/lib/historyResumeCommand.ts` | OpenCode 历史恢复命令构造 |
| `scripts/opencodeHook.test.mjs` | Hook 10 项测试 |
| `scripts/historyResumeCommand.test.mjs` | 历史恢复 4 项测试 |
| `scripts/openCodeTuiClipboard.test.mjs` | 剪贴板 9 项测试 |
| `README-TRANSFER.md` | 上一版交接文档（仍有效，可直接参考） |
| `docs/项目迁移计划-WSL到Windows.md` | 迁移计划（含本次复核补充 §10） |
| `docs/开发环境与构建流程.md` | 环境说明（迁移后需改为 Windows-only） |

---

## 4. 迁移与合并的完整步骤（修正版）

### 第 1 阶段：WSL（一次性）

```powershell
# 当前位于 /mnt/demo/CLI-Manager（WSL）
git fetch upstream
git fetch origin

# 合并 upstream/master（8/17 最新），会有冲突
git merge upstream/master

# 冲突文件重点：package.json、src-tauri/tauri.conf.json、
#             src/components/XTermTerminal.tsx、src/lib/historyResumeCommand.ts
# 解决冲突后提交
git add .
git commit -m "merge: sync upstream master 2026-08-17"

# 验证
node --test scripts/*.test.mjs
npx tsc --noEmit

# 提交剩余改动
git add .
git commit -m "fix: resolve OpenCode session ID, history resume, and TUI clipboard"

# 推送
git push origin fix/opencode-session-resume-clipboard
```

### 第 2 阶段：Windows 接管

```powershell
cd D:\Program\soft\code\CLI-Manager-src

# 确认远程
git remote -v
# 需同时有 origin 与 upstream（没有 upstream 就补加：
#   git remote add upstream https://github.com/dark-hxx/CLI-Manager.git）

# 拉取并切换
git fetch origin
git fetch upstream
git checkout fix/opencode-session-resume-clipboard
git pull origin fix/opencode-session-resume-clipboard

# 依赖（lock 可能已变）
npm install

# 验证
node --test scripts/*.test.mjs
npx tsc --noEmit
cd src-tauri && cargo check && cargo test
cd ..

# 构建
npm run tauri build
```

### 第 3 阶段：验证

1. 安装新 EXE/MSI。
2. **重装 OpenCode Hook**：设置 → Agent Capabilities → OpenCode → 重装/更新。
3. 验证 Session ID 正确、历史恢复可用。
4. 重点：**继续排查 OpenCode TUI 复制粘贴**。
5. 通过后向 `dark-hxx/CLI-Manager` 提 PR。

---

## 5. 后续完整规划（Windows-only 固化流程）

> 详情见 `docs/项目迁移计划-WSL到Windows.md` §10.4。摘要如下：

### 原则
- **Git 是唯一真相源**，WSL 只做一次性导出。
- **所有代码修改、编译、测试、提交都在 Windows 完成**。
- **上游更新后在 Windows 处理 merge**，不在两套环境同时改。

### 日常命令

```powershell
npm run tauri dev            # 开发
npm run tauri build          # 构建安装包
node --test scripts/*.test.mjs
npx tsc --noEmit
cd src-tauri && cargo check && cargo test && cd ..
git add . && git commit -m "fix: ..." && git push origin fix/...
git fetch upstream && git merge upstream/master   # 上游同步
```

---

## 6. OpenCode 复制粘贴遗留问题的排查方向（给 Windows Codex）

当前最可能的原因（结合已有代码）：

1. **OpenCode TUI 有自己的文本选择/复制协议**，`XTermTerminal` 的 `getSelection()` 拿不到 OpenCode 所选文本，导致 `Ctrl+C` 复制无效。
2. **按键事件被 OpenCode TUI 内部先消费**，`xterm` 层监听器触发顺序/时机晚于 TUI 的默认 handler。
3. **监听器挂载的容器/条件不对**：`XTermTerminal.tsx` 只在 `isOpenCodeTerminalContext` 时 attach，需确认真实会话下该判定是否为 true。
4. **OpenCode 版本差异**：OpenCode 近期有更新，TUI 快捷键协议变化可能导致模块失效。

验证建议（Windows 真机）：
- 在 OpenCode 终端里打开 DevTools/日志，确认 `OpenCodeTuiClipboard` 的 `keydown` 监听是否真正触发。
- 打印 `isActive/isVisible/hasInputFocus/isMac` 返回值。
- 确认 `sessionTool` / `projectTool` / `startupCmd` 对 OpenCode 的识别是否命中（`isOpenCodeTerminalContext`）。

---

## 7. 参考资料

- `README-TRANSFER.md`：上一版交接文档（3 个 Bug 的完整根因与修复细节）。
- `docs/项目迁移计划-WSL到Windows.md`：迁移计划 + 本次复核补充（§10）。
- `docs/开发环境与构建流程.md`：环境说明（迁移后需按 §5 Windows-only 更新）。
- `AGENTS.md`：本仓库 Agent 工作规则（含 Git 分支同步检查、CHANGELOG/功能清单要求等）。
