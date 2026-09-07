# 侧边栏快捷切换跟随 CLI Home 全局供应商

## Goal

TBD.

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
# 侧边栏快捷切换跟随 CLI Home 全局供应商

## Changelog Target

`[TEMP]`

## Goal

让侧边栏快捷切换供应商与设置中的全局供应商切换使用同一条 CLI Home 应用链路，并在侧边栏供应商切换界面展示当前 Home 运行模式（本机或 WSL），避免项目级临时快照与全局真实配置产生语义差异。

## What I already know

* 侧边栏打开 `ProviderSwitchModal`，当前写入项目/Worktree `provider_overrides`，终端启动时走 `provider_scope_prepare` 生成隔离快照。
* 设置页 `useNativeProviderHome` 已通过 `provider_home_active_get` 加载当前 Home，并将 `homeIdentity` 传给 `provider_global_preview/apply`。
* 当前全局 Home identity 区分 `local:host` 与 `wsl:<distro>`；Home 选择和全局应用均由后端持久化、校验并执行。
* 前端新增用户可见文案必须同时覆盖 `zh-CN` 与 `en-US`。

## Requirements

* 侧边栏快捷切换选中供应商后，使用当前 CLI Home 的全局 preview → 确认 → apply 流程，不再写项目/Worktree 供应商覆盖。
* 侧边栏“跟随全局/重置”语义调整为刷新当前全局供应商状态，不产生项目/Worktree 覆盖；已有覆盖需要保持可识别并允许清理。
* 供应商切换界面显示当前 CLI Home 模式图标和本地化标签：本机或 WSL；模式来自实际 active Home identity，而不是静态默认值。
* Home 不可用、供应商未配置 key、preview/apply 冲突或失败时，沿用设置页稳定错误码和确认/失败反馈，不修改项目配置。
* 覆盖现有项目/Worktree、主项目、多个终端、Worktree、Local、WSL 等场景，并保持中英文和可访问性标注。

## Acceptance Criteria

* [ ] 侧边栏选择供应商后，后端实际写入当前 active CLI Home 对应的真实配置文件，新启动 CLI 使用该供应商。
* [ ] 侧边栏切换流程与设置页全局切换共享 preview、确认、指纹冲突和 apply 语义。
* [ ] 侧边栏界面能正确显示 local 与 WSL 图标/标签，切换语言后文案和 aria-label 均正确。
* [ ] 侧边栏不再因供应商选择新增或保留项目/Worktree provider override；清理旧覆盖后能跟随全局。
* [ ] 运行 `npx tsc --noEmit`，并完成相关 Rust 检查/测试。
* [ ] 更新 `CHANGELOG.md` `[TEMP]` 与 `docs/功能清单.md`。

## Definition of Done

* 实现、类型检查和相关测试完成。
* 手动验证 Local/WSL、项目/Worktree、中文/英文以及已有覆盖清理场景。
* 变更记录和功能清单已更新。

## Out of Scope

* 不改变设置页已有 CLI Home 选择、探测、保存和 Hook 根目录认领逻辑。
* 不新增供应商目录、API key 或 failover 功能。
* 不改变终端启动时对其他来源（显式 provider scope）的通用协议，除非为兼容旧覆盖清理所必需。

## Technical Notes

* 相关前端：`src/components/ProviderSwitchModal.tsx`、`src/components/sidebar/index.tsx`、`src/components/settings/providers/useNativeProviderHome.ts`、`src/lib/i18n.ts`。
* 相关后端：`src-tauri/src/provider/home.rs`、`src-tauri/src/provider/global.rs`、`src-tauri/src/commands/provider.rs`。
* 规范：`.trellis/spec/frontend/ccs-provider-domain-contracts.md`、`.trellis/spec/backend/ccs-provider-domain-contracts.md`、`.trellis/spec/guides/fix-triage-guide.md`。

## Decision (ADR-lite)

**Context**: 侧边栏原先把供应商选择写成项目/Worktree scope override，导致它与设置页“应用到全局”具有不同目标和终端启动语义；用户还无法从切换面板确认当前配置来自本机还是 WSL。

**Decision**: 侧边栏直接读取 active Home，调用既有 `provider_global_preview` / `provider_global_apply`，复用设置页确认文案和指纹保护；成功后清理已解析的项目/Worktree override，apply 失败则恢复旧 override。使用 Monitor/Globe 图标和 active Home identity 展示 local/WSL。

**Consequences**: 侧边栏切换会影响当前 Home 下后续启动的所有对应 CLI，而不再只影响一个项目/Worktree；项目级隔离切换不再由此入口创建，仍由设置中的 scope 管理入口负责。跨窗口、终端和 Workspan 不额外持有 Home 状态，均读取后端 active Home。

## Discovery List

* [x] `ProviderSwitchModal`: 列表加载、当前 scope 解析、供应商应用和重置入口。
* [x] `provider_home_active_get`: active Home identity 与 local/WSL 模式来源。
* [x] `provider_global_preview/apply`: 设置页既有全局真实 Home 写入、指纹与恢复链路，确认复用而非复制后端逻辑。
* [x] `provider_scope_prepare`: 确认旧 override 会在终端启动时优先于全局，因此成功全局应用后必须清理旧 override。
* [x] i18n：新增切换成功、Home 模式和 aria 文案，zh-CN/en-US 同步。

## Scenario Matrix

* Window focus: 当前窗口、另一个窗口、应用后台时切换状态反馈不丢失。
* Split/session: 当前终端、其他终端、多个 Workspan 不改变全局 Home 目标。
* Minimized/tray: 调用链不依赖窗口可见状态。
* Runtime: Local host 与 WSL distribution 均使用对应 active Home identity。
* Worktree: 主项目和 Worktree 都执行全局 Home 切换，不写 scope override；旧 override 可清理。
* Hook: Hook 已安装、未安装或仅安装一种 CLI 时，全局 apply 遵循现有设置页语义。
