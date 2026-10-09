# ZCode 首期接入证据

## 官方来源

源码基线：`zai-org/ZCode@29628c9acdb81b703bbd4080c207a0e7ce5e276e`，2026-10-08 通过 `git ls-remote` 核对。GitHub REST API 达到匿名限流后使用同一提交的 raw 文件，没有安装或运行上游代码。

- [根 README](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/README.md)：官方发行包 `zcode` 无参数进入 TUI；首参数 `--web` 分流到 Web；其余参数交给 Agent CLI。发行包仍需要 Node；开发／打包依赖 Node 24.14.0 和 pnpm 10.33.2。
- [mise.toml](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/mise.toml)：上述工具版本的权威声明。
- [CLI workspace package](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/package.json)：workspace 版本为 `0.16.9`；不能将它当作本机安装版实际版本。
- [CLI package](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/package.json)：私有包 `@zcode/cli` 声明 `bin.zcode = ./dist/zcode.cjs`。不建议安装同名公共 npm 社区包。
- [TUI 判定](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/tui-stderr.ts)：`isTuiInvocation` 先解析全局参数；help/version/prompt/target 非 TUI，首 positional 缺省或为 `tui` 才是 TUI。
- [CLI 参数](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/cli/src/arguments.ts)：存在 `--resume`、`--continue/-c`、`--cwd`、`--locale` 等原生参数；本轮透传用户参数，不自动生成恢复选择器。
- [CLI README](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/README.md)：原生配置、MCP、Hook 在其自身配置文件中管理。存在原生能力不等于 CLI-Manager 已完成对应集成。

## 安装与验证条件

- `Get-Command zcode` 没有找到本会话 PATH 中的程序；尚未获得用户的安装路径或版本。
- 官方根 README 说明自行构建 `pnpm build:zcode`，输出含校验摘要的运行包；安装脚本默认 `~/.zcode/runtime` 和 `~/.local/bin`。Windows 可用 `where.exe zcode` 确认命令来源。
- 已构建发行包可直接用 `node <解压目录>/zcode/bin/zcode.mjs` 运行；源码 Agent 构建入口是 `node apps/zcode-cli/packages/cli/dist/zcode.cjs`。本次不替用户安装全局程序或构建上游完整桌面/Web。
- 真实 TUI 输入、粘贴、尺寸、焦点、退出及 WSL/SSH 尚未验证；不能用源码检查或模拟调用宣称通过。

## 本地触点和影响

下表记录早期首期方案。用户后续将范围缩小为“仅增加 CLI 类别”，终端识别和恢复策略等计划未实施；最终改动及验证以 `verification.md` 为准。

| 入口（规划时行号） | 发现 | 计划 |
| --- | --- | --- |
| `src/shared/lib/cliTools.ts:37` | 统一工具元数据驱动项目、标签、图标；ZCode 缺席 | 新增描述项，追加在既有项之后，能力保守声明 |
| `src/shared/ui/CliToolIcon.tsx:25` | 显式图标映射，现有依赖含 Zhipu 图标 | 新增 ZCode key，复用厂商品牌图标 |
| `src/features/projects/components/ConfigModal.tsx:64` | 五项优先、四项隐藏，其余来自统一表 | 保留此前修改，新增 ZCode 自动进入末尾 |
| `src/features/projects/api/projectStartupCommand.ts:180` | 普通 CLI 直接拼接用户参数；ZCode 无需特殊包装 | 验证复用，无需重写通用拼接 |
| `src/features/terminal/lib/terminalLaunch.ts:118` | 恢复识别可能匹配参数中的其他 CLI 名称 | 为明确 ZCode 启动保持未接入原生恢复的边界 |
| `src/features/terminal/lib/terminalLaunch.ts:431` | 原有 native/WSL/SSH 路由传递 cwd 和环境 | 通过行为测试验证，优先复用 |
| `src/features/terminal/store/terminalStore.ts:1479` | daemon 元数据优先 attach，不重跑启动命令 | 保持此分支并加回归 |
| `src/features/terminal/store/terminalStore.ts:1614` | 目前只有已支持 resume 的 CLI/DSH 跳过旧画面 | 增加已识别 ZCode TUI 的重建画面策略 |
| `src/features/providers/api/providerSwitching.ts:37` | `zcode` 不属于供应商切换类型 | 保持 null，不新增错误能力 |
| `src-tauri/src/infrastructure/pty/manager.rs:317` | WSL 转发仅覆盖显式白名单／用户 WSLENV | 不自动跨环境搬运 ZCode 密钥或主机路径 |

GitNexus 查询的 FTS 索引缺失，因此不以空查询认定没有实现；结合生产代码精确搜索、现有契约和逐符号 context/impact。符号行号以当前文件为准，索引返回的部分行号滞后。

上游 impact：`CLI_TOOL_DESCRIPTORS`、`CLI_TOOL_ICONS`、`restoreSessions` 均报告 LOW、0 个直接依赖；这些常量和 Zustand 回调有图谱覆盖盲点，不代表没有 UI 消费者。`detectCliResumeKind` 报告 HIGH，3 个直接调用方、9 个总影响符号、3 条受影响流程，若后续修改需覆盖保存到侧栏、恢复与标签菜单。本轮只修改工具描述和图标映射，未修改 `restoreSessions` 或 `detectCliResumeKind`。
