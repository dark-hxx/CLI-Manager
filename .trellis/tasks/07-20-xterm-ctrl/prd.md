# xterm 链接图标与 Ctrl 点击

## Goal

增强 xterm.js 终端中的可交互目标提示：悬停时按目标类型显示图标，并将打开操作改为 Ctrl+单击，避免普通单击误触。

## Requirements

- HTTP/HTTPS 与 OSC 8 链接悬停时显示链接图标。
- 本地或 WSL 文件路径悬停时，根据真实文件系统类型显示文件或文件夹图标。
- 所有可打开目标仅在按住 Ctrl 并单击时激活；普通单击不得打开。
- 文件路径在 SSH 会话中继续保持现有禁用行为。
- 不修改终端输出文本、复制内容或字符列宽。
- Changelog Target: `[TEMP]`。

## Acceptance Criteria

- [ ] 普通单击 URL、OSC 8 链接、文件或文件夹路径时均不会打开目标。
- [ ] Ctrl+单击上述目标时沿用现有打开方式。
- [ ] 悬停 URL/OSC 8 链接显示链接图标。
- [ ] 悬停真实文件显示文件图标，悬停真实目录显示文件夹图标。
- [ ] 图标不进入终端缓冲区，不影响选择、复制、换行或终端输入。
- [ ] 本地 PowerShell/CMD/Pwsh 与 WSL 路径可识别；SSH 文件路径行为不变。
- [ ] 前端类型检查和相关自动化测试通过。

## Open Questions

- 无。

## Technical Approach

- 使用 xterm.js 的 `hover` / `leave` 回调，在 `Terminal.element` 内创建带 `xterm-hover` 类的浮动图标徽标，定位到目标起点左上方。
- URL 与 OSC 8 链接直接显示链接图标；文件路径通过只读路径类型查询返回 `file` / `directory` / `missing`，准确选择文件或文件夹图标。
- 所有 `activate` 回调统一检查 `MouseEvent.ctrlKey`，不满足时直接返回。
- 路径类型查询复用现有 `check_paths_exist` 所在的文件系统边界与 WSL 处理模式，不扩大前端文件系统权限。

## Decision (ADR-lite)

**Context**: xterm.js 的链接 API 只能装饰现有字符，无法插入图标而不改变缓冲区。

**Decision**: 使用不进入缓冲区的悬浮图标徽标，并由用户确认接受该视觉形式。

**Consequences**: 不影响复制、换行和字符对齐；图标属于悬停提示，不是终端文本的一部分。

## Technical Notes

- 现有入口位于 `src/components/XTermTerminal.tsx`：OSC 8 使用 `linkHandler`，HTTP 使用 `WebLinksAddon`，文件路径使用自定义 `ILinkProvider`。
- 当前 xterm.js `ILink` 支持 `activate`、`hover`、`leave` 与下划线/指针装饰，但不支持向缓冲区插入图标；官方建议 hover DOM 放在 `Terminal.element` 内并添加 `xterm-hover` 类。
- 当前文件路径识别只返回文本范围，不包含文件系统类型；准确区分文件/目录需要读取路径元数据，不能依赖扩展名猜测。

## Out of Scope

- 修改终端实际输出内容。
- 为 SSH 远程路径新增文件系统探测。
- 改变 URL scheme 安全限制，仍仅允许 HTTP/HTTPS。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
