# Technical Design

## Root-Cause Statement

问题位于 Hook 后端对工具必需模块的建模、用户扩展文件所有权边界和 Pi 生命周期事件映射：通用状态判定错误要求 Pi 支持不存在的 attention 模块，写入边界没有拒绝非自有文件，生成器又把同一轮两个生命周期事件映射成同一通知，因此修复必须落在这些源头。

## Changes

1. 为 `ToolChecks` 增加 attention 是否必需的显式字段，Claude/Codex 保持必需，Pi 设置为非必需。
2. 写入 Pi 扩展前统一检查现有文件；仅不存在或包含 `PI_EXTENSION_MARKER` 时允许写入。
3. Pi 运行状态只监听 `agent_start`，删除重复的 `before_agent_start` 上报。
4. 继续使用 `pickByLanguage()` 和 `t()`；其 `zh-TW` 分支由 OpenCC 转换简体文案，避免另建第三套内联文案 API。
5. 将 Pi 稳定错误码的前端映射收口到共享模块，设置页与侧边栏复用；回放来源分支显式识别 `pi`。

## Compatibility

- 已安装的 CLI-Manager Pi 扩展可正常重装、模块增删和卸载。
- 非 CLI-Manager 同名扩展不再被覆盖。
- Claude/Codex 状态计算保持现状。
- IPC payload 和持久化字段不变。

## Scenarios

- 本地 PowerShell/CMD/Pwsh、WSL/Bash：共享 PTY 环境注入逻辑不变。
- 仅 Pi 安装：Pi 为 `installed` 后可独立启用 Hook 环境。
- Claude/Codex/Pi 混合安装：每个启用工具独立参与健康状态聚合。
- Pi 全装、部分安装、未安装、用户同名文件冲突：分别得到 installed、partial、not installed、明确错误。
- 界面语言：简中原文、繁中自动转换、英文文案。

## Rollback

改动集中于 Pi Hook 生成/状态逻辑和文案入口；回退对应提交即可，不涉及数据迁移。
