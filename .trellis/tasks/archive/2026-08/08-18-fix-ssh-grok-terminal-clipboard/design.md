# 技术设计：SSH Grok 会话历史不可用提示

## 责任边界

`projectCapabilities` 是项目功能能否进入 UI 与数据桥接的统一契约；SSH 历史桥接实际只支持 `SshToolSource = "claude" | "codex"`。修复应让能力契约复用这项既有事实，而不是在 `sshAgentHistory` 内捕获后将内部错误码扩散到各个调用方。

`TerminalTabs` 和侧栏只负责把能力拒绝映射为本地化 toast。`HistoryWorkspace` 已从同一能力契约派生可选项目列表，无需另建筛选规则。

## 行为流

| 项目类型 / CLI | `history` 能力 | 用户操作结果 |
| --- | --- | --- |
| SSH Claude / Codex | 可用 | 进入既有远程历史桥接 |
| SSH Grok Build | 不可用 | 显示“Grok 暂不支持查看会话历史”提示，不调用桥接 |
| SSH 其他或未配置 CLI | 不可用 | 显示通用 SSH CLI 不支持提示，不调用桥接 |
| Local / WSL Grok Build | 可用 | 保持既有本地 / WSL Grok 历史行为 |

## 设计决策

- 在 `projectCapabilities` 中通过 `resolveSshToolSource()` 收窄 SSH `history` 能力；不改动 `SSH_CAPABILITIES` 的其他项，特别是不扩大到 `statistics`。
- 在同一模块提供小型纯判断函数，区分“SSH 历史源不受支持”与“SSH Grok 历史不受支持”。两个 UI 入口复用它，避免各自解析 CLI 命令。
- 两个 toast 均使用 i18n 键：Grok 使用专用标题和说明；其他 SSH 非支持 CLI 使用通用标题和说明。不会硬编码中文或英文。
- 保留 `buildSshAgentHistoryContext()` 的 `history_remote_source_required` 校验，作为非 UI 调用的防御性契约；正常 UI 流不再到达该校验。

## 兼容性与风险

- SSH 中当前由远程桥接支持的 Claude / Codex 不受影响；Local / WSL Grok 也不受影响。
- 过去能从历史项目筛选中选到的 SSH Grok 会被隐藏，这是符合实际支持范围的行为修正。
- 统计、Markdown 预览等仍可能直接使用远程历史桥接的独立路径不在本次范围；不通过扩面改动 `statistics` 能力掩盖该差异。
- 不涉及数据库、IPC、权限、网络协议或持久化迁移；回滚只需恢复 SSH `history` 能力判断及对应 UI 文案分支。
