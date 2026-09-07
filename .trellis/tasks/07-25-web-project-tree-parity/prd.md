# Web 项目列表复用桌面端设计与拖拽

## Goal

Web 端项目侧栏复用桌面端项目树的视觉与交互设计，仅同步项目树数据，不在项目树中上报或展示会话列表，并复现项目树拖拽能力。

## Changelog Target

`[TEMP]`

## What I already know

- 桌面端项目树实现在 `src/components/sidebar/ProjectTree.tsx`，使用 `@dnd-kit` 支持分组、项目与 Worktree 的树形排序。
- Web 端项目树当前实现在 `apps/web/src/views.tsx`，会把历史会话渲染到项目/Worktree 节点下。
- 桌面端当前由 `src/hooks/useWebDeviceBridge.ts` 同时上报历史会话和 workspace 快照。
- Web workspace 快照已包含分组、项目、Worktree 及 `sortOrder`，可作为项目树数据源。

## Requirements

- Web 项目列表的布局、层级、展开状态、选中态和图标与桌面端保持一致。
- Web 项目树只展示分组、项目和 Worktree，不展示会话节点。
- 项目树支持拖拽，并保持桌面端允许的层级与排序规则。
- 不新增依赖；优先复用仓库已有拖拽依赖与交互约束。
- Web 拖拽结果必须回写桌面端；桌面端是项目树顺序与归组关系的唯一权威数据源。

## Acceptance Criteria

- [x] Web 项目树不再出现历史会话行。
- [x] 分组、项目、Worktree 的图标和主要视觉状态与桌面端一致。
- [x] 鼠标/触控拖拽复用桌面端 PointerSensor 约束，可完成合法排序与归组操作。
- [x] 非法拖拽不持久化项目树；失败后重新加载桌面端快照。
- [x] 未新增可见文案，现有中英文 i18n 不受影响。
- [x] Web 与桌面 TypeScript 检查、服务端测试、桌面 Rust 定向测试通过。
- [x] Web 拖拽只在设备在线且具备项目管理能力时启用；失败后恢复桌面端快照。
- [x] 桌面端不再采集或上传历史会话摘要，服务端旧会话快照被空列表清理。

## Open Questions

- 无。

## Approval

- 用户已确认方案并选择拖拽结果回写桌面端。

## Decision

**Context**：Web 项目树需要复现桌面端拖拽，拖拽结果必须在刷新和多端访问后保持一致。

**Decision**：Web 仅发起排序/归组操作，由桌面端复用现有项目树写入逻辑持久化，再通过 workspace 快照回传最终结果。

**Consequences**：离线时禁用拖拽写入；不在浏览器维护第二套权威排序，避免多端状态分叉。

## Technical Approach

- 保留现有 `HistorySnapshot` 协议兼容性，但桌面端固定发送 `sessions: []`，只携带安全的 workspace 项目树 DTO。
- Web 项目树使用仓库已有 `@dnd-kit` 依赖，复刻桌面端的指针激活阈值、同层排序、跨组移动、禁止组拖入自身/后代等规则；Worktree 与桌面端一致不可拖拽。
- 新增 `project.tree.reorder` operation。浏览器只发送项目/分组 ID、目标父级和期望同级顺序；桌面端校验 ID 集合与层级后调用 `projectStore` 现有的 `moveProjectToGroup`、`moveGroupToParent`、`reorderItems` 持久化。
- 拖拽在 Web 端做临时预览；最终状态以桌面端重新发布的 workspace 快照为准，失败时重新拉取快照回滚。
- 项目图标使用与桌面端相同的 CLI 图标映射；分组使用 `Folder`，Worktree 使用同款自定义 SVG。

## Discovery List

- `src/hooks/useWebDeviceBridge.ts`：当前会加载并上报完整历史会话；需要改为只发布 workspace。
- `src/lib/webDevice.ts`：桌面 Web 设备上报 DTO/API；需收紧调用面为 workspace-only。
- `src/lib/webManagement.ts`：桌面远程管理 operation 白名单、校验和执行入口；需新增项目树排序。
- `src/stores/projectStore.ts`：已有排序/归组持久化方法；确认复用，不修改。
- `src/components/sidebar/index.tsx`、`ProjectTree.tsx`、`TreeNodeItem.tsx`：桌面拖拽与视觉基准；确认作为行为参考，原则上不修改。
- `apps/web/src/views.tsx`：Web 项目树当前混入会话节点且图标不同；需要重做项目树节点与 DnD。
- `apps/web/src/styles.css`：Web 项目树视觉、选中态、拖拽态样式。
- `apps/web/src/useAppModel.ts`：operation 提交、workspace 刷新和失败回滚链路。
- `apps/web/package.json`、`package-lock.json`：为 Web workspace 声明仓库已使用的 DnD/CLI 图标依赖，不升级版本。
- `apps/server/src/api.rs`：服务端 operation 白名单、能力映射和校验测试。
- `src-tauri/src/commands/web_device.rs`：桌面默认能力声明及相关测试。
- `crates/web-protocol/src/lib.rs`：协议仍允许空 sessions；确认兼容，无需修改。
- `apps/server/src/storage.rs`、`apps/server/src/ws.rs`：空会话全量快照会清理旧会话，workspace 原子保存；确认复用，无需修改。
- `.trellis/spec/backend/web-service-contracts.md`：需同步 workspace-only 上报与项目排序 operation 契约。
- `CHANGELOG.md`、`docs/功能清单.md`：记录 `[TEMP]` 行为变更与功能清单。

## Risk

- 中等：跨 Web、服务端和桌面 operation 链路；若白名单、能力声明或 payload 校验不同步，拖拽会被拒绝。
- 兼容性：协议不升级，旧服务仍可接收空 sessions + workspace；旧桌面不会声明项目管理能力，因此 Web 自动禁用拖拽。
- 数据一致性：拒绝浏览器提交缺失/重复/未知 ID 的顺序，避免旧快照覆盖桌面新状态。

## Scenario Notes

- 桌面设备在线/离线：离线时项目树可读取缓存，但无法回写桌面端。
- 多浏览器/多设备：若回写桌面端，需要以桌面端为权威源并处理旧快照覆盖。
- 输入方式：鼠标、触控和键盘拖拽需沿用桌面端激活约束与可访问性语义。
- 树状态：根级/嵌套分组、空分组、无 Worktree、缺失 Worktree、搜索/筛选状态均需明确行为。

## Out of Scope

- 不在本任务中重做历史会话页面。
- 不新增拖拽库或重构桌面端项目树架构。

## Notes

- 当前任务属于跨端功能改动，实施前需完成 GitNexus 影响分析并提交方案确认。
