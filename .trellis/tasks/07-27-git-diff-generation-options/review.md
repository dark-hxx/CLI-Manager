# Self Review

## Scope

- 任务：`扩展 Git Diff 空白与上下文选项`
- 风险：CRITICAL。GitNexus 对 `GitTransport.getFileDiff` 的影响分析识别 1 个直接依赖、139 个扩散符号和 66 条潜在流程；改动跨设置、共享 Viewer、Desktop Rust、SSH bridge 与 Agent 协议。
- 结论：默认 `exact + 3` 保持旧请求语义；非默认选项通过显式 capability 协商，并在忽略空白时关闭部分回滚能力。

## Scenario Matrix

- [x] Windows / Linux / macOS：Desktop libgit2 使用同一枚举、默认值和后端验证边界。
- [x] WSL：`/mnt` 仓库继续走 native libgit2，其余 UNC 仓库使用 Git CLI 对应参数。
- [x] SSH：默认选项走 legacy `gitDiff`；非默认选项走 `gitDiffWithOptions` 和 `gitDiffOptions` capability。
- [x] 根仓库 / 嵌套仓库：选项只扩展 Diff 请求，不改变 repository id 和文件相对路径。
- [x] 未跟踪 / 冲突 / 二进制 / 非 UTF-8：保持原有只读或安全降级，不能开启部分回滚。
- [x] 设置恢复 / 偏好同步：非法旧值迁移到 `exact + 3`，两个字段均属于 `preferences`。
- [x] 中英文：空白模式、上下文、升级提示和回滚禁用原因均同步。

## Findings And Fixes

1. 初版显式默认选项会给 legacy `gitDiff` 携带 `options`，旧 Agent 的 `deny_unknown_fields` 会拒绝请求。
   - 修复：默认值和省略值都使用无 `options` 字段的 legacy wire shape；增加前端契约测试。
2. 初版仅在调用层判断 Agent capability，仍可能把不支持的请求写入 bridge。
   - 修复：daemon 在生成 request id 和写帧前校验 `gitDiffOptions`；缺失时直接返回可翻译错误。
3. 初版只隐藏非 exact 模式的 Hunk/行级回滚入口，回调仍可被直接调用。
   - 修复：后端强制 `canRevertHunks=false`，Controller 的两个 mutation 回调再次检查 capability。
4. Desktop 与 Agent 原 Git 文件已过大，继续内联 Diff 逻辑会扩大职责混杂。
   - 修复：分别抽取 `git_diff.rs`、显示编码模块和独立测试文件；本任务新增职责文件均不超过 300 行。

## Verification

- [x] `npx tsc --noEmit`
- [x] `npm run build`
- [x] 8 个前端 Git Diff/Git Store 契约文件，共 34 项通过。
- [x] Desktop `cargo test --lib commands::git`：59 项通过。
- [x] daemon capability 前置拒绝测试通过。
- [x] SSH Agent 全量测试：69 项库测试、3 项 CLI 测试通过。
- [x] Desktop 与 SSH Agent `cargo check` 通过。
- [x] `cargo fmt --all -- --check` 通过。

当前 Rust `1.95.0` 未安装 `cargo-clippy`，因此未执行 clippy。Desktop 全量 `cargo test --lib` 的 4 个既有失败位于 Pi Hook、AskPass 和历史日志测试；AskPass 隔离复跑通过，其余失败不在本任务触点内。未启动 Tauri 桌面应用，跨系统和中英文手工切换保留在父任务最终验收矩阵中。
