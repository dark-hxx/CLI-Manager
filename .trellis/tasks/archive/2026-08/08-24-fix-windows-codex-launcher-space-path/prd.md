# 修复 Windows Codex 启动器空格路径

## Goal

cc-connect 远程托管通过 CLI-Manager Codex 代理启动 `.cmd/.bat` 时，真实启动器位于含空格、中文或 Windows `\\?\` 扩展前缀的路径也必须正常启动；失败诊断应正确显示本地化文本，而不是乱码。

## Root-Cause Statement

根因位于 Windows 原生代理到 CMD 脚本启动器的参数边界：`cmd.exe /c` 直接接收脚本路径参数时，带空格的 `\\?\D:\...` 路径被 CMD 截断为第一个空格前的命令；同时探针输出一律按 UTF-8 解码，使系统代码页中文错误变成乱码。修复必须落在代理命令构造和进程输出解码层，而不是修改 cc-connect 或吞掉探针失败。

## Requirements

- `.exe` Codex 启动器继续直接通过 `Command` 启动，不经过 shell。
- `.cmd/.bat` 使用 CMD `call` 语义并正确处理包含空格、中文的绝对路径。
- 传给 CMD 前移除本地盘和 UNC 的 `\\?\` 扩展前缀，不改变实际目标。
- 保留并加强脚本启动器及参数的 shell 元字符拒绝规则，禁止换行、引号和命令拼接字符注入。
- app-server 与普通 `--version` 等透传命令使用相同安全启动器逻辑并保留退出码、stdin/stdout 和 Provider 参数。
- Windows 非 UTF-8/OEM/GBK 诊断使用现有编码探测解码；UTF-8 输出保持不变，无法识别时才 lossy 回退。
- 不修改 cc-connect 源码、Provider 选择、会话恢复或授权逻辑。

## Acceptance Criteria

- [x] 带空格目录中的 `.cmd` 可完成 app-server stdin/stdout 代理并返回真实退出码。
- [x] `\\?\` 前缀 + 空格路径可以启动。
- [x] 普通 Codex 透传仍保留参数和退出码。
- [x] 危险 shell 字符仍被拒绝。
- [x] GBK 中文系统错误可读，UTF-8 诊断不回归。
- [x] Windows 真实代理 E2E、Rust 单测、cc-connect tests、编译和类型检查通过。

## Scenario Matrix

- 启动器类型：`.exe`、`.cmd`、`.bat`、`.ps1`。
- 路径：普通路径、空格、中文、`\\?\D:\...`、`\\?\UNC\...`。
- 命令：app-server、普通透传、Provider 覆盖、多参数、非零退出码。
- 输出：UTF-8、GBK/OEM 本地化错误、空输出。
- 安全：`& | < > ^ % !`、引号、CR/LF 注入。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
