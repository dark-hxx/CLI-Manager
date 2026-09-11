# Frontend Development Guidelines

> Concrete React/TypeScript contracts for this project.

---

## Overview

Read the domain contract that owns the code being changed; do not load every guideline by default.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Current module layout and feature-first migration | Active |
| [AI Architecture Contracts](./ai-architecture-contracts.md) | 2000-line limit, feature boundaries, standalone checks, shrinking migration baseline | Active |
| [Frontend Code Comment Contracts](./code-comment-contracts.md) | 前端函数与方法的必要注释、开发门禁及审查要求 | Active |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | Active |
| [Hook Guidelines](./hook-guidelines.md) | Hook ordering around mounted-but-hidden UI | Active |
| [State Management](./state-management.md) | Local state, global state, server state | Active |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | Active |
| [File Explorer Batch Contracts](./file-explorer-batch-contracts.md) | Selection snapshots, batch mutations, dirty buffers and scoped drag/clipboard | Active |
| [Type Safety](./type-safety.md) | Stable entry for type validation and owning contracts | Active |
| [History Session Contracts](./history-session-contracts.md) | History favorites, metadata, and snapshot fallback contracts | Active |
| [Workspace Session Restore Contracts](./workspace-session-restore-contracts.md) | 关闭后恢复工作区终端会话：TUI 走 resume、shell 贴 scrollback、节流落盘与启动问询 | Active |
| [Background Task Continuation Contracts](./background-task-continuation-contracts.md) | 运行任务退出守卫、daemon 后台继续、托盘最小化与通知边界 | Active |
| [Terminal Output Scheduling Contracts](../backend/terminal-output-scheduling-contracts.md) | Daemon live-frame budget and frontend cross-terminal xterm scheduling contract | Active |
| [Statusline Editor Contracts](./statusline-editor-contracts.md) | Claude/Codex 独立编辑状态、共享终端主题预览与响应式布局 | Active |
| [Web UI Visual Guidelines](./web-ui-visual-guidelines.md) | macOS-inspired frosted-glass, clean white visual language and surface rules | Active |
| [Git Diff Viewer Contracts](./git-diff-viewer-contracts.md) | Shared snapshot/live data sources, target identity, and viewer responsibility boundaries | Active |
| [Git Changes Performance Contracts](./git-changes-performance-contracts.md) | 大规模变更树虚拟化、Worker/分批构造、目录完整操作与刷新合并 | Active |
| [Markdown File Navigation Contracts](./markdown-file-navigation-contracts.md) | Scoped preview anchors, source gestures, project-bound file resolution, and stale navigation protection | Active |
| [CCS-Compatible Provider Domain Contracts](./ccs-provider-domain-contracts.md) | Planned complete supplier list/editor, multi-key, type common config, Home/global apply, import, i18n and accessibility contract | Planned |
| [Agent Capability Diagnostics Contracts](../backend/agent-capability-diagnostics-contracts.md) | Session-bound MCP/Skill card, stale-result protection, OpenCode setup, and local/WSL/SSH diagnostic contract | Active |
