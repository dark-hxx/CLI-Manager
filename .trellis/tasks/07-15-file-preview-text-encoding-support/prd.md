# 文件预览多编码文本兼容

## Goal

让内置文件预览/编辑器可靠打开常见非 UTF-8 文本文件，并在保存时保持原始编码，避免中文乱码或静默破坏文件。

## Changelog Target

`[TEMP]`

## What I already know

- 当前 `.cs` 文件打开时后端返回 `not_utf8`。
- `file_read_text` 使用严格的 `String::from_utf8`，只接受 UTF-8。
- 前端除图片外默认都调用文本读取命令，读取失败后统一标记为 `unsupported`。
- `file_write_text` 直接写入 Rust `String`，实际保存格式固定为 UTF-8；只增加有损解码会破坏原文件编码。
- 用户要求按成熟编辑器标准扩大常见文本文件编码兼容范围，而不是只修复 `.cs` 扩展名。

## Assumptions (temporary)

- 编码能力应由文件内容/BOM 检测决定，不依赖扩展名白名单。
- 可编辑文件必须记录检测到的编码，并在保存时使用相同编码回写。
- 二进制文件必须在解码前识别并拒绝，不能以有损文本方式打开。

## Requirements

- 支持 UTF-8、UTF-8 BOM、UTF-16 LE/BE，以及常见本地代码页文本。
- 读取响应携带规范化编码标识，前端文件状态保留该标识。
- 保存时默认保持原始编码，不静默转换为 UTF-8。
- 无法可靠识别的内容显示可理解的错误，不直接暴露 `not_utf8` 内部错误码。
- 文件编码能力适用于常见源码、配置、日志和纯文本文件，不绑定 `.cs`。
- MVP 不提供编码显示、手动重新打开、保存为编码或编码配置界面。
- 编辑内容包含原编码无法表示的字符时，阻止保存并显示明确提示；禁止自动转 UTF-8或替换为 `?`。
- 多编码能力不局限于编辑器入口，应覆盖已确认的其他用户项目文本读取链路。
- 兼容范围仅限用户项目文件；CLI-Manager 自身生成或消费的 JSON、JSONL、Replay patch、配置等内部格式继续保持固定 UTF-8 契约。
- Git Diff 对非 UTF-8 文本提供可读展示，但不得把转码后的展示文本复用于 Snapshot/恢复或其他要求原始 Patch 字节语义的链路。

## Acceptance Criteria

- [ ] UTF-8、带 BOM UTF-8、UTF-16 LE/BE 文本可正确预览和编辑。
- [ ] 至少一种常见中文本地编码文本可正确预览、编辑并保持编码保存。
- [ ] 保存后原始编码和 BOM 策略符合已确认的产品决策。
- [ ] 二进制文件不会被误判为文本并产生乱码内容。
- [ ] 非 UTF-8 读取失败提示完成中英文国际化。
- [ ] 文件内容搜索能命中支持编码的非 UTF-8 文本。
- [ ] Git Diff 能正确显示支持编码的非 UTF-8 文本；非 UTF-8 Diff 不允许执行会把展示文本重新作为 Patch 应用的行级/Hunk 级回滚。
- [ ] Worktree Snapshot/恢复仍使用原有 Patch 链路，不消费转码后的 UI Diff。
- [ ] 编码读写单元测试、前端类型检查和 Rust 测试通过。

## Out of Scope

- 富文本文档、PDF、Office、字体、压缩包等二进制格式预览。
- 完整 IDE 级语言服务和语法分析能力。
- 编码选择器、“重新以编码打开”、“保存为编码”和项目级默认编码设置。
- 历史 JSONL、Replay patch、Worktree Snapshot patch、CLI-Manager 配置及其他固定 UTF-8 内部数据的编码放宽。
- 对非 UTF-8 Diff 执行行级或 Hunk 级 Patch 回滚；整文件丢弃、暂存和取消暂存仍按现有 Git 操作执行。

## Technical Notes

- 用户项目编辑入口：`src-tauri/src/commands/fs.rs::file_read_project_text` / `file_write_project_text`；原有 `file_read_text` / `file_write_text` 保持严格 UTF-8，继续服务 Replay 等内部文件。
- 前端状态：`src/stores/fileExplorerStore.ts::ActiveProjectFile` 与 `loadProjectFile` / `saveFile`。
- 当前文件大小上限和路径安全校验应保持不变。

## Research References

- [`research/encoding-strategy.md`](research/encoding-strategy.md) — VS Code、IntelliJ 与 Rust 编码检测/转换方案对比。

## Feasible Approaches

### A. 自动检测 + 手动覆盖（推荐）

- BOM、严格 UTF-8、二进制检查、传统编码猜测依次执行。
- 普通保存保持原编码；编辑器显示编码，并支持重新打开/保存为编码。
- 自动猜错时用户可恢复，范围仍小于完整项目编码设置体系。

### B. 仅自动检测与原编码保存

- 后端支持多编码，但前端不提供编码选择器。
- 改动较少，但自动判断错误时无法继续编辑。

### C. 完整编码配置体系

- 增加全局、项目、目录和文件级编码设置与继承。
- 能力最完整，但显著扩大设置、持久化和迁移范围。

## Decision (ADR-lite)

**Context**: 自动编码猜测存在误判风险，但本次用户优先要求扩大常见文本兼容范围并控制 UI/设置范围。

**Decision**: MVP 采用方案 B：自动检测常见文本编码，前端保存检测结果，普通保存保持原编码；不提供手动编码选择器和持久化编码规则。

**Consequences**: 实现范围较小，但编码猜错时用户无法在应用内手动纠正。检测失败采用明确错误；保存时若内容无法映射回原编码，则阻止保存并提示，禁止静默损坏文件。

### Scope Expansion

用户选择扩展到预览之外的更多文本入口。已发现的项目文件链路包括：

- 文件预览、编辑与保存：`file_read_text` / `file_write_text`。
- 文件内容搜索：`collect_content_matches` 当前跳过所有非 UTF-8 文件。
- Git Diff：未跟踪文件使用 `read_to_string`；libgit2 patch 正文使用逐行 `from_utf8(...).unwrap_or("")`，可能丢失非 UTF-8 内容。

最终范围仅覆盖用户项目文件。内部 Replay patch、历史 JSONL、应用配置等格式由 CLI-Manager 自身生成或受固定格式约束，继续保持 UTF-8，不参与自动猜测。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
