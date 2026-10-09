# 本地提交方案

版本：V1.4.3。当前 master 比本地记录的 origin/master 领先 3、落后 0。

用户决定：保留修改，由用户自行提交。本方案仅供参考，未执行提交、归档或日志写入。

## 1. 修复提交

fix(agents): preserve WSL identity across hooks and diagnostics

内容：合并本任务上次已完成的 WSLENV、Pi/OpenCode producer 修复，以及本次根据客户日志补齐的精确历史来源解析。旧 Hook 缺少发行版时，仅接受同 Agent、同 CLI 会话的 WSL 历史路径；保留现有 cwd 与实例路由。

文件：

- package.json
- package-lock.json
- src-tauri/Cargo.toml
- src-tauri/Cargo.lock
- src-tauri/tauri.conf.json
- src-tauri/src/infrastructure/pty/manager.rs
- src-tauri/src/features/hooks/settings/pi.rs
- src-tauri/resources/opencode/cli-manager-hook.js
- src/features/agents/api/agentCapabilities.ts
- src/features/agents/api/useAgentCapabilities.ts
- scripts/wslHookIdentity.test.mjs
- scripts/agentCapabilities.test.mjs
- .trellis/spec/backend/agent-capability-diagnostics-contracts.md
- .trellis/spec/backend/terminal-runtime-monitoring-contracts.md
- CHANGELOG.md
- docs/功能清单.md
- .trellis/tasks/10-09-fix-wsl-agent-capability-distro/（任务需求、设计、执行/复盘及本方案）

本轮开始时已有的修改已逐项对照原对话与任务记录确认归属，没有纳入不相关文件。

## 2. 任务收尾

修复提交之后使用 Trellis 归档本任务并记录本次会话。归档和日志脚本各生成一个独立 bookkeeping 提交；不处理其他历史任务。

仅本地提交，不 push、pull、merge 或 rebase。

## 验证

- Node 定向回归 55/55。
- Rust WSLENV 回归 7/7。
- npx tsc --noEmit、cargo check、严格架构检查、git diff --check 通过。
- GitNexus detect_changes 对已索引子集报告 low；缺失符号通过直接引用及契约补充审查。
- 本机没有 WSL；真实 Windows/guest interop 与桌面验收仍需 WSL 环境，见 review.md 的人工步骤。

提交确认依据：.trellis/workflow.md 第 627 行，要求先展示方案并获得一次性确认。
