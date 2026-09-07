# Kimi Code CLI 官方命令、路径与 Hooks 契约研究

## 1. 研究范围与结论基线

- 研究日期：**2026-08-18（UTC）**。
- 证据范围：仅使用 Moonshot AI 官方 GitHub 组织下的仓库、官方 GitHub Pages 文档和 `code.kimi.com` 官方发布 CDN；未使用社区文章、搜索摘要或第三方实现作为事实依据。
- 当前产品：[`MoonshotAI/kimi-code`](https://github.com/MoonshotAI/kimi-code)，不是正在退役的旧 Python 项目 [`MoonshotAI/kimi-cli`](https://github.com/MoonshotAI/kimi-cli)。
- 固定源码快照：[`cdaa80b778072662bebd9fb1c09aac98f0f15591`](https://github.com/MoonshotAI/kimi-code/commit/cdaa80b778072662bebd9fb1c09aac98f0f15591)。该提交对应 `@moonshot-ai/kimi-code` `0.37.2`。[S1][S2]
- 官方 CDN 在 `2026-08-18T18:04:33Z` 发布 `0.37.2`；官方 changelog 按发布侧时区标为 `2026-08-19`，二者不是版本冲突。[S17][S19]

### 核心结论

1. 当前主命令仍是 **`kimi`**，npm 包名是 **`@moonshot-ai/kimi-code`**；`kimi --version` 是官方安装后验证命令。[S1][S3][S8]
2. 当前默认数据 Home 是 **`~/.kimi-code`**，主配置文件是 **`~/.kimi-code/config.toml`**；可用 `KIMI_CODE_HOME` 整体迁移数据根目录。[S4][S5][S6]
3. 当前 Kimi Code **明确提供官方 Lifecycle Hooks API**，配置为 `config.toml` 中的 `[[hooks]]`。不存在“官方没有 Hook API”的情况。[S7][S10][S11]
4. 当前 Hooks 支持 **20 个事件**，不是旧 `kimi-cli` 文档曾记录的 13 个事件。[S7][S10][S26]
5. Windows 官方安装入口是 PowerShell 脚本；首次运行还要求 Git for Windows，因为 Kimi 的 `Bash` 工具使用 Git Bash。[S3][S16][S20]
6. 官方没有独立的“SSH remote 安装器、远端发现协议或机器可读安装状态 API”。SSH 主机应按该主机自己的 Linux/macOS 环境安装，并在远端执行检测命令；这是基于官方普通安装契约得出的实现建议，不是官方专门声明的 SSH 流程。[S3][S21]

## 2. 新旧产品线必须区分

| 项目 | 当前 Kimi Code | 旧 Kimi CLI |
| --- | --- | --- |
| 官方仓库 | `MoonshotAI/kimi-code` | `MoonshotAI/kimi-cli`（官方声明将逐步退役） |
| 实现/发行 | TypeScript；官方原生单二进制或 npm | Python/uv |
| 命令 | `kimi` | `kimi` |
| 默认数据 Home | `~/.kimi-code` | `~/.kimi` |
| Home 覆盖变量 | `KIMI_CODE_HOME` | `KIMI_SHARE_DIR` |
| 当前 Hook 配置 | `~/.kimi-code/config.toml` 中 `[[hooks]]` | `~/.kimi/config.toml` 中 `[[hooks]]` |

旧产品状态、路径与 Hook 事实见其官方仓库和保留文档。[S24][S25][S26]

新旧产品共用 `kimi` 命令名，因此“`kimi` 可执行文件存在”或“`kimi --version` 成功”本身不足以判定它是哪一代产品。当前官方安装器会尽量将旧 Python shim 重命名为 `kimi-legacy` 并清理后续重复 shim，但遇到权限或自定义 PATH 时不能假定迁移必然完成。[S9][S20][S21]

当前 Kimi Code 首次运行会检查 `~/.kimi/`，也可以执行 `kimi migrate`；迁移不会删除旧数据。CLI-Manager 不应把 `~/.kimi/` 当作当前 Kimi Code Home，也不应在检测阶段修改或迁移旧安装。[S9]

## 3. 命令名、发行包与版本检测

### 3.1 确定事实

- 主命令：`kimi`。
- npm 包：`@moonshot-ai/kimi-code`。
- 当前快照版本：`0.37.2`。
- 官方命令定义将 `kimi` 映射到 `dist/main.mjs`；原生安装器最终安装为 Unix 的 `bin/kimi` 或 Windows 的 `bin/kimi.exe`。[S1][S20][S21]
- 官方最小检测命令：

  ```sh
  kimi --version
  ```

- 当前 Kimi Code 还提供只读配置验证命令：[S8]

  ```sh
  kimi doctor
  kimi doctor config
  kimi doctor config /path/to/candidate-config.toml
  ```

  `kimi doctor` 验证默认 `config.toml` 和 `tui.toml`；默认文件缺失时会报告 skipped 且仍可退出 `0`。显式传入的文件若缺失或无效则退出 `1`。因此 `doctor` 的退出码可以验证配置有效性，但不能单独证明默认配置文件存在。

### 3.2 推荐的产品身份判定

CLI-Manager 应按以下证据分层判断，而不是只检查进程或文件：

1. 解析 PATH 中实际命中的 `kimi` 路径，并保留所有候选，防止旧 shim 抢占。
2. 对选中的可执行文件直接执行 `--version`，要求退出码 `0` 且 stdout 是可解析的 semver。
3. 再探测 `kimi doctor config` 或 `kimi doctor --help`。`doctor` 是当前 Kimi Code 的官方子命令，可用于把新产品与旧 `kimi-cli` 区分开。
4. 独立解析当前数据 Home，检查 `$KIMI_CODE_HOME/config.toml` 或默认 `~/.kimi-code/config.toml`；不要用旧 `~/.kimi` 补位。
5. 将结果分成“当前 Kimi Code”“疑似旧 kimi-cli”“命令冲突/未知”，不要静默选择错误的一代。

## 4. Home、配置与安装目录

### 4.1 当前数据 Home

默认数据根目录：[S4][S5]

| 平台 | 默认路径 |
| --- | --- |
| Windows | `C:\Users\<name>\.kimi-code` |
| Linux | `/home/<name>/.kimi-code` |
| macOS | `/Users/<name>/.kimi-code` |

`KIMI_CODE_HOME` 覆盖整个数据根目录。设置后，主配置、TUI 配置、session、日志、OAuth credentials、Kimi-specific Skills、插件记录等都位于该目录下。

关键文件包括：

```text
$KIMI_CODE_HOME/                  # 默认 ~/.kimi-code
├── config.toml                   # Agent/runtime 主配置；Hooks 位于此文件
├── tui.toml                      # TUI 偏好
├── mcp.json
├── session_index.jsonl
├── sessions/
├── credentials/
├── logs/kimi-code.log
├── updates/
└── bin/
```

### 4.2 配置文件

- 主配置固定文件名为 `config.toml`，默认路径 `~/.kimi-code/config.toml`，覆盖后为 `$KIMI_CODE_HOME/config.toml`。[S5][S6]
- Hooks 只在用户级主配置的 `[[hooks]]` 中声明。[S6][S7]
- 项目级 `<project-root>/.kimi-code/local.toml` 当前只文档化了 `[workspace].additional_dir`，没有项目级 Hooks schema。不要向 `local.toml` 写 `[[hooks]]`。[S6]
- 修改 `config.toml` 后，新进程启动时生效；活动 TUI 可由用户执行 `/reload` 重新加载。当前没有官方外部 IPC 用于让第三方管理器强制 reload。[S6]

### 4.3 安装目录与数据 Home 不是同一个概念

官方原生安装脚本另有 `KIMI_INSTALL_DIR`：

- 默认也恰好是 `~/.kimi-code` / `%USERPROFILE%\.kimi-code`；
- 可执行文件安装到 `$KIMI_INSTALL_DIR/bin/kimi` 或 `%KIMI_INSTALL_DIR%\bin\kimi.exe`；
- `KIMI_CODE_HOME` 决定数据和配置位置；
- `KIMI_INSTALL_DIR` 决定原生二进制位置；
- 二者可被分别设置，不能互相推导。[S20][S21]

因此 CLI-Manager 的数据 Home 选择和 binary discovery 必须是两个独立字段/步骤。

## 5. 官方 Hooks 配置 schema

### 5.1 TOML 格式

每条 Hook 是一个 `[[hooks]]` array-of-tables 项：[S7][S11]

```toml
[[hooks]]
event = "TurnStarted"
matcher = "^(user|task|system_trigger)$"
command = "/absolute/path/to/cli-manager-kimi-hook"
timeout = 5

[[hooks]]
event = "PermissionRequest"
command = "/absolute/path/to/cli-manager-kimi-hook"
timeout = 5
```

| 字段 | 类型 | 必填 | 约束/默认值 |
| --- | --- | --- | --- |
| `event` | string enum | 是 | 必须是 20 个官方事件之一 |
| `matcher` | string | 否 | JavaScript regular expression；省略或空字符串匹配全部 |
| `command` | non-empty string | 是 | 作为 shell command 启动；事件 JSON 从 stdin 输入 |
| `timeout` | integer | 否 | `1..600` 秒；默认 `30` 秒 |

用户配置严格只允许以上四个字段。额外添加 `id`、`name`、`env`、`cwd`、`args` 等字段会导致配置校验失败。源码内部类型虽然允许插件注入 `cwd`/`env`，但这不是用户 `config.toml` 的公开 schema。[S10][S11]

### 5.2 `matcher` 的精确语义

- 实现使用 `new RegExp(pattern).test(value)`，即默认是“包含/部分匹配”，不是全字符串匹配；要精确匹配需显式写 `^...$`。[S12]
- 空 pattern 匹配全部。
- regex 无效时该规则不匹配；Hook 执行引擎按 fail-open 处理，不会因此阻断 Agent。[S12]
- `UserPromptSubmit` 等 matcher value 若是多段内容，只拼接其中的文本段，并以空格连接后再匹配。[S12]
- 同一事件下的匹配规则并行执行；相同 `command` 的规则会去重，只执行一次。[S7][S12]

### 5.3 `command` 运行契约

- 当前 session 的项目目录是 Hook process 的 working directory。[S7][S12]
- CLI 将一份 JSON 直接写入 command 的 stdin，不会把事件字段展开成命令行参数。[S7][S12]
- 用户 schema 只有一条 command string，不是 argv array，也没有公开的 per-hook environment map。[S10][S11]
- 非 Windows 上 Hook process 使用独立 process group；超时后会终止进程组。Windows 上隐藏子进程窗口并在终止时结束进程树。[S7][S13][S22]
- 源码通过 host process 的 `shell: true` 执行 Hook command。[S13]

**Windows 注意**：官方“使用 Git Bash”的明确保证针对 Kimi 的 `Bash` tool；Hooks 文档没有承诺 Hook command 一定由 Git Bash 或 PowerShell 解释。当前 Hook runner 也没有把 `KIMI_SHELL_PATH` 显式传给 Hook command。[S7][S13][S16] 因此 Windows Hook 不应直接依赖 PowerShell 语法；如需 PowerShell，应在 `command` 中显式调用 `powershell.exe`/`pwsh.exe` 及脚本路径。

## 6. 支持的 20 个 Hook 事件

所有事件 stdin 都包含以下公共字段（`session_title` 在标题尚未生成时可能为空/缺省）：[S7][S12][S14][S15]

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "session_abc",
  "session_title": "Fix the login page",
  "client_type": "kimi_code_cli",
  "cwd": "/path/to/project"
}
```

事件特定字段全部使用 `snake_case`。下表把官方 Hooks 文档与当前源码触发点合并；“可阻断”表示返回值能改变主流程，其他事件即使返回 deny 也只是 observation-only。

| 事件 | `matcher` 匹配值 | 主要附加字段 | 可阻断 | 适合 CLI-Manager 的含义 |
| --- | --- | --- | --- | --- |
| `UserPromptSubmit` | 用户提交文本 | `prompt`, `is_steer` | 是 | 用户 prompt 进入处理前；不等于所有 turn start |
| `UserPromptQueued` | 排队 prompt 文本 | `prompt_id`, `prompt`, `queue_length` | 否 | turn 运行中又排入消息 |
| `PreToolUse` | tool name | `tool_name`, `tool_input`, `tool_call_id` | 是 | permission check 前的工具拦截 |
| `PostToolUse` | tool name | `tool_name`, `tool_input`, `tool_call_id`, `tool_output` | 否 | 工具成功；当前源码将文本 output 截到 2000 字符 |
| `PostToolUseFailure` | tool name | `tool_name`, `tool_input`, `tool_call_id`, `error` | 否 | 工具失败或被阻止 |
| `PermissionRequest` | tool name | approval/session/agent/turn/tool call、`action`, `display`, `tool_input` | 否 | 即将等待用户审批，适合 attention 状态 |
| `PermissionResult` | tool name | Request 字段加 `decision`，以及可选 `scope`, `feedback`, `selected_label`, `error` | 否 | 审批结束，适合清除 attention |
| `TurnStarted` | origin kind，如 `user`/`task`/`system_trigger` | `turn_id`, `origin_kind`, `origin_name`, `prompt` | 否 | 最完整的 turn 开始信号 |
| `Stop` | 空字符串 | `stop_hook_active` | 是 | 正常 turn 准备结束；当前没有独立 `TurnEnded` observation event |
| `StopFailure` | error type | `error_type`, `error_message` | 否 | turn 因错误失败 |
| `Interrupt` | 空字符串 | `turn_id`, `reason` | 否 | 用户中断；正常 `Stop` 不触发 |
| `SessionStart` | `startup` 或 `resume` | `source`, `model`, `profile` | 否 | session 新建/恢复；fork 不走该事件 |
| `SessionEnd` | `exit` 或 `archive` | `reason` | 否 | session 关闭/归档 |
| `SessionHeartbeat` | 空字符串 | `uptime_ms` | 否 | 配置该事件后每 60 秒触发；未配置时不启动 timer |
| `SubagentStart` | sub-agent name | `agent_name`, `prompt` | 否 | 子 Agent 启动前 |
| `SubagentStop` | sub-agent name | `agent_name`, `response` | 否 | 子 Agent 成功结束 |
| `TaskStarted` | `agent`/`process`/`question` | `task_id`, `kind`, `description`, `status`, `detached`, `started_at` | 否 | background task 启动 |
| `PreCompact` | `manual` 或 `auto` | `trigger`, `token_count` | 否 | compaction 前；返回值完全忽略 |
| `PostCompact` | `manual` 或 `auto` | `trigger`, `estimated_token_count` | 否 | compaction 后 |
| `Notification` | notification type，如 `task.completed` | `sink`, `notification_type`, `title`, `body`, `severity`, `source_kind`, `source_id` | 否 | background task 状态通知，不是普通 turn 完成事件 |

证据：[S7][S10][S13][S14][S15]

## 7. Hook 输出与阻断协议

### 7.1 Exit code

| 结果 | 语义 |
| --- | --- |
| exit `0` | allow；对支持上下文注入的路径，stdout 可追加到上下文 |
| exit `2` | block；stderr 作为阻断理由 |
| 其他非零 | command error，fail-open |
| timeout / spawn error / crash | fail-open |

只有 `PreToolUse`、`UserPromptSubmit`、`Stop` 的返回值能阻断主流程。其余 17 个事件为 observation-only。[S7][S13]

### 7.2 Structured stdout

exit `0` 时可以在 stdout 输出 JSON：[S7][S13]

```json
{
  "message": "optional context text",
  "hookSpecificOutput": {
    "permissionDecision": "deny",
    "permissionDecisionReason": "Please use rg instead of grep"
  }
}
```

- `hookSpecificOutput.permissionDecision` 必须精确为 `deny` 才形成 block。
- `permissionDecisionReason` 只有 string 才作为 reason。
- `message` 可位于顶层或 `hookSpecificOutput.message`。
- 普通非 JSON stdout 对 `UserPromptSubmit` 可作为 context text；非零退出和 timeout 的 stdout 不注入。

### 7.3 Fail-open 的实现影响

官方明确说明 Hooks 不应作为唯一安全边界。CLI-Manager 可把它用于状态同步、通知和轻量拦截，但不能把“Hook 已安装”解释为高风险操作已被强制防护。[S7]

对于只上报状态的 CLI-Manager wrapper：

- 不要把 bridge HTTP response 原样打印到 stdout，尤其是 `Stop`/`UserPromptSubmit`，防止意外注入上下文或被解析为 deny。
- 正常成功应无 stdout、exit `0`。
- Kimi 官方执行器对非 `2` 失败码采用 fail-open；但 CLI-Manager 既有 hidden Hook client 契约要求 bridge 失败写入脱敏 stderr 后仍退出 `0`，避免各 CLI 对非零码解释差异。本任务维持仓库现有契约，不把 Hook 当安全边界，也不伪造事件送达。
- `Stop` 是同步且可阻断的事件，wrapper 必须快速、确定地结束，不能把长轮询放在该路径。

## 8. Windows / PowerShell 安装与检测

### 8.1 官方安装事实

官方推荐命令：[S3][S20]

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

- 安装脚本支持 PowerShell 5.1+，主动启用 TLS 1.2。
- 默认 `KIMI_INSTALL_DIR=%USERPROFILE%\.kimi-code`。
- binary 安装为 `%USERPROFILE%\.kimi-code\bin\kimi.exe`。
- 安装器将该 `bin` 加入 User PATH；新终端才保证看到更新后的 PATH。
- `KIMI_NO_MODIFY_PATH` 可禁用 PATH 修改。
- 当前 `0.37.2` manifest 实际提供 `win32-x64` 与 `win32-arm64`，没有 `win32-x86` artifact。[S19]
- Kimi Code 首次运行前需安装 Git for Windows；自定义安装位置可通过 `KIMI_SHELL_PATH=<absolute bash.exe>` 指定。[S3][S16]

### 8.2 推荐的 PowerShell 只读检测

以下是 CLI-Manager 实现建议，不是官方提供的专用 probe：

```powershell
$command = Get-Command kimi -ErrorAction SilentlyContinue | Select-Object -First 1
$defaultBinary = Join-Path $env:USERPROFILE '.kimi-code\bin\kimi.exe'
$kimiBinary = if ($command) { $command.Source } elseif (Test-Path $defaultBinary) { $defaultBinary } else { $null }

if ($kimiBinary) {
  & $kimiBinary --version
  & $kimiBinary doctor config
}

$kimiHome = if ($env:KIMI_CODE_HOME) {
  $env:KIMI_CODE_HOME
} else {
  Join-Path $env:USERPROFILE '.kimi-code'
}
$configPath = Join-Path $kimiHome 'config.toml'
Test-Path -LiteralPath $configPath -PathType Leaf
```

实现时还应：

- 枚举 `Get-Command kimi -All`，识别原生 `kimi.exe` 与 npm 产生的 `.cmd`/`.ps1` shim 冲突。
- PATH 未刷新时检查官方默认 binary path，但允许用户配置自定义 binary path，因为 `KIMI_INSTALL_DIR` 不一定可从当前环境读取。
- 独立报告 Git Bash 是否可用；官方源码的探测顺序是 `KIMI_SHELL_PATH`、PATH 上各 `git.exe` 推导位置、`git --exec-path` 推导位置、标准 Git for Windows 目录以及 `%LOCALAPPDATA%\Programs\Git`。[S16]
- Hook command 若用 PowerShell，显式写 `powershell.exe -NoProfile -NonInteractive -File <absolute-script>`，不要假定 command string 本身由 PowerShell 解析。

## 9. SSH remote 环境安装与检测

### 9.1 官方事实与边界

当前官方文档、命令参考和仓库没有给出独立的 SSH remote installer、SSH discovery endpoint、远端 Agent 或 Hook bridge 协议。

可确定的是：

- Linux/macOS 官方安装命令为：[S3][S21]

  ```sh
  curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
  ```

- 该脚本在“执行脚本的那台机器”检测 OS/architecture、下载并校验 checksum、写入该用户的 `$KIMI_INSTALL_DIR/bin/kimi`，并修改该用户的 shell rc。
- 当前原生 manifest 提供 Linux `x64`/`arm64`、macOS `x64`/`arm64`。[S19]
- 官方原生 Linux binary 只支持 glibc；install.sh 会拒绝 Alpine/musl，并明确建议改用 Node.js + `npm install -g @moonshot-ai/kimi-code`。[S21]
- npm 安装要求 Node.js `>=22.19.0`。[S1][S3]

所以 SSH 集成必须在远端 host 上执行安装和检测，不能以本机 `kimi`、本机 Home 或本机配置代表远端状态。

### 9.2 推荐的远端只读 probe

以下脚本应通过既有 SSH transport 在远端执行；它不是官方专用 API：

```sh
kimi_home="${KIMI_CODE_HOME:-$HOME/.kimi-code}"

if command -v kimi >/dev/null 2>&1; then
  kimi_bin="$(command -v kimi)"
elif [ -x "$HOME/.kimi-code/bin/kimi" ]; then
  kimi_bin="$HOME/.kimi-code/bin/kimi"
else
  kimi_bin=""
fi

if [ -n "$kimi_bin" ]; then
  "$kimi_bin" --version
  "$kimi_bin" doctor config
fi

test -f "$kimi_home/config.toml"
```

实现注意：

- 非交互 SSH shell 常常不会读取 installer 修改的 rc；因此 `command -v` 后应检查官方默认 absolute path。
- 自定义 `KIMI_INSTALL_DIR` 没有官方全局登记或发现 API。默认路径和 PATH 都失败时，应允许用户指定远端 binary path，而不是递归猜目录。
- `KIMI_CODE_HOME` 必须按启动 Kimi 的远端环境解析；CLI-Manager 自己的 SSH probe 环境与交互终端环境可能不同，应把最终使用的 env/config root 明确显示给用户。
- Hook 配置、Hook wrapper 和 bridge 都必须安装在远端。stdin JSON 中只有远端 `cwd`/session facts，没有 SSH host identity；CLI-Manager wrapper 需要在不泄露 credential 的 sidecar/受保护配置中补充 host/project identity。
- install.sh 会修改 shell rc、安装 binary 并可能迁移旧 shim，属于有副作用操作；检测和安装必须分开，安装前显式确认。

## 10. CLI-Manager Hook 集成建议

### 10.1 建议事件集合

| CLI-Manager 状态 | 官方事件 | 说明 |
| --- | --- | --- |
| turn running | `TurnStarted` | 比 `UserPromptSubmit` 完整，覆盖 task/system-trigger origin |
| waiting approval | `PermissionRequest` | matcher 可按 tool name 筛选 |
| approval resolved | `PermissionResult` | 根据 `decision` 更新/清除 attention |
| normal turn finished | `Stop` | 当前唯一正常结束 Hook；必须保证 wrapper 不返回 block |
| turn failed | `StopFailure` | error type/message 可用于失败状态 |
| user interrupted | `Interrupt` | 不应误记为正常完成 |
| session closed | `SessionEnd` | 区分 `exit`/`archive` |
| liveness | `SessionHeartbeat`（可选） | 60 秒；只有配置时才有 timer |
| background work | `TaskStarted` + `Notification` | 不要把 background `Notification` 当普通 turn 完成 |

`UserPromptQueued`、Subagent、Compact 和 Tool events 可按产品需求增量接入，不需要为“完整安装”强制安装全部 20 条规则。

### 10.1.1 本任务确认决策（2026-08-19）

- 接入 `PermissionResult` 与 `Interrupt`，暂不接入 `SessionEnd`/Heartbeat/Task/Tool/Compact。
- Kimi Subagent 只进入通用 binding、状态、通知和 Replay，不创建 transcript split pane。
- 本地自定义 root 仅管理 Hook config，不自动注入 `KIMI_CODE_HOME`；SSH custom root 仍注入。
- 仅支持当前 Kimi Code；inspect/install 使用 `doctor` capability/candidate validation，旧 `kimi-cli` 显示 unsupported 且不迁移 `~/.kimi`。

### 10.2 配置所有权与写入

1. 用 TOML-aware 编辑器保留用户现有 provider、model、permission、第三方 hooks 和注释；不要字符串拼接整个文件。
2. schema 不允许自定义 `id` 字段。CLI-Manager 应以稳定且唯一的 wrapper command/path 作为所有权标识，并在可保留时加相邻注释；卸载只删除自己拥有的 entries。
3. 不要用“Hook 总条数”等于固定数量判断安装状态。应逐条匹配 CLI-Manager 所需 event + owned command，并允许官方以后增加事件、用户增加 Hook。
4. 在替换 live config 前，把 candidate 写到临时文件并执行：

   ```sh
   kimi doctor config /path/to/candidate-config.toml
   ```

   验证成功后再原子替换；失败时原样展示官方 validation error，不做静默降级。
5. 修改配置后明确提示“新 session 生效；活动 TUI 需 `/reload`”。当前官方新产品没有旧文档中的 `/hooks` 查看命令，安装状态应由配置解析 + `doctor` 验证得出。[S8][S23]

### 10.3 事件绑定与 transport

- 公共 payload 有 `session_id`、`cwd`、`client_type`、可选 `session_title`，但没有 SSH host id、CLI-Manager tab id、统一 event id 或 sequence。
- 本地可用 session + cwd 作为候选绑定信息；SSH 必须由远端 wrapper 补充 host/project identity。
- wrapper 应生成自己的稳定 event id 用于 transport 去重；不要把 title 当身份。
- `PermissionRequest`/`PermissionResult` 包含 `tool_call_id`，可优先用于审批生命周期关联。
- `Stop`/`StopFailure`/`Interrupt` 是互斥语义路径，不能收到其中任意一个就统一标成 completed。

## 11. 确定事实清单

- [x] 当前主命令是 `kimi`。
- [x] 当前官方 npm 包是 `@moonshot-ai/kimi-code`。
- [x] `2026-08-18 UTC` 官方 CDN 最新版本是 `0.37.2`。
- [x] 当前默认数据 Home 是 `~/.kimi-code`，Windows 展开为 `%USERPROFILE%\.kimi-code`。
- [x] 当前主配置是 `$KIMI_CODE_HOME/config.toml`，默认 `~/.kimi-code/config.toml`。
- [x] `KIMI_CODE_HOME` 与原生安装器的 `KIMI_INSTALL_DIR` 是不同职责的变量。
- [x] 当前存在官方 Hooks API，格式是 TOML `[[hooks]]`。
- [x] 用户 Hook schema 只有 `event`、`matcher`、`command`、`timeout` 四个字段。
- [x] 当前支持 20 个 Hook events。
- [x] `PreToolUse`、`UserPromptSubmit`、`Stop` 可阻断；其他事件 observation-only。
- [x] Hook 失败、超时、无效 regex 均 fail-open。
- [x] Windows 官方安装方式是 PowerShell installer，Git for Windows 是首次运行前置。
- [x] SSH 没有独立官方协议，应在远端按远端 OS 安装/检测。
- [x] `kimi doctor config [path]` 是官方只读配置验证入口。

## 12. 仍未知或官方未承诺的项目

1. **Hook API 版本化**：没有独立 Hook schema version、兼容性等级或机器可读 capability negotiation；事件在 `0.32.0` 仍增加过，不能硬编码“永远 20 个”。[S18]
2. **完整机器可读 JSON Schema**：官方没有发布独立的 Hook stdin/output JSON Schema 文件；payload 以文档和源码类型为准。
3. **Windows Hook shell**：官方没有承诺 Hook command 由 PowerShell、Git Bash 还是其他具体 shell 解释；只能确认当前源码使用 `shell: true`。
4. **SSH discovery**：没有官方远端探测命令、registry 或 agent protocol，也没有自定义 `KIMI_INSTALL_DIR` 的全局登记位置。
5. **Hook 列表 CLI**：当前 Kimi Code 命令/Slash command 文档未提供机器可读 Hook list/export 命令；应解析配置并用 `doctor` 验证。
6. **事件传输标识**：payload 没有统一 event id、sequence、SSH host id 或 CLI-Manager tab id。
7. **输出/输入总大小上限**：官方未文档化 Hook stdin、stdout、stderr 的通用大小上限；只在当前源码中看到 `PostToolUse.tool_output` 截断到 2000 字符。
8. **活动 session 的外部 reload**：只文档化 TUI `/reload`，没有第三方非交互 reload API。

## 13. 官方来源 URL

### 当前产品与文档

- **[S1] [当前 package 与命令映射（固定 commit）](https://github.com/MoonshotAI/kimi-code/blob/cdaa80b778072662bebd9fb1c09aac98f0f15591/apps/kimi-code/package.json)**
- **[S2] [固定源码快照](https://github.com/MoonshotAI/kimi-code/commit/cdaa80b778072662bebd9fb1c09aac98f0f15591)**
- **[S3] [Getting started / 官方安装](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html)**
- **[S4] [Data locations](https://moonshotai.github.io/kimi-code/en/configuration/data-locations.html)**
- **[S5] [Environment variables](https://moonshotai.github.io/kimi-code/en/configuration/env-vars.html)**
- **[S6] [Configuration files](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html)**
- **[S7] [Hooks 官方文档](https://moonshotai.github.io/kimi-code/en/customization/hooks.html)**
- **[S8] [`kimi` command / `doctor`](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html)**
- **[S9] [从旧 kimi-cli 迁移](https://moonshotai.github.io/kimi-code/en/guides/migration.html)**

### 当前 Hooks 源码（固定 commit）

- **[S10] [20 个事件 enum](https://github.com/MoonshotAI/kimi-code/blob/cdaa80b778072662bebd9fb1c09aac98f0f15591/packages/agent-core-v2/src/agent/externalHooks/types.ts)**
- **[S11] [用户配置 Zod schema](https://github.com/MoonshotAI/kimi-code/blob/cdaa80b778072662bebd9fb1c09aac98f0f15591/packages/agent-core-v2/src/agent/externalHooks/configSection.ts)**
- **[S12] [matcher、并行与 command 去重](https://github.com/MoonshotAI/kimi-code/blob/cdaa80b778072662bebd9fb1c09aac98f0f15591/packages/agent-core-v2/src/app/externalHooksRunner/runner.ts)**
- **[S13] [command runner、stdin/output、timeout/fail-open](https://github.com/MoonshotAI/kimi-code/blob/cdaa80b778072662bebd9fb1c09aac98f0f15591/packages/agent-core-v2/src/agent/externalHooks/runner.ts)**
- **[S14] [Agent 级事件触发与 payload](https://github.com/MoonshotAI/kimi-code/blob/cdaa80b778072662bebd9fb1c09aac98f0f15591/packages/agent-core-v2/src/agent/externalHooks/externalHooksService.ts)**
- **[S15] [Session/Subagent/Heartbeat 事件触发与 payload](https://github.com/MoonshotAI/kimi-code/blob/cdaa80b778072662bebd9fb1c09aac98f0f15591/packages/agent-core-v2/src/session/externalHooks/externalHooksService.ts)**
- **[S16] [Windows Git Bash 探测源码](https://github.com/MoonshotAI/kimi-code/blob/cdaa80b778072662bebd9fb1c09aac98f0f15591/packages/agent-core-v2/src/_base/execEnv/environmentProbe.ts)**
- **[S22] [Host process spawn/Windows process-tree termination](https://github.com/MoonshotAI/kimi-code/blob/cdaa80b778072662bebd9fb1c09aac98f0f15591/packages/agent-core-v2/src/os/backends/node-local/hostProcessService.ts)**
- **[S23] [当前 Slash commands reference](https://moonshotai.github.io/kimi-code/en/reference/slash-commands.html)**

### 官方发布与安装 CDN

- **[S17] [当前 rollout metadata](https://code.kimi.com/kimi-code/latest.json)**
  - 研究时响应 SHA-256：`6938a952a91e120d977fcef90aa7ed758351bb24ac78afafc062bd0b61ef9dcf`
- **[S18] [官方 changelog](https://moonshotai.github.io/kimi-code/en/release-notes/changelog.html)**
- **[S19] [`0.37.2` 固定 manifest](https://code.kimi.com/kimi-code/binaries/0.37.2/manifest.json)**
- **[S20] [Windows PowerShell installer](https://code.kimi.com/kimi-code/install.ps1)**
  - 研究时响应 SHA-256：`ebeb2ac3a8e4a996a7ea90ffa433f5681876e8200fa41ae95cace1830dad3069`
- **[S21] [Linux/macOS installer](https://code.kimi.com/kimi-code/install.sh)**
  - 研究时响应 SHA-256：`624e4857a73f587961b51ef91c9bf28229f886a0817e96935e88dfd09445faab`

### 旧 kimi-cli 官方资料（仅用于迁移和误判边界）

- **[S24] [旧项目官方仓库与退役说明](https://github.com/MoonshotAI/kimi-cli)**
- **[S25] [旧项目 Data locations](https://moonshotai.github.io/kimi-cli/en/configuration/data-locations.html)**
- **[S26] [旧项目 Hooks（13-event 旧契约）](https://moonshotai.github.io/kimi-cli/en/customization/hooks.html)**

> `latest.json` 和 installer URL 是移动资源；版本/源码结论以 `0.37.2` manifest 与固定 commit `cdaa80b...` 为复现基线。
