# Web 管理 P1：项目、文件、Diff、Git 与服务端口

## Goal

在 P0 的登录、设备配对、工作台和结构化对话基础上，让用户通过浏览器查看并审批已登记项目的代码变更；同时让独立 Web 服务的监听地址和端口可持久化、可部署地配置。

## Scope

- 项目和 Worktree：按桌面端上报的 ID 选择上下文，保持分组、项目、Worktree 层级和状态一致。
- 文件：浏览、搜索、文本/图片预览，以及受确认保护的创建、重命名、复制、移动、删除和保存入口。
- Diff：统一展示 Git 变更和桌面端返回的 Unified/Codex Patch，支持文件切换、行级高亮、折叠未变区、复制和窄屏布局。
- Git：状态、分支、暂存区、提交记录和受确认保护的 Fetch/Pull/Push、分支与暂存操作。
- 服务运行时：Web 服务 bind 地址/端口支持环境变量、命令行和配置文件三种来源，优先级明确；开发代理跟随配置，不再依赖固定 8787。

## Security and boundaries

- 浏览器只提交 `deviceId`、`projectId`、`worktreeId` 和项目内相对路径；真实根目录由桌面端解析。
- Provider 密钥、SSH 凭据、环境变量和本机绝对路径不得进入浏览器协议或历史缓存。
- 写文件、Git 网络操作、分支切换、Worktree 删除等操作需要 Web 目标确认和桌面原生确认。
- 设备离线、能力缺失、冲突、仓库锁定和超时必须返回稳定错误，禁止自动重放危险操作。
- SSH 项目作为独立 capability 适配；P1 默认先完成 local/WSL，不能把未验证的 SSH 操作标记为可用。

## Acceptance criteria

- 项目树和 Worktree 上下文可切换，操作目标与桌面端登记 ID 一致。
- 文件浏览/搜索/预览可以查看项目内容；写操作显示影响范围并正确处理冲突和失败。
- Diff 能查看变更文件与 Unified/Codex Patch，加载期间不重复请求，窄屏无整页横向滚动。
- Git 状态、分支、暂存和提交闭环可用；高风险操作有二次确认且断线不重复执行。
- Web 服务可以通过持久化配置选择监听地址/端口；服务启动、健康检查、Vite 开发代理和桌面 Web 服务地址保持一致。
- `npm run web:typecheck`、`npm run web:build`、Web server check/test、Tauri check、TypeScript check 和关键 P1 回归测试通过。
