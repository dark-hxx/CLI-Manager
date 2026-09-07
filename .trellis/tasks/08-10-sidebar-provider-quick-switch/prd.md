# 终端右侧供应商与故障转移快捷面板

## Changelog Target

`[TEMP]`

## Goal

在终端区域右侧侧边面板增加供应商快捷入口：保留现有全局供应商查看/切换基础功能，同时让用户能快速查看当前 CLI 的本地路由与故障转移状态、队列成员和熔断状态，并在自动故障转移模式下调整队列顺序。左侧项目侧栏保持不变；供应商 CRUD、密钥、Home/WSL、路由服务参数和故障转移阈值等维护功能继续放在设置页。

## Requirements

- 在 `TerminalSidePanel` 页签组中增加“供应商”页签，与实时统计、系统资源、Replay、Git、文件并列；不在左侧项目侧栏增加入口。
- 打开面板后根据活动终端的 `cliTool → startupCmd → project.cli_tool` 推导 Claude Code、Codex 或 Grok Build，提供紧凑 CLI 分段控件供手动切换。
- 保留基础供应商功能：展示 provider 名称、模型/密钥就绪等必要状态；当前供应商直接高亮；点击可用 provider 仍走安全的 preview → confirm → apply → refresh 链路。
- 当当前 CLI 存在已接管的本地路由时，显示紧凑路由状态：服务/daemon 是否可用、自动故障转移是否开启、当前路由 provider 和实时熔断状态。
- 自动故障转移开启时，显示故障转移队列：队列序号、当前 provider、ready/not ready、健康/降级/熔断状态；ready provider 可加入/移出队列，已入队 provider 支持上移/下移排序。
- 自动故障转移关闭时，遵循后端单元素队列约束；列表使用单选语义，选择 ready provider 调用既有 `routing_set_failover_queue` 热切换当前路由，不能显示多选排序控件。
- 队列排序沿用现有 `provider_catalog_reorder` 语义，保持设置页和故障转移运行时使用同一 `sort_index` 顺序；不在前端维护第二套排序来源。
- 故障转移状态只在面板打开且当前 CLI 可见时轮询，目标约 1 秒；轮询失败保留最后一次成功快照，不自动启动/停止 routing daemon。
- 面板正文保持简约：不显示正文“供应商”标题、搜索框、分组标题、三 CLI 总览卡、重复当前 provider 卡或完整故障转移参数表。可使用一个窄的路由状态行和一个队列列表。
- 设置入口继续深链到“设置 → 供应商”；新增、编辑、删除、密钥、Home/WSL、服务端口、代理、整流器、优化器、重试/熔断参数仍只在设置页。
- 所有新增用户可见文案、tooltip、ARIA、toast、加载/空/错误/不可用状态同步支持 `zh-CN` 与 `en-US`，并兼容 `zh-TW` 转换。
- 键盘支持：CLI 分段控件使用 roving tab；队列行支持上下移动焦点；上移/下移、加入/移出、手动热切换均有可见 focus 和可读 aria-label。

## Acceptance Criteria

- [ ] 供应商功能只出现在终端右侧面板，左侧项目导航无变化。
- [ ] 当前活动终端可正确默认 Claude/Codex/Grok Build，切换 pane/session/workspan 后上下文不会串用。
- [ ] 无 routing takeover 时，基础供应商切换仍显示当前 provider，并通过既有全局 preview/apply 安全链路完成。
- [ ] 有 routing takeover 时，侧边栏能区分全局 current 与当前路由状态；运行中的 daemon/circuit 状态不被静态数据库状态冒充。
- [ ] 自动故障转移模式显示队列成员、序号、ready 状态和 circuit 状态，并可通过上下按钮改变队列优先级；刷新后顺序保持。
- [ ] 自动故障转移模式可加入/移出 ready provider；not ready provider 保持可见但不可入队，并显示设置入口提示。
- [ ] 手动模式只允许一个队列 provider；选择后复用既有热切换链路，失败时恢复原状态并反馈错误。
- [ ] daemon 未连接、能力不支持、服务停止、空队列、空 provider、熔断 open/halfOpen/unknown 等状态均有紧凑反馈。
- [ ] 合并/非合并面板、single-open、窗口宽度低于 1100px、面板宽度记忆和工具栏显隐/排序均保持现有行为。
- [ ] 供应商 CRUD、密钥、Home/WSL、路由服务与参数配置没有搬到侧边栏。
- [ ] 1024px/1440px、中英文、键盘操作和长 provider 名称下无水平溢出。

## Definition of Done

- `npx tsc --noEmit` 通过。
- 相关 Rust routing/provider 测试或 `cargo check` 在后端未改动时保持通过；若修改后端则补充对应测试。
- `CHANGELOG.md` `[TEMP]` 和 `docs/功能清单.md` 已更新。
- 完成合并/非合并、基础切换、自动队列排序、手动热切换、daemon 不可用和中英文手工验证。

## Out of Scope

- 在侧边栏编辑故障转移阈值、超时、重试次数、代理、整流器或优化器。
- 在侧边栏启停 routing daemon、修改监听端口、修改 Home/WSL 接管或修复环境。
- 在侧边栏创建/编辑/删除 provider、管理 API Key、编辑原始配置文档。
- 新增后端故障转移算法、熔断策略或新的 IPC；优先复用当前 routing commands。
- 搜索框、完整故障转移参数表、跨 CLI 总览卡和大面积状态说明。

## Technical Approach

- `ProviderQuickSwitchPanel` 作为右侧面板内容，沿用 `TerminalSidePanel` 的皮肤、宽度、页签紧凑化和单面板机制。
- 新增聚焦的 `useProviderQuickSwitch`，只读取当前 app type 所需的 catalog/current/routing/failover 数据；不直接复用会触发 service recovery 和全量配置加载的设置页 routing hook。
- 基础切换复用 `provider_global_preview` / `provider_global_apply`；已接管且手动故障转移时，provider 选择复用 `routing_set_failover_queue` 的后端热切换与回滚语义。
- 故障转移展示复用 `NativeProviderFailoverState`：`providers`、`inFailoverQueue`、`ready`、`isCurrent`、`circuits`；队列重排复用 `provider_catalog_reorder`。
- 路由运行态使用 `routing_get_state`，只展示事实状态；不因为侧边栏轮询而隐式启动 daemon。
- 队列排序使用现有箭头按钮而非拖拽，适配窄侧栏并保持键盘可用；排序操作提交完整 provider id 顺序，避免只更新局部数组造成 `sort_index` 漂移。

## Decision (ADR-lite)

**Context**: 新版代码已提供本地 routing、自动故障转移、手动热切换、队列排序和 daemon circuit 状态，但这些能力集中在供应商设置页；用户需要侧边栏快速查看和调整。

**Decision**: 侧边栏只做高频操作：查看当前 provider/路由健康、切换基础 provider、管理故障转移队列成员和优先级；参数与环境维护继续设置页。自动模式允许多 provider 排序，手动模式严格遵守后端单 provider 队列约束。

**Consequences**: 需要同时消费 provider global 与 routing failover 两套状态，并处理二者不一致；侧边栏必须显示“路由当前”和“全局当前”的差异，避免把静态 `isCurrent` 当作 daemon 实时健康。通过复用后端命令和现有类型，避免新增协议和第二套队列规则。

## Technical Notes

- 主要 frontend 触点：`src/components/terminal/TerminalSidePanel.tsx`、`src/components/TerminalTabs.tsx`、`src/components/settings/pages/SidebarSettingsPage.tsx`、`src/stores/settingsStore.ts`、`src/lib/i18n.ts`、`src/lib/providerSwitching.ts`。
- 新增 frontend 组件/Hook：`src/components/terminal/ProviderQuickSwitchPanel.tsx`、`src/components/terminal/useProviderQuickSwitch.ts`。
- 复用类型：`src/components/settings/providers/nativeProviderTypes.ts` 中的 `NativeProviderFailoverState`、`NativeProviderFailoverProvider`、`NativeProviderGlobalCurrent`、`NativeProviderRoutingState`。
- 已有 IPC：`provider_catalog_list`、`provider_global_current`、`provider_global_preview`、`provider_global_apply`、`routing_get_state`、`routing_get_failover_queue`、`routing_set_failover_queue`、`provider_catalog_reorder`、`routing_reset_circuit`。
- backend 已明确：自动模式允许空队列约束由启用逻辑维护；手动模式队列必须恰好一个 provider；队列更新在 active takeover 下会执行 hot switch，失败会回滚队列。
- GitNexus 已在远端同步后可重新分析；正式编辑前仍需对 `TerminalSidePanel`、`TerminalTabs`、routing IPC 和设置迁移触点执行 impact。
