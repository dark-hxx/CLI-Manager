# 修复 KNX 项目文件路径目录跳转

## Goal

使终端中的 POSIX 前缀 Windows 文件路径（例如 `/F:/github/smart-home/demo3/knx-workspace/initial-quote-v1/project.knxproj`）打开后准确定位到该项目文件所在目录。

## Confirmed Facts

- 该格式被终端文件链接识别为绝对路径；当前前端归一化结果为 `F:/github/.../project.knxproj`。
- 绝对文件链接经 `openTerminalFilePath` 调用后端 `open_folder_in_explorer`；该命令负责在 Windows Explorer 中选中普通文件。
- 当前工作区不存在用户给出的实际 KNX 文件，故回归验证需覆盖等价路径格式与可控测试样例。

## Requirements

- `/X:/...`、`X:/...` 与 `X:\\...` 的本地绝对文件路径必须保持正确的文件/目录语义。
- 对文件路径，应打开其父目录并选中该文件；对目录路径，应直接打开该目录。
- 保持 UNC、`/mnt/<drive>/...`、WSL 路径与终端相对路径现有行为。

## Acceptance Criteria

- [ ] `/F:/.../project.knxproj` 被识别、归一化并传递为正确的 Windows 文件路径，不会被作为相对路径或默认目录处理。
- [ ] 打开本地文件后，Windows Explorer 定位到对应文件所在目录并选中该文件。
- [ ] 现有路径链接匹配与相对路径导航测试继续通过，并新增该格式的回归测试。

## Root Cause and Discovery

- 根因：前端已把 `/F:/...` 识别并转换为 `F:/...`，但 `open_folder_in_explorer` 将保留正斜杠的字符串直接交给 Windows Explorer。Explorer 的命令行边界需要原生 Windows 路径，正斜杠会使目标文件未被正确解释并回落到默认目录；因此应在 Rust 打开路径边界归一化，而不是在终端链接匹配处补丁。
- `src/lib/terminalFileLinks.ts`：已覆盖 `/X:/` 识别和去前缀归一化；保留实现，仅补充回归断言。
- `src/components/XTermTerminal.tsx`：已将归一化路径传给 `open_folder_in_explorer`；确认无须改变调用语义。
- `src-tauri/src/commands/shell.rs`：验证路径并启动 Explorer 的边界，需修改。
- `src-tauri/src/wsl.rs`：现有 `normalize_wsl_unc_path` 已统一正反斜杠与 WSL UNC 形态，可在 Windows 边界复用。
- `src/components/TerminalTabs.tsx`：仅消费终端相对路径导航事件，绝对路径不经过该链路，确认无关。
