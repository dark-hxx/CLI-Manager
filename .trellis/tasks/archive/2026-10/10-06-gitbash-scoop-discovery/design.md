# 设计

## 根因
Windows shell_resolver 的安装布局假设不包含 Scoop：Scoop 通过 shims 暴露 Git，实际可执行位于 apps/git/current/bin/bash.exe。修复统一解析层而非修改界面 detected 状态。

## 方案
保留固定路径优先级，补充基于已确认 Git 安装布局的 PATH 推导与 Scoop 根目录探测，再保留注册表回退。只选择 Git 安装根下 bin/bash.exe 或 usr/bin/bash.exe；不将 PATH 上任意 bash.exe 或 git-bash.exe GUI launcher 当作 PTY shell。
Scoop 根目录来源包含 SCOOP、SCOOP_GLOBAL、USERPROFILE/scoop、ProgramData/scoop；优先 current 路径以适配升级。不执行 Git 或 Bash 探测进程，不添加网络、依赖和 IPC。

## 影响分析（GitNexus 不可用时的契约 + 静态引用降级）
GitNexus MCP 未配置，npx --no-install 确认 CLI 未安装。不擅自安装分析工具。解析函数影响：shell.rs scan_windows 与 resolve_shell_executable；pty/manager.rs 的 Git Bash 启动；shell_commands.rs 的外部启动参数；external_program.rs 通过 shell_exe 间接消费。范围为 Git Bash 发现/启动，中等风险。不修改 silent_command、进程超时、WSL、SSH 和前端状态协议。

## 场景
默认安装、PATH Git/bin、PATH Git/usr/bin、PATH Git/cmd、Scoop 默认/自定义/全局根、shims、路径不存在、仅 WSL bash。窗口焦点/托盘/分屏/Worktree/hook 不改变纯文件路径解析，确认无关；非 Windows 不引入 Scoop 发现。

## 回滚
恢复本次解析与文档改动即可；未修改用户环境。安装替换需额外确认，保留原安装程序。
