# 修复供应商弹框层级与 KNX 路径跳转：实施计划

1. 在 `NativeProviderSettingsPage` 采用已有的供应商嵌套确认层级，验证删除流程和非删除确认流程未改变。
2. 在 `open_folder_in_explorer` 的 Windows 边界归一化 slash-prefixed drive path，并复用现有 WSL UNC normalizer；为纯路径转换添加 Rust 单测。
3. 在 `scripts/terminalFileLinks.test.mjs` 断言 `/F:/.../project.knxproj` 的识别与前端 IPC 路径归一化契约。
4. 更新 `CHANGELOG.md` 的 `V1.3.8` 条目以及 `docs/功能清单.md` 的终端输出、原生供应商条目。
5. 验证：`node scripts/terminalFileLinks.test.mjs`、`npx tsc --noEmit`、`cd src-tauri && cargo test normalize_windows_explorer_path`、`cd src-tauri && cargo check`；最后使用 GitNexus `detect_changes()` 检查实际影响范围。
