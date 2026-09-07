# 优化 Tauri 开发构建速度与 target 体积

## Goal

降低 Windows 下 `npm run tauri dev` 的冷启动和热启动等待时间，控制 Rust 开发构建缓存的磁盘占用，同时保留 Codex 远程托管所需的原生 proxy 能力，不改变应用运行时行为。

## Background and confirmed facts

- 当前仓库为 Windows Tauri 2.x 应用，前端由 Vite 提供开发服务，Rust 由 Cargo/Tauri CLI 构建。
- `package.json` 的 `tauri` 脚本进入 `scripts/tauri-cli.mjs`。该脚本在 Windows `dev` 模式下先调用 `cargo build --bin cli-manager-codex-proxy`，然后再启动 Tauri；截图中对应两段 `Finished dev`，耗时约 1 分 32 秒和 1 分 18 秒。
- [scripts/tauri-cli.mjs](../../../scripts/tauri-cli.mjs) 的 proxy 预构建目前只转发 target、profile、target-dir 和 release 选择，没有完整复用 Tauri 实际传给 Cargo 的 feature/构建选择参数；Tauri 日志显示主构建使用 `cargo run --no-default-features`，且 `tauri --config` 会向 Cargo 注入 `TAURI_CONFIG`，两次构建的 fingerprint 输入因此可能不同。
- [src-tauri/Cargo.toml](../../../src-tauri/Cargo.toml) 的 `cli_manager_lib` 同时声明 `staticlib`、`cdylib`、`rlib`，依赖数量较多，当前只配置了 release profile，开发模式使用 Cargo 默认完整调试符号和增量编译设置。
- 2026-09-03 对当前 checkout 的只读统计：`src-tauri/target/debug` 约 93.19 GiB，其中 `debug/incremental` 约 63.07 GiB、`debug/deps` 约 25.58 GiB；release 约 9.90 GiB，总计约 103.18 GiB。多个 clone/worktree 还会进一步叠加体积。
- 增量目录包含大量带 hash 的历史 `cli_manager_lib-*` 目录，说明磁盘问题主要是长期累积的开发缓存和大型 Rust 调试产物，不是最终 exe 本身异常膨胀。
- 现有 `scripts/tauriCliDevProxy.test.mjs` 验证 proxy 预构建必须先于 Tauri、Windows target/release/profile/target-dir 转发、失败时阻止启动；`scripts/codexAppServerProxy.e2e.test.mjs` 验证真实 proxy 的 PE/GUI 子系统和运行行为。这些契约必须保留。

## Root-cause statement

问题位于 Windows 开发启动的 Cargo 构建边界：wrapper 先以一组参数构建共享的大型 Rust library/proxy，再由 Tauri 以另一组参数运行主 binary；Tauri 的 `tauri-build` 还会将 `TAURI_CONFIG` 作为 Cargo fingerprint 输入，旧 wrapper 未复用该输入，导致主程序再次编译。与此同时开发 profile 保留完整调试符号并持续累积增量状态，导致启动阶段重复编译/链接和 `target` 目录失控增长，因此优化应落在构建参数一致性、预构建触发条件及 Cargo profile/缓存治理层，而不是在 UI 启动阶段增加等待或遮罩。

## Requirements

### R1. 建立可比较的构建基线

- 分别记录 proxy 预构建、Tauri 主构建、Vite 首屏和整个 `npm run tauri dev` 的冷启动/热启动耗时。
- 记录 `target/debug`、`incremental`、`deps`、release 目录的体积，区分当前 checkout 与其他 worktree/clone。
- 不把一次清理缓存后的首次全量编译误判为优化后的常态结果。

### R2. 降低开发构建产物体积

- 为开发 profile 增加经过验证的调试信息级别，优先保留应用自身可用的基本源码定位能力，减少第三方依赖的完整 PDB/调试符号。
- 保留日常增量编译能力；不以全局关闭 incremental 作为日常方案。
- 不修改 release profile 的发布语义，避免影响正式包、sidecar 和 updater 产物。

### R3. 消除无效或重复的 proxy 构建成本

- 让 proxy 预构建与 Tauri 主构建使用一致的 target、profile、target-dir、feature 选择，避免因参数不一致生成重复构建图。
- proxy 仍须在 Windows 开发启动前可用；不能简单移除预构建。
- 在不牺牲首次启动正确性的前提下，只有 proxy 源码/相关 Rust 依赖或构建选择实际变化时才触发必要的工作；未变化时不得阻塞启动进行无意义的完整构建。
- 保留现有 target/profile/runner 参数转发和错误退出语义。

### R4. 缓存清理可控且不误删用户数据

- 提供针对当前仓库开发缓存的明确清理方式，并区分 dev、release、交叉编译产物。
- 不在每次启动时自动删除 Cargo 缓存，不删除源码、Cargo registry 或应用数据。
- 对多个 worktree/clone 给出按路径确认后的单独清理策略，避免误操作其他工作区。

### R5. 可观测性与回归

- 日志能区分 proxy 预构建、Tauri 主构建以及跳过/复用原因，并在失败时给出可定位错误。
- 保持非 Windows、`tauri build`、自定义 target/profile/target-dir、Codex proxy 运行行为不变。
- 不新增前端用户可见文案；如后续增加 UI/CLI 文案，必须同时支持 `zh-CN` 和 `en-US`。

## Acceptance Criteria

- [x] 清理旧开发缓存后，Windows `npm run tauri dev` 可以成功启动主程序，Codex proxy 通过现有 proxy 测试和 E2E 验证。
- [x] 热启动（源码未变化）不再执行无意义的 proxy 全量构建；稳定重复启动中 wrapper 约 1.5s、Tauri Cargo 约 1.76s，日志明确显示 Cargo fingerprint 复用路径。
- [x] 修改主程序、proxy 源码、Cargo.lock/Cargo.toml、target/profile 选择后，统一的 Cargo fingerprint 和选择参数会触发必要重编译，不能复用过期 proxy。
- [x] Tauri 的 `--release`、`--profile`、`--target`、`--target-dir` 及 runner/application 参数边界保持现有测试契约；wrapper 测试覆盖长短参数、等号形式和两个 `--` 边界。
- [x] 开发构建仍支持基本 Rust 调试；本次清理后 `target/debug` 约 5.75 GiB（清理前约 93.19 GiB），`debug/incremental` 约 1.95 GiB（清理前约 63.07 GiB），后续重复启动未出现再次累积完整构建产物的现象。该对比受历史缓存污染影响，作为本机观测值记录，不作跨机器绝对阈值。
- [x] `npm run build`、`npx tsc --noEmit`、wrapper Node proxy 测试、`cargo check`/Rust 测试和 Codex proxy E2E 通过。
- [x] `CHANGELOG.md` 使用 `V1.3.9` 记录本次构建优化，`docs/功能清单.md` 在对应构建/开发能力板块同步记录。

## Final validation record (2026-09-03)

- 清理前 `src-tauri/target` 约 103.18 GiB：`debug` 93.19 GiB、`debug/incremental` 63.07 GiB、`debug/deps` 25.58 GiB、`release` 9.90 GiB。
- `npm run tauri:clean:dev -- --dry-run` 只命中当前仓库 dev 产物；实际清理移除 42,394 个文件、约 93.3 GiB，release 产物保留。`npm run tauri:clean -- --dry-run` 另确认全量命令也只指向当前 manifest。清理后当前 target 约 15.74 GiB，其中 `debug` 5.75 GiB、`debug/incremental` 1.95 GiB、`debug/deps` 2.95 GiB、`release` 9.90 GiB。
- 双 binary 冷构建命令耗时约 200.66s；随后直接 Cargo warm build 约 1.52s。实际 `npm run tauri dev` 的稳定重复启动中，wrapper 预构建约 1.5s、Tauri Cargo 约 1.76s，并出现 `CLI-Manager started` 与 `PTY daemon connected`。
- `npm run test:tauri-dev-proxy`：20 checks passed；`npm run build`、`npx tsc --noEmit`、`cargo check --locked --manifest-path src-tauri/Cargo.toml` 通过；`cargo test --locked --manifest-path src-tauri/Cargo.toml`：1,212 passed、0 failed、1 ignored。
- `npm run test:codex-proxy:e2e`：proxy 编译成功，GUI subsystem、普通命令透传、app-server provider 和退出码检查共 4 项通过；测试使用临时 `CODEX_HOME`/profile 夹具，不修改 `C:\Users\1\.codex`。

## Scope boundaries

- 本任务只处理 Rust/Tauri 开发构建耗时、构建缓存体积和 proxy 预构建链路。
- 不在本任务中重构 Rust 业务模块、拆分 `cli_manager_lib` crate、优化 Vite 首屏模块加载或修改应用启动时数据库/历史扫描逻辑；这些属于独立优化项。
- 不自动清理用户机器上其他仓库的 `target`，只提供安全的按路径操作建议。

## Discovery list

- [x] `scripts/tauri-cli.mjs`: `main` → `buildWindowsDevProxy` → Cargo proxy build → Tauri CLI。
- [x] `src-tauri/Cargo.toml`: lib crate types、依赖规模和 profile 配置。
- [x] `src-tauri/tauri.conf.json`: `beforeDevCommand`、dev URL 和正式构建命令边界。
- [x] `.trellis/spec/backend/tauri-updater-contracts.md`: Windows dev proxy 预构建、target/profile 参数及失败阻断契约。
- [x] `scripts/tauriCliDevProxy.test.mjs`: wrapper 参数转发及失败阻断契约。
- [x] `scripts/codexAppServerProxy.e2e.test.mjs`: proxy 二进制和运行时契约。
- [x] 旧版文档/变更记录：proxy 预构建是为 Windows Codex app-server 托管引入，不能按普通冗余代码直接删除。
- [x] GitNexus：`buildWindowsDevProxy` upstream 影响 2 个符号、风险 LOW；`main` 影响 1 个符号、风险 LOW；`cargoBuildSelectionArgs` 影响 3 个符号、风险 LOW。FTS 缺失导致 execution-flow 查询降级，已用源码和现有测试补足证据。

## Resolved decisions

- proxy 的开发启动策略采用“默认保持自动可用，并增加精确的变更检测、构建参数一致性和复用机制”。不采用默认跳过 proxy 的快速模式，避免开发者在使用 Codex 远程托管时遇到缺少 proxy 的运行时故障。
- 开发 profile 接受“应用保留基本源码定位、第三方依赖关闭完整调试符号”的折中，以换取更小的 `target` 和更短的链接时间；正式发布 profile 不变。
- 缓存治理采用手动、按仓库/按 profile 的清理命令，不在启动时按年龄或体积自动删除；避免与并发 Cargo/Tauri 进程或其他 worktree 发生竞态。
- 为了让预构建与 Tauri 的 `tauri-build` fingerprint 完全一致，Windows wrapper 读取当前 `--config` 合并值并为 Cargo 预构建设置同样的 `TAURI_CONFIG`；配置文件或内联 JSON 的合并仅用于复现 Tauri 的构建输入，不改变运行时配置来源。
