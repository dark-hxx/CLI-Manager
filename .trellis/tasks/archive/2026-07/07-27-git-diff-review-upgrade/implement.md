# Implementation Plan

## Branch and Task Flow

1. 分支固定为 `feat/git-power`，PR 基线为 `master`。
2. 按 D01 -> D02 -> D03 -> D04 -> D05 -> D06 执行实施任务。
3. D07-D09 只完成研究文档，不执行产品代码。
4. 每个子任务单独 `task.py start`、检查、提交、finish；父任务保持路线图角色。
5. 所有子任务完成后回到父任务做综合回归、Changelog 和功能清单收敛。

## Common Quality Gate

- 修改符号前运行 GitNexus upstream impact；不可用时按 fix-triage 产出契约 + `rg` 发现清单。
- 前端运行 `npx tsc --noEmit` 和相关 Node 定向测试。
- Desktop Rust 运行定向测试与 `cargo check`；Agent 改动额外运行 Agent 测试和 fmt/clippy。
- 运行 `git diff --check`，核对中英文文案和设置同步。
- 提交前运行 GitNexus `detect_changes`；不可用时记录降级审查证据。
- 不主动运行 `npm run build/dev` 或 `npm run tauri build/dev`。

## Commit Boundaries

每个实施或研究子任务形成一个独立提交；不得把无关重构混入某个功能提交。父任务最终只做必要的文档收敛提交。
