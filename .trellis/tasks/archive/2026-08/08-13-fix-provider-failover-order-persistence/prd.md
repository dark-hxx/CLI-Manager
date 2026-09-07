# 修复供应商故障转移排序持久化与侧栏操作图标

## Changelog Target

`[TEMP]`

## Goal

修复供应商侧边栏开启自动故障转移后的交互与状态持久化：侧栏不显示多余的上移/下移图标；供应商的故障转移队列成员状态和目录排序在侧栏、设置页、轮询刷新及重新打开后保持一致。

## Root Cause Statement

故障转移队列状态（`in_failover_queue`）与目录排序（`providers.sort_index`）跨后端数据库、Tauri IPC 和多个独立前端 Hook 流转，现有侧栏仍渲染重复的箭头操作，且不完整/非一致的快照同步与故障转移启停时的队列归一化会造成界面看似重置或覆盖已保存顺序，因此修复应落在统一服务端快照同步和侧栏渲染边界，而不是仅在图标处打补丁。

## Discovery List

- `src/components/terminal/ProviderQuickSwitchPanel.tsx`：侧栏渲染上下箭头、拖拽手柄、队列编号及排序提交。
- `src/components/terminal/useProviderQuickSwitch.ts`：侧栏 Hook 的队列读取、排序/队列 mutation、轮询和跨 Hook 快照同步。
- `src/components/settings/providers/NativeProviderFailoverSection.tsx`：设置页故障转移列表及排序入口。
- `src/components/settings/providers/useNativeProviderRouting.ts`：设置页 Hook 的故障转移读取、排序 mutation、轮询和跨 Hook 快照同步。
- `src/components/settings/providers/providerFailoverOrder.ts`：两处共享的队列置顶与 `sortIndex` 派生顺序。
- `src/components/settings/pages/NativeProviderSettingsPage.tsx`、`NativeProviderCatalog.tsx`、`NativeProviderCard.tsx`：设置页目录列表消费故障转移快照，需确认不会被不完整快照覆盖。
- `src-tauri/src/provider/repository/failover.rs`：故障转移成员标记的数据库读写。
- `src-tauri/src/provider/repository/catalog.rs`、`src-tauri/src/commands/provider.rs`：全量供应商 `sort_index` 的持久化 IPC 链路。
- `src-tauri/src/provider/routing.rs`、`src-tauri/src/commands/routing.rs`：故障转移启停、队列校验与状态组装；不改变数据库 schema 或算法契约。
- `src/lib/i18n.ts`：本次不新增用户可见文案；若调整 aria/title，必须同步中英文。

GitNexus impact：`reorder_providers` 上游为 `provider_catalog_reorder`，风险 LOW；`set_failover_enabled` 影响 routing commands 与 `routing_set_takeover`，风险 LOW；`set_failover_queue` 影响 routing 内部队列设置与相关 commands，风险 LOW。修改前仍需对实际编辑的符号重新执行 impact。

## Requirements

- 自动故障转移开启时，侧栏隐藏上移/下移按钮；保留拖拽手柄与键盘拖拽能力，不改变设置页的精细调整入口。
- 自动故障转移关闭或手动模式时，侧栏不显示故障转移排序控件，且不响应拖拽排序。
- 侧栏和设置页均以服务端返回的完整 `NativeProviderFailoverState.providers` 为故障转移成员与 `sortIndex` 真源；成功 mutation 后立即同步，轮询和重新打开后重新从后端校准。
- 队列成员与目录排序必须按当前 `appType` 隔离持久化；修改一个 CLI 类型不得重置其他类型。
- 自动故障转移的开启/关闭、队列加入/移出、拖拽排序、刷新和重新打开后，`inFailoverQueue` 与供应商顺序保持用户最后一次成功保存的结果；保留现有手动模式单供应商约束。
- 兼容 Local/WSL Home、窗口侧栏与设置页两个入口、鼠标/键盘排序、ready/not-ready、当前供应商、空/单/多供应商和 daemon busy/不可用场景。
- 不新增数据库字段，不改变故障切换算法、IPC 参数或现有 Home/WSL 识别语义。

## Acceptance Criteria

- [ ] 自动故障转移开启后，侧栏不显示上移/下移箭头；拖拽手柄仍可用且有现有中英文 aria 文案。
- [ ] 自动故障转移关闭/手动模式下，侧栏不显示或响应排序控件。
- [ ] 侧栏或设置页修改队列/排序后，另一入口在当前打开状态和下一次轮询中显示相同的成员与顺序。
- [ ] 关闭并重新打开面板、刷新页面或重新加载后，队列成员与 `sort_index` 保持最后一次成功保存的状态。
- [ ] Local/WSL Home、Claude/Codex/Grok Build、鼠标/键盘、ready/not-ready 与当前供应商场景无回归。
- [ ] `npx tsc --noEmit`、相关前端测试与 `cd src-tauri && cargo test` 通过（若环境限制需明确记录）。
- [ ] `CHANGELOG.md` `[TEMP]` 与 `docs/功能清单.md` 已更新。

## Scenario Matrix

| 维度 | 覆盖场景 |
|---|---|
| 窗口/入口 | 当前窗口侧栏、设置页、侧栏与设置页同时打开、关闭后重新打开、应用失焦 |
| 模式 | 自动故障转移开启、关闭、手动热切换；本地路由未接管；daemon 不可用/busy |
| 供应商 | 0/1/多个；ready/not-ready；当前/非当前；入队/未入队 |
| 同步 | 侧栏先改、设置页先改、轮询期间外部修改、失败后保留上一次成功快照 |
| 输入 | 鼠标拖拽、键盘拖拽；中英文界面；长名称 |
| 环境/类型 | Local Home、WSL Home；Claude、Codex、Grok Build；各 appType 顺序互不影响 |

## Technical Approach

- 先执行实际编辑符号的 GitNexus upstream impact；高风险结果必须暂停并报告。
- 侧栏移除上下箭头渲染与不再需要的 handler/import，保留 dnd-kit 拖拽手柄；所有可见 aria/title 文案继续走 i18n。
- 检查并修正两个 Hook 的成功 mutation、轮询和订阅更新，使完整 failover snapshot（包括 providers/config/circuit）作为唯一前端同步快照；避免旧快照或仅 circuit 快照覆盖最新 `sortIndex`/队列成员。
- 保持 `provider_catalog_reorder` 的当前全量 ID 提交和后端事务持久化；仅在验证发现启停归一化覆盖用户数据时，最小化调整其恢复/持久化行为并补测试。

## Out of Scope

- 修改数据库 schema、故障切换算法、daemon 路由策略或 IPC 参数。
- 新增独立的故障转移排序字段或第二套前端排序来源。
- 重做供应商卡片布局、图标风格或设置页箭头交互。

## Definition of Done

- 实现代码、针对性测试和类型检查完成。
- GitNexus `detect_changes` 确认影响范围仅为预期供应商故障转移/排序链路。
- 更新 `CHANGELOG.md`、`docs/功能清单.md`、任务记录。
- 保留工作区已有变更，不覆盖无关文件。

## Notes

- 已确认上游 `origin/feat/native-provider-management` 未领先本地；工作区仅有本任务目录未跟踪文件。
- 相关先前任务 `08-11-sync-provider-failover-order` 已实现跨入口快照同步基础，本任务针对用户反馈继续修复其剩余侧栏交互与持久化边界问题。
