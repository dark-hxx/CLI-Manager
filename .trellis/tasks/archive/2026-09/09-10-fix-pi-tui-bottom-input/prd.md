# 修复 Pi CLI 全屏 TUI 底部输入框展示

## Goal

修复 [GitHub Issue #258](https://github.com/dark-hxx/CLI-Manager/issues/258)：Windows 11 + WSL 中使用 Pi CLI 全屏 TUI 时，底部输入框被 MCP 直连工具提示覆盖的问题。版本记录为 `V1.4.0`。

## Confirmed Behavior

- Pi 全屏 TUI 启动后，底部应持续显示可用的输入编辑区。
- 问题只要求修复 Pi 全屏 TUI 的展示；普通 Shell、其他 CLI、Pi 的其他输出行为需要保持原样。
- 截图中的重复文本与 `pi-mcp-adapter` 在直连工具达到 75 个时输出的 advisory 完全一致：`MCP: ... direct tools resolved ...`。

## Root Cause

Pi 全屏 TUI 运行后，`pi-mcp-adapter` 为 75 个以上 direct tools 通过 `console.warn` 把 advisory 作为普通 stderr 文本写入与 stdout 共用的 PTY；Pi TUI 没有把这条原始 stderr 重新纳入差分渲染，CLI-Manager 又按普通终端输出转发到 xterm，文本从当前光标位置覆盖底部 editor/composer，因此底部输入框状态被破坏。

## Discovery Checklist

1. Issue #258 指定 Windows 11、WSL、Pi 全屏 TUI 和“底部输入框正常展示”的预期。
2. 截图文本命中 `pi-mcp-adapter` 的直连工具 advisory，重复出现是 PTY 原始输出叠加的结果。
3. PTY 将 stdin、stdout、stderr 接入同一伪终端，后端只做字节流转发，并不区分该 advisory 的来源。
4. Pi 全屏渲染器负责自己的屏幕重绘，但外部 `console.warn` 绕过了渲染器。
5. 前端当前只做 OSC 规范化和 Pi ANSI 兼容转换，因此会保留并写入这段 advisory。

## Requirements

- 在现有终端输出转换链增加 Pi 专用、精确匹配的 advisory 过滤。
- 支持 PTY 帧边界任意切分，不能因提示跨帧而泄漏到 xterm，也不能吞掉相邻普通文本。
- 只移除该条已确认的直连工具 advisory；其他 MCP 状态、错误、普通终端输出必须保留。
- 过滤仅在 Pi 会话上下文生效，退出/重置 Pi 上下文时清理残余分帧状态。
- 过滤要覆盖实时输出、回放和恢复共用的输出转换路径。
- 不修改用户 Pi 配置，不禁用直连工具，不新增 IPC、数据库字段或用户可见文案。
- 新增回归测试覆盖完整提示、任意切分、重复提示、相邻文本、非 Pi 原样输出和 reset 后残余状态。

## Acceptance Criteria

- [x] Pi 全屏 TUI 收到完整或跨帧的直连工具 advisory 后，底部输入框不再被 advisory 覆盖（用户已在 Windows/WSL 中验收）。
- [x] 重复 advisory 全部被过滤；提示前后紧邻的普通文本保持顺序和内容。
- [x] 普通 Shell、其他 CLI、非匹配 MCP 文本仍按原始字节内容输出。
- [x] Pi 上下文重置后，前一条提示的残余片段不会影响后续普通输出。
- [x] 回归测试通过，前端类型检查和架构检查通过。
- [x] `CHANGELOG.md` 的 `V1.4.0` 与 `docs/功能清单.md` 的终端工作区条目同步记录修复。

## Scope Boundary

本任务不改变 PTY 的 stdout/stderr 合并策略、不调整 Pi 或 MCP 配置、不处理 Pi 上游 TUI 渲染实现，也不修复与该 advisory 无关的终端布局问题。
