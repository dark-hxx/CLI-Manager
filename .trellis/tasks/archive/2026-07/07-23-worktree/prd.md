# 修复 Worktree 创建并发与错误截断

## Changelog Target

V1.3.1

## Goal

修复 Windows 下创建 Git Worktree 时重复请求互相撞路径、Git 失败原因不可见以及前端出现 `Uncaught (in promise)` 的问题，让一次创建操作可控失败并给出可行动的错误信息。

## Confirmed Facts

- `src/stores/worktreeStore.ts:createWorktreeForProject` 只有 Git 创建成功并写入 SQLite 后才记录 Worktree；创建耗时期间重复请求会复用同一个默认任务名。
- `src-tauri/src/commands/git_worktree.rs:git_worktree_create` 对 Git 输出使用前 300 个字符。Git checkout 进度位于前部，最终 `fatal/error` 常位于后部，因此真实原因被截断。
- Git `worktree add` 失败后会回滚未完成目录；后端失败清理函数只尝试清理本次新建的 `wt/` 分支。
- Sidebar 的自动创建、手动隔离和分屏创建调用使用 `void`，失败未统一捕获，浏览器控制台出现未处理 Promise。

## Requirements

1. 同一项目、同一任务名的 Worktree 创建在请求完成前不得并发进入 Rust 创建命令；重复触发不得产生新的目录或分支。
2. 创建失败后必须释放进行中状态，后续用户可重新创建；已成功的 Worktree 不能重复写入数据库。
3. Rust 返回的 `git_failed` 信息必须包含 Git 最终错误内容，不能只返回 checkout 进度前缀。
4. 自动创建、手动隔离、分屏隔离三条前端路径必须捕获创建异常并显示中英文一致的本地化错误提示。
5. 不复用已存在路径，不删除用户未明确创建的目录或分支；保留现有 `wt/` 分支安全校验。
6. 不新增依赖，不改变 Tauri command 参数和成功返回结构。

## Acceptance Criteria

- [x] 快速重复触发同一个项目的自动/手动 Worktree 创建时，只有一个 `git_worktree_create` 请求；不会出现连续的 `worktree_path_exists` 噪声。
- [x] 首次 Git 创建失败时，错误提示包含最终 Git 错误，而不是仅显示 `Checking out files...`。
- [x] 创建失败不会留下前端进行中锁；修正环境后再次创建可以成功。
- [x] 自动创建、手动隔离、分屏隔离失败均不会产生 `Uncaught (in promise)`。
- [x] Rust 单元测试覆盖错误尾部提取；前端类型检查覆盖进行中创建状态的类型与调用链；`npx tsc --noEmit` 与 Worktree 定向 Rust 测试通过。
- [x] `CHANGELOG.md` 的 V1.3.1 条目记录本修复，中文与英文新增文案均存在。

## Out of Scope

- 不改变 Git/LFS、权限、杀毒软件等外部环境问题的处理策略；修复后将真实错误暴露给用户。
- 不重构 Worktree 生命周期、数据库 schema 或 merge/remove 流程。

## Verification

- 用户已在桌面端确认 Worktree 创建修复成功。
- `npx tsc --noEmit` 通过。
- `cargo test --manifest-path src-tauri/Cargo.toml git_worktree -- --nocapture`：20 项通过。
- Rust 全量测试：712 项通过、1 项忽略；既有 `hook_settings::install_then_uninstall_pi_extension` 失败，与本任务无关。
