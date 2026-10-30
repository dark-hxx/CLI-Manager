# 设计：设置 / 扩展 / Provider / 同步 / SSH / 提示词 / 统计

> 上游：父 `design.md` §9；shell-foundation（SettingsModel、ui_kit、表单约定）；rich-content-host（CodeEditor、原生 Markdown、PreviewHost 设置数据接口）；core-extraction（Repository、PrefsStore、CoreEvent）。
> 原则：设置值写回同一偏好文件且保留未知字段；每个页面以 React 版为验收基准。

## 1. 表单框架

- `SettingsPage` trait：`id`、`title_key`、`icon`、`search_keywords`、`render(cx)`；左侧导航 + 顶栏搜索（对应 `SettingsNav`、`SettingsTopBar`、`SettingsLayout`、`SettingsListItem`）。
- `SettingField<T>` 组件：绑定 `SettingsModel` 的字段路径，提供即时保存（防抖 300 ms）、校验、重置为默认、“需重启生效”提示；所有页面复用。
- 设置搜索：页面注册关键字 + 字段标签，模糊匹配后跳转并高亮字段。

## 2. 页面清单（对应 `src/features/settings/components`）

| 页面 | React 源 | 特殊控件/依赖 |
|---|---|---|
| 常规 | `GeneralSettingsPage`、`ExternalTerminalProgramSetting`、`DataStorageSection` | closeBehavior、exitWithRunningTasksBehavior、backgroundIncludeFinishedTasks（与 terminal-native 退出守卫联动）、数据目录迁移 |
| 外观/主题 | `ThemeSettingsPage`、`ThemeToggle`、`FontFamilySelect`、`TerminalThemePresetGrid`、`TerminalBackgroundSection` | 颜色选择、字体列表（FontCatalog 懒加载）、背景图（复制到 `appLocalData/backgrounds/<hash>.<ext>`，core 已有）、**预览渲染**状态区（rich-content-host 数据接口） |
| 侧栏 | `SidebarSettingsPage` | |
| 快捷键 | `ShortcutSettingsPage` | 键位录制控件；冲突检测；与 shell-foundation Keymap 双向 |
| 命令建议 | `CommandSuggestionSettingsPage` | |
| 模板 | `TemplateSettingsPage` | 三级作用域（全局/分组/项目）→ TemplateRepo |
| Hook | `HookSettingsPage`、`HookSettingsControls`、`CodexHookScopeStatus` | 安装/卸载 Claude/Codex/OpenCode Hook（core::hooks::settings），状态刷新改为操作后刷新 + 页面可见时手动刷新 |
| Statusline | `StatuslineSettingsPage`、`StatuslinePreview`、`StatuslineProfileBar`、`CodexStatuslineEditor` | 预览用原生渲染（模拟终端行）；脚本编辑用 CodeEditor |
| 历史来源 | `HistorySourceSettingsPage` | 外部会话同步配置 |
| 模型定价 | `ModelPricingSettingsPage` | PricingRepo；在线同步 |
| Provider | `NativeProviderSettingsPage` + `providers/*`（约 40 个文件） | 见 §3 |
| 同步 | `SyncSettingsPage` | 见 §4 |
| 远程/SSH | `RemoteConnectionsSettingsPage`、`SshHostsSettingsPage`、`SshHostEditor`、`SshConfigImportDialog`、`SshCliIntegrationDialog` | 见 §5 |
| 桌宠 | `DesktopPetSettingsPage` | 与 desktop-integration 的桌宠窗口联动 |
| Web 服务 | `WebServerSettingsSection`、`WebDeviceSettingsSection`、`WebMobileAccess` | 二维码（`qrcode` crate → 图片）；状态由 `WebServerStatusChanged`/`WebDeviceStatusChanged` 事件驱动；启停由 desktop-integration 提供 |
| 第三方通知 | `ThirdPartyNotificationSection` | |
| 开发者 | `DeveloperSettingsPage` | 日志目录、调试开关、诊断导出 |
| 关于/赞助 | `AboutSettingsPage`、`AboutSection`、`SponsorsSettingsPage` | 许可证/致谢用原生 Markdown；更新检查入口（desktop-integration） |

## 3. Provider / 路由 / 快速切换

- `NativeProviderCatalog`/`Card`/`Button`/`TypeTabs`：Provider 列表与分类；图标来自 lobehub SVG 资产。
- `NativeProviderEditor`/`FormModal`/`DetailModal`/`DocumentEditor`/`CodeEditor`：表单 + 原生 CodeEditor（JSON/TOML/env 文档编辑，带校验）；替代 Monaco。
- Key 管理（`KeySection`、`KeyFormModal`、`KeyRevealModal`、`KeyReplacementModal`）：显示遮罩、复制、替换；敏感值不写日志。
- 路由/故障转移/代理/Rectifier（`RoutingSection`、`FailoverSection`、`GlobalProxySection`、`RectifierSection`）：通过 core → DaemonClient 的 routing 请求；`RoutingEvent` 事件驱动状态展示（取代轮询）。
- 导入（`ImportSection`、`nativeProviderImportDisplay`）：cc-switch 等外部来源。
- 模型候选（`useNativeProviderModels`、`providerModelCandidates`）：异步拉取 + 缓存。
- 快速切换（`features/providers/ProviderSwitchModal`）：命令面板动作 + 对话框。
- 视图模型（`nativeProviderConfigView.ts`、`nativeProviderDetailView.ts`、`nativeProviderGlobalView.ts`、`nativeProviderAdvancedConfig.ts`）中的纯逻辑移植到 core（附测试），GPUI 只做呈现。

## 4. 同步（WebDAV）
- 配置（sync-config.json）、测试连接、手动同步、自动同步开关；冲突处理对话框：**不静默覆盖**，展示本地/远端差异并让用户选择（与 Tauri 版一致）。
- 同步状态指示（侧栏 `SyncStatusIndicator`）由 SyncModel 事件驱动。

## 5. SSH / 远程
- 主机与分组（SshHostRepo、SshHostGroupRepo）、工具偏好、Agent 安装与集成（SshAgentRepo；安装进度事件 `SshAgentInstallProgress`）、`~/.ssh/config` 导入、CLI 集成对话框。
- 连接测试、远程文件/Git 入口（`features/remote`）与 workspace-features 的文件/Git 视图对接（远程模式）。

## 6. 扩展（MCP / Skills，`src/features/extensions`）
- `GlobalExtensionsPage`、`GlobalMcpPanel`、`NativeMcpPanel`、`GlobalSkillsPanel`、`SkillInventoryPanel`、`ProjectExtensionsDialog`：列表 + 启用开关（`ExtensionCliToggle`）+ 排序（`ExtensionSortableList`，顺序写 `extension-list-order.json`）。
- `McpEditorDialog`/`McpConfigForm`/`McpArgumentRows`/`McpKeyValueRows`：表单模式 + JSON 模式（CodeEditor + 校验）互转。
- `ExtensionImportDialog`、`GithubSkillDialog`：导入与 GitHub 拉取（core 现有逻辑）。

## 7. 提示词 / 模板
- `templateStore`（直连 SQL）→ TemplateRepo；三级作用域；预览用原生 Markdown；插入终端动作对接 terminal-native。

## 8. 统计（`src/features/stats`，约 9,200 行）

| React | GPUI |
|---|---|
| `EChart.tsx` + 各图表（趋势、Token 趋势、甜甜圈、模型构成、项目条形、散点、来源对比、小时活动） | `ui_kit::chart` 自绘：折线/面积/柱状/堆叠/环形/散点；坐标轴、图例、tooltip、hover 高亮；数据量 30 天 × 小时级可流畅渲染 |
| `TimelineHeatmap` | 日历热力图自绘 |
| `StatsDatePicker` | 日期范围选择 |
| `RequestLogsView` | 虚拟表格；P1：`RequestLogAppended` 事件驱动（删除 60 s 轮询） |
| `CcusageStatsPanel`、`TerminalStatsPanel`（实时统计） | P1：`UsageUpdated`（Hook 上报触发）驱动；兜底定时器仅面板可见时运行；未安装 Hook 时引导到 Hook 设置 |
| `useSystemResources` | P1：仅面板可见时采样；低功耗态暂停 |
| `statsScreenshot.ts`（html-to-image） | GPUI 离屏渲染导出 PNG（若 gpui-pre 不支持离屏渲染则隐藏按钮，记录在验收中） |

## 9. 轮询清单（P1，面板侧）
在实施第一步用 `grep -rn "setInterval\|setTimeout" src/features/{settings,stats,extensions,providers,sync,remote}` 生成完整清单，逐条决定：事件驱动 / 手动刷新 / 仅可见时低频兜底；结果写入本任务 `research/polling-map.md` 并作为验收依据。

## 10. 不在本任务范围
桌宠窗口本身、Web 服务进程管理、更新器（desktop-integration）；终端设置中的退出守卫逻辑（terminal-native，本任务只提供设置 UI）。
