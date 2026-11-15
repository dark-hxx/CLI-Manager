# 实现与验收记录

版本：TEMP；日期：2026-11-15。

## 结果与发现清单

- 已删除：CcusageStatsPanel、ccusageStore、Rust ccusage 模块及三个 IPC 注册、专用来源类型、通用设置的开关/WSL 状态/安装弹窗、设置字段和同步策略、中英文专属文案。
- 已删除：只供外部看板使用的 EChart 封装、颜色/tooltip 常量、echarts 和 zrender 锁文件条目；锁文件没有其他版本变更。
- 已调整：App 分析入口统一打开 StatsPanel，删除该入口专用的 Hook 检查、类型和引导逻辑。
- 已保留并确认无须修改：内置历史分析、请求记录、终端实时统计、统计按钮可见性控制、共享 Recharts 色板、StatsDatePicker、Hook 本体、WSL 基础能力和模型价格存储。
- 终端 useTerminalTabsController 也使用 Hook 提示，因此共享通知键保留；两个通知字典最终内容与 HEAD 一致。
- 数据库 v10 保持原文，新增 v42 清理废弃派生缓存。生产代码中的 ccusage 字面引用仅存在于这两项迁移；回归测试保留旧表名以验证升级清理。
- CHANGELOG 的 TEMP 节、功能清单的历史用量分析板块、CLAUDE 说明和现行契约已更新。

## 已通过

- `npx tsc --noEmit`。
- `npm run build`：Vite 生产构建通过，31.95 秒；存在既有大 chunk 和混合导入提示。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过，26.01 秒；编译器启动一度触发 Windows 线程资源错误，项目的 rustc-retry 自动重试成功。
- `node --test scripts/workspaceBackgroundLayout.test.mjs scripts/settingsPresentation.test.mjs`：8/8 通过。
- `npm run check:architecture -- --strict`：1511 个源码文件，0 个超过 2000 行，0 个违规。
- 对真实 syncSettings 模块转译后运行：旧 ccusage 开关 true/false 均不会进入备份/恢复字段集合，语言和主题字段完整保留。
- 中英文 analytics/settings 字典键集合一致。
- Python SQLite 内存数据库运行真实迁移 SQL：缓存不存在、空表、有记录三种状态均成功；表和索引删除；重复执行安全；其他项目/模型价格数据完整保留；v10 SQL 与 HEAD 完全一致。
- `git diff --check` 通过；源码/脚本/依赖/现行契约残留引用已核对。

## 图分析与边界

- 编辑前 impact：共享 settingsStore 为 CRITICAL（114 个直接依赖），专门限定到两个退休字段；Rust 命令 UNKNOWN 通过 IPC 注册及 invoke 字面引用补充确认。
- EChart impact 为 LOW，两个直接图表消费者均属于已删除的外部看板；共享 statsPalette 为 MEDIUM，保留其他消费者使用的色板。
- `detect-changes --scope all --limit 1000 --repo .` 已运行：30 个已跟踪变更文件、496 个符号、661 个影响流程，风险 CRITICAL；shared store 的图传播覆盖多领域，不能解释为低风险。
- 索引落后两个构建相关提交，FTS 降级且 MCP 连接关闭，使用 CLI 图分析和源码核对。CLI 只展示前 10 个流程；这些数据是影响估计，不声称完整无影响。未进行 Git 提交或同步。

## 待人工桌面验收

项目 `.trellis/spec/frontend/quality-guidelines.md` 明确规定：AI agents must not start CLI-Manager services or the Tauri desktop app to verify runtime UI behavior。

- 设置 → 通用：中英文下均无 ccusage 开关、WSL 状态和安装弹窗；“显示分析看板按钮”仍正常工作。
- 使用之前启用/未启用 ccusage 的偏好与备份：分析入口直接打开内置看板，无工具检测/Hook 安装拦截；历史查询、来源和时间筛选正常。
- 设置 → 通用 → 界面语言切换中文/英文：模型价格说明生效，时间仍为 24 小时制。
- 终端内置实时统计仍按自己的 Hook 就绪状态工作；工作区背景及窄窗口布局正常。

实施和自动验证完成，任务进入 review，人工桌面结果未冒充通过。

## 复查问题修复与 Rust 测试

- 根因：`provider_migration_tests::history_generated_titles_and_request_project_path_migrations_are_additive` 把版本 41 当作注册表固定上限，导致新增 v42 后断言失败；原先 `cargo check` 不执行测试，未发现该断言问题。
- 修复：把固定上限替换为相邻迁移版本严格递增的检查，继续检测重复和错误排序，并兼容后续新增迁移。
- 补充：`app::migrations::retired_analytics_migration_tests` 验证 v42 唯一登记、位于 v41 后且为 Up 迁移；在真实 SQLite 事务中覆盖缺表、空表、有旧数据的清理，确认旧表/索引删除、重复清理安全以及项目/模型价格/内置用量数据完整保留。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib migration`：34/34 通过，包括原先失败的断言、两个新增测试、完整插件迁移列表兼容性测试和数据库修复相关测试；编译 33.48 秒，执行 0.09 秒。
- 本批次 `npm run check:architecture -- --strict` 再次通过：1511 个源码文件、0 超限、0 违规；`git diff --check` 通过。
- 本批次仅修改 Rust 测试和交付记录，不改变生产迁移 SQL 或界面；原有人工桌面验收项仍保持待验证。
