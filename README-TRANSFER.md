# CLI-Manager 1.3.7 修复：交接文档

> 生成时间：2026-08-17
> 源代理：Codex (WSL Linux)
> 接手代理：Codex (Windows)
> 分支：`fix/opencode-session-resume-clipboard`
> 目标版本：**1.3.7**

---

## 1. 故事背景

用户使用 CLI-Manager 管理 OpenCode / Claude / Codex / Grok 等 CLI 工具。当前发现三个 Bug：

1. **OpenCode 标签页 Session ID 显示错误** —— 顶部标签显示的 ID 被子 Agent 会话覆盖，不再是根会话。
2. **历史会话“继续对话”失败** —— 选择 OpenCode 历史记录→点“继续对话”→右下角报错“会话来源不受支持”。
3. **OpenCode TUI 无法 Ctrl+C 复制 / Ctrl+V 粘贴** —— 选中文字后快捷键无响应。

用户 fork 了原项目到 `https://github.com/unixcs/CLI-Manager`，在分支 `fix/opencode-session-resume-clipboard` 上完成了修复。修复方案经过两轮独立子代理代码评审（第一轮 FAIL→修复→第二轮 PASS），测试全部通过。

现在需要在 **Windows 真机**上把代码构建成安装包，并做手工验证。

---

## 2. 当前仓库状态

### 仓库信息

```json
fork:   https://github.com/unixcs/CLI-Manager.git
remote: origin → https://github.com/unixcs/CLI-Manager.git
branch: fix/opencode-session-resume-clipboard
base:   master (upstream: dark-hxx/CLI-Manager)
```

### 已修改文件

| 文件 | 改动 |
|---|---|
| `CHANGELOG.md` | 新增 `V1.3.7` 节 |
| `README.md` / `README.zh-CN.md` | OpenCode 会话恢复能力标记为 ✅ |
| `docs/功能清单.md` | V1.3.7 OpenCode 板块 |
| `package.json` / `package-lock.json` | 版本 → 1.3.7 |
| `src-tauri/Cargo.toml` / `Cargo.lock` / `tauri.conf.json` | 版本 → 1.3.7 |
| `src-tauri/src/commands/opencode_hook.rs` | 内嵌 JS 替换为 `include_str!("../../resources/opencode/cli-manager-hook.js")` |
| `src/components/XTermTerminal.tsx` | 新增 OpenCode 剪贴板 hook 接入（仅 import + if 块） |
| `src/lib/historyResumeCommand.ts` | 新增 `buildHistoryResumeCommand` OpenCode 分支、`stripOpenCodeResumeCliArgs` |
| `src/terminal/browser/TerminalCliContext.ts` | 新增 `isOpenCodeTerminalContext()`（`sessionTool` 优先） |
| `src/terminal/browser/OpenCodeTuiClipboard.ts` | **新建** — 独立剪贴板模块 |
| `src-tauri/resources/opencode/cli-manager-hook.js` | **新建** — OpenCode Hook 状态机（root/child/unresolved/tombstone） |
| `scripts/opencodeHook.test.mjs` | **新建** — Hook 10 项测试 |
| `scripts/historyResumeCommand.test.mjs` | **新建** — 历史恢复 4 项测试 |
| `scripts/openCodeTuiClipboard.test.mjs` | **新建** — 剪贴板 9 项测试 |
| `.trellis/tasks/08-16-.../` | **新建** — Trellis 任务文档 |

### 未改动的策略性决定

- `src/terminal/browser/handleCliHookEvent` 保持不变；前端依赖新版 Hook（必须重装）。
- 其他 CLI 的通用 `keyboard handler` / 鼠标报告不变。
- 不自动提交/推送 PR。

---

## 3. 三个 Bug 的根因与修复要点

### 3.1 OpenCode Session ID 被子 Agent 覆盖

**根因**：OpenCode 根会话和子/子 Agent 会话共享终端 Hook 环境。旧 Hook 插件把所有 `session.*` ID 都当根推送给前端，前端通用 rebind 逻辑让子 `ses_xxx` 覆盖了标签页的根 ID。

**修复方式**：在 `src-tauri/resources/opencode/cli-manager-hook.js`（OpenCode 插件端的 Bridge）实现完整状态机：

- 只用 `properties.sessionID`（规范字段），`info.id` 仅在规范字段缺失时做兼容回退。
- 只有 `session.created`（无 parent）能建立/切换 active root。
- child 事件只维护映射，不发布状态。
- `session.deleted` 只写 tombstone 并清理，不发布 Hook。
- 根切换后旧根的迟到事件不发布。
- 已删除的根/子不能被迟到事件复活。
- Map 有 1024 上限、5 分钟 TTL 清理、64 层父链深度限制、环路检测。

**验收前置**：Agent Capabilities 中必须重装 OpenCode 的托管 Hook（因为旧 Hook 内嵌在老版本 DLL 里，新 Hook 是独立 JS 文件）。

### 3.2 历史会话“继续对话”失败

**根因**：`buildHistoryResumeCommand` 没有处理 `source === "opencode"` 的分支，返回 null，前端无法构造命令。

**修复方式**：在 `src/lib/historyResumeCommand.ts` 增加 `else if (session.source === "opencode")` 分支：
- 提取 `session_id`，校验 `^ses_[A-Za-z0-9]+$`。
- 生成 `opencode --session <id>`。
- 项目有 OpenCode cli_tool 时，剥离冲突参数（`--session`/`-s`/`--continue`/`-c`/`--fork`，含 `=` 和引号形式）后附加 `cli_args`。
- 不修改 Claude / Codex / Grok / Pi 的既有路径。

**注意**：只使用 `session.session_id`；`file_ref.path` 和 `#session=` 形式不进入 command builder。

### 3.3 OpenCode TUI 无法 Ctrl+C / Ctrl+V

**根因**：OpenCode 启用 TUI 鼠标/输入处理，xterm 内置的快捷键处理无法按预期工作。

**修复方式**：新建独立模块 `src/terminal/browser/OpenCodeTuiClipboard.ts`：

- 用 capture 阶段的 `keydown` 事件监听器。
- 只对**当前活跃、可见、有焦点、非 macOS** 的 OpenCode 终端生效。
- **Ctrl+C**：有 selection → 复制到剪贴板 + 清除 xterm selection + 清除输入选择 + 恢复焦点；无 selection → 不拦截（继续发 PTY `\x03` 中断）。
- **Ctrl+V**：读剪贴板 → 粘贴到终端。
- **Ctrl+Shift+V**：读剪贴板 → 多行包装后粘贴。
- macOS 上 inert（`isMac()` 返回 true → 整个模块跳过）。
- 其他 CLI（Claude/Codex/Grok/Pi）不安装此监听器。

`XTermTerminal.tsx` 中只在 OpenCode 上下文时 attach/dispose：

```tsx
if (contextMenuTarget && isOpenCodeTerminalContext(getSessionToolContext())) {
  inputDisposables.push({
    dispose: attachOpenCodeTuiClipboard({ container, terminal, isActive, isVisible, hasInputFocus, isMac, ... }),
  });
}
```

OpenCode 终端判定（`isOpenCodeTerminalContext`）：
- `sessionTool` 明确时以其为准（`sessionTool="codex"` 即使 project 是 opencode 也不匹配）。
- 仅 sessionTool 缺失时回退 projectTool / startupCmd 可执行文件名。

---

## 4. 后续任务清单（Windows Codex 完成）

### 步骤 A：同步代码到 Windows

```powershell
# 1. 进入项目目录（用户Windows上的原目录）
cd D:\Program\soft\code\CLI-Manager

# 2. 添加 fork 远程（如果还没有）
git remote add origin https://github.com/unixcs/CLI-Manager.git

# 3. 拉取最新分支
git fetch origin
git checkout -b fix/opencode-session-resume-clipboard origin/fix/opencode-session-resume-clipboard
# 或：如果在本地已有，直接
git pull origin fix/opencode-session-resume-clipboard
```

### 步骤 B：安装依赖

```powershell
# 清除旧 node_modules 确保干净
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force src-tauri\target -ErrorAction SilentlyContinue

npm install

# 检查 Rust
rustc --version
cargo --version
# 如果没有，去 https://rustup.rs 装
```

### 步骤 C：编译 Windows 安装包

```powershell
npm run tauri build
```

产物在 `src-tauri\target\release\bundle\msi\` 或 `\nsis\`。

### 步骤 D：安装并验证（所有手动操作由用户执行，你来指导）

1. **安装** 双击 `.msi` 或 `.exe` 安装新版本。
2. **重装 OpenCode Hook** — 打开 CLI-Manager → Agent Capabilities → 找到 OpenCode → 重装/更新 Hook（因为 Session ID 修复依赖新版 Hook JS 文件）。
3. **验证 Session ID** — 启动根 OpenCode 会话 → 建一个子 Agent → 确认标签页 Session ID 保持根 `ses_xxx`。
4. **验证历史恢复** — 历史会话 → 来源选 OpenCode → 点一条 → 点“继续对话” → 应恢复正确会话。
5. **验证 TUI 剪贴板** — OpenCode 终端里：
   - 选中文字 + `Ctrl+C` → 复制
   - `Ctrl+V` → 粘贴
   - `Ctrl+Shift+V` → 多行粘贴
   - 无选择时 `Ctrl+C` → 中断
6. **回归其他 CLI** — 开 Claude/CC、Codex/CX、Grok、Pi 终端，确认 `Ctrl+C`/`Ctrl+V` 行为没变。

### 步骤 E：版本号检查

确认以下文件版本为 **1.3.7**：
- `package.json`（`"version": "1.3.7"`）
- `package-lock.json`（顶层的 `"version"` 和 `"packages"[""]` 的 `"version"`）
- `src-tauri/Cargo.toml`（`[package] version = "1.3.7"`）
- `src-tauri/Cargo.lock`（`name = "cli-manager"` 下面 `version = "1.3.7"`）
- `src-tauri/tauri.conf.json`（`"version": "1.3.7"`）

### 步骤 F：如果验证没问题

```powershell
# commit（如果 Windows 上有改动）
git add .
git commit -m "fix: resolve OpenCode session ID, history resume, and TUI clipboard"

# 推送到 fork
git push origin fix/opencode-session-resume-clipboard

# 向原项目提 PR
# 在 https://github.com/unixcs/CLI-Manager 页面 → Pull Request → dark-hxx/CLI-Manager:master
```

### 步骤 G：如果验证还有问题

- 反馈给用户，并回退 `git checkout master`。
- 如果需要改代码，反馈具体现象到此 WSL 环境（当前不存在了），或我在文档里记录要点。

---

## 5. 已知注意事项

| 坑 | 说明 |
|---|---|
| OpenCode Hook 必须重装 | 旧 Hook 内嵌在老 DLL 中，修复了 Session ID 的新 Hook 是独立 JS 文件（`resources/opencode/cli-manager-hook.js`），必须重装才能生效 |
| OpenCode 剪贴板只影响 Windows | `isMac()` 检查使 macOS 下本模块 inert |
| Cargo 版本 | Rust 建议 ≥1.77（apt 的 1.75 理论够用，但不是最佳） |
| 测试文件 | 前端测试在 `scripts/` 下可单独跑 `node --test scripts/opencodeHook.test.mjs` 等 |
| 全量 test 有 8 个预存失败 | 与本改动无关，是 baseline 问题（缺少 module、快照不匹配等） |

---

## 6. 架构快速参考

```
src-tauri/resources/opencode/cli-manager-hook.js     ← OpenCode 插件端的 Session ID 状态机
src/terminal/browser/OpenCodeTuiClipboard.ts         ← OpenCode 专用剪贴板模块
src/terminal/browser/TerminalCliContext.ts           ← isOpenCodeTerminalContext() 判定
src/lib/historyResumeCommand.ts                      ← buildHistoryResumeCommand OpenCode 分支
src/components/XTermTerminal.tsx                     ← 剪贴板模块的接入点
```

---

交接完成。祝编译顺利 🚀
