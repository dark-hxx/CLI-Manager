# 实施计划：SSH Grok 会话历史不可用提示

## 实施前检查

1. 在获得本更新计划的明确批准后，启动 Trellis 任务。
2. 加载 `trellis-before-dev` 及其前端组件、质量与终端输出相关规约。
3. 对 `projectSupportsCapability`、`TerminalTabs` 的能力拒绝回调和侧栏的能力拒绝回调执行 GitNexus 上游影响分析；若风险为 HIGH 或 CRITICAL，先向用户报告再编辑。
4. 确认无关脏文件仍未被本任务触及。

## 变更步骤

1. 修改 `src/lib/projectCapabilities.ts`：使 SSH `history` 能力仅在 CLI 可解析为 Claude / Codex 时为真，并导出供 UI 复用的 SSH 历史不支持判断。
2. 修改 `src/components/TerminalTabs.tsx`：在既有能力拒绝 toast 中，为 SSH Grok 历史显示专用 i18n 文案，为其他不支持的 SSH 历史源显示通用 i18n 文案。
3. 修改 `src/components/sidebar/index.tsx`：应用与终端工具栏一致的 i18n 提示逻辑。
4. 修改 `src/lib/i18n.ts`：同时增加 `zh-CN` 与 `en-US` 的 Grok 专用和 SSH 通用提示键。
5. 新增 `scripts/projectCapabilities.test.mjs`：断言 SSH Claude / Codex、SSH Grok、SSH 其他 CLI、Local / WSL Grok 的历史能力，并以轻量源码断言保护两个入口和双语键的复用。
6. 更新 `CHANGELOG.md` 的 `V1.3.7` 与 `docs/功能清单.md` 对应 SSH / 会话历史板块。

## 验证

1. `node --test scripts/projectCapabilities.test.mjs`
2. `npx tsc --noEmit`
3. `git diff --check`
4. 手动验证：在中文与英文界面中，分别从侧栏和终端工具栏打开 SSH Grok Build 会话历史；均显示友好提示且不出现内部错误。确认 SSH Claude / Codex 与 Local / WSL Grok 仍能通过能力检查。
5. 交付前运行 GitNexus `detect_changes()`，确认改动仅覆盖预期能力契约、两个入口、i18n、测试和交付文档。

## 回滚点

- 若已支持的 SSH Claude / Codex 被错误阻止，恢复 `projectCapabilities` 中 SSH 历史源判断和对应测试；不回滚无关工作区变更。
