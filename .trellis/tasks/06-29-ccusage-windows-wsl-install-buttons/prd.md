# ccusage Windows WSL install buttons

## Goal

在 Windows 宿主环境下，保留现有 ccusage 宿主安装入口，并在 ccusage 看板中新增一个 WSL 小图标安装入口，用于把 Bun/bunx 安装到 WSL 发行版中，避免“使用 ccusage 看板”只能依赖 Windows 宿主环境。

## Requirements

- Windows 环境下，ccusage 看板继续保留现有宿主安装按钮。
- Windows 环境下，如果已配置的 Claude/Codex 配置目录中存在 WSL UNC 路径，则额外显示一个 WSL 小图标安装按钮。
- WSL 小图标按钮只负责安装到 WSL，不改变现有宿主安装行为。
- 后端安装命令需要支持按目标环境分流：Windows 宿主或指定 WSL distro。
- 前端需要给 WSL 安装按钮补充中英文 tooltip、确认文案、结果提示。
- 如果 Claude/Codex 分别指向不同 WSL distro，首版不做一键多发行版安装；需要给出明确提示。
- 现有 ccusage 状态检查、报告刷新、缓存逻辑不得因本次改动被破坏。

## Acceptance Criteria

- [ ] Windows 宿主下，原有 `Install Bun/bunx` 按钮仍可正常工作。
- [ ] 存在 WSL 配置目录时，看板显示额外的 WSL 安装入口。
- [ ] 点击 WSL 安装入口后，会弹出针对 WSL 的确认文案，并把 Bun/bunx 安装到目标 distro。
- [ ] 没有 WSL 配置目录时，不显示 WSL 安装入口。
- [ ] 多个不同 WSL distro 冲突时，前端给出明确提示，不静默选择目标。
- [ ] `npx tsc --noEmit` 通过。
- [ ] `cd src-tauri && cargo check` 通过。

## Definition of Done

- 相关前后端代码完成修改。
- 中英文文案补齐。
- 静态检查通过。
- 补充人工验证清单，供桌面端手测确认。

## Technical Approach

- 前端基于现有设置中的 `claudeHookConfigDir` / `codexHookConfigDir` 判断是否存在 WSL 配置目录。
- 后端复用 `wsl.rs` 中的 WSL 路径解析和 `wsl.exe` 定位能力。
- `ccusage_install_tools` 新增安装目标参数，支持宿主安装和指定 distro 安装。
- 仅在 Windows 宿主 UI 中增加一个局部 WSL 安装入口，不改动历史用量分析面板入口结构。

## Decision (ADR-lite)

**Context**: 用户明确要求在 Windows 下保留原有宿主安装方式，同时增加单独的 WSL 安装入口，而不是把宿主和 WSL 安装混成一个按钮。  
**Decision**: 保留主按钮作为 Windows 宿主安装入口，新增 WSL 图标按钮作为辅助入口；后端按安装目标分流执行。  
**Consequences**: 改动范围集中在 ccusage 前后端链路和文案；UI 更清晰，但首版只处理单一 WSL distro，跨 distro 仍需显式提示。

## Out of Scope

- 不实现自动同时安装到多个 WSL distro。
- 不改造 ccusage 报告刷新为多环境聚合。
- 不增加新的第三方依赖。

## Technical Notes

- 现有后端入口：`src-tauri/src/commands/ccusage.rs`
- 现有前端状态：`src/stores/ccusageStore.ts`
- 现有看板 UI：`src/components/stats/CcusageStatsPanel.tsx`
- WSL 规约：`.trellis/spec/backend/wsl-path-contracts.md`
- i18n 规约：`.trellis/spec/frontend/component-guidelines.md`
