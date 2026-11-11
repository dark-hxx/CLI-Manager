# DeepSeek Harness TUI 插件适配

## Goal
将 CLI-Manager 产品中 DSH 统一为官方内核 + dsh-TUI 插件 profile，在现有终端内交互。已有 dsh/deepseek-harness 项目不再默认启动浏览器。

## Requirements
- 统一 DSH CLI 描述符、旧项目识别、品牌图标和配置，安装版默认使用 dsh-tui，由启动器负责官方宿主与 profile；源码调试保留直接官方宿主入口。
- 常规配置仅使用其他 CLI 的通用字段；不显示 DSH 专属高级选项或源码目录选择，默认直接使用 dsh-tui。已有源码环境变量与明确源码命令保留兼容。
- 可选官方源码目录复用 CLI_MANAGER_DSH_SOURCE_ROOT；cwd 保持项目/Worktree；不要求 Web 构建。
- 插件由官方 profile 安装加载。配置校验只读，不隐式安装或修改 profile。
- 移除管理器 Web URL 状态、自动端口参数、WebUI 按钮及退出 marker。
- 明确 ID 恢复、不读共享 last 指针；存活 daemon 复用，失效进程新建终端不灌回旧 TUI 画面。
- 正常安装的实际执行命令保持 dsh-tui/dst，不追加 patch、NODE_OPTIONS 或 Shell 包装；新会话列表和 UUID 由 TUI 管理。仅旧直接宿主命令保留按 PTY UUID 隔离的 bridge；明确 ID 恢复保留。
- 用户自定义启动脚本保留；unsupported 环境/配置给出准确双语说明。
- 不在本批伪造 DSH 原生历史统计、供应商、完成通知、MCP/Skills 能力。

## Acceptance
- [x] 项目/命令/源码/插件 profile 预检通过定向测试。
- [x] 原生 PTY 中 TUI 真正渲染、输入/缩放/退出/恢复验证。
- [x] Web 专属生产代码清理完毕，既有 CLI 定向回归通过。
- [x] TypeScript、Rust、构建及独立 normal/strict architecture 通过。
- [x] 中英文、CHANGELOG TEMP、功能清单、契约与验证记录更新。

## Authorization
用户已明确同意创建 Trellis task，开始实现，并将所有 DSH 入口转移为 TUI。

## User-confirmed desktop acceptance
用户按桌面验收流程测试后反馈没有问题，并要求更新 PR 描述。该确认记为用户完成的本机桌面验收，不归为 agent computer-use 验收；各子项未单独列出，真实 WSL/SSH 与最终安装包验证仍无新增证据，见 verification.md。
