# 修复 WSL CLI Home 目录输入禁用

## Goal

修复“设置 → 供应商设置 → CLI Home”在运行环境切换为 WSL 后既不能选择目录、也不能手动填写目录的问题，使用户能够为 WSL 配置有效的 Home 根目录。

## What I already know

- Windows 本地运行环境下使用原生目录选择器。
- WSL 路径不能直接依赖 Windows 原生目录选择器，应至少允许手动填写 Linux 绝对路径。
- 当前工作区已有未提交的供应商设置改动，修复必须保留并兼容这些变更。
- 该问题依赖运行环境状态，按根因修复处理。

## Assumptions

- WSL Home 沿用后端既有 WSL UNC 契约（例如 `\\wsl.localhost\\Ubuntu\\home\\user`）。
- Windows 原生目录选择器无法可靠选择 WSL 远端 Linux 路径，因此 WSL 下按钮按现有产品契约保持禁用；输入框必须可直接编辑。

## Requirements

- 切换到 WSL 后，即使 Home 来源仍是“自动解析”，Home 路径也必须可编辑；首次编辑自动把草稿切换为“手动选择”。
- Local 与 WSL 的路径输入、校验、保存和恢复自动解析行为必须保持各自正确。
- 新增或修改的用户可见文案必须同时支持 `zh-CN` 与 `en-US`。
- 不覆盖当前工作区中用户已有的供应商设置改动。

## Acceptance Criteria

- [ ] WSL 自动模式下可直接编辑或粘贴 WSL UNC Home，首次输入自动切为手动模式。
- [ ] WSL 模式下输入合法路径后可以保存，不再被 Windows 路径校验错误拦截。
- [ ] 切回本地运行环境后，原有 Windows 目录选择与绝对路径校验不回归。
- [ ] 自动解析、恢复自动配置在 Local 与 WSL 下行为一致且不会留下不可编辑状态。
- [ ] 中英文界面文案与 aria 标签保持完整。
- [ ] 前端类型检查与相关测试通过。

## Definition of Done

- 根因陈述、场景矩阵与代码触点清单已记录。
- 实现、必要测试、`CHANGELOG.md` 与 `docs/功能清单.md` 已更新。
- GitNexus 变更影响检测和 Trellis 质量检查通过。

## Out of Scope

- 新增通用 WSL 文件浏览器或改变 WSL 发行版管理方式。
- 修改其他供应商配置能力。

## Technical Notes

- Changelog Target: `[TEMP]`
- 根因陈述：前端 `NativeProviderHomeSection` 同时用“自动模式”禁用 Home 输入、用“WSL 环境”禁用原生目录选择器，导致 WSL 自动模式的两个路径入口同时不可用；修复应落在该组件的模式切换与可编辑状态边界。
- GitNexus 刷新因 `.gitnexus/lbug` 访问被拒而失败，影响分析返回 `UNKNOWN`；已按降级规则用契约与源码搜索确认调用关系。
- 代码触点：
  - `NativeProviderHomeSection.tsx`：直接根因与唯一实现改动点。
  - `NativeProviderSettingsPage.tsx`：唯一直接挂载者，确认无需改动。
  - `useNativeProviderHome.ts`：负责草稿、预览、保存与恢复，现有 `setMode`/`setHomePath` 足够，确认无需改动。
  - `src-tauri/src/provider/home.rs`：已按发行版验证 WSL UNC、存在性与读写权限，确认无需改动。
  - `i18n.ts`：现有中英文说明和占位符已覆盖 WSL UNC，确认无需新增文案。
  - `ccs-provider-domain-contracts.md`：明确 WSL 禁用原生选择器但支持粘贴绝对路径；需补充自动模式直接编辑的行为契约。
- 场景矩阵：
  - Local + 自动：输入禁用、原生目录选择可用，选择后切到手动。
  - Local + 手动：输入和原生目录选择均可用。
  - WSL + 自动：原生目录选择禁用，输入可编辑，首次输入切到手动。
  - WSL + 手动：输入可编辑，原生目录选择禁用。
  - 任一环境 + busy：输入与选择器都禁用，避免重复提交。
  - WSL 手动路径为空/非法/发行版不匹配：沿用现有保存禁用或后端稳定错误码。
  - 恢复自动：重新使用目标环境自动探测结果，仍可在 WSL 下再次直接编辑。

## Technical Approach

保持 WSL 原生目录选择按钮禁用；仅在 WSL 自动模式放开 Home 输入，并在输入事件中先将草稿模式切换为 `manual`，再写入路径。Local、后端校验、IPC 和持久化结构保持不变。

## Decision (ADR-lite)

**Context**: WSL 无法使用 Windows 原生目录选择器，但现有自动模式同时禁用了文本输入。

**Decision**: 复用现有手动 WSL UNC 流程，让 WSL 自动模式的输入框成为“编辑即转手动”的入口。

**Consequences**: 改动集中、无需新增 IPC；本任务不建设新的通用 WSL 文件浏览器。

**Approval**: 用户已于 2026-08-11 确认该方案。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
