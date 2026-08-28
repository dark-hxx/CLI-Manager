# 修复 SSH Grok 会话历史不可用提示

## 范围调整

远端 `master` 的 `7dc50200` 已包含 SSH 终端本机剪贴板修复，用户确认复制问题已解决。本任务不再修改终端鼠标或剪贴板逻辑，范围调整为 SSH Grok Build 打开会话历史时的错误处理体验。

## Goal

用户从 SSH Grok Build 项目的会话历史入口进入时，应用必须明确告知“Grok 暂不支持查看会话历史”，而不是暴露 `Error: history_remote_source_required`。可支持的 SSH Claude / Codex 历史，以及本地和 WSL Grok 历史，必须保持可用。

## 根因陈述

`src/lib/projectCapabilities.ts` 将所有 SSH 项目的 `history` 统一声明为可用；但 `src/lib/sshAgentHistory.ts` 通过 `resolveSshToolSource()` 只接受 Claude 和 Codex。SSH Grok Build 因此越过入口能力校验并在远程历史桥接层抛出内部错误码。

## 发现清单

- `src/lib/projectCapabilities.ts`：能力契约与远程历史桥接支持范围不一致，是根因修复点。
- `src/lib/sshToolIntegration.ts`：SSH 历史源当前只解析 Claude / Codex；这是既有有效约束，不修改。
- `src/lib/sshAgentHistory.ts`：错误码是对无效桥接请求的防线，不在此处将内部错误转为 UI 文案。
- `src/components/TerminalTabs.tsx` 与 `src/components/sidebar/index.tsx`：项目会话历史的两个入口，需显示专用 i18n 提示。
- `src/components/HistoryWorkspace.tsx`：已复用 `projectSupportsCapability(..., "history")` 过滤项目；中央能力修复后自动排除 SSH Grok，无需直接修改。
- SSH Worktree 在既有能力中不可用；对应 Worktree 历史路径不属于本次 SSH Grok 项目入口范围。

## Requirements

- R1：SSH 项目的历史能力必须以 `resolveSshToolSource(project.cli_tool)` 为准；只有 Claude 和 Codex 可进入远程历史桥接。
- R2：SSH Grok Build 点击项目会话历史时，显示本地化的友好提示，中文明确包含“Grok 暂不支持查看会话历史”，英文语义等价；不得调用远程历史桥接或展示内部错误码。
- R3：其他不受支持的 SSH CLI 或未配置 CLI 时，显示本地化的通用“SSH CLI 暂不支持会话历史”提示，不将其误称为 Grok。
- R4：SSH Claude / Codex 的会话历史能力保持可用；本地和 WSL Grok Build 的会话历史能力保持可用。
- R5：历史工作区的项目筛选列表复用中央能力判断，不再列出 SSH Grok Build 项目。

## Acceptance Criteria

- [ ] 从侧栏 SSH Grok Build 项目的“会话历史”入口打开时，出现友好提示，不出现 `Error: history_remote_source_required`，且历史工作区不会切换到该远程上下文。
- [ ] 从 SSH Grok Build 终端工具栏打开会话历史时，出现相同的友好提示，不出现原始错误。
- [ ] 历史工作区项目筛选不列出 SSH Grok Build 项目。
- [ ] SSH Claude / Codex、local Grok、WSL Grok 的 `history` 能力断言仍为可用。
- [ ] 不受支持的非 Grok SSH CLI 使用通用 i18n 提示，避免错误归因。
- [ ] 新增的能力测试和前端类型检查通过；不新增依赖、IPC、数据库迁移或远程协议。

## Out of Scope

- 不为 SSH Grok Build 实现远程会话历史读取、同步、恢复或统计能力。
- 不修改已由上游修复的终端复制、OSC 52 或鼠标交互逻辑。
- SSH 统计、Markdown 预览等其他历史桥接消费者不在本次范围；其中会话回放会随 `history` 能力校验自然被阻止。

## Delivery Constraints

- CHANGELOG 记录版本为 `V1.3.7`。
- 同步更新 `CHANGELOG.md` 与 `docs/功能清单.md` 的 SSH / 会话历史说明。
- 新增或修改的用户可见文案必须同时提供 `zh-CN` 与 `en-US`。
- 当前工作区已有无关变更；本任务不得修改、暂存或回退它们。
