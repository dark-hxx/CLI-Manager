# 工具栏设置迁移到侧边栏页

## Goal

把当前位于“通用设置”中的工具栏设置迁移到“侧边栏设置”页面，避免用户在两个页面之间来回找同一类布局/入口配置。

## What I already know

* “通用设置”页当前有一整块终端工具栏设置，来源是 `terminalToolbarVisibility`：`src/components/settings/pages/GeneralSettingsPage.tsx`
* 该工具栏设置项包含 `templates / commandHistory / fullscreen / sessionHistory / replay / files / stats / gitChanges`
* “侧边栏设置”页当前已有侧边栏相关配置，以及一块 `sidebarToolbarVisibility.stats` 开关：`src/components/settings/pages/SidebarSettingsPage.tsx`
* 设置存储已经分成两类：
  * `terminalToolbarVisibility`：终端顶部工具栏
  * `sidebarToolbarVisibility`：左侧主导航底部按钮

## Assumptions (temporary)

* 用户说的“放到侧边栏当中去”是指把设置页面上的配置分组迁移到“侧边栏设置”页，而不是改运行时 UI 的物理位置
* 先只做设置页迁移，不改底层 store 结构，避免把 `terminalToolbarVisibility` 和 `sidebarToolbarVisibility` 混为一类

## Requirements (evolving)

* “终端工具栏”设置不再出现在“通用设置”页
* 同一组设置迁移到“侧边栏设置”页
* 现有设置值与行为保持不变，只调整设置入口位置
* 只迁移“终端工具栏”这一整块，不顺手重整“侧边栏工具栏”现有块

## Acceptance Criteria (evolving)

* [ ] “通用设置”页不再显示终端工具栏配置块
* [ ] “侧边栏设置”页能看到终端工具栏配置块
* [ ] 切换任一工具栏开关后，现有功能行为不变

## Definition of Done (team quality bar)

* 相关代码已更新
* 至少完成前端类型检查或等价静态验证
* 不影响现有设置持久化

## Out of Scope (explicit)

* 不新增新的设置项
* 不重构 settings store 结构
* 不改运行时工具栏/侧边栏布局逻辑

## Technical Notes

* 主要影响文件预计为：
  * `src/components/settings/pages/GeneralSettingsPage.tsx`
  * `src/components/settings/pages/SidebarSettingsPage.tsx`
* 现有设置来源：`src/stores/settingsStore.ts`

## Decision (ADR-lite)

**Context**: “终端工具栏”设置目前放在“通用设置”，但语义上更接近侧边栏/布局相关配置。  
**Decision**: 将这整块配置从 `GeneralSettingsPage` 迁移到 `SidebarSettingsPage`，保持字段、开关逻辑和持久化方式不变。  
**Consequences**: 改动仅限设置页面展示位置，风险低；但需要注意避免通用页与侧边栏页同时保留重复入口。
