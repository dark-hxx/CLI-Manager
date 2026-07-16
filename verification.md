# cc-connect 首版验证

日期：2026-07-15

## 通过

- `cc-connect.exe --version`：v1.4.1，commit `5d4c96dd`。
- 本机 EXE SHA-256：`D3F7B0C673A4D5539A461639C98ECA054D18B1FA38FC1AFC6422A7BBF3A2B18D`，与上游 v1.4.1 `checksums.txt` 的 Windows amd64 值一致。
- 用包含 Agent 空密钥覆盖、完整命令限制和 Telegram 平台配置的临时 TOML 执行 `cc-connect config format --config ...` 成功；临时文件已删除。
- `tsc --noEmit` 全量通过。
- `npm run build` 通过：Vite 完成 6595 个模块转换并生成生产包；仅有既有的动态/静态混合导入和大 chunk 警告。
- 为恢复原有终端路径调用链，补回了上游 master 已存在的 `src/lib/terminalOscPath.ts`。
- Rust stable 已安装到 `F:\rust`：`cargo 1.97.0`、`rustc 1.97.0`、`rustfmt 1.9.0`、`clippy 0.1.97`。
- 新增 Rust 文件已执行 rustfmt，针对 `cc_connect.rs` 与 `credential_store.rs` 的格式检查通过。
- `cargo check` 已通过。
- `cargo test cc_connect::tests --lib` 已通过：5 项通过、0 项失败，覆盖版本/哈希、白名单、安全配置、日志脱敏，以及 Windows 普通路径、`\\?\` 扩展路径和 UNC 路径。
- 真实 Telegram 链路已验证：代理连接、Bot 鉴权、用户白名单、消息接收及 Codex 回复链路均已跑通。
- 修复 Windows 扩展路径泄漏：Agent `work_dir` 从 `//?/F:/...` 规范化为 `F:/...`，界面中的 cc-connect 可执行文件路径不再展示 `\\?\` 前缀。
- `git diff --check` 通过，仅输出工作区既有的 LF/CRLF 转换提示。
- 两轮后端并发/Windows API/安全审查及一轮前端审查完成，发现的高风险二进制信任、命令绕过、凭证继承和操作竞态已做本地缓解。

## 未完成或未执行

- 飞书真实账号链路尚未验证。
- 尚未启动 Tauri 窗口手动切换中英文；新增中英文键已由全量 TypeScript 检查与生产构建覆盖。
- Windows 路径修复后的安装包尚未重新生成，等待用户明确提出“打包”后执行。

## 代理与日志开关增量验证（2026-07-16）

- cargo test cc_connect::tests --lib 通过：12 项通过、0 项失败。
- 新增覆盖：旧配置缺少开关字段、代理关闭时忽略手动地址和本地端口、清理继承代理环境、关闭时暂不校验保留的代理地址。
- cargo check 通过。
- npm run build 通过；仅有既有的动态/静态混合导入和大 chunk 警告。
- git diff --check 通过，仅有工作区既有的 LF/CRLF 转换提示。
- 尚未启动 Tauri 窗口手动检查开关交互与中英文切换；本次未打包。

## 远程项目切换增量验证（2026-07-16）

- 新增 /cli_manager_list（兼容连字符写法），输出托管配置生成时 CLI-Manager 已登记的项目、路径、当前项目及不可用路径状态。
- 修复 Telegram 菜单展开全部项目的问题：托管配置只注册一个 `/cli_manager_switch <序号>` 命令，不再为每个项目生成 `cli-manager-switch-N` 命令或 alias。
- 单一切换命令调用 CLI-Manager 生成的参数校验脚本；脚本按与项目列表相同的快照将序号映射为项目 ID 摘要令牌，再请求已运行的 CLI-Manager 更新 profile/config 并延迟重启受管 cc-connect。
- 切换请求使用独立请求 ID 返回结果，避免并发切换复用同一结果文件；脚本严格拒绝缺参、零、负数、非数字、额外参数、越界序号及 PowerShell 注入形式。
- 切换参数不接受任意路径；/dir、/shell、/commands 等高风险命令仍保持禁用。
- 未修改 cc-connect 源码、全局 npm 包或可执行文件，仅使用其 v1.4.1 原生自定义命令参数能力。
- cargo test cc_connect::tests --lib 通过：17 项通过、0 项失败；包含真实 cc-connect v1.4.1 配置格式验证、Windows PowerShell UTF-8 清单输出、参数边界及 here-string + Base64 参数隔离验证。
- cargo check 通过。
- npm run build 通过；仅有既有的动态/静态混合导入和大 chunk 警告。
- 未执行真实 Telegram/飞书消息下的单实例回调与受管进程重启冒烟；需使用新构建安装包验证。
