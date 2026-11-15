# Windows helper 运行库链接修复

## 授权与分诊

- 2026-11-15：用户同意创建 Trellis task、实施修复及按 `V1.5.1` 记录。
- 构建验收后用户授权创建本地提交，仅包含本次 helper 修复及对应记录。
- 当前 `master` 与本地记录的 `origin/master` 领先/落后均为 0；保留工作区其他任务的未提交改动。
- 根因修复：故障跨越 Cargo 依赖库与独立 helper 最终链接边界。

## 根因陈述

Tauri 主库的 build script 将占位 `msvcrt.lib` 所在的 native 搜索路径传递给独立 helper，却没有将配套运行库链接参数传递给 helper 二进制，导致 MSVC 先发现无效占位库并缺失 CRT 符号；修复应落在 helper 自己的 Windows MSVC 构建入口。

真实证据：三个 helper 的 Cargo 诊断先出现 `out/msvcrt.lib: LNK4003`，随后出现 `__security_cookie`、`__CxxFrameHandler3`、`memcpy` 等 LNK2001；占位文件为 82 字节，与已锁定 `tauri-build 2.5.6/src/static_vcruntime.rs` 的生成逻辑一致。仅为三个 helper 的最终链接补齐该运行库选择，三个 `cargo rustc` 均通过，耗时约 4–5 秒。

## 发现清单

- [x] `src-tauri/helpers/build.rs`：修复入口；现有三个二进制的版本资源编译继续执行。
- [x] `src-tauri/helpers/Cargo.toml` 和三个 `helpers/src/*.rs`：确认独立 Cargo 根及三个实际 helper；无需修改 manifest 或程序逻辑。
- [x] `src-tauri/build.rs`、主程序 manifest、两份锁文件：确认 Tauri 生成占位库和选择 CRT 的来源；无需修改或升级依赖。
- [x] `scripts/prepare-helper-binaries.mjs`：确认通过 Cargo 构建独立 helper，并复制到主 target；无需修改。
- [x] `scripts/prepare-bundle-binaries.mjs`、`scripts/tauri-build-local.mjs`、Tauri 配置：确认本地/正式打包入口及缓存目录；无需修改。
- [x] `scripts/helper-windows-runtime.test.mjs`：增加原生链接回归验证，复现占位库阴影及真实 C `/GS` 对象依赖，并验证修复后可运行。
- [x] `CHANGELOG.md`、`docs/功能清单.md`：在 `V1.5.1` 的 Windows 构建板块记录。
- [x] GUI、PTY/IPC、Git 业务、Web/Tap、用户数据：确认不属于本次实现范围。

GitNexus 索引绑定 `CLI-Manager`，commit 与当前 HEAD 一致。对 `Function:src-tauri/helpers/build.rs:main` 的 upstream impact 为 `UNKNOWN`，零调用边不是无影响证明；Cargo 自动构建入口通过上述 manifest、脚本及真实链接诊断补充确认。FTS 加载失败，概念查询降级；不将空查询当作安全结论。

## 实施

1. 在 helper `build.rs` 的 Windows MSVC 分支，为 helper 二进制显式选择与已锁定 Tauri 一致的 `libcmt`、`libvcruntime`、动态 UCRT，并排除冲突运行库。
2. 将参数限定为 `cargo:rustc-link-arg-bins`，保持原有资源生成；不生成或删除占位库，不更改全局 Rust flags。
3. 用包含空格的临时路径编译真实 C `/GS` 探针：占位 `msvcrt.lib` 下未经修复的链接应失败；由实际 helper build script 输出的参数应使链接和程序执行成功。
4. 验证三个真实 helper、完整本地打包及必要的架构检查，按实际结果记录。

## 场景

| 场景 | 行为/验证 |
| --- | --- |
| Windows MSVC x64 本地 release | 三个 helper 均通过，完整本地安装包构建成功。 |
| Windows MSVC debug | 同一运行库选择覆盖开发 helper；定向原生探针及真实 debug helper 验证。 |
| Windows MSVC 正式 release | 同一入口与优化参数无关；保持正式优化配置，验证配置及链接入口，未完整重建时明确记录。 |
| 旧/新缓存含 Tauri 占位库 | 最终链接参数显式排除占位库，原生回归测试真实保留阴影文件。 |
| 自定义 target、空格路径、linked Worktree | 参数不硬编码目录；回归探针使用空格路径，既有本地构建参数测试验证自定义 target。 |
| Windows 非 MSVC | 不应用 MSVC 链接参数；现有资源逻辑保持，未实机验证时记录。 |
| Linux/macOS、WSL native Cargo | 不进入 Windows MSVC 分支；本机不声明跨平台构建已验证。 |
| UI 焦点/分屏/最小化/侧栏/会话/焦点模式/项目 Worktree/CLI Hook | 属于应用运行状态，与编译时 CRT 选择无关。 |

## 验收

- 原生回归测试确实复现失败，并验证修复后探针可执行。
- `node --test scripts/helper-windows-runtime.test.mjs scripts/tauri-build-local.test.mjs` 通过。
- 正常 Cargo helper 构建不再需要手工追加链接参数。
- 完整 `npm run tauri:build:local` 成功产生实际安装包；不安装或发布。
- 独立运行严格架构检查；既有失败与本次改动分别记录。
- 不修改依赖、锁文件、版本元数据或其他任务实现；文档按已授权 `V1.5.1` 更新。
