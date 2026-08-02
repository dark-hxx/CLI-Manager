# Web 项目树右键菜单与快捷启动

## Goal

为 Web 项目树补齐桌面端对齐的项目、分组、Worktree 右键菜单，并增加悬浮快捷启动按钮。Web 端只发送基于节点 ID 的操作请求，由配对桌面端复用现有终端、文件浏览、Provider 和配置弹窗能力执行。

## Changelog Target

[TEMP]

## Requirements

- 项目、分组、Worktree 节点支持右键菜单。
- 项目和 Worktree 支持快捷启动，分组支持批量启动。
- 菜单覆盖桌面端常用启动、分屏、选择、批量操作、目录/文件、历史、Provider、编辑、重命名、删除及 Worktree 操作。
- Web 操作只传项目/分组/Worktree ID，不传路径和环境变量。
- 复用桌面端现有处理逻辑；Web 不重复实现桌面配置弹窗。
- 所有新增用户可见文案同步支持 zh-CN 与 en-US。
- 保留现有项目树拖拽排序、当前字号和字重调整。

## Acceptance Criteria

- [ ] 三类节点均可打开右键菜单，菜单具备边界定位、Escape 关闭和键盘导航。
- [ ] 快捷启动可创建项目/Worktree/分组终端，并正确处理离线、缺失 Worktree、SSH 和未配置 CLI。
- [ ] 右键菜单操作通过 Web operation 下发，桌面端完成后 Web 能看到状态并刷新 Workspace。
- [ ] 删除、丢弃等危险操作需要显式确认；服务端和桌面端都校验目标 ID。
- [ ] Web 类型检查、Server Rust 测试、桌面端 Rust 测试和 diff 检查通过。
- [ ] 中英文切换后新增菜单和快捷按钮文案完整。

## Definition of Done

- 类型检查和相关测试通过。
- CHANGELOG.md 以 [TEMP] 记录功能变更。
- 未覆盖敏感环境变量或无关功能。

## Technical Approach

- Web `ProjectTree` 增加上下文菜单状态、节点选择状态和 Play 快捷按钮。
- 新增 `project.start` 与 `project.action` 操作；现有 `project.tree.reorder` 保持不变。
- 桌面端 Web bridge 按 ID 解析本地项目，再调用现有 Sidebar/终端动作；交互型原生弹窗通过进程内 action bus 请求。
- 操作成功后沿用既有 Timeline、BrowserSocket 和 Workspace 发布链路。

## Out of Scope

- 不新增第三方依赖。
- 不把环境变量或敏感 Provider 配置传到 Web/Server。
- 不重构与项目树无关的终端、历史和管理模块。
