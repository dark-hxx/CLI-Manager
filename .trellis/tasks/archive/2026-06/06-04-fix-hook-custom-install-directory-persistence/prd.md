# Fix hook custom install directory persistence

## Goal

修复 Hook 设置页中 Claude/Codex 自定义配置目录只在当前页面内有效的问题。用户选择自定义安装目录后，切换设置页选项再回来，不应回退到默认 `~/.claude` / `~/.codex`。

## What I already know

* 用户反馈：Hook 设置中可自定义 Claude/Codex 安装目录，但切换选项再回来又变成默认安装位置。
* `src/components/settings/pages/HookSettingsPage.tsx` 使用组件本地 state 保存 `selectedDir` / `codexSelectedDir`。
* 页面首次挂载时调用 `refreshStatus(undefined)`，后端会在未传入目录时解析默认目录。
* 后端 `hook_settings_get_status` 已支持 `selectedDir` / `codexSelectedDir` 参数，问题主要在前端没有持久化所选目录。
* `src/stores/settingsStore.ts` 已通过 `tauri-plugin-store` 持久化 Hook 弹框设置，适合复用保存 Hook 配置目录。

## Requirements

* 新增并持久化 Claude Hook 配置目录设置。
* 新增并持久化 Codex Hook 配置目录设置。
* Hook 设置页首次进入时优先使用已保存目录刷新状态。
* 用户重新选择目录后立即保存，并用新目录刷新状态。
* 安装、删除、刷新 Hook 状态都继续使用当前已保存/已选择目录。

## Acceptance Criteria

* [x] 选择 Claude 自定义目录后，离开 Hook 设置页再回来仍显示该目录。
* [x] 选择 Codex 自定义目录后，离开 Hook 设置页再回来仍显示该目录。
* [x] 刷新状态不会把已保存的自定义目录覆盖成默认目录。
* [x] 安装/删除 Hook 仍作用于用户选择的目录。
* [x] TypeScript 类型检查通过。

## Definition of Done

* 最小代码改动，不引入新依赖。
* 相关状态持久化到现有 settings store。
* 不改 Hook 脚本安装语义，不扩大 Tauri 权限。
* 用户负责最终 UI/构建验证，除非明确要求我执行。

## Out of Scope

* 不改 Claude/Codex Hook 脚本内容。
* 不增加“恢复默认目录”按钮，除非用户后续要求。
* 不调整 Codex/Claude 默认目录解析规则。

## Technical Approach

在 `settingsStore.ts` 增加两个 nullable 字符串设置：`claudeHookConfigDir`、`codexHookConfigDir`。`HookSettingsPage.tsx` 初始化本地 state 时读取这两个设置；选择目录成功后调用 `updateSetting` 持久化；刷新/安装/删除继续传当前目录给后端。

## Technical Notes

* 影响文件：`src/stores/settingsStore.ts`、`src/components/settings/pages/HookSettingsPage.tsx`。
* 后端 `src-tauri/src/commands/hook_settings.rs` 已支持接收目录参数，暂不需要改。
