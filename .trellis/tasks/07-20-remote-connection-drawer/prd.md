# 使用抽屉区分远程连接方式

## Goal

优化“设置 → 远程连接”页面，将“本机 cc-connect”和“Web 设备连接”两个独立能力通过抽屉分离，避免两套配置连续堆叠在同一页面而难以区分。

## Changelog Target

`[TEMP]`

## What I already know

- 当前设置导航中的“远程连接”对应 `CcConnectSettingsPage`。
- 页面顶部直接渲染 `WebDeviceSettingsSection`，下方紧接完整的本机 cc-connect 配置。
- 两者的数据、状态和操作互相独立，但当前缺少明确的一级入口分隔，视觉上容易被理解为同一配置流程。
- 项目已使用 Mantine，可直接使用现有 `Drawer` 组件，不需要新增依赖。

## Requirements

- 远程连接主页只展示“本机 cc-connect”和“Web 设备连接”两个清晰入口。
- 两个入口采用纵向单列排列，并显示各自的未配置、已配置或运行中状态。
- 点击入口后，从右侧打开对应抽屉，抽屉内只展示该连接方式的现有配置与操作。
- 两个抽屉互斥，同一时间只打开一个。
- 保留两种方式现有的状态加载、保存、启动、停止、重启、配对、日志和确认逻辑。
- 新增或修改的用户可见文案必须同时支持 `zh-CN` 与 `en-US`。

## Acceptance Criteria

- [x] 进入“远程连接”后，只看到两个独立连接方式入口，不再同时看到两套完整表单。
- [x] 两个入口纵向排列，并展示各自的配置或运行状态。
- [x] 点击“本机 cc-connect”后打开右侧抽屉，并保留现有全部 cc-connect 配置与进程操作代码。
- [x] 点击“Web 设备连接”后打开右侧抽屉，并复用现有全部配置、启停和配对组件。
- [x] 关闭抽屉后返回两种连接方式入口页。
- [ ] 普通窗口和窄窗口中，抽屉内容可正常滚动和操作。
- [x] 两种方式原有后端调用和状态逻辑不发生变化。
- [x] 中英文界面文案均完整。

## Scenario Enumeration

- 连接状态：未配置、已配置、运行中、停止、错误状态。
- 抽屉切换：打开 cc-connect、打开 Web 设备、关闭后重新打开。
- 未保存内容：抽屉关闭时不额外改变现有组件的状态语义。
- 窗口尺寸：普通窗口和较窄窗口下入口及抽屉内容可滚动操作。
- 键盘与可访问性：入口可聚焦、抽屉可关闭、关闭后焦点返回触发入口。

## Out of Scope

- 不修改 cc-connect 或 Web 设备的后端协议、数据结构和运行逻辑。
- 不合并两种连接方式的配置和状态。
- 不增加新的远程连接方式。

## Technical Notes

- 页面与 cc-connect 触点：`src/components/settings/pages/CcConnectSettingsPage.tsx`。
- Web 设备触点：`src/components/settings/WebDeviceSettingsSection.tsx`。
- 国际化触点：`src/lib/i18n.ts`。
- 本需求属于前端展示层交互调整，不修改后端或数据库。

## Decision (ADR-lite)

- **Context**：本机 cc-connect 与 Web 设备连接当前连续显示在同一页面，用户无法快速判断它们是两种独立的远程连接方式。
- **Decision**：远程连接主页展示两个入口卡片；点击后分别打开右侧 Mantine Drawer，并保持抽屉内容挂载以保留组件状态。
- **Consequences**：只调整前端页面组织，不改变任何连接、保存或进程控制逻辑；需要补充中英文入口文案并验证窄窗口滚动和焦点行为。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
