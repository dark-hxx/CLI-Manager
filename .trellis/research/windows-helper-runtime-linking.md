# Windows helper 的 MSVC 运行库链接

## 已确认根因（2026-11-15）

桌面与 `src-tauri/helpers` 是两个 Cargo 根。已锁定的 `tauri-build 2.5.6` 在主库 build script 输出目录生成 82 字节的占位 `msvcrt.lib`，并输出静态 VCRuntime + 动态 UCRT 的链接参数。native 搜索路径会传给依赖方，`rustc-link-arg` 不会自动传给独立 helper 的二进制。

helper 因此先找到占位库，出现 `LNK4003: 无效的库格式`，继而大量 `LNK2001`，包括 `__security_cookie`、`__GSHandlerCheck`、`__CxxFrameHandler3`、`memcpy`。判断根因时读完整链接日志中更早的警告，不能将后面的 libgit2 对象名当作 libgit2 源码故障。

## 修复边界

- `src-tauri/helpers/build.rs` 在实际目标为 Windows MSVC 时，通过 `cargo:rustc-link-arg-bins` 补齐与该 Tauri 版本一致的运行库选择。
- 使用 `CARGO_CFG_TARGET_OS` / `CARGO_CFG_TARGET_ENV` 判断链接目标；build script 的 Rust `cfg` 描述宿主机，不能代替 Cargo 实际目标。
- 参数只作用于三个 helper 的最终二进制；保留版本资源及三个 helper 的正常构建与复制流程。
- 没有升级依赖、生成/删除占位库、更改全局 Rust flags 或修改应用业务逻辑。
- 后续更换 `tauri-build` 版本或 CRT 策略时，重新核对 `static_vcruntime` 行为及这组参数；本结论的已验证依赖基线为 2.5.6。

## 验证证据

- `scripts/helper-windows-runtime.test.mjs` 编译实际 helper build entry，复现空 COFF `msvcrt.lib` 阴影；真实 C `/GS` 对象在旧配置下失败，使用构建脚本输出的参数后 Rust 探针成功链接并运行。测试同时确认 Windows GNU/Linux/macOS 目标不输出 MSVC 参数，并使用带空格的临时路径。
- 该原生测试及既有本地构建测试共 8 项通过；Rust formatting 与定向 diff 检查通过。
- 正常 `cargo build --locked --manifest-path src-tauri/helpers/Cargo.toml` 的 debug 及本地 release 配置均构建三个 helper 成功，无需手工附加链接参数。
- 完整 `npm run tauri:build:local` 成功产生 MSI、NSIS；NSIS 解包后的三个 helper SHA-256 与独立编译产物一致，Tap 页面及字体资源存在。
- 变更记录为用户授权的 `V1.5.1`；安装包名称沿用仓库现有 `1.5.0` 版本元数据。构建验收后用户另行授权仅提交本次修复；未安装或发布。

## 实际限制

- Windows x64 实机验证；其他平台和 Windows 其他架构未完整构建。目标选择负向用例是 build entry 测试，不等于其他平台编译验收。
- 正式 fat-LTO 完整打包未运行；既有测试确认正式优化配置和本地覆盖保持隔离。
- 严格架构检查的两项 HEAD 既有违规仍在：`StatsPanel.tsx` 2020 行；终端信息栏设置页导入终端私有模块。
- GitNexus 对 Cargo 自动 build entry 的 upstream impact 为 `UNKNOWN`，通过 manifests、调用脚本、锁定依赖源码和真实链接验证补充确认。全工作区变更分析含其他 Web/Tap 任务并报告 critical，不能作为本次隔离提交的清洁准入证据。
- 提交前刷新索引并以 CLI 同版本 backend 完成检查：暂存范围 10 文件、7 符号、0 已索引流程，报告 low，`partial` / `truncated` 均为 false；全工作区 34 文件、141 符号、29 流程仍报告 critical，其他任务保持未暂存。零流程不代表 Cargo 自动入口无影响。

任务与完整发现清单：`.trellis/tasks/11-15-fix-windows-helper-runtime-linking/prd.md`；构建、哈希与限制：同任务 `validation.md`。
