# DeepSeek Harness 官方 WebUI 适配

## Goal

在 CLI-Manager 中完整接入官方 WebUI 启动工作流，支持安装版及本地源码仓库；完成验证、推送用户 fork 并创建 upstream draft PR。ZCode / 社区 TUI 留在 issue #272 后续范围。

## Requirements

- 项目 CLI 入口识别 dsh，提供品牌图标。
- 使用官方 dsh web profile，默认 --port 0，保留显式端口、--no-open、profile/patch 参数。
- 本地源码仓库可选；使用其官方已构建 CLI 入口，cwd 属于目标项目/Worktree。
- WebUI 与会话进程生命周期由现有 PTY/daemon 管理；存活 daemon 重连不能重复启动。
- 根据真实 dsh readiness 输出启用 WebUI 打开入口；地址不落盘、不猜测默认端口。
- WSL/SSH 安装版命令保留；本机源码路径不能套入 guest。SSH 本机打开须提示端口转发，不误开本机同端口。
- 官方 WebUI 自己承担聊天、历史、模型、插件功能；不伪造管理器原生历史/resume/Hook支持。
- 中英文、新建/编辑/克隆、分屏、同CLI多会话、恢复、源码缺失/未构建均验证。
- CHANGELOG 使用 TEMP，更新功能清单，提交用户 fork并创建draft PR。

## Acceptance

- [x] 项目配置、命令生成、源码校验、URL解析、清理与恢复测试通过。
- [x] 实际启动本地官方 WebUI，验证端口、项目目录、HTTP页面和停止。
- [x] 前端类型/构建、相关 Rust checks、strict architecture通过。
- [x] UI 中英文检查完成。
- [x] fork / push / draft PR 已验证且附加到聊天。

## Authorization

用户明确要求直接全部做完，随后要求 fork / commit / draft PR；无需再次询问任务启动许可。
