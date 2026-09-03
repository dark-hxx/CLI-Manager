# Hook 系统通知自定义声音实施计划

## Step 1：任务启动与影响确认

- [x] 创建任务并确认用户范围：Windows、本机全局 WAV、替换默认声、保存本机路径、选择/清除。
- [x] 完成 fix-triage：这是跨设置持久化、前端 UI、IPC 和 Windows 进程/API 的新需求，走新功能场景枚举，不走最小修复。
- [x] 完成分支检查：`master` 与 `origin/master` 已同步（`0 0`）；已有 `AGENTS.md`、`CLAUDE.md` 修改不属于本任务。
- [x] 完成 GitNexus 影响分析：`Settings` 236 个上游符号、75 个直接依赖、`CRITICAL`；`App.tsx`、`HookSettingsPage.tsx`、`syncSettings.ts` 为 LOW；Rust 文件级索引为 LOW 且未解析具体命令符号，补充以契约和源码交叉检查。
- [x] 任务启动前重新确认工作区只包含预期任务文档和用户已有修改。

## Step 2：设置模型与同步策略

- [x] 在 `Settings` 和默认值中加入 `systemNotificationSoundPath: string | null`。
- [x] 增加纯 migration，坏值回退为 null，保留存在但失效的路径用于 UI 提示。
- [x] 在 `SETTING_BACKUP_POLICY` 中明确标记为 `excluded`，验证 sync 类型穷举仍通过。

## Step 3：Rust 路径校验与声音播放

- [x] 扩展 `windows-sys` 的 `Win32_Media_Audio` feature。
- [x] 在 `system_notification.rs` 增加 WAV 路径校验、canonicalization、常规文件/大小/RIFF-WAVE 检查和稳定错误码。
- [x] 增加 Windows `PlaySoundW` 异步播放 helper 与 preview/validate commands。
- [x] 给 interactive notification 增加可选 `custom_sound_path`，有效自定义路径静音 Toast 并异步播放；无效配置只 warning 并保持现有通知。
- [x] 在 `src-tauri/src/lib.rs` 注册新增 commands，确认 capability 不需要扩大 fs/asset scope。
- [x] 补充 Rust 单元测试，覆盖验证边界和跨平台 cfg。

## Step 4：前端 Hook 设置与通知接线

- [x] 在 `HookSettingsPage` 增加 Windows-only 选择/状态/试听/清除 UI。
- [x] 使用 dialog WAV filter，选择后先调用 Rust validate，再持久化路径。
- [x] 对启动/路径变更进行失效检查；所有 toast、按钮、状态、aria 文案双语化。
- [x] 在 `sendSystemNotification` 传入可选路径，不改变总开关、事件筛选、聚焦、后台、权限、WSL fallback 和点击跳转流程。
- [x] 更新 `src/lib/i18n.ts` zh-CN/en-US 两套 key。

## Step 5：契约、产品记录与验证

- [x] 更新 `.trellis/spec/backend/cli-hook-contracts.md` 的系统通知签名、行为和测试矩阵。
- [x] 更新 `CHANGELOG.md` 的 `V1.3.9` 版本段，引用 `Refs #239` 的提交说明。
- [x] 更新 `docs/功能清单.md` 的 `Hook 通知` 功能板块。
- [x] 运行 `npx tsc --noEmit`。
- [x] 运行 `cd src-tauri && cargo check`。
- [x] 运行 `cd src-tauri && cargo test`。
- [x] 运行 `git diff --check`。
- [x] 运行 GitNexus `detect_changes({ scope: "all" })`，确认只影响预期符号/流程。
- [ ] 人工在 Windows 桌面验证自定义 WAV 播放、默认回退、通知点击和所有场景矩阵边界。

验证备注：本次前端生产构建、Windows Rust 单元测试和 Rust 编译检查均通过；全仓 `cargo fmt --all -- --check` 仍受任务开始前 `src-tauri/src/provider/database.rs` 的既有格式差异影响，目标文件 `system_notification.rs` 已单独通过 rustfmt 检查。实际 Windows 桌面通知/音频交互仍需在可运行桌面环境手动验收。

## Risky Files

- `src/stores/settingsStore.ts` — `Settings` 高扇出，保持新增字段兼容。
- `src/App.tsx` — 系统通知入口，不能改变既有准入/fallback 语义。
- `src/components/settings/pages/HookSettingsPage.tsx` — Windows-only 设置交互与失效状态。
- `src/lib/syncSettings.ts` — 必须排除机器本地绝对路径。
- `src/lib/i18n.ts` — 两套翻译 key 必须成对出现。
- `src-tauri/src/commands/system_notification.rs` — IPC 输入校验、Win32 播放和交互通知。
- `src-tauri/src/lib.rs` — command 注册。
- `src-tauri/Cargo.toml` — 仅扩展已有 `windows-sys` feature。
- `CHANGELOG.md`、`docs/功能清单.md`、`.trellis/spec/backend/cli-hook-contracts.md` — 交付记录和契约同步。

## Dependency Order

1. Settings/sync contract and Rust validation helper.
2. Rust commands and interactive notification extension.
3. Frontend settings UI and App IPC payload.
4. i18n, contracts, product records.
5. Type/build/test/diff/GitNexus verification and manual handoff.
