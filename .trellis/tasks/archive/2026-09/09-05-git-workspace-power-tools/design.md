# Git 工作区三阶段增强设计

## Boundaries

```text
GitWorkspace / dialogs
  -> GitTransport typed methods
    -> local Tauri commands
    -> SSH request helpers -> SSH Agent protocol -> remote git CLI
```

前端只决定交互、确认和刷新；引用校验、仓库边界、命令参数和危险选项由 Rust 后端负责。不得接受任意命令字符串。

## Action Model

- 分支、标签、提交和仓库动作使用上下文动作描述，按当前引用类型、脏状态、上游、Transport capability 动态启用。
- 两个现有分支入口复用同一动作定义，避免 Git Changes 与 Git Log 行为漂移。
- 网络/写操作返回结构化结果；冲突态通过 `GitBranchStatus.pendingOp` 驱动继续/中止入口。

## Phase 1 Data

- 最近分支和收藏分支是本机 UI 偏好，按 transport context + repo id 隔离。
- Log 过滤请求使用结构化 filter 对象，后端转为固定 Git 参数。
- Tag 通过独立列表接口获取，不再从已加载提交推导。

## Phase 2 Data

- Stash、Remote、Reflog、Blame 使用只读列表接口和显式动作接口。
- Remote URL 只用于显示/打开经过协议白名单校验的网页，不作为命令解释内容。
- 文件历史/Blame 使用仓库相对路径，并复用已有仓库路径校验。

## Phase 3 Safety

- 交互式 Rebase 前端生成结构化 todo，后端验证每个提交属于选定范围并写入受控 sequence-editor 文件。
- Force Push 仅允许 `--force-with-lease`。
- Bisect 状态来自 `.git/BISECT_*`/Git CLI，不使用仅前端状态。
- Submodule 操作只允许仓库配置中已登记的 path。

## Scenarios

- 前后台、最小化恢复、Git 工作区开关与终端存活。
- 根仓库、嵌套仓库、主 Worktree、linked Worktree、目录缺失。
- Local native、WSL Linux、WSL `/mnt` native 回退、SSH 新旧 Agent。
- 空仓库、detached HEAD、浅克隆、大量 refs、无 remote、多 remote、无 upstream。
- 脏工作区、进行中 merge/rebase/cherry-pick/revert/bisect、网络失败、认证失败、请求迟到。

## Verification

- 使用临时真实 Git 仓库验证引用、标签、stash、remote、reflog、blame、rebase todo、bisect 和 submodule。
- 运行相关 Node/Rust 测试、`npx tsc --noEmit`、两个 Cargo check、`git diff --check`。
- 最终执行 `npm run tauri:build:local -- --bundles nsis`，不构建 MSI、不签名更新包。
