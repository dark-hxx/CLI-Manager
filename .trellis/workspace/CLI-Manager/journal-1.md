# Journal - CLI-Manager (Part 1)

> AI development session journal
> Started: 2026-04-21

---



## Session 1: Bootstrap frontend spec guidelines

**Date**: 2026-04-23
**Task**: Bootstrap frontend spec guidelines
**Branch**: `feat/compact-mode-launcher`

### Summary

Filled the frontend Trellis spec files, verified build, and captured current UI/component/state/type-quality conventions from the codebase.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c7b2bd5` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: 全项目性能优化 MVP

**Date**: 2026-05-26
**Task**: 全项目性能优化 MVP
**Branch**: `feat/compact-mode-launcher`

### Summary

优化终端输出解码与隐藏缓冲、历史会话搜索匹配和 WebDAV 同步内存边界，并补充相关 Trellis code-spec。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `256549b` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: 修正 Claude Code IME 候选框漂移（底部优先锚点）

**Date**: 2026-06-15
**Task**: fix-claude-code-ime-drift
**Branch**: `master`

### Summary

上一轮"硬件光标就近双向扫描输入行"方案仍漂移：Claude Code 输入中文时候选框贴到屏幕顶部而非底部输入框。根因——TUI 的硬件光标（`buffer.cursorX/Y`）不指向底部真实输入框（输入框光标是 TUI 用反色字符画的视觉光标），而屏幕顶部历史回显的 `> hishu` 这类以 `>` 开头的行会被识别成输入行；就近双向扫描在光标漂移到上半屏时命中了顶部诱饵。改为从屏幕最底行向上扫描第一个输入行作为锚点（TUI/shell 当前输入框恒在底部），光标恰在该行时才返回精确光标以保留普通 shell 行内 caret。

### Main Changes

- `src/components/XTermTerminal.tsx` `resolveCompositionAnchorCell`：删除"光标在行即 return cursor + 就近双向扫描"两段，改为单向从 `terminal.rows-1` 向上扫第一个输入行；命中即锚点（光标在该行则返回精确光标），无输入行才回落硬件光标。净减代码，消除顶部诱饵死角。

### Testing

- [OK] `npx tsc --noEmit` 通过
- [ ] 运行态人工验收：Claude Code / Codex 中文 IME 候选框贴底部输入框；普通 shell 行内移动 caret 后 IME 跟随（待用户验证）

### Status

[进行中] 代码完成，待人工验收

### Next Steps

- 人工验证三场景：Claude Code 流式输出期间中文 IME、Codex、普通 shell 行内 caret 移动
