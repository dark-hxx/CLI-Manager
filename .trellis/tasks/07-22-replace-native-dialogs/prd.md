# 统一替换系统弹框

## Goal

全局移除前端直接使用的浏览器/系统确认框、提示框和输入框，统一为 CLI-Manager 内置弹框风格。

## Requirements

- 扫描 `window.confirm`、`window.alert`、`window.prompt` 及裸调用。
- 扫描 Tauri 原生 message/confirm/ask 对话框调用，并区分文件选择器等必要系统 UI。
- 复用已有 `ConfirmDialog`、`useAppConfirm`、`useAppPrompt` 与 toast，避免新增依赖。
- 保持原操作语义、异步流程及中英文文案。
- 不写入 `CHANGELOG.md`。

## Acceptance Criteria

- [x] 产品前端不存在浏览器/系统确认、提示或输入弹框调用。
- [x] 确认操作可取消，确认后原业务逻辑保持不变。
- [x] 提示类信息使用软件内 toast 或对话框。
- [x] TypeScript 类型检查通过。
- [x] 全局复扫无遗漏。

## Definition of Done

- 静态检查通过。
- Git diff 仅包含本任务相关变更。
- 记录无法由自动化验证的桌面 UI 检查项。

## Out of Scope

- 文件/目录选择器等必须使用系统能力的选择界面。
- 重构现有内置弹框组件。
- 写入 `CHANGELOG.md` 或功能清单。

## Technical Notes

- Changelog Target: `[TEMP]`（流程占位；用户明确要求不写入 `CHANGELOG.md`）。
- GitNexus 本地索引缺失时，使用 Serena 与 `rg` 降级完成触点清单。
- 先前已将历史会话转换的 `window.confirm` 替换为 `useAppConfirm`。
