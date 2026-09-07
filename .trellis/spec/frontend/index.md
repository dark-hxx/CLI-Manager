# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

This directory contains guidelines for frontend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | Active |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | To fill |
| [State Management](./state-management.md) | Local state, global state, server state | Active |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | Active |
| [Type Safety](./type-safety.md) | Type patterns, validation | To fill |
| [History Session Contracts](./history-session-contracts.md) | History favorites, metadata, and snapshot fallback contracts | Active |
| [Workspace Session Restore Contracts](./workspace-session-restore-contracts.md) | 关闭后恢复工作区终端会话：TUI 走 resume、shell 贴 scrollback、节流落盘与启动问询 | Active |
| [Terminal Output Scheduling Contracts](../backend/terminal-output-scheduling-contracts.md) | Daemon live-frame budget and frontend cross-terminal xterm scheduling contract | Active |
| [Statusline Editor Contracts](./statusline-editor-contracts.md) | Claude/Codex 独立编辑状态、共享终端主题预览与响应式布局 | Active |
| [Web UI Visual Guidelines](./web-ui-visual-guidelines.md) | macOS-inspired frosted-glass, clean white visual language and surface rules | Active |
| [Git Diff Viewer Contracts](./git-diff-viewer-contracts.md) | Shared snapshot/live data sources, target identity, and viewer responsibility boundaries | Active |
| [Markdown File Navigation Contracts](./markdown-file-navigation-contracts.md) | Scoped preview anchors, source gestures, project-bound file resolution, and stale navigation protection | Active |
| [CCS-Compatible Provider Domain Contracts](./ccs-provider-domain-contracts.md) | Planned complete supplier list/editor, multi-key, type common config, Home/global apply, import, i18n and accessibility contract | Planned |
| [Agent Capability Diagnostics Contracts](../backend/agent-capability-diagnostics-contracts.md) | Session-bound MCP/Skill card, stale-result protection, OpenCode setup, and local/WSL/SSH diagnostic contract | Active |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
