# Scoop Git Bash 检测修复

## 需求
修复 Windows Scoop 安装的 Git Bash 在 CLI Manager 显示未检测到的问题。用户已授权源码根因修复与创建 Trellis task，记录版本为 TEMP。

## 约束
- 不修改全局 PATH、Git 安装和用户设置。
- 保留既有默认安装位置优先级及未安装错误，不误选 System32 的 WSL bash 或任意同名 bash。
- 设置扫描、图标、内置 PTY 与外部终端使用一致解析结果。
- 未获确认不关闭应用、不替换正在运行的安装版、不提交或推送。

## 验收
- 可发现当前用户 Scoop Git，以及环境变量指定的 Scoop 根目录和全局 Scoop 安装。
- 默认 Git、PATH Git/bin 与 Git/usr/bin 的发现能力不回归。
- 覆盖 PATH Git/cmd、Scoop shims 与无 Git 的情况；仅存在 WSL bash 不应识别为 Git Bash。
- 编译、架构与 diff 检查通过，构建本地安装产物；浏览器/桌面人工验收与编译验证分别报告。
