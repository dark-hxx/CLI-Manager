# 验证记录

## 修复与范围

- 根因及发现清单见 `prd.md`。
- `src-tauri/helpers/build.rs` 按 Cargo 的实际 Windows MSVC 目标，为三个二进制选择 Tauri 2.5.6 对应的 CRT；既有版本资源继续执行。
- 新增 `scripts/helper-windows-runtime.test.mjs`；`CHANGELOG.md` 和 `docs/功能清单.md` 在授权的 `V1.5.1` 下追加 Windows 构建记录，保留其他任务内容。
- 用户已有的 `src-tauri/helpers/Cargo.lock` 改动保持原样，本次没有修改依赖、业务源码或版本元数据。

## 通过

| 验证 | 结果 |
| --- | --- |
| 原生回归的修复前验证 | 保留空 COFF 占位库，真实 C `/GS` + Rust 链接复现 LNK4003 与缺失 security cookie；未修复 build entry 的输出不能使探针链接。 |
| `node --test scripts/helper-windows-runtime.test.mjs scripts/tauri-build-local.test.mjs` | 8/8 通过，0 跳过；修复后探针链接并运行成功。 |
| 目标选择 | Windows GNU、Linux、macOS 目标不输出 MSVC 参数；空格临时路径通过。 |
| `rustfmt --check src-tauri/helpers/build.rs` | 通过。 |
| 定向 `git diff --check` | 通过。 |
| 正常 helper 本地 release 构建 | 3 个 helper 成功，6.65 秒；无额外 `cargo rustc` 链接参数。 |
| 正常 helper debug 构建 | 3 个 helper 成功，1 分 44 秒。 |
| 完整 `npm run tauri:build:local` | 退出码 0；桌面、Web/Tap、主程序、beforeBundle helper、MSI/NSIS 均通过。最终 helper 阶段 27.36 秒。 |
| 安装包包含项 | NSIS 包含三个 helper、Tap index 与字体。 |
| helper 复制和解包哈希 | 独立编译产物、主 target 副本、NSIS 解包文件三方 SHA-256 一致。 |

本地构建沿用仓库现有 `1.5.0` 版本元数据；本次变更记录为 `V1.5.1`，未执行安装或发布。

## 产物

- `src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.5.0_x64-setup.exe`：31,905,801 字节。
- `src-tauri/target/local/release/bundle/msi/CLI-Manager_1.5.0_x64_en-US.msi`：40,144,896 字节。
- 完整构建日志：`.codex/windows-helper-runtime-local-build-20261115.log`。
- debug 日志：`.codex/windows-helper-runtime-debug-build-20261115.log`。
- 解包校验目录：`.codex/windows-helper-runtime-installer-20261115/`。

| helper | SHA-256 |
| --- | --- |
| cli-manager-daemon | E3CF95CA3B8CC3CCD1B806BDE2CBF70B80ACA10828439DCE9A42DE364ECBD094 |
| cli-manager-web-daemon | 826DF4B2915754DFF12F30B431C94E7844DFC33E284AE4DAA8A4712C25196294 |
| cli-manager-codex-proxy | 86FA3A642F11304AA14A227ECBC47E877A180DB57349FE2E712ABD1A63888002 |

## 既有失败及验证限制

- 独立 `npm run check:architecture -- --strict` 退出 1，仍为修改前两项：`src/features/stats/api/StatsPanel.tsx` 2020 行；`TerminalStatusBarSettingsPage.tsx` 跨域导入 `terminal/lib/terminalStatusBarItems`。本次源码没有新增违规或豁免。
- 构建验收阶段的全工作区 `detect-changes --scope all` 报告 28 文件、110 符号、26 流程、critical，包含其他 Web/Tap 任务；CLI 展示为摘要，不据此声称隔离提交准入通过。用户随后授权仅提交本次 helper 修复及对应记录，提交前另行检查暂存范围。
- 提交前刷新索引，使用 CLI 同版本 backend 获取完整结构化结果；暂存范围为 10 文件、7 符号、0 已索引流程、low，全工作区为 34 文件、141 符号、29 流程、critical。两次分析 `partial` / `truncated` 均为 false；逐项核对暂存文件及共享文档段落，其他任务未暂存。结果保存于 `.codex/helper-commit-gitnexus-staged.json` 和 `.codex/helper-commit-gitnexus-all.json`。
- 初始 helper build entry impact 为 `UNKNOWN`（未解析 Cargo 自动调用），通过 manifest、构建脚本及实际编译确认触点，未视为 low risk。
- Windows x64 debug/local release 已验证；Windows 其他架构、Linux/macOS、正式 fat-LTO 完整打包未运行。正式优化配置及本地缓存隔离由现有测试覆盖。
- 本次没有新增界面文案或交互，因此不涉及新的中英文界面验收。
