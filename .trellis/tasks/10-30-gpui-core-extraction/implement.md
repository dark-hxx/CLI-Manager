# 实施步骤：M1 根 workspace + 核心 crate 抽取

> 先读：本目录 `prd.md`、`design.md`；父 `design.md` §0.1/§3/§5.1；`.trellis/spec/backend/pty-daemon-contracts.md`；`research/backend-coupling.md`。
> 每批开始前：只读 Git 同步检查；对将移动/修改的公共符号跑 GitNexus `impact`（upstream），HIGH/CRITICAL 先报告。每批结束：`detect_changes({scope:"all"})`、更新 `CHANGELOG.md`（Unreleased：内部重构条目）与必要时 `docs/功能清单.md`（本任务对用户无可见变化，通常只记 CHANGELOG）。

## 0. 抽取前基准（不改代码）
- [ ] 生成命令清单快照：从 `lib.rs` `invoke_handler![]` 导出命令名列表 + 每个命令的参数名（脚本解析或 `tauri-specta` 风格宏不可用时用 grep 脚本），存 `src-tauri/tests/snapshots/commands.txt`。
- [ ] 生成事件清单快照：`grep -rn "\.emit\|emit_to" src-tauri/src` 结果整理为事件名列表。
- [ ] 记录 `npm run tauri build` 产物列表与路径（4 个 exe + 资源）。

## 批 0：根 workspace
1. 新建 `/Cargo.toml`（design §1.2）与 `/.cargo/config.toml`。
2. 把 `src-tauri/Cargo.toml` 的 `[profile.*]` 移到根；公共依赖版本移入 `[workspace.dependencies]`（成员用 `dep.workspace = true`，可分批改）。
3. 锁文件：`cp src-tauri/Cargo.lock Cargo.lock`（覆盖已过时的根锁），`cargo metadata --format-version 1 > /dev/null`，`git diff --stat Cargo.lock` 审查版本变化；删除 `src-tauri/Cargo.lock`、`src-tauri/helpers/Cargo.lock`、`apps/server/Cargo.lock`。
4. 核对脚本：`scripts/package-portable.ps1`、`scripts/tauri-build-local.mjs`(+test)、`scripts/prepare-bundle-binaries.mjs`、`scripts/prepare-helper-binaries.mjs`、`scripts/dev-server.mjs`、`scripts/webConversationRuntime.smoke.mjs`、`package.json` 中的 `tauri:clean*`/`web:server:*`（`--manifest-path`）、`.github/workflows/release.yml`、`ssh-agent-release.yml` 中的路径与 `--manifest-path`。
5. 验证：`npm run check:architecture`（`scripts/architecture.mjs` 以 `src-tauri/src/lib.rs`、`commands/mod.rs` 为 Rust 路由入口，后续批次把实现移到 `crates/core` 后需同步扩展其入口与依赖规则，并用 `--baseline-json` 更新基线；每批都必须通过）；`cargo check --workspace`；`cd src-tauri && cargo test`；`npm run tauri build`（或 `node scripts/tauri-build-local.mjs`）产物路径与第 0 步一致；`node --test scripts/tauri-build-local.test.mjs`。

## 批 1：core 骨架 + 无耦合模块
1. `crates/core/Cargo.toml`；`git mv` `src-tauri/src/shared` 与 `infrastructure/{pty,ssh,webdav,web,system,diagnostics}`、`process`（除 conpty_sideload 的 Tauri 部分）到 `crates/core/src/`。
2. `src-tauri` 中以 `pub use cli_manager_core::{...}` 保持原模块路径可用（减少一次性改动）。
3. 验证：全量测试 + `npm run tauri dev` 冒烟终端。

## 批 2：daemon 服务端与三个 helper bin
1. 移动 `infrastructure/daemon/{server*,protocol,routing,route_http*,circuit,ssh_agent_bridge*,discovery}` 到 core；`server.rs` 的 Origin 白名单改为构造参数（默认值与现状一致）。
2. `src-tauri/helpers` 改依赖 `cli-manager-core`；删除 `src-tauri/Cargo.toml` 中同名 `[[bin]]` 并调整开发期 daemon 定位/构建（design §2）。
3. 验证：`cargo tree -p cli-manager-helpers -e normal -i tauri` 为空；`tauri dev` 下终端可用；`npm run tauri build` 安装包含 4 个 exe；手动：终端、转入后台后重开 attach、本地路由、SSH Agent、Hook 通知。

## 批 3：上下文抽象
1. core 中新增 `context.rs`（AppPaths/UiServices/EventSink/CoreEvent/AppContext）、`error.rs`（CoreError）。
2. src-tauri 新增 `adapters/{event_sink.rs, paths.rs, ui_services.rs}`；setup 中构造 `Arc<AppContext>` 并 `manage`。
3. `DaemonClient`、`app_paths`、`conpty_sideload` 改用抽象。
4. 测试：EventSink 映射快照；`NativePaths` vs `TauriPaths` 对比测试（Windows CI 上运行）。

## 批 4–6：features 迁移
- 每个 feature 一个提交：`git mv` → 修 `use` 路径 → `AppHandle`/`State`/`emit`/`async_runtime` 替换 → Tauri 命令改为薄转发。
- 每个提交后：该 feature 测试 + 命令清单快照对比 + 相关前端冒烟。
- 顺序见 design §8；history 与 providers 体量最大，可再拆子提交（catalog、search、live_transcript、edit_audit / routing、catalog、keys、failover）。

## 批 7：core-db 迁移与连接池
1. `migrations.rs` → `core-db/src/migrations/main.rs`（中立结构），Tauri 侧改为转换调用；先只做这一步并跑一致性测试与真实旧库测试。
2. `DbPool`/`DbPools`；在 Tauri setup 中构造并注入 AppContext。
3. 按 feature 替换临时连接（extensions、remote、providers、stats、history catalog …），每个 feature 一个提交；维护“例外清单”。
4. 批量写入加事务；并发读写压力测试（16 并发读 + 2 写，10 s，无 `database is locked`）。

## 批 8：Repository
- 逐表实现 + 测试；生成“TS 文件:行 → Repo 方法”对照表写入 `core-crate-contracts.md`。

## 批 9：core-prefs
- 实现 + 未知字段往返测试 + 默认值对照测试（新增 `scripts/export-settings-defaults.mjs` 导出 TS 默认值 JSON）。

## 批 10：daemon 协议扩展 + P1 事件
1. protocol：feature 常量、`Auth.client_features`、`session_status` 帧。
2. server：按连接记录协商结果；ACK 单位切换；无 Origin 连接处理；状态推送。
3. client（NDJSON）：声明 `session_status_push_v1`，转发为 `CoreEvent::DaemonSessionStatus`。
4. 请求日志写入、Hook 触发的统计更新、子代理目录 watcher 发出新事件（Tauri 侧不映射）。
5. 测试：design §6 测试清单；更新 `pty-daemon-contracts.md`。

## 批 11：Web 设备 Operation 分发
- `core::web::operations::dispatch` + 与 `useWebDeviceBridge.ts` 分发表的对照测试；Tauri 版行为不变。

## 收尾
- [ ] 写 `.trellis/spec/backend/core-crate-contracts.md`（抽象、事件映射表、命令对照、Repository 对照、连接池规则与例外清单）。
- [ ] 更新 `pty-daemon-contracts.md`、项目根 `CLAUDE.md`/`AGENTS.md` 的架构段落（crate 布局、Hook 端口在 daemon）。
- [ ] 全量冒烟（prd 清单）；`detect_changes --scope compare --base-ref master`。

## 估时
约 6–8 人周（批 6、7 占一半）。

## 回退
每批独立提交；任一批出现无法快速修复的回归，`git revert` 该批即可，后续批次顺延。批 0 失败时直接删除根 `Cargo.toml` 与 `.cargo/config.toml` 并恢复两个锁文件。
