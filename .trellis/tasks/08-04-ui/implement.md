# 原生供应商大屏详情与全局切换 UI 调整实施计划

## Phase 1：页面与详情壳

- [x] 更新 `NativeProviderSettingsPage`：响应式大屏高度、详情 Tab 状态和供应商/类型切换重置。
- [x] 更新 `NativeProviderEditor`：拆分四个 Tab 内容，确保 basic/effective/keys/documents 内容完整挂载。
- [x] 将现有 `NativeProviderGlobalSection` 复用到基本信息 Tab，明确展示当前全局状态和 preview/apply 操作。

## Phase 2：详情子组件与 Codex/Grok

- [x] 调整 Key、文档和预览区的容器高度/滚动与 Tab 语义，避免内容裁剪。
- [x] 核对 Codex/Grok 基础表单、Key、auth/config 文档的同构展示；不改变 Claude 专属逻辑。
- [x] 保证供应商切换、类型切换、刷新和错误状态不会残留错误 Tab。

## Phase 3：文案、回归与收尾

- [x] 新增 Tab、全局状态、全局操作、空态和 ARIA 文案并同步 zh-CN/en-US。
- [x] 添加/更新纯逻辑回归测试，覆盖默认 Tab、切换重置和详情分区映射。
- [x] 运行 `npx tsc --noEmit`、`cargo fmt --all -- --check`、`cargo check`、`cargo test`、`git diff --check`、i18n parity 和 GitNexus detect_changes compare master；运行时 UI、WSL、macOS 仍按验收记录保持 BLOCKED。
- [x] 更新 acceptance、HANDOFF、spec、CHANGELOG `[TEMP]` 和 `docs/功能清单.md`。

## Runtime feedback fixes (2026-08-04)

- [x] Common/provider/document editors now use stable Monaco paths/models; common collapse keeps the editor mounted.
- [x] Global current detection prefers exact materialized target matching and falls back to the database current flag for drift states.
- [x] Global action buttons wrap without being squeezed; detail duplicate action removed.
- [x] Provider create/edit exposes provider-specific JSON/TOML documents; backend preserves key-manager-owned secrets during update.
- [x] Global confirmation displays the app-specific config root, and Apply auto-preflights when no explicit Preview was requested.

## Runtime feedback: advanced provider maintenance (2026-08-04)

- [x] Add one shared Codex/Grok advanced section for upstream/wire API, model mappings, User-Agent, JSON header/body overrides, Goal mode and remote compression.
- [x] Persist non-secret advanced values in the existing provider settings envelope under `advanced`; preserve key-manager-owned secrets and unknown raw config fields.
- [x] Generate an empty provider-specific document from typed fields: Claude JSON, Codex TOML and Grok TOML; stop auto-generation after the user manually edits the raw document.
- [x] Validate override objects and model mappings before save; add regression coverage for generation and envelope round-trip.
- [ ] Runtime verify advanced controls, TOML rendering and edit/reopen persistence in Windows Tauri UI; WSL/macOS remain environment-blocked.

## 约束

- 不运行 dev/build/tauri dev/tauri build。
- 不添加依赖、不升级框架、不 reset/checkout/commit/push。
- 修改函数、类或方法前先运行 GitNexus upstream impact；UNKNOWN 需人工复核，HIGH/CRITICAL 先停下复核。
