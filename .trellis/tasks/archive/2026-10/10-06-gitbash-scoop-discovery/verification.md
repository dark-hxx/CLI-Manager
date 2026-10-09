# 验证与交付

## 状态
源码修复、构建与安装已完成；用户重新扫描后提供截图，Git Bash 显示“可用”且启用，已启用终端类型为 5 个，用户确认“找到了，可以”。检测问题人工验收通过；截图未展示实际内外部交互终端，不将其记为已验证。用户已授权安装；安装过程中原 CLI Manager 内的 Pi 会话退出，用户改从外部 Pi 恢复。未提交、推送或修改 PATH。

安装核验：当前运行路径为 `D:\useful software package\CLI-Manager\cli-manager.exe`。从 NSIS 安装包解出主程序，与已安装主程序 SHA256 完全一致：`C48517EB433B5892099DBE352744FBA4A067991977FDEFA5B12AB7D7D39F0DEA`。不能直接用 release 目录中打包后再次 patch 的主程序哈希判断安装失败。程序含新增 Scoop 探测布局，版本号保持 1.4.1。安装后旧设置曾保留 detected=false，用户重新扫描后的截图已确认 Git Bash 变为“可用”。Windows UIAutomation 仅暴露 WRY_WEBVIEW Pane，未找到可调用的扫描按钮，因此不盲点坐标，交给用户在许可界面手动扫描与终端验证。

## 根因和发现清单
- [x] shell_resolver.rs：统一 Git Bash 解析增加布局和 Scoop 发现。
- [x] git_bash_paths.rs：新增纯文件路径探测，不执行探测进程。
- [x] terminal/shell.rs：扫描/图标共用解析，调用方不修改。
- [x] pty/manager.rs：PTY 使用解析结果，调用方不修改。
- [x] terminal/shell_commands.rs：外部启动共用解析，调用方不修改。
- [x] terminal/external_program.rs：间接使用 shell_exe，确认无需修改。
- [x] WSL/SSH/前端持久化/焦点/分屏/Worktree/hook：确认无关，无契约变更。
- GitNexus 未配置且本地 CLI 未安装，按分诊契约降级为契约与静态引用分析；影响为 Git Bash 检测和启动链路，中等风险。

## 已验证
- 真实 Scoop Bash 可执行，GNU bash 5.3.15。
- 使用包含实际新增 Rust 模块的临时只读诊断程序，打印而非断言：当前 PATH shims、Git/cmd PATH、用户默认 Scoop 均发现当前实际 Bash。
- 仅 System32 + 不存在的 Scoop 根：PATH/Scoop 均 None，不误选 WSL Bash。
- 隔离默认用户/全局根后，将真实 Scoop 根分别设置为 SCOOP 和 SCOOP_GLOBAL：均发现 Bash。未验证另行安装的真实全局 Scoop。
- `cargo +1.95.0 check --manifest-path src-tauri/Cargo.toml --lib` 通过。
- `npm run check:architecture -- --strict` 与 `git diff --check` 通过。
- 桌面 TypeScript/Vite 与 Web TypeScript/Vite 构建通过；Rust release 与 NSIS 打包完成。未编写/运行断言测试。

## 构建环境问题及处理
- 默认 rustc 1.94.1 不满足既有 sysinfo 依赖要求；使用本机已安装的 1.95.0，不修改默认工具链和依赖。
- 既有 tauri:build:local 包装脚本通过 Windows shell 传带空格的绝对配置路径，报 D:\\default 配置找不到；不扩大范围修改脚本，直接调用本地 Tauri JS 入口，沿用本地优化参数与隔离缓存。
- 首次 release 全量编译超过 600 秒工具时限，使用现有缓存继续；桌面/Web 已构建后通过临时配置跳过重复前端构建，最终成功。
- 既有大 chunk 与 bundle identifier 警告仍存在，不属于本次改动。

## 产物
`src-tauri/target/local/release/bundle/nsis/CLI-Manager_1.4.1_x64-setup.exe`
修复记录使用 TEMP，安装程序仍保留项目现有 1.4.1 版本。替换前需明确确认；安装可能影响当前 CLI Manager 会话，应先保存工作。
