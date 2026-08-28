# 修复 KNX 项目文件路径目录跳转：设计

## Root Cause

`/F:/...` 已被终端链接解析成 `F:/...`，但 Rust `open_folder_in_explorer` 将该正斜杠路径原样交给 Windows Explorer。路径在 `PathBuf` 存在性检查中可通过，却没有以 Explorer 所需的 Windows 命令行形式传递，导致文件定位回落到默认目录。

## Change

- 仅在 Windows 分支内将 slash-prefixed drive path 去除 POSIX 前缀，并复用 `wsl::normalize_wsl_unc_path` 将路径转换为反斜杠形式。
- 使用该规范化路径做存在性检查及 Explorer 调用；保留 `open_file` 和文件 `/select,` 语义。
- 不调整前端链接提供器、相对路径文件面板事件或 IPC 签名。

## Verification

- Rust 单测覆盖 `/F:/...`、`F:/...` 与 UNC/WSL UNC 保持。
- 前端脚本测试覆盖 `/F:/.../project.knxproj` 的链接匹配与 IPC 路径归一化。
- 运行 Rust 编译检查和 TypeScript 类型检查。
