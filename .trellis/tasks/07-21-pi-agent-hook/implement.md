# Implementation Plan

1. 检查 `build_pi_status`、`status_from_checks`、`install_pi_modules`、`pi_extension_source` 及其调用点。
2. 修正工具必需模块判定并补齐 Claude/Codex/Pi 初始化值。
3. 增加 Pi 扩展所有权写入保护及回归测试。
4. 删除重复运行事件注册并增加生成内容断言。
5. 审计 PR 新增 Pi 文案的简中、繁中、英文路径。
6. 更新 `CHANGELOG.md` 的 `V1.3.0`。
7. 运行定向 Rust 测试、`cargo check`、`npx tsc --noEmit` 和变更范围检查。
8. 二次审查补齐侧边栏冲突错误本地化与 Pi 回放来源标签。

## Risky Files

- `src-tauri/src/commands/hook_settings.rs`：Hook 安装文件写入与三种工具共享状态计算。
- `src/components/settings/pages/HookSettingsPage.tsx`：大量用户可见文案和模块操作入口。
- `src/lib/i18n.ts`：语言路由，避免破坏现有 OpenCC 繁中转换。

## Validation Commands

- `cargo test install_then_uninstall_pi_extension`
- `cargo test install_pi_single_module_only_enables_requested_event`
- 新增的非自有文件保护测试
- `cargo check`
- `npx tsc --noEmit`
