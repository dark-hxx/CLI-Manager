# Tauri 开发构建优化技术设计

## 1. 设计结论

- Windows 开发启动继续自动准备 `cli-manager-codex-proxy`，不新增要求开发者手动构建 proxy 的默认流程。
- 以 Cargo fingerprint 作为“是否需要重新编译”的唯一事实来源，不实现容易漏掉环境、工具链或 build script 输入的自定义 mtime/hash 判定。
- Windows wrapper 的一次预构建同时请求 `cli-manager` 和 `cli-manager-codex-proxy`，并尽量复用 Tauri 实际使用的 Cargo 选择参数，让共享的 `cli_manager_lib` 在同一个 Cargo 构建图中完成。
- Tauri CLI 会把 `--config` 的合并值写入 `TAURI_CONFIG`，而 `tauri-build` 将其声明为 Cargo 的环境 fingerprint 输入；wrapper 在 proxy 预构建时读取并合并同一组配置扩展，向 Cargo 传递完全相同的 JSON，确保后续 Tauri `cargo run` 为 fresh。
- 开发 profile 降低调试信息：当前应用 crate 保留基本源码定位，依赖 crate 关闭完整调试符号；`incremental` 继续开启。
- 构建缓存只提供显式、按 profile 的清理命令，不在每次启动时自动删除。

## 2. 根因与当前数据流

当前 Windows 启动链路：

```text
npm run tauri dev
  -> scripts/tauri-cli.mjs
  -> cargo build --bin cli-manager-codex-proxy
  -> tauri dev
       -> beforeDevCommand: npm run dev
       -> cargo run --no-default-features -- ... (cli-manager)
```

这会让同一个大型 `cli_manager_lib` 在 proxy 和主程序两个目标之间经历两次目标选择/编译边界。当前 wrapper 只转发 target、profile、target-dir 和 release；主 Cargo 命令还带有 `--no-default-features`，两边的选择参数并未形成单一来源。

当前 `cli_manager_lib` 同时输出 `staticlib`、`cdylib`、`rlib`，而开发 profile 未配置，使用默认完整调试信息。2026-09-03 的当前 checkout 统计为约 103.18 GiB，其中 debug 增量缓存约 63.07 GiB、debug deps 约 25.58 GiB；这解释了 target 长期增长和链接阶段耗时。

## 3. 建议的数据流

```text
npm run tauri dev
  -> wrapper 解析 Tauri 参数
  -> 生成统一 Cargo 选择参数
  -> cargo build --bin cli-manager --bin cli-manager-codex-proxy
       (Cargo fingerprint 决定 fresh 或必要的编译)
  -> tauri dev
       -> npm run dev
       -> cargo run cli-manager
          (应复用上一阶段的结果，只做快速 fresh 检查/启动)
```

预构建仍然阻塞 Tauri 启动，这是为了保证 proxy 在应用可执行时已经存在；优化目标是避免两次独立的完整构建，而不是将可能失败的 proxy 构建放到应用启动后。

## 4. Wrapper 参数规范

在 `scripts/tauri-cli.mjs` 中将构建参数分为三类：

1. 固定参数：`build`、`--locked`、`--manifest-path`、`--no-default-features`、两个必要的 `--bin`。
2. Cargo 选择参数：`--target/-t`、`--profile`、`--target-dir`、`--release`，以及 Tauri 支持且位于 Cargo 参数区的 feature 选择参数。
3. 应用参数：第二个 `--` 之后的参数，禁止进入 proxy Cargo 构建。

预构建环境还会镜像第一个 `--` 之前的 `--config`/`-c` 文件或内联 JSON，按 Tauri CLI 的配置扩展顺序合并后设置 `TAURI_CONFIG`。无法读取配置时保留原有环境并让 Tauri CLI 返回其自身的配置错误，避免 wrapper 自行改变配置语义。

规则：

- 保留当前相对 `target-dir` 的解析语义：proxy 和 Tauri 都以 `src-tauri` 为工作目录。
- 支持长参数、短参数和 `--option=value` 形式，并对值缺失保持安全失败/忽略行为。
- 不复制 Tauri 的应用 runtime 参数，不让 `--release` 等第二个分隔符后的应用参数污染 proxy 构建。
- 使用 `--bin cli-manager --bin cli-manager-codex-proxy`，不使用 `--bins`，避免把 daemon 和其他测试目标加入日常开发预构建。
- 若后续 Tauri CLI 改变默认 feature 行为，测试必须覆盖 wrapper 与实际 Tauri 命令的一致性；当前 Cargo metadata 显示本包没有自定义 feature，但仍保留参数边界。

不实现 wrapper 自己的源文件 mtime/hash 缓存。Cargo fingerprint 已覆盖 Cargo.lock、依赖、编译器和 build script 语义，重复调用只要输入未变更就不会进行完整编译；自定义 marker 若漏记任一构建输入会造成过期 proxy。

## 5. Cargo 开发 profile

在 `src-tauri/Cargo.toml` 增加：

```toml
[profile.dev]
debug = 1
incremental = true

[profile.dev.package."*"]
debug = 0
```

影响：

- 应用自身保留行级/基本调试定位能力。
- 依赖和 workspace path dependency 不再保留完整调试符号，降低 PDB、对象文件和链接输入体积。
- 增量编译继续开启，避免每次 Rust 文件变更都全量重编译。
- `[profile.release]`、发布包、sidecar 和 updater 产物不改变。

本任务不改变 `cli_manager_lib` 的 crate type，不拆分业务 crate；这两项可能进一步降低构建成本，但属于独立的高风险架构任务。

## 6. 缓存治理

增加仓库级 npm 命令，统一通过 Cargo 的 manifest 定位当前仓库：

- `npm run tauri:clean:dev`：仅清理当前仓库 dev profile 产物。
- `npm run tauri:clean`：清理当前仓库全部 target 产物。

文档说明：

- 执行前关闭当前 Tauri/Cargo 进程。
- 多个 worktree/clone 必须逐个确认绝对路径后清理，不能用宽泛 glob 批量删除。
- 优先在 debug/incremental 超过可接受体积、切换 Rust toolchain、升级依赖或遇到疑似 stale fingerprint 时执行 dev 清理。
- 不删除 Cargo registry、源码、应用数据或其他仓库的 target。

## 7. 日志与可观测性

wrapper 在 proxy/main 预构建阶段输出统一阶段名和耗时，至少能区分：

- 开始准备 Windows Rust dev binaries；
- Cargo 预构建成功/失败及退出码；
- 预构建结束后启动 Tauri。

Cargo 自身负责报告 `Compiling` 或 fresh 结果；wrapper 不吞掉 stdout/stderr。这样既保留诊断信息，也避免另造一套可能不准确的 freshness 结论。

`TAURI_CONFIG` 由 wrapper 与 Tauri CLI 共同传入的内容保持一致；日志中的 Cargo `Finished`/`Compiling` 结果因此能直接反映实际 fingerprint，而不是 wrapper 的猜测。

## 8. 兼容性矩阵

| 场景 | 预期行为 |
| --- | --- |
| Windows `npm run tauri dev` | 预构建主程序和 proxy，再启动 Tauri |
| Windows 源码未变化再次启动 | Cargo 快速 fresh 检查，不发生完整 proxy 编译 |
| Windows 修改主程序/proxy/Cargo.lock | Cargo fingerprint 触发必要重编译 |
| `--release` | proxy 与主程序都使用 release 产物 |
| `--profile custom` | 两个目标都使用同一 custom profile |
| `--target` / `--target-dir` | 两个目标写入同一选择的 target 位置 |
| 第二个 `--` 后应用参数 | 不进入 proxy 构建参数 |
| macOS/Linux | 不执行 Windows proxy 预构建，原有 Tauri 流程不变 |
| `tauri build` | 不执行 dev proxy 预构建，原有发布流程不变 |
| Codex 远程托管 | 仍能找到对应 profile/target 下的 proxy executable |

## 9. 风险、回滚与影响分析

- `buildWindowsDevProxy` upstream 影响 2 个符号，风险 LOW；`main` 影响 1 个符号，风险 LOW；`cargoBuildSelectionArgs` 影响 3 个符号，风险 LOW。GitNexus execution-flow 查询因 FTS 缺失降级，已由源码和现有测试补足。
- 最大行为风险是错误解析 Tauri runner/application 参数，或 proxy 与主程序落入不同 target/profile；通过参数边界测试和实际 Windows 启动验证控制。
- profile 调整的主要风险是 Rust 调试体验变弱；可通过删除新增 profile 配置回滚，不涉及数据迁移。
- 若预构建合并目标后出现 Tauri CLI 兼容问题，可回退为只预构建 proxy，同时保留 profile 和清理命令改动。
- 不自动删除缓存，避免与并发 worktree/Cargo 进程发生数据竞态。
- Windows dev 预构建契约目前记录在 `.trellis/spec/backend/tauri-updater-contracts.md`；实现后必须同步更新其中的命令示例、场景和测试要求，避免代码与项目契约分叉。
