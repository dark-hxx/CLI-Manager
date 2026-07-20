# CLI-Manager

> **Language**: English | [简体中文](README.zh-CN.md)

<div align="center">

**🚀 Cross-platform AI CLI workspace**

[![Tauri](https://img.shields.io/badge/Tauri-2.x-blue?logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-blue?logo=react)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-latest-orange?logo=rust)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript)](https://typescriptlang.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](https://github.com/dark-hxx/CLI-Manager)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue)](LICENSE)

A multi-project AI CLI workspace for local terminals, SSH hosts, and mobile-assisted workflows

[Features](#-core-features) • [Comparison](#-product-positioning-and-comparison) • [Preview](#-preview) • [Quick Start](#-quick-start) • [Tech Stack](#-tech-stack) • [Community](#-community)

</div>

---

## 💡 Overview

CLI-Manager is a desktop app focused on **AI CLI workflow enhancement**. It combines local and SSH terminals, multi-project management, deep Claude Code / Codex integration, multi-source history, Git Worktree isolation, and mobile-assisted conversations.

> **Platform support**: Windows (fully tested) | macOS / Linux (experimental, feedback welcome)

### 🎯 Why CLI-Manager?

When developing across multiple projects, you may run into these problems:

- ❌ You must keep watching the terminal while Claude / Codex runs, and one missed approval request can block the task
- ❌ You want to review what code changed in a previous session, but Claude history has no Diff view
- ❌ You do not know how many tokens you used this month or which project costs the most
- ❌ You switch terminals across many projects and repeatedly type the same commands
- ❌ You want different Claude backends for different projects (official / proxy / self-hosted), but have to edit environment variables manually

**CLI-Manager provides:**

✅ **Real-time hook notifications** - desktop alerts when Claude needs approval, click to jump back<br>
✅ **Live session statistics** - token usage, cost, and tool calls for each terminal session<br>
✅ **Historical Diff review** - review code changes across sessions and jump back to the triggering message<br>
✅ **Usage analytics dashboard** - heatmaps, trends, efficiency scatter charts, and more<br>
✅ **SSH remote development** - launch and manage remote AI CLI terminals without leaving the workspace<br>
✅ **cc-connect phone conversations** - continue Claude Code / Codex sessions from Telegram or Feishu<br>
✅ **Multi-source session history** - parse and search histories from 11 AI CLI / coding-agent sources<br>
✅ **Mature Worktree isolation** - isolate, commit, merge, and clean up parallel tasks through a guided workflow<br>
✅ **Durable background tasks** - keep terminal jobs running and attach again after reopening the app<br>
✅ **Desktop pets** - visualize session status and jump back to active tasks from a floating companion<br>
✅ **Project-level provider switching** - switch Claude backend per project without editing config manually<br>
✅ **Flexible split layout** - free terminal splits plus tab dragging across panes<br>
✅ **Command palette and templates** - launch projects or run common commands quickly with `Ctrl+P`

---

## ✨ Core Features

### 🔥 Deep Claude Code / Codex CLI Integration

<table>
<tr>
<td width="50%">

#### 🔔 Real-time Hook Notifications

- **Approval reminders** - desktop notification when Claude needs approval, click to jump back
- **Task status sync** - terminal tabs show running / waiting approval / completed / failed states in real time
- **OSC 133 shell integration** - standardized command boundary detection
- **SessionStart binding** - automatically links a terminal with its Claude session ID

</td>
<td width="50%">

#### 📊 Live Session Statistics

- **Real-time token monitoring** - input / output / cache token composition for the current session
- **Cost estimation** - real-time cost estimate for the current session
- **Tool call details** - see which tools / MCP extensions Claude invoked
- **Git branch display** - automatically detects the current project's Git branch

</td>
</tr>
</table>

<table>
<tr>
<td width="50%" align="center">
<img src="docs/img/hook-notification-jump.gif" width="100%" alt="Hook notifications and status sync" />
<br><sub>Hook notification popup + live tab status sync</sub>
</td>
<td width="50%" align="center">
<img src="docs/img/live-session-stats.png" width="100%" alt="Live session statistics panel" />
<br><sub>Live terminal statistics: tokens / cost / Git branch</sub>
</td>
</tr>
</table>

---

### 📜 Unified Session History

<table>
<tr>
<td width="50%">

#### 🗂️ Session Browsing

- **Multi-source view** - browse Claude Code, Codex, Gemini, Copilot CLI, Antigravity, Grok Build, Pi, OpenCode, Kiro, Cursor, and Cline history in one place
- **Smart filters** - group and filter by source / project / time
- **In-session search** - highlighted search results with jump navigation
- **Tags and favorites** - mark important sessions for later

</td>
<td width="50%">

#### 🔍 Diff Review

- **Deep Claude / Codex workflows** - Diff review, message editing, session resume, and cross-format conversion
- **Code change visualization** - supports Unified Diff and Codex Patch style
- **Line-level highlighting** - added / removed / hunk header lines use distinct colors
- **Jump to triggering message** - navigate from a Diff block back to the related conversation
- **Prompt Library** - extract historical prompts for quick reuse

</td>
</tr>
</table>

<p align="center">
<img src="docs/img/session-history.png" width="85%" alt="Session history list" />
<br><sub>Session history list + in-session search and Diff review</sub>
</p>

#### Session Source Capability Matrix

`✅` Full support · `👁️` Read-only support · `—` Not supported · `DB` Database-backed source without a standalone raw session file

| Source | Browse | Search | Statistics | Raw source | Diff / changes | Resume | Edit / delete | Convert | Live stats |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Claude Code | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Codex CLI | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Gemini CLI | 👁️ | 👁️ | 👁️ | 👁️ | — | — | — | — | — |
| GitHub Copilot CLI | 👁️ | 👁️ | 👁️ | 👁️ | — | — | — | — | — |
| Antigravity | 👁️ | 👁️ | 👁️ | 👁️ | — | — | — | — | — |
| Grok Build | 👁️ | 👁️ | 👁️ | 👁️ | — | — | — | — | — |
| Pi | 👁️ | 👁️ | 👁️ | 👁️ | — | — | — | — | — |
| OpenCode | 👁️ | 👁️ | 👁️ | DB | — | — | — | — | — |
| Kiro | 👁️ | 👁️ | 👁️ | 👁️ | — | — | — | — | — |
| Cursor | 👁️ | 👁️ | 👁️ | 👁️ | — | — | — | — | — |
| Cline | 👁️ | 👁️ | 👁️ | 👁️ | — | — | — | — | — |

> Statistics depend on the fields exposed by each source. Claude Code and Codex CLI provide the deepest integration, including Hook-driven live status, file-change Diff, message editing with audit / rollback, resume, and two-way session conversion.

---

### 📈 Multi-dimensional Usage Analytics

#### Data Insights

- **Token composition analysis** - input / output / cache creation / cache read breakdown
- **Cost estimation** - automatic pricing for Claude, GPT, and o-series models
- **Project ranking** - click a project name to filter by project
- **Activity heatmap** - 7 / 30 / 90 day ranges, click a date to inspect sessions from that day
- **Token trend chart** - session / message / token trends with hover details
- **Efficiency scatter chart** - project efficiency analysis (token usage vs session count)
- **24-hour activity distribution** - understand your most active hours

<table>
<tr>
<td width="50%" align="center">
<img src="docs/img/usage-analytics-dashboard.png" width="100%" alt="Usage analytics dashboard" />
<br><sub>Analytics dashboard: heatmap / token trend / efficiency scatter / project ranking</sub>
</td>
<td width="50%" align="center">
<img src="docs/img/usage-analytics-details.png" width="100%" alt="Usage analytics details" />
<br><sub>Token composition pie chart / model share / active hour distribution</sub>
</td>
</tr>
</table>

---

### 🔄 cc-switch Provider Integration

#### Project-level Backend Switching

- **Provider management** - read-only parsing of the cc-switch database, grouped by `app_type`
- **Project-level switching** - right-click project -> switch provider -> automatically writes `.claude/settings.json`
- **Global default / project override** - choose either global default or project-level override
- **Provider badges** - projects with overridden providers display dedicated badges in the project tree

**Use cases:**

- Use the official API for project A
- Use a proxy backend for project B
- Use a self-hosted backend for project C
- Switch with one click instead of editing environment variables manually

<table>
<tr>
<td width="50%" align="center">
<img src="docs/img/provider-list.png" width="100%" alt="Provider management" />
<br><sub>Provider list and details</sub>
</td>
<td width="50%" align="center">
<img src="docs/img/provider-switch.png" width="100%" alt="Project-level provider switching" />
<br><sub>Project context menu: switch provider with one click</sub>
</td>
</tr>
</table>

---

### 🌐 SSH Remote Development

- **SSH host management** - SSH Config, Agent, private key, password / keyboard-interactive authentication, jump hosts, and ProxyCommand
- **Proxy and diagnostics** - built-in HTTP CONNECT / SOCKS5 proxy helper, connection tests, host-key confirmation, and detailed diagnostic logs
- **Remote project workflow** - browse remote directories, configure remote startup commands and environment variables, and launch AI CLI sessions directly in the target path
- **Workspace integration** - remote terminals support tabs, splits, Workspan, background execution, and daemon-backed recovery
- **Remote Agent and Hook** - explicitly install or upgrade the signed `cli-manager-ssh-agent`, configure Claude/Codex roots per host or project, preview Hook changes, and install or remove only CLI-Manager-owned entries
- **Reliable live status** - SSH sessions with a validated installed Hook reuse one per-host protocol 1.3 Agent bridge with bounded handshake/response timeouts, heartbeat, reconnect gates, and a streaming Host/client-isolated spool
- **Remote history** - browse scoped Claude Code and Codex sessions from the existing history workspace, with incremental list/search, on-demand detail and Diff, usage summaries, pagination, and explicit stale/offline cache state
- **Credential safety** - passwords use the operating system credential store; sync and export never include passwords, credentials, or private-key paths

> Remote Hook status and read-only remote history are available for Claude Code and Codex. Remote resume, aggregate history analytics, file/Git panels, Worktree tools, external terminal launch, and remote resource monitoring are not available yet. SSH projects never scan or switch remote providers.

<p align="center">
<img src="docs/img/ssh-settings.png" width="85%" alt="SSH host settings and connection diagnostics" />
<br><sub>SSH host management, authentication, proxy, and connection diagnostics</sub>
</p>

---

### 📱 Mobile Conversations with cc-connect

- **Chat from your phone** - use Telegram or Feishu to start independent Claude Code / Codex conversations on the desktop host
- **Project-scoped access** - explicitly select the project exposed to remote conversations and restrict access with a fail-closed user-ID allowlist
- **Managed runtime** - CLI-Manager verifies the supported cc-connect binary checksum, generates an isolated configuration, supervises the process, and can start it with the app
- **Secure credentials** - bot tokens and app secrets are stored in Windows Credential Manager instead of generated config files
- **Claude and Codex support** - Claude uses its permission modes; Codex uses the app-server stdio approval channel, with YOLO mode available only through an explicit warning and confirmation
- **History convergence** - remote conversations create native CLI histories and flow back into CLI-Manager's unified session workspace

> The current cc-connect integration runs on a Windows desktop host and supervises one project plus one messaging platform at a time. Telegram and Feishu are supported.

<table>
<tr>
<td width="50%" align="center"><img src="docs/img/cc-connect-settings.png" width="100%" alt="cc-connect settings" /><br><sub>Project / Agent selection, allowlist, credentials, and process status</sub></td>
<td width="50%" align="center"><img src="docs/img/cc-connect-mobile.png" width="55%" alt="cc-connect mobile conversation" /><br><sub>Claude Code / Codex conversation from Telegram or Feishu</sub></td>
</tr>
</table>

---

### 💻 Terminal and Splits

<table>
<tr>
<td width="50%">

#### 🖥️ Built-in Terminal

- **Multiple shell support** - Windows (PowerShell / CMD / Pwsh / WSL / Git Bash), macOS / Linux (Bash / Zsh, etc.)
- **Tab management** - drag sorting / overflow scrolling / duplicate configuration
- **Performance optimizations** - high-frequency output batching / WebGL rendering / lower refresh rate for inactive terminals
- **Chinese IME support** - stable candidate window anchoring and stream redraw resilience
- **Terminal search** - search terminal output with `Ctrl+F`
- **Custom background** - image / opacity / blur / dark overlay

</td>
<td width="50%">

#### 📐 Flexible Splits

- **Free layout** - Split Right / Split Down / mixed nested splits
- **Draggable separators** - adjust adjacent pane ratios
- **Drag tabs across panes** - move tabs to another pane or create a split at the edge
- **Independent tab bars** - each pane has its own tab bar

</td>
</tr>
</table>

<p align="center">
<img src="docs/img/terminal-splits.png" width="85%" alt="Terminal splits" />
<br><sub>Flexible split layout + dragging tabs across panes</sub>
</p>

#### Durable Workspaces and Background Tasks

- **Workspan workspaces** - group multiple terminals and nested panes into a persistent top-level workspace
- **Daemon-backed sessions** - keep CLI tasks running after the main window exits, then attach without restarting the command
- **Ordered replay and recovery** - restore terminal output, tab metadata, split layout, and live output in order after reconnecting
- **Background task center** - inspect, restore, discard, or clean up tasks that continue outside the main window

---

### ⚡ Command Reuse and Shortcuts

#### 🎯 Command Palette

- **Global `Ctrl+P` palette** - fuzzy search and keyboard navigation
- **Quick project launch** - start a project terminal directly from the palette
- **Run command templates** - execute common commands with one click

#### 📝 Command Templates

- **Three scopes** - global / project / session-level templates
- **Variable substitution** - `${projectPath}` / `${projectName}`
- **Command suggestions** - combine templates, existing local history, built-in AI CLI commands, and path completion without automatically executing the candidate

<table>
<tr>
<td width="50%" align="center">
<img src="docs/img/command-palette.png" width="100%" alt="Command palette" />
<br><sub>Command palette: fuzzy search + quick launch</sub>
</td>
<td width="50%" align="center">
<img src="docs/img/command-templates.png" width="100%" alt="Command templates" />
<br><sub>Command templates: three scopes + variable substitution</sub>
</td>
</tr>
</table>

---

### 🗂️ Project Management

- **Project groups** - nested groups / drag sorting / collapse and expand
- **Project config** - dedicated path / shell / startup command / environment variables
- **Health checks** - automatically detects invalid paths
- **Context menu** - open directory / switch provider / launch terminal
- **Git integration** - automatically detects project Git branch
- **Built-in file and Git tools** - file browsing / editing, Git status and Diff, hunk rollback, and sub-repository visibility
- **Mature Worktree isolation** - prompt, auto-isolate parallel tasks, or always isolate into dedicated directories and `wt/<task-name>` branches
- **Finish-task workflow** - review and commit changes, merge into the main workspace, abort safely on conflicts, then clean up the Worktree and branch

---

### ☁️ WebDAV Cloud Sync

- **Versioned backups** - immutable snapshots instead of a single overwrite-only backup
- **Selective restore** - restore individual data domains, create a safety snapshot first, and undo the most recent restore
- **Multi-device retention** - independent device snapshots with automatic retention of recent versions
- **Offline retry** - failed uploads stay in an outbox and retry on a later launch
- **Local import and export** - ZIP backup support with the same restore workflow

---

### 🎨 Personalization and Themes

- **App themes** - multiple built-in themes and customization
- **Terminal themes** - Tokyo Night / Dracula / Monokai / Nord / Solarized, etc.
- **Font customization** - UI font / terminal font / size / font color
- **Shortcut configuration** - all shortcuts are customizable
- **Compact mode** - compact UI plus external terminal by default
- **Desktop pets** - floating status companion, task list and session jump-back, size / position / always-on-top controls, `.clipet` packages, and Codex Pets compatibility

<p align="center">
<img src="docs/img/pet-settings.png" width="85%" alt="Desktop pet settings and gallery" />
<br><sub>Desktop pet, task list, pet gallery, and `.clipet` package management</sub>
</p>

---

## 🧭 Product Positioning and Comparison

CLI-Manager is positioned as a **durable AI CLI workspace**: it connects local and SSH terminals, multi-agent execution, long-term session history, Git Worktree isolation, analytics, provider configuration, background tasks, and phone conversations into one product.

The comparison below is based on the public positioning of [Orca](https://github.com/stablyai/orca) and [cmux](https://github.com/manaflow-ai/cmux) as of 2026-07-05. Planned CLI-Manager capabilities are explicitly marked as planned.

| Area | CLI-Manager | Orca | cmux |
|---|---|---|---|
| Primary focus | Long-running AI CLI workspace across projects, local / SSH terminals, history, analytics, and configuration | Multi-agent orchestration and result comparison in isolated worktrees | Native macOS terminal workspace for agent panes, notifications, and programmable surfaces |
| Desktop platforms | Windows fully tested; macOS / Linux experimental | macOS / Windows / Linux | macOS |
| Remote workflows | Built-in SSH projects / terminals plus cc-connect phone conversations through Telegram or Feishu | SSH-oriented worktree workflows and remote orchestration | SSH / tmux through a composable terminal workflow |
| Session history | 11 parsed sources with unified browse, search, filtering, tags, favorites, and statistics | Usage, account, notification, and AI Diff-oriented features | Session restore, notification panel, and workspace metadata |
| Deep history operations | Claude / Codex Diff, file changes, message edit / delete, audit rollback, resume, and two-way conversion | Not the primary focus of its public positioning | Not the primary focus of its public positioning |
| Git Worktree lifecycle | Mature project-level isolation: prompt / automatic strategies, dedicated branches, dependency setup, history, commit, merge, conflict abort, and cleanup | Core parallel-agent orchestration model | External / composable Git workflow rather than a guided task lifecycle |
| Agent visualization | Automatic sub-agent splits with session association and live status | Parallel agents, isolated attempts, comparison, and merge workflow | Native panes / splits for agents and related tools |
| Analytics and configuration | Token / cost / model / project analytics, cc-switch provider integration, versioned WebDAV backups | Usage and rate-limit tracking plus account switching | Ghostty configuration, CLI / socket APIs, hooks, and OSC integration |
| Mobile and web | cc-connect phone conversations available now; dedicated Web and mobile clients are in planning | Includes a mobile companion in its public product positioning | macOS desktop focus |
| Personalization | App / terminal themes, custom backgrounds, status-line tools, and desktop pets | Product-specific UI and orchestration views | Native terminal theming and Ghostty compatibility |

**How to choose:**

- Choose **CLI-Manager** for a persistent daily workspace around Claude Code, Codex, and other AI CLI histories, especially when you need SSH, Worktree task isolation, deep history operations, analytics, provider management, and phone access.
- Choose **Orca** when the central workflow is dispatching the same task to multiple isolated agents, comparing their results, and merging the preferred output.
- Choose **cmux** when the priority is a native high-performance macOS terminal with programmable panes, notifications, and terminal / browser surfaces.

### 🌍 Multi-surface Roadmap

| Surface | Status | Role |
|---|---|---|
| Desktop app | ✅ Available | Full terminal, project, history, Git, analytics, SSH, and background-task workspace |
| Phone conversations | ✅ Available through cc-connect | Talk to Claude Code / Codex from Telegram or Feishu while the desktop host supervises the session |
| Web client | 🧭 Planning | Browser-based access to CLI-Manager workflows; scope and release schedule are not yet committed |
| Dedicated mobile client | 🧭 Planning | A first-party mobile companion beyond messaging-platform conversations; scope and release schedule are not yet committed |

---

## 🤖 Agent Parallelism

CLI-Manager provides two mature parallel-work paths: automatic sub-agent visualization inside the terminal workspace, and project-level Git Worktree isolation for independent tasks.

### 🤖 Automatic Sub-agent Splitting

- **Smart splits** - automatically creates split terminals when Claude Code dispatches sub-agents
- **Session association** - each sub-agent gets an independent terminal with live status sync
- **Layout optimization** - automatically adjusts split layout based on agent count

### 🌿 Mature Git Worktree Task Isolation

- **Flexible isolation strategies** - keep normal opening as the default, prompt when a parallel CLI task exists, auto-isolate parallel sessions, or always create a Worktree
- **Dedicated directory and branch** - each task uses an independent Worktree directory and `wt/<task-name>` branch
- **Integrated project context** - file browsing, Git status, history, live statistics, provider overrides, and terminal focus follow the active Worktree
- **Dependency setup** - optionally detect missing dependencies and open a dedicated installation terminal
- **Finish-task wizard** - review and commit changes, merge into the main workspace, abort safely on conflicts, and clean up the Worktree / branch
- **Safety guards** - block merges into a dirty main workspace, skip no-diff merges, handle stale / damaged Worktrees, and retry cleanup around Windows file locks

---

## 📸 Preview

<p align="center">
<img src="docs/img/main-workspace.png" width="90%" alt="Main interface" />
<br><sub>Main interface - terminal workspace</sub>
</p>

---

## 🛠️ Tech Stack

### Frontend

- **Framework**: React 19 + TypeScript 5.8
- **Build tool**: Vite 7
- **State management**: Zustand
- **Styling**: Tailwind CSS 4
- **Terminal**: xterm.js + FitAddon + WebglAddon
- **UI components**: Radix UI, Mantine Core
- **Charts**: ECharts
- **Drag and drop**: @dnd-kit
- **Diff rendering**: react-diff-view

### Backend

- **Runtime**: Tauri 2.x
- **Language**: Rust
- **Database**: SQLite (tauri-plugin-sql)
- **Storage**: tauri-plugin-store
- **PTY**: Rust PTY session management
- **Cloud sync**: WebDAV adapter layer

### Core Capabilities

- Cross-platform desktop app (Windows / macOS / Linux, based on Tauri 2)
- Multi-shell support (Windows: PowerShell / CMD / Pwsh / WSL / Git Bash; macOS / Linux: Bash / Zsh, etc.)
- PTY session management and status broadcasting
- Daemon-backed background tasks, ordered replay, attach, and workspace recovery
- Claude Code / Codex Hook Bridge (127.0.0.1 loopback + bearer token validation)
- Automatic sub-agent splitting (cmux-like, creates split terminals when Claude Code dispatches sub-agents)
- Mature Git Worktree task isolation and commit / merge / cleanup workflow
- Multi-source history parsing (Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI, Antigravity, Grok Build, Pi, OpenCode, Kiro, Cursor, and Cline)
- Deep Claude / Codex history workflows (Diff, edit, resume, conversion, and analytics)
- SSH remote projects and terminals (OpenSSH launch plans, proxy support, diagnostics, remote directory browsing, and signed Linux Agent lifecycle management)
- cc-connect mobile conversations (Telegram / Feishu with Claude Code or Codex)
- Desktop pets (`.clipet` packages and Codex Pets compatibility)
- Read-only cc-switch provider database parsing
- WebDAV cloud sync and conflict handling
- Git integration (branch detection / project path health checks)

---

## 🚀 Quick Start

### Option 1: Download a Release

Go to the [Releases](https://github.com/dark-hxx/CLI-Manager/releases) page and download the latest version.

> Windows builds are the primary release artifact at the moment. macOS / Linux users are recommended to build from source.

### SSH Remote Agent

For a configured SSH Host, open **Settings -> SSH Hosts -> CLI Integration** to explicitly preview and install, upgrade, roll back, or uninstall `cli-manager-ssh-agent`. The first supported remote targets are Linux x86_64 and aarch64. Opening the page never connects automatically, and Agent lifecycle operations never install or modify Claude/Codex Hooks.

After the Agent is installed and detected, use the Claude or Codex card on the same page to inspect the configured root, preview the exact files and fingerprints, and explicitly confirm Hook installation or removal. Each SSH Host and project override keeps its own config-root identity; the default roots are `$HOME/.claude` and `$HOME/.codex`.

The reusable bridge requires Agent protocol `1.1` or newer. An older healthy Agent remains available for explicit upgrade, but is shown as incompatible until it provides heartbeat, cancellation, and bounded-backpressure capabilities.

The same signed release artifacts can be installed from a reviewed POSIX script:

```sh
curl -fL -o install-ssh-agent.sh https://github.com/dark-hxx/CLI-Manager/releases/latest/download/install-ssh-agent.sh
less install-ssh-agent.sh
sh install-ssh-agent.sh
```

The script requires `curl`, `minisign`, and either `jq` or `python3`. It verifies the signed manifest, target, artifact size, and SHA-256 before execution. Use `--install-dir` for a custom root; HTTP mirrors require the explicit `--allow-http` option and still must pass the built-in public-key verification.

### Option 2: Run from Source

#### Prerequisites

- Node.js >= 20
- Rust >= 1.70
- Operating system: Windows 10/11 | macOS | Linux

#### Install Dependencies

```bash
npm install
```

#### Start Development Mode

```bash
npm run tauri dev
```

#### Build a Release

```bash
npm run tauri build
```

#### Other Useful Commands

```bash
# TypeScript type check
npx tsc --noEmit

# Rust check
cd src-tauri && cargo check

# Rust tests
cd src-tauri && cargo test
```

---

## 🎯 Use Cases

- ✅ Developers who use Claude Code / Codex CLI heavily
- ✅ Users who need real-time token usage and cost monitoring
- ✅ Users who want to review historical session code changes
- ✅ Users who need one searchable history workspace across multiple AI CLI tools
- ✅ Developers who run AI CLI tasks on remote SSH hosts
- ✅ Developers who want to continue Claude Code / Codex conversations from a phone
- ✅ Teams running parallel tasks that need mature Git Worktree isolation and merge cleanup
- ✅ Users who need long-running CLI tasks to survive window or app restarts
- ✅ Users who want a lightweight visual companion for task and session status
- ✅ Multi-project development workflows with frequent terminal switching
- ✅ Users who manage multiple Claude backends with cc-switch
- ✅ Users who need to sync development configuration across devices

---

## 📋 Feature Quick Reference

<details>
<summary><b>Project Management</b></summary>

- Project groups / search / drag sorting
- Project configuration (path / shell / startup command / environment variables)
- Path health checks
- Automatic Git branch detection
- Context menu (open directory / switch provider)
- Built-in file browser / editor and Git Diff tools
- Git Worktree isolation strategies and finish-task workflow

</details>

<details>
<summary><b>Terminal Workspace</b></summary>

- Built-in PTY terminal (xterm.js)
- Tab management (drag sorting / overflow scrolling / duplicate configuration)
- Flexible splits (Split Right / Split Down / mixed nested splits)
- Drag tabs across panes
- Persistent Workspan workspaces
- Daemon-backed background tasks and session recovery
- Terminal search (`Ctrl+F`)
- Custom background (image / opacity / blur)
- Chinese IME support

</details>

<details>
<summary><b>AI CLI Integration and Session History</b></summary>

- Real-time hook notifications (approval / completed / failed)
- Tab status dots (running / waiting approval / completed / failed)
- Live session statistics (tokens / cost / tool calls / Git branch)
- Multi-source history parsing (11 supported sources)
- Unified filtering / search / tags / favorites
- Diff review (Unified Diff / Codex Patch)
- Claude / Codex message editing, resume, and conversion
- Prompt Library

</details>

<details>
<summary><b>SSH Remote Development</b></summary>

- SSH host groups and host management
- SSH Config / Agent / private key / password authentication
- Jump hosts / ProxyCommand / HTTP CONNECT / SOCKS5
- Connection diagnostics and host-key confirmation
- Remote directory browsing and startup commands
- Remote tabs / splits / Workspan / background recovery
- Signed `cli-manager-ssh-agent` install / upgrade / rollback / uninstall
- Per-host and per-project Claude/Codex config roots plus previewed remote Hook lifecycle
- Bound Hook events, live tab status, offline spool replay, and gap warnings

</details>

<details>
<summary><b>cc-connect Mobile Conversations</b></summary>

- Telegram / Feishu phone conversations
- Claude Code / Codex Agent selection
- Project-scoped access and user-ID allowlist
- Verified cc-connect binary and managed process lifecycle
- Windows Credential Manager for platform credentials
- Native history convergence into CLI-Manager

</details>

<details>
<summary><b>Usage Analytics</b></summary>

- Multi-dimensional analytics dashboard
- Token composition analysis (input / output / cache)
- Cost estimation
- Interactive project ranking
- Activity heatmap (7 / 30 / 90 days)
- Token trend chart
- Efficiency scatter chart
- 24-hour activity distribution

</details>

<details>
<summary><b>cc-switch Integration</b></summary>

- Read-only provider database parsing
- Grouped by `app_type`
- Project-level provider switching
- Automatically writes `.claude/settings.json`
- Global default / project override

</details>

<details>
<summary><b>Command Reuse</b></summary>

- Command palette (`Ctrl+P`)
- Command templates (global / project / session-level)
- Inline command suggestions (templates / existing local history / AI CLI commands / paths)
- Variable substitution (`${projectPath}` / `${projectName}`)

</details>

<details>
<summary><b>Cloud Sync</b></summary>

- Versioned WebDAV snapshots
- Selective data-domain restore
- Safety snapshot and one-step undo
- Per-device retention and offline outbox retry
- Local import and export (ZIP)

</details>

<details>
<summary><b>Personalization</b></summary>

- App themes / terminal themes
- Font customization (UI / terminal / size / color)
- Shortcut configuration
- Compact mode
- Desktop pets / `.clipet` packages / Codex Pets
- Custom terminal background

</details>

---

## 🔑 Default Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+P` | Open command palette |
| `Ctrl+K` | Open session history |
| `Ctrl+Shift+T` | New terminal |
| `Ctrl+W` | Close current terminal |
| `Alt+ArrowRight` | Next tab |
| `Alt+ArrowLeft` | Previous tab |
| `F11` | Terminal fullscreen |
| `Ctrl+F` | Terminal search / in-session search |

> 💡 All shortcuts can be customized in Settings - Shortcuts.

---

## 💬 Community

<p align="center">
  <img src="docs/img/wechat-group-qr.png" width="280" alt="WeChat community group" />
  <br>
  <sub>Scan the QR code to join the WeChat community for updates and support</sub>
</p>

---

## 🎉 Acknowledgements

This project was promoted in the [LINUX DO](https://linux.do/) community. Thanks to the LINUX DO community for supporting and recognizing open-source projects.

---

## 📄 License

CLI-Manager is dual-licensed:

- **Open source**: [AGPL-3.0-or-later](LICENSE). Companies and individuals may use, study, modify, distribute, and provide network access to CLI-Manager under the AGPL terms.
- **Commercial**: Proprietary integration, closed-source modifications, internal productization where AGPL obligations are not acceptable, commercial redistribution, or hosted/managed offerings under proprietary terms require a separate commercial license. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

Copyright (c) 2026 Chenyme. See [NOTICE](NOTICE).

Ordinary use of the unmodified application does not require a commercial license. Open-source use that complies with AGPL-3.0-or-later does not require a commercial license.

---

## ⭐ Star History

<p align="center">
  <a href="https://www.star-history.com/?repos=dark-hxx%2FCLI-Manager&type=date&legend=top-left">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=dark-hxx/CLI-Manager&type=date&theme=dark&legend=top-left&sealed_token=yMb1FSvSFz9fR9h9JP66BSxsU5qTaxdVJhvVj9VVFTP-2EXQ-dKINdBrzJmByEJ542IYvMXVQOvabZJv8JIEMUUosdPAKlbfQIQbuP9pnRvVtSogPwHzdw" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=dark-hxx/CLI-Manager&type=date&legend=top-left&sealed_token=yMb1FSvSFz9fR9h9JP66BSxsU5qTaxdVJhvVj9VVFTP-2EXQ-dKINdBrzJmByEJ542IYvMXVQOvabZJv8JIEMUUosdPAKlbfQIQbuP9pnRvVtSogPwHzdw" />
      <img alt="CLI-Manager Star History Chart" src="https://api.star-history.com/chart?repos=dark-hxx/CLI-Manager&type=date&legend=top-left&sealed_token=yMb1FSvSFz9fR9h9JP66BSxsU5qTaxdVJhvVj9VVFTP-2EXQ-dKINdBrzJmByEJ542IYvMXVQOvabZJv8JIEMUUosdPAKlbfQIQbuP9pnRvVtSogPwHzdw" />
    </picture>
  </a>
</p>

---

<div align="center">

**⭐ If this project helps you, a Star is appreciated.**

[Submit Issue](https://github.com/dark-hxx/CLI-Manager/issues) • [Contribute](https://github.com/dark-hxx/CLI-Manager/pulls) • [View Docs](docs/功能清单.md)

</div>
