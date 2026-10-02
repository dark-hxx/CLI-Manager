# Design

## Boundary

复用项目 env_vars 持久化一个不含凭据的管理器配置键 CLI_MANAGER_DSH_SOURCE_ROOT；没有 DB migration。独立共享纯命令模块生成官方 web profile启动命令。薄 Rust IPC 只校验用户所选本地仓库及构建入口，不创建另一个进程管理器。

安装版使用 dsh --profile web，默认 --port 0；源码使用 node <root>/apps/cli/lib/bin.js。官方 WebUI负责原生会话/模型/插件功能。自定义 startup_cmd 保持优先，不自动改写任意脚本。

## Lifecycle

PTY/daemon继续独占进程树。WebUI URL仅从dsh官方readiness输出提取，按Tab隔离，流式分块/ANSI/重放均可处理；只接受loopback HTTP地址，URL/token不写入设置或日志。关闭会话清理URL；attach复用，daemon消失后重新启动web服务，不等价于原生对话resume。

## Environment

本地源码模式仅native shell；guest使用自己的dsh安装。安装版WSL/SSH使用原有命令传输。SSH的loopback URL不能直接在本机浏览器打开，按钮明确提示转发需求。环境变量保持原有转发契约。

## Impact and discovery

GitNexus MCP不可用；npx --no-install尝试被npm缓存EPERM阻止。使用契约+rg降级，无自动图谱风险评级。

- shared/cliTools 与 CliToolIcon：项目选择、树、Tab、Workspan图标消费者；中等影响。
- projects/projectStartupCommand：sidebar / terminalTabsModel / terminalLaunch / external terminal / web management；中等影响。
- ConfigModal：创建、编辑、克隆；局部UI+已有env_vars持久化。
- terminalLaunch.resolvePtyLaunch：本地/WSL/SSH；保持provider/hook/transport顺序。
- TerminalProcessManager：create/close/output；只旁路观察已订阅frame，不改变ACK和流控。
- terminalStore.restoreSessions：较高风险；存活daemon attach原逻辑不动，DSH死进程重启不回灌旧URL。
- toolbar renderer：新增独立组件，自身读取当前会话，不增加大聚合入口。
- Rust commands注册：新只读source校验命令。
- history/hooks/providers：确认不在首期WebUI工作流实现范围，能力保持未声明。

## Scenarios

当前/其他窗口/失焦/托盘：官方浏览器交互由用户操作；不新增误报完成通知。
当前/其他/深层分屏，多会话，Workspan：endpoint按TabID隔离。
本地shell/WSL/SSH：guest不使用host repo；SSH不误开local loopback。
主仓/Worktree/目录缺失/.git文件：cwd复用原launch owner，不解析.git目录假设。
Hook安装/未装/仅另一CLI已装：不继承其他CLI hook能力。
源目录含空格、特殊字符、缺失构建；端口0/显式端口/冲突；no-open；旧daemon/死daemon。

## Rollback

移除新DSH入口模块和配置字段UI即可；已有项目行/env_vars/命令原样保留。无数据迁移或上游源代码改动。
