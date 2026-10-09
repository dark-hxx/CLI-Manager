# 修复 Codex Shift 方向键与全局 Tab 切换冲突

## Goal

Codex CLI v0.160.0 之后使用 `Shift+←` 打开 LLM 提问回答入口。在 CLI-Manager 终端获得焦点时，该操作应交给终端，不应同时触发应用的标签切换。

## Confirmed Facts

- 用户已同意创建 Trellis task，指定变更记录版本为 `V1.4.2`。
- 用户于 2026-10-08 反馈“测试修复成功，可以提交”；快捷键修复已提交为 `b7eb8008`。
- 用户当前无法使用异步提问界面；后续问题直接在对话中提出。
- `master` 与本地 `origin/master` 同步（0 ahead / 0 behind），初始工作区干净。
- `useXTermController.ts:1276` 已包含 Codex `Shift+Left/Right` 让行逻辑，其作用范围限于终端内部处理。
- 本机 Codex CLI 为 `0.161.0`。
- 已安装的 `F:/soft/CLI-Manager/cli-manager.exe` 为 `1.4.1`，文件时间 2026-09-24，早于仓库 2026-09-30 的快捷键修复；该安装版正在运行。
- 同时运行 `F:/github/CLI-Manager/src-tauri/target/debug/cli-manager.exe`（`1.4.2`）。其源码也包含 Shift 方向键让行逻辑；此目录有其他任务的未提交改动，本任务不修改它。
- 现有快捷键、换行和手动 Codex 输入定向测试 29/29 通过，但未覆盖真实 Windows 键盘到 Codex 提问界面的完整链路。
- 用户确认包含放行逻辑的版本也存在问题，旧构建不能作为完整根因。
- 用户进一步指出设置中的 Shift Tab 切换可能冲突。`ShortcutSettingsPage.tsx:36` 提供此预设；`useKeyboardShortcuts.ts:138` 在终端内仍执行该全局绑定。真实回调实验确认：一个会话时调用 preventDefault，多个会话时触发 getNextSessionIdForShortcut / setActive。
- 真实 xterm、系统 ConPTY 和随包 ConPTY 的隔离实验均确认 Shift 修饰位保留；本次修复聚焦全局分发入口。完整证据见 `research.md`。

## Requirements

- R1：终端获得焦点时，单独 Shift 配合左右方向键优先由终端处理；全局快捷键不得先切换 Tab、切换焦点或取消该输入，用户自行录制的相同组合键也遵守该规则。
- R2：Codex 沿用原生 Shift+Left/Right，普通 shell 沿用输入选区；空输入、有草稿和已有选区均不触发应用 Tab 切换。
- R3：终端外 Shift Tab 绑定、Alt/Ctrl Tab 切换、复合修饰键、关闭终端和文件编辑器快捷键保持兼容。
- R4：设置页中英文说明 Shift 方向键在终端内的用途，以及可使用 Alt/Ctrl 切换 Tab。
- R5：按真实事件目标确定是否在终端内，不依赖活动会话、Hook 或输出文本，兼容分屏、Workspan、本地/WSL/SSH 和 Worktree。
- R6：更新 `CHANGELOG.md` 的 `V1.4.2`、`docs/功能清单.md` 的 Codex 提问/终端板块及相关契约。

## Acceptance Criteria

- [x] AC1（R1/R2/R5）：配置 Shift Tab 后，单/多会话终端内的 Shift+左右均不触发全局 Tab 动作或 preventDefault；正确终端仍处理按键。
- [x] AC2（R2）：实际处理器与隔离 xterm 验证 Codex 修饰信息、普通 shell 选区路由和无修饰方向键行为；用户随后确认实际修复测试成功。
- [x] AC3（R3）：终端外 Shift、终端内 Alt/Ctrl Tab、复合修饰键和关闭终端通过定向测试。
- [x] AC4（R4）：中英文文案及键名类型静态核对通过，时间格式逻辑未修改；用户整体验收修复成功。语言切换及 24 小时显示的细分操作未单独反馈，保留为补充核查记录。
- [x] AC5（R6）：定向测试、TypeScript、严格架构和 diff 检查通过，两份交付记录完整。
- [x] AC6：列出真实 Codex 提问、分屏和语言切换的人工验收项；独立夹具不宣称替代 WebView2 原生验收。

## Out of Scope

- 不更换 Codex 自身快捷键，不引入新的用户设置或快捷键配置迁移。
- 不调整模型提问内容或会话协议。
- 不启用新的 xterm 输入协议，不修改 Rust PTY，不修改其他 checkout 或自动覆盖运行中的程序。

## Review Status

用户在最终方案展示后明确批准“可以 开始实施”；2026-10-08 完成实现和自动验证。用户随后确认“测试修复成功，可以提交”，已按批准提交 `b7eb8008`。补充验证范围与反馈边界见 verification.md。
