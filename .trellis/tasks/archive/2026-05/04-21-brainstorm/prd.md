# 精简模式启动器

## Goal

为 CLI-Manager 增加一个可切换的“精简模式”：不显示内嵌 CLI 终端，让应用以左侧项目列表为核心启动器。要求视觉更完整、更大方，同时标准模式原有终端工作流完全保留，可随时切回。

## What I already know

* 当前主布局是 `Sidebar + TerminalTabs`，入口在 `src/App.tsx:140-149`
* Sidebar 已具备项目树、分组、搜索、点击/双击启动、宽度折叠、密度等基础能力；项目启动入口在 `src/components/sidebar/index.tsx:349-389`
* 现有启动逻辑支持内嵌终端会话和外部 Windows Terminal，两者受 `useExternalTerminal` 控制；外部终端桥接在 `src/lib/externalTerminal.ts:12-33`
* 设置已持久化到 `settingsStore`，可安全扩展布局/模式字段，见 `src/stores/settingsStore.ts:14-35`、`src/stores/settingsStore.ts:40-61`、`src/stores/settingsStore.ts:92-162`
* 当前没有“视图模式 / 布局模式”的统一抽象
* 现有最接近“启动器视图”的不是终端区，而是 Sidebar 本身；若直接复用，改动面最小

## Assumptions (temporary)

* 精简模式应为全局可切换 UI 模式，而不是替换现有默认模式
* 标准模式的终端、历史、设置、统计等能力必须不受影响
* 精简模式下项目点击后直接使用外部终端启动
* 精简模式采用“侧栏放大版”形态：复用现有 Sidebar 作为主视图，右侧改为简洁欢迎区/说明区，不新增独立 launcher 页面

## Open Questions

* 暂无

## Requirements (evolving)

* 新增精简模式开关，保留原标准模式
* 精简模式开关放在设置中，优先放在“通用 > 终端与侧栏”区域
* 精简模式不显示内嵌 CLI 终端区
* 左侧项目列表成为主视觉与主交互区域
* 视觉需比现有侧栏更完整，不是简单“把右侧砍掉”
* 精简模式优先复用现有 Sidebar 结构并扩展为主视图，控制改动范围
* 不破坏现有项目管理、分组、搜索、启动等能力

## Acceptance Criteria (evolving)

* [ ] 可以在标准模式与精简模式之间切换
* [ ] 精简模式下不展示内嵌终端主区
* [ ] 精简模式下项目列表仍支持搜索、分组展开/折叠、项目启动
* [ ] 精简模式下点击项目直接打开外部终端，不创建内嵌终端会话
* [ ] 切回标准模式后原有终端能力保持可用
* [ ] 模式偏好可持久化

## Definition of Done (team quality bar)

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Technical Approach

* 在 `settingsStore` 中新增全局 `viewMode`（标准 / 精简），并持久化到现有 `settings.json`
* 在 `GeneralSettingsPage` 的“终端与侧栏”区域新增“精简模式”开关
* 在 `App` 主布局层根据 `viewMode` 条件渲染：
  * 标准模式：保持现有 `Sidebar + TerminalTabs`
  * 精简模式：复用现有 `Sidebar` 作为放大主视图，右侧改为轻量欢迎区/说明区，不渲染 `TerminalTabs`
* 在 Sidebar 启动逻辑中对精简模式做分支：点击项目时直接走外部终端启动，不创建内嵌 session
* 视觉上优先复用现有 `ui-surface-card`、`ui-selection-card`、现有配色与圆角体系，避免引入新设计系统

## Decision (ADR-lite)

**Context**: 需要在不破坏现有终端工作流的前提下，为 CLI-Manager 增加一个更轻量的项目启动器视图。
**Decision**: 采用全局可切换的精简模式；入口放在设置中；精简模式使用“侧栏放大版”方案；点击项目直接打开外部终端。
**Consequences**: 改动集中在前端设置、主布局和 Sidebar 启动分支，风险可控；但精简模式依赖外部终端体验，不覆盖内嵌终端工作流。

## Out of Scope (explicit)

* 重做项目数据模型
* 改动 PTY / Rust 后端行为
* 为精简模式单独维护第二套项目树数据结构
* 在本任务中顺手重构无关面板体系
* 为精简模式新增独立页面或重做整个信息架构

## Technical Notes

* 已查看：`src/App.tsx`、`src/stores/settingsStore.ts`、`src/components/sidebar/index.tsx`、`src/components/sidebar/TreeNodeItem.tsx`、`src/lib/externalTerminal.ts`、`src/components/settings/pages/GeneralSettingsPage.tsx`
* 当前 `openProjects()` 在 Sidebar 内部根据 `useExternalTerminal` 决定是创建内嵌 session 还是打开外部终端
* 若精简模式仅隐藏终端区但仍允许创建内嵌 session，用户可能会“点击后无明显反馈”，这是一个产品风险
* Sidebar 已有折叠、宽度、密度、树交互和 hover 操作，可作为精简模式的主要复用基础
* 当前 `App` 主骨架是固定左右布局，若走“侧栏放大版”，可在 `src/App.tsx:145-149` 条件渲染右侧主区并保留整体壳层

## Research Notes

### What similar tools do

* 启动器型工具通常把“选择项目”与“活跃工作区/终端”拆成两个视图，避免在轻量入口页混入复杂工作区
* 对已有产品做非侵入增强时，常见做法是增加持久化的 view mode，而不是复制一套数据流

### Constraints from our repo/project

* 当前“打开项目”默认与终端行为强绑定；若不明确精简模式的启动去向，交互会变得含糊
* Sidebar 的信息结构已够用，但它现在是“侧栏视觉”，若扩成主视图，需要额外布局与层次设计
* 现有设置体系适合新增模式字段，但还没有统一的 panel/view registry

### Feasible approaches here

**Approach A: 全局精简启动器模式**（Recommended）

* How it works: 新增全局 `viewMode`，切到精简模式后主区不显示终端，列表扩展为主视图；项目启动统一按精简模式规则处理
* Pros: 改动集中、原有标准模式保留、用户心智清晰
* Cons: 需要明确精简模式下项目启动到底走外部终端还是别的行为

**Approach B: 仅隐藏终端区**

* How it works: 复用现有 Sidebar，进入精简模式时仅隐藏 `TerminalTabs`
* Pros: 改动最小，开发成本低
* Cons: 视觉提升有限；若仍创建内嵌 session，容易出现“看不见终端但其实开了”的体验问题

**Approach C: 独立启动器视图**

* How it works: 保留现有标准模式，再新增一个更完整的 launcher 页面/视图
* Pros: 视觉空间最大，最容易做出明显差异化
* Cons: 改动面更大，需要处理更多视图切换状态
