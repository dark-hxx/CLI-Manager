# Tauri 开发构建优化实施计划

## 0. 开始前检查

- [x] 再次执行并报告 `git status --short --branch`、`git branch -vv`、`git rev-list --left-right --count 'HEAD...@{upstream}'`：`master` 与 `origin/master` 同步，ahead 0 / behind 0。
- [x] 确认 `AGENTS.md`、`CLAUDE.md` 现有未提交修改不属于本任务，不覆盖、不回滚；另有未跟踪的 workspace task 目录，均保留。
- [x] 记录版本号：`V1.3.9`。
- [x] 运行与待修改函数对应的 GitNexus upstream impact：`buildWindowsDevProxy`、`main`、`cargoBuildSelectionArgs`、`devSpawnEnv` 均为 LOW，无 HIGH/CRITICAL 风险。

## 1. 建立基线

- [x] 记录当前 `src-tauri/target` 总量以及 debug/incremental/deps/release 分项；清理前约 103.18 GiB，清理并验证后当前约 15.74 GiB。
- [x] 记录 Windows `npm run tauri dev` 的 proxy、主 Cargo 和启动阶段结果；冷构建阶段另以直接 Cargo 双 binary 构建计时，热启动记录 wrapper/Tauri Cargo 阶段耗时，Vite 仅保留其 dev URL 与应用启动日志作为阶段证据。
- [x] 保存一次现有 `npm run tauri dev`、`npm run test:tauri-dev-proxy`、`npm run test:codex-proxy:e2e` 的结果；Codex E2E 已通过临时 profile 夹具隔离用户环境。

## 2. Cargo profile 与清理入口

- [x] 在 `src-tauri/Cargo.toml` 增加已批准的 dev profile 配置。
- [x] 在 `package.json` 增加当前仓库 dev 清理和全量清理命令，使用显式 `--manifest-path`。
- [x] 为清理命令补充关闭进程、按绝对路径处理 worktree/clone 等文档说明，不实现启动时自动删除。

## 3. Wrapper 构建链路

- [x] 重构 `scripts/tauri-cli.mjs` 的 Cargo 参数生成，区分固定参数、Cargo 选择参数和应用参数。
- [x] proxy 预构建改为同时选择 `cli-manager` 与 `cli-manager-codex-proxy`，保持 `--locked`、manifest、Windows 条件和退出码语义。
- [x] 让 `--no-default-features`/feature 选择与 Tauri 的 Cargo 选择保持一致；确保自定义 target、profile、target-dir、release 的长短/等号形式不回归。
- [x] 增加阶段日志和耗时，保留 Cargo 输出。
- [x] 不添加自定义源文件 hash/mtime marker，不在启动时删除 target。

## 4. 自动化测试

- [x] 更新 `scripts/tauriCliDevProxy.test.mjs`：验证双 binary、feature/选择参数转发、第二个 `--` 隔离、失败阻断和 `tauri build` 不触发 proxy。
- [x] 保留并运行 Codex proxy E2E；补充临时 `CODEX_HOME` 与空 profile 夹具隔离用户环境，最终 GUI subsystem、普通命令透传、app-server provider 和退出码 4 项检查通过。
- [x] 未新增清理脚本逻辑，仅使用带显式 manifest 的 npm/Cargo 命令，并完成 dry-run 路径与体积验证。

## 5. 文档与交付记录

- [x] 在 `CHANGELOG.md` 的 `[V1.3.9]` 版本增加开发构建速度、缓存体积、proxy 构建链路优化记录。
- [x] 在 `docs/功能清单.md` 的构建/开发能力板块增加对应说明，记录清理命令和 proxy 兼容性。
- [x] 同步更新 `.trellis/spec/backend/tauri-updater-contracts.md` 中 Windows dev proxy 预构建契约，反映双 binary 和统一 Cargo 选择参数。
- [x] 更新 PRD 的最终验收数据，完成 PRD convergence pass。

## 6. 验证命令

```powershell
npm run test:tauri-dev-proxy
npm run test:codex-proxy:e2e
npm run build
npx tsc --noEmit
cd src-tauri
cargo check --locked
cargo test --locked
```

Windows 环境追加：

```powershell
npm run tauri:clean:dev
npm run tauri dev
# 关闭后再次执行，记录 warm start
npm run tauri dev
```

验证记录至少包含：

- 冷启动与热启动总耗时、proxy 阶段耗时、主 Cargo 阶段耗时；
- 清理前后以及重复启动后的 target/debug、incremental、deps 体积；
- 主程序正常显示、daemon/PTY 能力正常、Codex proxy 可执行文件存在且 E2E 通过；
- 修改 Rust 源文件、proxy 源文件和 Cargo 配置后都能触发正确重建。

## 7. 交付前质量门禁

- [x] `git diff --check` 通过。
- [x] GitNexus `detect_changes()` 已检查：风险 `low`，6 个已索引变更符号均位于预期 `scripts/tauri-cli.mjs` 启动链路，未发现受影响 execution flow；工作区变更文件均属于本任务脚本、Cargo/package 配置、测试、契约、任务记录或版本文档，另有用户既有 `AGENTS.md`/`CLAUDE.md` 与并行 task 目录保持不动。
- [x] 复查未误改用户已有 `AGENTS.md`/`CLAUDE.md` 修改。
- [x] `task.py start` 前由用户审阅并批准 `prd.md`、`design.md`、`implement.md`，批准后进入实现阶段。

## 8. 验证记录

- 清理前统计：`target` 约 103.18 GiB；`debug` 约 93.19 GiB，其中 `incremental` 约 63.07 GiB、`deps` 约 25.58 GiB；`release` 约 9.90 GiB。
- `npm run tauri:clean:dev -- --dry-run` 确认只命中当前 manifest 的 dev 产物；随后执行 `npm run tauri:clean:dev`，Cargo 报告移除 42,394 个文件、约 93.3 GiB。release 产物未被 dev 清理命令删除；`npm run tauri:clean -- --dry-run` 另确认全量命令也只指向当前 manifest 的 15.7 GiB target。
- 清理后的双 binary 冷构建：`cargo build --locked --no-default-features --manifest-path src-tauri/Cargo.toml --bin cli-manager --bin cli-manager-codex-proxy`，耗时约 200.66s；之后直接 Cargo warm build 约 1.52s。
- Windows 实际 `npm run tauri dev`：wrapper 预构建阶段在 fingerprint 过渡后约 26.3s，随后 Tauri Cargo 约 1.75s；稳定重复启动记录 wrapper 约 1.5s、Tauri Cargo 约 1.76s，日志出现 `CLI-Manager started` 和 PTY daemon connected，应用启动链路完成。
- 当前验证后 target 约 15.74 GiB（`debug` 5.75 GiB、`debug/incremental` 1.95 GiB、`debug/deps` 2.95 GiB、`release` 9.90 GiB）；测试产物会随后续 Rust test 增长，必要时可再次执行 `npm run tauri:clean:dev`。
- `npm run test:tauri-dev-proxy`：20 checks passed；`npm run build`、`npx tsc --noEmit`、`cargo check --locked --manifest-path src-tauri/Cargo.toml` 通过；`cargo test --locked --manifest-path src-tauri/Cargo.toml`：1,212 passed、0 failed、1 ignored。
- `npm run test:codex-proxy:e2e`：proxy 编译成功，GUI subsystem、普通命令透传、app-server provider 和退出码检查共 4 项通过；测试使用临时 `CODEX_HOME`/profile 夹具，不修改 `C:\Users\1\.codex`。
