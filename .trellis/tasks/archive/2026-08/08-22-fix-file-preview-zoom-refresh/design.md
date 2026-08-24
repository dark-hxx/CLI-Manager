# V1.3.8 技术设计

## Architecture Boundaries

| 交付物 | 责任边界 | 计划改动 |
| --- | --- | --- |
| Markdown 缩放 | 文件编辑器预览样式 | 在文件 Markdown 预览上提供字号 CSS 变量，并以专用选择器覆盖渲染器的固定 `text-xs`。 |
| 文件自动刷新 | 持久的刷新控制器 + 文件 store | 将 watcher、焦点检查、WSL 回退轮询从可卸载侧栏移至 App 级非视觉控制器；复用 store 的单飞刷新和草稿保护。 |
| SSH 刷新 | 现有只读远程文件桥接 | 为自动刷新提供静默 list/read 选项，保持手动浏览的后台任务反馈；不修改 Rust/Agent wire protocol。 |
| Git Diff Markdown | Diff 语法 token 的 CSS 隔离 | 在 `.diff-code` 内将 Refractor `span.token` 固定为内联布局，阻断 Tailwind `.table` 等工具类与运行时语法类冲突。 |
| 文件标签右键菜单 | 文件编辑器标签 + 现有关闭确认 | `FileEditorTabs` 只根据标签顺序计算目标路径并将其交给 `FileEditorPane`；Pane 复用现有未保存确认与 `fileExplorerStore.closeFile`，不触及 terminalStore。菜单复用终端 Tab 的 `terminal-skin` 与根终端主题变量，避免 Radix Portal 脱离文件编辑器祖先后回退到文件浏览器菜单皮肤。 |

## Data Flow

### 文件刷新

```text
App-mounted ProjectFileRefreshController
  ├─ local/WSL: project-files-changed → refreshVisibleState(changedPaths, background)
  ├─ local/WSL watcher 启动失败: 15 s → refreshVisibleState(undefined, background)
  ├─ SSH (remote context + open files): 15 s → refreshVisibleState(undefined, background)
  └─ focus / visible: immediate background refresh
       ↓
fileExplorerStore.refreshVisibleStateOnce
  ├─ list affected directories (local listDir / remote fileList)
  ├─ compare entry modifiedMs + sizeBytes
  ├─ clean open file → read latest content
  └─ dirty open file → retain draft and only refresh metadata
```

- Controller is mounted with `App`, so hiding/collapsing/unmounting `FileExplorerSidebar` cannot stop it.
- `FileExplorerSidebar` retains only its view-local `.gitignore` matcher invalidation listener; watcher start/stop, polling and state refresh ownership move out.
- Existing single-flight and changed-path coalescing remain the only refresh serialization mechanism.
- SSH automatic calls use `silent: true`; explicit list/open/search behavior retains progress reporting and retry behavior.

### Git Diff Markdown table rendering

```text
.md diff → detectLanguage("*.md") → Refractor Markdown tokens
  → span class="token table" inside .diff-code
  → Tailwind .table utility changes span layout
  → scoped .diff-code .token { display: inline } restores source-token flow
```

The fix is deliberately CSS-scoped to Diff code cells. It does not alter Markdown parsing, diff hunk boundaries, generated Git data, nor global Tailwind utilities. Syntax tokens are semantically inline fragments of one source-code line, so the explicit inline display is the root-boundary invariant rather than a one-table visual exception.

### 文件标签右键关闭

```text
right-click normal FileEditorTabs tab
  -> Close / Close Others / Close Left / Close Right
  -> ordered target paths (only normal open files)
  -> FileEditorPane checks target dirty paths once
      -> clean: fileExplorerStore.closeFile(path) for each target
      -> dirty: existing save/discard/cancel dialog
          -> save only dirty targets, then close targets
          -> discard closes targets
          -> cancel leaves every target intact
```

- The context menu is attached only to ordinary `ActiveProjectFile` tabs. Pinned Git Diff tabs retain their existing independent behavior and are never included in a close target list.
- `FileEditorTabs` owns ordering and disabled-state presentation (`others`, `left`, `right`); `FileEditorPane` owns draft safety and side effects. This preserves the store as the source of truth for active-file fallback and per-location editor workspaces.
- No filesystem, SSH, terminal, Workspan, or Git Diff transport action is initiated by a menu click. A save follows the pre-existing local/WSL permission path; SSH stays read-only.

## Compatibility and Safety

- No migration, new preference, i18n text, Rust command, or SSH Agent protocol version is required.
- SSH retains existing remote context validation, root confinement, read-only RPCs, bridge capability checks and no-local-fallback behavior.
- Automatic refresh runs only while a project has opened files for SSH; it coalesces overlap with focus/watcher events and does not replace dirty content.
- File deletion continues existing behavior: clean tabs may disappear; dirty tabs are retained as drafts.
- Git Diff remains a source-code renderer. The CSS reset applies to all Refractor token spans in its code cell so future token names cannot accidentally inherit Tailwind display utilities.
- Batch file close acts only on the visible location's file workspace. It preserves project/worktree/SSH identity and cannot close terminal sessions, pinned diffs, or files from another cached editor workspace.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Duplicate refresh triggers after moving lifecycle ownership | Centralize watcher/polling in one controller and use existing store single-flight/coalescing. |
| SSH polling spams remote-operation UI | Add explicit silent operation path only for automatic refresh. |
| SSH context changes during request | Preserve store’s project/context identity check before applying results. |
| Gitignore matcher no longer updates | Retain its lightweight sidebar event listener, decoupled from watcher ownership. |
| CSS token reset harms code syntax highlighting | Restrict it to `.diff-code .token`; verify Markdown and non-Markdown highlighting plus wrap/view modes. |
| Bulk tab close discards a draft unexpectedly | Centralize selected target paths and dirty-path confirmation in `FileEditorPane`; do not call `closeFile` before the user chooses Save or Discard. |
| File menu grows terminal-only behavior | Use a dedicated four-action file menu and file-specific i18n keys; do not reuse terminal Tab menu rendering or session actions. |

## Rollback

- Revert the new controller and restore the existing sidebar-owned lifecycle as one unit.
- Revert the scoped token-display rule independently if it has an unexpected syntax-highlighting interaction.
- Revert the `FileEditorTabs` context-menu binding and the corresponding Pane bulk-close request path as one unit; no persisted state or store migration needs rollback.
- No persisted state or remote protocol needs rollback.
