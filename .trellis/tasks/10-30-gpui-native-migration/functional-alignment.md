# GPUI 功能对齐矩阵

依据父任务 `design.md` §9（2026-10-31 复核）。状态只表示当前代码和已有验证证据，不代表平台人工验收已经完成。

| # | 功能域 | GPUI 当前状态 | 证据/入口 | 下一步 |
|---:|---|---|---|---|
| 1 | 根壳、标题栏、关闭行为、退出遮罩 | 部分完成 | `apps/desktop-gpui/src/main.rs`、`render.rs`、`exit.rs`、`shell_controls.rs`、`ime.rs`；透明标题栏、自绘拖动区和窗口控制已接，GPUI 测试覆盖退出决策 | Windows Snap、双击/跨屏及退出/后台真实窗口矩阵 |
| 2 | 设置 | 部分完成 | `settings_host.rs`、`terminal_settings.rs`、共用 `TerminalPreferences`；终端字体/字号/行高/历史/光标持久化与热更新已接线，Tauri 消费同键；偏好、引擎与语言/主题测试 | 终端设置双壳真实窗口/双语验收，补齐其他面板和全部字段对齐 |
| 3 | 项目树、分组、拖拽、Worktree、冲突解决 | 部分完成 | `projects`、`workspace/worktree.rs`、`workspace/conflicts`；真实临时 Git 测试 | 拖拽树和完整冲突人工矩阵 |
| 4 | 终端、分屏、Workspan、回放、后台任务 | 部分完成 | `terminal`、`workspace/pane_tree.rs`、`background_sessions.rs`；daemon bootstrap、后台列表与 attach、外部路径拖放和 core 图片快照粘贴已接线；共享行准备 LRU 与 1/2/4/8 Pane 原生缓存对照基准已落地 | 完整回放、Workspan、Alt+V/SSH 图片上传、真实 PTY/呈现/缓存失效及系统剪贴板验收 |
| 5 | 文件树、编辑 | 已接入核心路径 | `files.rs`、文件 watcher、EditorState；文件操作/标签/保存测试 | 完整编辑器交互和 5,000 文件真实窗口性能 |
| 6 | Markdown、HTML、PDF 预览 | 已接入代码路径，平台验收未完成 | `crates/preview`、`preview_host.rs`；Windows PoC 截图和生命周期证据 | 六状态 × 三类型矩阵、焦点/DPI/Airspace/IME |
| 7 | Git 状态、暂存、提交、引用、Diff | 已接入核心路径 | `git.rs`、增量 watcher、git2 元数据、tree-sitter 高亮测试 | 5,000 文件真实窗口刷新 ≤200ms |
| 8 | 历史浏览、转录、搜索、收藏 | 已接入核心路径 | `history.rs`、`history-core`、共享 watcher、20 文件模型测试 | Tauri↔GPUI 真实切换和 UI 更新 ≤300ms |
| 9 | 统计、图表、请求日志 | 部分完成 | `apps/desktop-gpui/src/stats.rs`、`history.rs`；历史摘要、7 天活动/Token 趋势、历史来源构成、请求数、来源/模型构成、当前项目最近请求明细、项目效率摘要及来源/时间/项目筛选已接入；全部项目筛选会独立扫描全部历史会话，`core-db` 有真实 SQLite 聚合测试及相似路径边界回归 | 完成真实窗口筛选交互与全量统计验收 |
| 10 | 扩展（MCP/Skills） | 部分完成 | `apps/desktop-gpui/src/stats.rs`、`crates/core-db/src/extensions.rs`、`crates/core-db/tests/extensions.rs`；GPUI 展示共享 MCP/Skill/部署记录，支持 MCP 名称编辑、删除和三 CLI 独立开关；数据库写保护、名称校验/损坏记录与开关事务有 SQLite 回归 | 迁移 MCP transport/秘密完整编辑与导入、Skill 导入/部署/卸载和策略操作 |
| 11 | Provider、路由、快速切换 | 未完成 | 共用服务存在，GPUI 无完整面板接入 | 迁移 Provider 与路由面板 |
| 12 | 同步（WebDAV） | 未完成 | GPUI 无同步面板和操作入口 | 接入同步配置、状态和操作 |
| 13 | SSH、远程 | 未完成 | 基础设施存在，GPUI 无远程入口 | 迁移远程连接配置和会话操作 |
| 14 | 提示词、模板 | 未完成 | GPUI 无三级作用域模板完整入口 | 迁移模板列表、编辑和作用域行为 |
| 15 | 命令面板、快捷键、Workspan 栏 | 部分完成 | `keymap.rs`、`shell_controls.rs`、命令面板和 Preview IPC 快捷键 | 完整动作注册、配置和 Workspan UI |
| 16 | 桌宠 | 未完成 | GPUI 无第二窗口桌宠实现 | 实现同进程第二窗口与生命周期 |
| 17 | Web 服务设置、设备 Operation | 部分完成 | web-daemon 保留，GPUI 无完整设置/设备操作面板 | 接入原生设置与设备 Operation |
| 18 | 托盘、单实例、更新、通知、Explorer 右键 | 未完成 | 现有 Tauri/安装器能力未迁移到 GPUI | 实现桌面集成与安装包路径 |
| 19 | 许可证与发布切换 | 部分完成 | `.cargo/deny.toml` 和 `cargo deny check licenses` 已通过 | 人工来源复核、双轨发布期和下线计划 |

## 对齐规则

- “已接入核心路径”只表示代码入口、模型和自动化测试存在；平台窗口、人工交互或跨壳一致性仍需单独验收。
- “部分完成”表示已有可复用基础或局部 UI，但不能满足父任务的全量功能要求。
- 只有补齐实现、对应子任务验收记录和必要的真实平台证据后，才能把条目改为“完成”。

## 关联记录

- 父任务实施进度：`implementation-progress.md`
- Workspace 验收：`../10-30-gpui-workspace-features/prd.md`
- 父任务验收：`prd.md`
