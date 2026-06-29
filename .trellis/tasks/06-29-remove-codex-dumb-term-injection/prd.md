# remove codex dumb term injection

## Goal

移除 CLI-Manager 在内置终端启动 Codex 时对 `TERM=dumb` 的强制注入，避免 Codex 启动时弹出 `Codex's interactive TUI may not work in this terminal` 警告，同时保持其他终端环境变量逻辑不变。

## Requirements

* Codex 新建终端会话时不再额外注入 `TERM=dumb`
* Codex 分屏终端会话时不再额外注入 `TERM=dumb`
* Codex 恢复持久化会话时不再额外注入 `TERM=dumb`
* 保留现有 shell runtime monitoring 环境变量注入逻辑
* 清理因此失效的本地判断参数或辅助函数，不保留死代码

## Acceptance Criteria

* [ ] `src/stores/terminalStore.ts` 不再对 Codex 启动分支写入 `TERM = "dumb"`
* [ ] PTY 创建相关调用仍能正常编译，且不再传递无用 `codexLaunch` 参数
* [ ] `npx tsc --noEmit` 通过
* [ ] 手动新开 Codex 会话时，不再出现 `TERM is set to "dumb"` 警告

## Definition of Done

* 改动限制在实现该修复所需的最小范围
* 无新增依赖，无配置变更
* 完成静态校验并列出手动验证项

## Technical Approach

直接收敛到 `src/stores/terminalStore.ts` 的 PTY 环境变量构建逻辑，删除 Codex 专用 `TERM=dumb` 注入，并同步移除只为该分支服务的 `codexLaunch` 判断链路。

## Decision (ADR-lite)

**Context**: Codex 的警告由 CLI-Manager 自己注入的 `TERM=dumb` 触发，而不是 Codex 启动命令参数导致。  
**Decision**: 不再对 Codex 做特殊 `TERM` 覆盖，恢复默认终端能力声明。  
**Consequences**: Codex TUI 将按真实终端能力运行；需要手动确认现有终端渲染未出现回归。

## Out of Scope

* 不修改 Codex 启动命令本身
* 不调整 xterm scrollback、alternate screen、ConPTY 或 hook 逻辑
* 不新增设置项

## Technical Notes

* 注入点位于 `src/stores/terminalStore.ts:689`
* `buildPtyEnvVars` 的 GitNexus 上游影响评估为 `LOW`
* `isCodexPtyLaunch()` 仅在 `src/stores/terminalStore.ts` 内部被 3 处调用，可随本次改动一并清理
