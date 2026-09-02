# 终端滚动到底部按钮实施计划

## Preconditions

1. 用户已确认 28×28 圆形 `ArrowDown` 按钮，并与字号控件组成右下角垂直控制组。
2. `prd.md`、`design.md` 与本文件审阅通过后，运行 `task.py start` 进入实施阶段。
3. 实施前再次只读检查 `git status --short --branch`、`git branch -vv` 与 `git rev-list --left-right --count 'HEAD...@{upstream}'`；不处理已有未提交改动或未配置上游之外的 Git 状态。
4. 修改 `XTermTerminal.tsx` 前再次运行 GitNexus `impact({ target: "XTermTerminal.tsx", direction: "upstream" })`，向用户报告 HIGH/CRITICAL 文件级图谱风险后再编辑。

## Ordered steps

1. 在 `XTermTerminal` 增加组件本地滚动状态、基于 xterm normal Buffer 的状态计算函数，并在初始化检查、`onScroll`、`onWriteParsed`、`onResize`、`onRender` 时同步。
2. 增加底部跳转点击处理，调用当前 xterm 的 `scrollToBottom()`；保留终端焦点和现有 TUI 颜色同步行为。
3. 将现有右下角 `FontSizeControl` 与新按钮包入垂直控制组；复用 `terminalFontSizeControlStyle` 与 `ArrowDown`，确保 Markdown 预览分屏时只覆盖终端区域。
4. 在 `src/lib/i18n.ts` 为 `terminal.scrollToBottom` 补齐 zh-CN/en-US 文案，使用同一键作为 title 和 aria-label。
5. 更新 `CHANGELOG.md` 的 `V1.3.9` 版本段，并在 `docs/功能清单.md` 的终端功能板块追加准确描述；不改写现有未提交文件。
6. 运行 `npx tsc --noEmit`、`npm run build`、`git diff --check` 及本任务相关的既有终端逻辑测试。
7. 完成静态代码检查和人工验收清单：滚轮/滚动条/键盘、输出、resize/reflow、清屏/恢复、Tab/分屏/多会话、隐藏会话、alternate buffer、字号控件共存、主题背景、预览分屏和语言切换。
8. 运行 GitNexus `detect_changes()`，检查变更是否仅落在预期文件/符号与流程；查看完整 diff，确认 `AGENTS.md`、`CLAUDE.md` 及其他既有未提交改动未被覆盖。
9. 将本次确定的 xterm Buffer 滚动状态约束沉淀到前端组件规范，避免后续实现改用浏览器滚动条几何或 PTY 输入路径。

## Expected files

- `src/components/XTermTerminal.tsx`
- `src/lib/i18n.ts`
- `scripts/terminalScrollToBottom.test.mjs`
- `.trellis/spec/frontend/component-guidelines.md`
- `CHANGELOG.md`
- `docs/功能清单.md`

预计不修改：`TerminalTabs.tsx`、`useTerminalDisplay.ts`、`terminalStore`、`components.css`、Rust/IPC、依赖锁文件。

## Rollback

若验证发现问题，只回退本任务在上述四个预期文件中的增量；不使用 destructive Git 命令，不触碰用户已有改动。由于不涉及数据库、IPC 或依赖，回退不需要迁移或协议兼容处理。
