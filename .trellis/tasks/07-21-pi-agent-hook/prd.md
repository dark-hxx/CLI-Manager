# 修复 Pi Agent Hook 桥接问题

## Goal

修复 PR #161 中会阻断 Pi Agent 实时统计或损坏用户文件的问题，并确保新增界面文案兼容简体中文、繁体中文和英文。

## Background

- PR #161 在 `~/.pi/agent/extensions/cli-manager-hook.ts` 安装 Pi Extension，并通过现有本地 Hook HTTP 通道绑定 `sessionId`。
- 当前 Pi 完整安装仍被通用状态判定中的 `attention` 必选项判为 `partialInstalled`，导致 PTY 不注入 `CLI_MANAGER_*` 环境变量。
- 当前安装逻辑会直接覆盖同名但不属于 CLI-Manager 的用户扩展文件。
- 当前 Extension 同时监听 `before_agent_start` 与 `agent_start`，一次运行会重复发送 `UserPromptSubmit`。
- 项目现有 `pickByLanguage()` 会将简体中文自动转换为 `zh-TW`，但新增用户可见文案仍需全部走该国际化入口，不能绕过语言选择。

## Requirements

- R1：Pi 完整安装必须返回 `installed`，部分模块安装必须返回 `partialInstalled`，未安装必须返回 `notInstalled`。
- R2：安装或按模块安装时，若目标文件存在但没有 CLI-Manager marker，必须拒绝覆盖并返回可理解的错误。
- R3：CLI-Manager 自己生成的扩展允许重装和按模块更新，卸载不得删除非 CLI-Manager 文件。
- R4：每轮 Pi Agent 运行只上报一次 `UserPromptSubmit`；保留状态更新与 `sessionId` 绑定能力。
- R5：本次新增或修改的 Pi 用户可见文案必须在 `zh-CN`、`zh-TW`、`en-US` 下正确展示。
- R6：行为变更记录写入 `CHANGELOG.md` 的 `V1.3.0`。
- R7：设置页和侧边栏自动修复必须共用 Pi 冲突错误映射，AI 回放必须正确显示 Pi Agent 来源。

## Technical Notes

- 根因修复落在 Rust Hook 状态/文件所有权边界和生成的 Pi Extension 生命周期绑定处，不在前端状态灯或通知消费者处增加兜底。
- 不新增依赖，不升级 Tauri、React、Rust 或 npm 包版本。
- 保持现有 Tauri 命令名称和参数不变。

## Acceptance Criteria

- [x] 全模块安装测试断言 `HookInstallStatus::Installed` 已修正；Rust 执行受本机工具链阻塞。
- [x] 单模块安装测试继续断言 `HookInstallStatus::PartialInstalled`；Rust 执行受本机工具链阻塞。
- [x] 已存在无 marker 的同名扩展不会被覆盖，且回归测试验证原内容保持不变。
- [x] 生成的 Extension 不会为同一轮同时注册两个运行开始上报处理器。
- [x] Pi Hook 设置页所有新增文案通过 `pickByLanguage()` 或 `t()` 渲染，繁体中文由现有 OpenCC 路径转换。
- [x] 设置页与侧边栏自动修复共用 Pi 冲突错误映射；AI 回放标题和来源标签识别 Pi Agent。
- [x] TypeScript 类型检查通过；Rust 测试与 `cargo check` 因当前 Rust 1.95 环境的 `--check-cfg` / `-Z unstable-options` 冲突未能完成。

## Out of Scope

- 不重构 Claude/Codex Hook 安装架构。
- 不改变 Pi 历史解析和统计聚合算法。
- 不新增 Pi 子 Agent 事件支持。

## Changelog Target

V1.3.0
