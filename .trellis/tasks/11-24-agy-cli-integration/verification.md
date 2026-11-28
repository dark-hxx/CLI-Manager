# V1.5.3 · agy 验证记录

## Windows：已运行

- 环境：Windows 原生；`agy --version` 为 `1.3.5`。`agy --help` 给出 `--conversation`（按 ID）及 `-c/--continue`（最近一条，两者语义不同）。
- `python scripts/agyWindowsSmoke.py`（需要 Git for Windows）：从三份临时、相互独立的 home/工作目录进入真实 TUI 登录页，不复用个人登录、不发送 prompt、不运行来自用户配置的命令。custom、stack 模式各自显示了测试命令的标记；disabled 模式未调用命令，也未显示标记。测试不检查叠加时的精确视觉位置。
- `python scripts/testAgyStatuslineRuntime.py <新编译的本机产品 exe> --tui` 进一步使用 Rust 生产命令生成器及实际产品 helper，不是固定 mock 标记。可执行路径含中文、空格、`&`、直/弯引号、`%` 和 `!`；真实 agy `1.3.5` 登录页在 custom 与 stacked 时显示测试工作目录，disabled 时不显示。单独经 Windows cmd 与 Git for Windows sh 的真实进程测试，含中文的 stdin、缺字段、明确报告的 0、窄屏换行和 ANSI stdout 均逐字节符合，stderr 为空。Git for Windows sh 不等同于 macOS 或 WSL 真机。
- 在该版本的登录页，状态栏 stdin 的白名单字段中，`cwd`、`conversation_id`、`session_id`、`agent_state` 是字符串；`model` 为 null；`context_window` 为对象；`terminal_width` 为整数。不保存字段原值、完整 stdin、邮箱或终端画面。这是状态栏协议证据，不是历史用量证据。
- 三个隔离测试均产生 0 份交互 transcript；默认 CLI 根的 `brain`、`conversations` 也均为空（仅查目录元数据）。没有取用 App/IDE 的日志作为替代，未核实带模型回复的 CLI transcript 的 Token 字段。**证据不足不是全版本不记录。**

- Hook 使用安装器生成的 Windows 命令，从含空格、中文、单引号及 `&` 的临时可执行路径调用编译后的产品 `__hook`。合成 stdin 经真实进程和已鉴权的本机回环服务器，验证开始、调用和空闲停止的最小投递；关闭接收、缺少身份、离线、坏 JSON、超限和后台未空闲均返回不干预响应且正常退出。不是从已登录 agy 取得的事件。

## 桌面组件与回归（不代表已登录的 agy 会话）

- 使用实际 React 通用设置、Hook 和状态栏组件，在隔离浏览器里通过「界面语言」从简体中文切换 English。两页的标题、模式、字段、替换操作及「不记录用量」提示均随切换更新；读取状态和渲染样例只调用只读 IPC 桩，没有改写偏好或 agy 配置。此项不是原生 WebView/IPC 联调。历史列表使用的 `formatTime` 对同一份本地 21:07 样本，中文输出 `11/24 21:07`，英文输出 `11/24, 21:07`。
- 以同一 checkout 运行启动、历史恢复、启动参数、多行命令与现有 CLI 的 8 个 Node 测试文件：113/113。覆盖两个 ID 同 cwd、旧根、快照、选中与新读详情的实例矛盾、指定目录消失、SSH 隔离和命令快照；这些是自动化用例，不是已登录 TUI A/B。Hook 共享 HTTP 接收 39/39、第三方通知回归 12/12、WSLENV 7/7、schema 21/21；agy 状态栏 Rust 12/12。
- 桌面生产前端 `npm run build`（TypeScript + Vite）及 `npm run tap:build` 均已通过；Vite 仍提示部分现有模块同时被静态与动态引用，以及包体积较大。前者不是 Windows 安装包构建。最后一次 `cargo check --locked` 通过，`npm run check:architecture -- --strict` 检查 1553 个文件，0 超 2000 行、0 新违规，`git diff --check` 通过。
- 最终合并运行 12 个 Node 测试文件：135/135。包含 agy 全未知、确证零、混合已计量小计和项目排行的中英文组件输出；另有临时 SQLite / 磁盘 fixture 验证会话消息活动未因 Token 缺失而丢失，以及原生/WSL 路径大小写和非空 UUID 的身份边界。这里的 SQLite 数值是合成测试数据，不是 agy 日志字段的证据。
- GitNexus 对工作区已有跟踪文件标记为 critical，主要因为历史索引、运行时和设置被多个既有流程共享；新文件不以该扫描的数量代替测试。回归范围包含既有来源的启动、参数、历史分页和按项目过滤。
- Windows 隔离 HOME / AppData 运行完整 Rust library 测试：1661 通过、1 失败、14 个默认忽略。唯一失败 `device_identity::tests::file_uri_decodes_escaped_path` 传入 `file:///tmp/My%20Wallpaper.jpg`，Windows 不把它识别为本机文件。该壁纸模块和依赖与 HEAD 一致；未跨范围修复。另跑 history 相关回归 173/173。需显式指定产品 exe 的 agy 烟测另行执行，不把默认忽略算通过。
- 已有置顶栏外观断言 `scripts/pinnedProjectLocate.test.mjs:19` 依赖完整静态 class 字符串，HEAD 已有额外的自动隐藏滚动条 class。其余同组测试通过；未为本任务更改该断言或组件，不宣称全仓测试全绿。

## 待有凭据的测试账号或真机验证

1. 在独立测试账号与空项目中启动 A，进行两轮无敏感内容的对话；另建 B，再从历史选 A，核对恢复的原生 ID、cwd、工作树，以及只绑定 A 的 Tab。若不希望共享日志，直接在本地记录版本、脱敏字段路径、数值递增/重复规律即可。
2. 双 Tab 同 cwd，分别开关 Hook；观察多次模型调用、普通完成、失败、后台未结束。未安装或禁用 Hook 时，历史仍能读取；选中缺失 Token 的历史不能显示为免费或零消耗。
3. 从设置选择 agy、调整排序，预览后主动应用；确认 TUI 的布局，切成叠加或停用。若有原自定义命令，先取消，再同意替换并还原。应用后在 agy 自行改配置，CLI-Manager 不应把用户改动抹掉。
4. macOS 和两个独立 WSL distro 重复上述用例，尤其核对同路径/同会话 ID 不跨系统、带空格和非 ASCII 路径、shell 引号与恢复失败提示。没有对应桌面前不记为真机通过。使用 zh-CN/en-US 检查增量界面和空状态。

没有在本次测试中登录、创建付费模型调用、发布产品或改写真实用户 agy 配置。

## 2026-11-26：macOS 真实 `agy 1.5.17` 样本核对与统计/工作区映射对接

- 样本来源：用户提供的 macOS `agy CLI 1.5.17` 真实交互对话压缩包（`~/.gemini/antigravity-cli/`），结合多轮对话 `transcript.jsonl` 核对：
  - `transcript.jsonl` 的 `DONE` + `MODEL` + `PLANNER_RESPONSE` 事件确认写入 `step_index`、`created_at`、`model`、`input_tokens`、`cache_read_tokens`、`output_tokens`（含仅工具调用且无正文 `content` 的步骤）；语义为逐调用增量且 `input_tokens` 为非缓存输入。
  - `conversation_summaries.db` 的 `conversation_summaries` 表确认写入 `conversation_id` 与 JSON 数组 `workspace_uris`（`file://` URI），`history.jsonl` 仍保留 `conversationId` / `workspace` 可作兼容回退。
- 已完成 3 处核心对接与默认根修正：`antigravity.rs` / `source_metadata.rs`（`conversation_summaries.db` + `history.jsonl` 回退 + 指纹缓存）、`transcript_parsers.rs` / `stats.rs` / `catalog.rs` / `sources.rs` / `historySources.ts`（Token/模型/趋势解析、看板聚合与版本递增）、`TerminalStatsPanel.tsx` / `roots.rs`（恢复 Token/趋势/模型卡片、有界轮询与 OS Home 默认根）。
