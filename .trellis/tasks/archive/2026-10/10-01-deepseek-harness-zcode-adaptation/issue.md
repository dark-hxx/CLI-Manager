### 要解决的问题

希望 CLI-Manager 能统一管理 **DeepSeek Harness** 和 **ZCode**，在项目配置中提供明确入口，并准确区分“可以启动”与“已适配历史、恢复、通知等能力”。

现有终端已允许手填 CLI 命令，但这两个工具尚未登记；其深度能力也未进入对应适配链路。

### 建议方案

首期聚焦可用的启动接入：

- **DeepSeek Harness：接入官方 WebUI。** 官方项目已开源，入口采用 `dsh web`；CLI-Manager 管理启动进程和项目 cwd，由官方 WebUI 承担交互。社区 TUI 属于另一个可选入口，后续按插件和版本单独适配。
- **ZCode：增加独立工具入口。** 以官方 `zai-org/ZCode` 命令行发行版为候选，`zcode` 无参数进入 TUI。实施前确认实际安装来源与版本，避免与同样提供 `zcode` 命令的社区客户端混淆。
- 复用现有项目参数、自定义启动命令和 PTY 生命周期；保持用户已保存的命令、参数和环境配置。
- 明确能力边界：基础启动接入后，不能自动宣称支持历史、Token 统计、原生对话恢复、Hook、供应商切换或 MCP/Skills 诊断。

### 首期验收

- [ ] 项目 CLI 选择、图标和终端标签可识别两个工具；自定义命令仍可用。
- [ ] DeepSeek Harness 官方 WebUI 从正确项目/Worktree 目录启动，支持额外参数及官方 `--no-open` 行为。
- [ ] WebUI 多项目/多会话启动时，端口占用有明确处理方式；关闭和重新连接不会误杀其他项目的进程或重复启动同一服务。
- [ ] ZCode 可在项目终端启动，核验中文输入、多行输入、粘贴及终端尺寸变化。
- [ ] 明确区分存活 daemon 的进程重连、重启 Web 服务与恢复某条原生对话；缺少 resume 协议时不展示错误的“继续对话”能力。
- [ ] 覆盖本地 PowerShell/Pwsh/CMD、WSL、SSH 的适用范围；WebUI 的远程访问/端口转发方案单独声明，不能只凭命令启动成功判定远程交互可用。
- [ ] WSL 中明确 API key/model 等环境变量的传递边界，不假定项目任意环境变量都会进入 Linux。
- [ ] 覆盖普通目录、主仓/Worktree、路径含空格、分屏与多个同工具会话；新增文案兼容中英文并保持 24 小时制。

### 后续能力分别验收

1. **只读历史与统计**：先获取版本明确的脱敏日志样例，核验目录、格式、稳定 session ID、cwd、usage 语义和工具事件，再接入来源注册、扫描、详情、搜索及统计。DeepSeek 官方持久化后端默认支持 Zstandard 压缩及版本化日志，不能直接套用普通 JSONL 行解析。
2. **Hook 与恢复**：ZCode 官方文档已有进程 Hook，但配置结构独立；须完成安装/卸载、事件准入、精确 Tab/session 绑定和通知闭环。覆盖 Hook 未装、仅另一工具已装、跨窗口、失焦/托盘、分屏、重复事件及 daemon 重启。DeepSeek WebUI 的事件桥接需核验官方插件接口。
3. **供应商、MCP/Skills 与远程集成**：确认原生配置和能力协议后独立实现；本地支持不能自动扩大到 SSH 历史。
4. **社区 DeepSeek TUI**：另选插件/版本，单独核验入口、键盘、附件及恢复行为。

### 补充信息：仓库调查

调查基于提交 `3a38a2346635cd4f42ea841372f43a0920030c5e`，未修改应用代码，也未执行两个新 CLI 的运行验证。

- [CLI 描述表](https://github.com/dark-hxx/CLI-Manager/blob/3a38a2346635cd4f42ea841372f43a0920030c5e/src/shared/lib/cliTools.ts#L24)：现有预设入口；新增名称不会自动开启其他能力。
- [项目启动命令](https://github.com/dark-hxx/CLI-Manager/blob/3a38a2346635cd4f42ea841372f43a0920030c5e/src/features/projects/api/projectStartupCommand.ts#L184)：已有自定义命令与 CLI 参数拼接。
- [终端启动与恢复](https://github.com/dark-hxx/CLI-Manager/blob/3a38a2346635cd4f42ea841372f43a0920030c5e/src/features/terminal/lib/terminalLaunch.ts#L109)：恢复类型仍按固定工具分发；新增工具需要明确恢复策略。
- [历史能力注册](https://github.com/dark-hxx/CLI-Manager/blob/3a38a2346635cd4f42ea841372f43a0920030c5e/src/shared/lib/historySources.ts#L3)：前后端来源、解析与能力需要成套扩展。
- [WSL 环境转发](https://github.com/dark-hxx/CLI-Manager/blob/3a38a2346635cd4f42ea841372f43a0920030c5e/src-tauri/src/infrastructure/pty/manager.rs#L317)：当前只显式登记管理器回调/颜色变量。

实施时按仓库要求先做符号影响分析，运行定向行为测试、必要跨层检查和独立 strict architecture 检查；代码交付同步更新 CHANGELOG 和功能清单。

### 上游资料

- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek CLI/profile 行为参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)
- [DeepSeek 会话持久化后端](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/README.md)
- [ZCode 官方命令行发行入口](https://github.com/zai-org/ZCode#zcode-命令行版)
- [ZCode 官方 Hook 配置](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/README.md#hooks-configuration)
