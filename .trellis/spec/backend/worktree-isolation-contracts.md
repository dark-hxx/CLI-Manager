# Worktree Isolation Contracts

> Executable contracts for Git worktree based parallel task isolation.

---

## Scenario: Git worktree parallel task isolation

### 1. Scope / Trigger

- Trigger: opening a project terminal for a CLI-configured project while another same-project terminal is already open can make two CLI/AI tasks modify the same checkout.
- This is a cross-layer contract because SQLite migrations, Tauri Git commands, Zustand stores, terminal tab metadata, project tree UI, and Git cleanup all participate in one lifecycle.
- The feature creates an isolated Git worktree, opens PTY sessions inside it, then guides commit → merge → cleanup.

### 2. Signatures

#### Database schema

```sql
ALTER TABLE projects ADD COLUMN worktree_strategy TEXT NOT NULL DEFAULT 'disabled';
ALTER TABLE projects ADD COLUMN worktree_root TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN worktree_deps_prompt_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS worktrees (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  branch                TEXT NOT NULL,
  path                  TEXT NOT NULL,
  base_branch           TEXT NOT NULL DEFAULT '',
  deps_prompt_dismissed INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
```

Allowed project strategies:

```ts
type WorktreeIsolationStrategy = "prompt" | "disabled" | "autoParallel" | "always";

interface Settings {
  projectWorktreeConfigEnabled: boolean; // defaults to true
}
```

#### Backend commands

```rust
#[tauri::command]
pub async fn git_worktree_validate(project_path: String) -> Result<bool, String>

#[tauri::command]
pub async fn git_worktree_create(
    project_path: String,
    task_name: String,
    worktree_root: Option<String>,
) -> Result<GitWorktreeCreateResult, String>

#[tauri::command]
pub async fn git_worktree_check_deps(
    worktree_path: String,
) -> Result<GitWorktreeDepsCheckResult, String>

#[tauri::command]
pub async fn git_worktree_merge(
    project_path: String,
    branch: String,
    base_branch: String,
) -> Result<GitWorktreeMergeResult, String>

#[tauri::command]
pub async fn git_worktree_remove(
    project_path: String,
    worktree_path: String,
    branch: String,
    delete_branch: bool,
) -> Result<String, String>
```

Response payloads are camelCase for the WebView boundary:

```ts
interface GitWorktreeCreateResult {
  name: string;
  branch: string;      // must be wt/<name>
  path: string;
  baseBranch: string;
}

interface GitWorktreeDepsCheckResult {
  needsInstall: boolean;
  command: string | null;
  reason: string | null;
}

interface GitWorktreeMergeResult {
  merged: boolean;
  output: string;
  conflictFiles: string[];
  skipped: boolean;
  skipReason: string | null;
}
```

#### Frontend records

```ts
interface WorktreeRecord {
  id: string;
  project_id: string;
  name: string;
  branch: string;
  path: string;
  base_branch: string;
  deps_prompt_dismissed: number;
  status: "active" | "missing";
  created_at: string;
  updated_at: string;
}

interface TerminalSession {
  worktreeId?: string;
}

type TreeNode =
  | { type: "group"; group: Group; children: TreeNode[] }
  | { type: "project"; project: Project; worktrees?: WorktreeRecord[] }
  | { type: "worktree"; project: Project; worktree: WorktreeRecord };
```

### 3. Contracts

#### Isolation strategy

- `settingsStore.projectWorktreeConfigEnabled=false` is a global frontend gate. Project create/edit forms hide the Worktree configuration section, and normal/split project launches must return the equivalent of strategy `disabled` before Git validation, prompts, or automatic creation.
- The global gate does not erase project Worktree fields, delete existing Worktree records, hide existing Worktree tree entries, or disable explicit manual Worktree actions.

| Strategy | Required behavior |
|---|---|
| `prompt` | If the project has a configured CLI tool and at least one existing same-project terminal session, ask whether to open in an isolated worktree. Direct-open must preserve legacy behavior. |
| `disabled` | Default. Do nothing. Always open a normal project terminal; never prompt and never auto-create a worktree, regardless of CLI tool configuration or existing same-project sessions. |
| `autoParallel` | If the project has a configured CLI tool and at least one existing same-project terminal session, create a worktree without prompting. The first session opens normally. |
| `always` | Every project terminal launch creates a worktree. This strategy still only applies to local Git projects that support `git worktree`; non-Git/WSL projects open normally. |

- `disabled` must short-circuit before Git validation and preserve pre-worktree behavior exactly.
- `prompt` / `autoParallel` must not depend on visible tab runtime state, `running` notifications, startup commands such as `npm run dev`, or shell process liveness.
- A project counts as CLI-configured when `projects.cli_tool` is non-empty and not a sentinel unconfigured value such as `none` / `未选择`.
- Existing same-project sessions should be open PTY terminal sessions for the same `projectId`; pseudo-tabs such as file editors or subagent transcript views must not trigger isolation.
- Non-Git projects and unsupported WSL/remote paths must not trigger prompts or automatic worktree creation.
- Split-terminal project launches must use the same isolation decision path as normal launches.

#### Worktree creation

- The frontend may propose a task name, but Rust is the authority for validation and path construction.
- Task names must be non-empty, 1..64 chars, only ASCII letters/digits/`-`/`_`, not start with `-`, and not be Windows reserved device names (`CON`, `NUL`, `COM1`, `LPT1`, etc.).
- Branch names must be `wt/<taskName>` and pass Git-safe validation.
- Default path is under a sibling worktree root (`<project-parent>/<project-name>-worktrees/<taskName>`). A custom root may only be used as a root; the task name is still appended by Rust.
- Git commands must be executed with argument arrays (`Command::new("git").args([...])`), never through shell string concatenation.
- Windows extended-length path prefixes (`\\?\` / `//?/`) must be stripped before passing paths to `git worktree add/remove`; Git CLI receives normal local paths only.
- WSL / UNC / remote paths remain unsupported and must be rejected before appending the task name or executing Git.
- If `git worktree add -b wt/<task>` fails after creating the branch, cleanup may delete only a branch that did not exist before the add attempt and still validates as a `wt/` worktree branch. Never delete non-`wt/` branches.
- While a Worktree create request for the same project path, worktree root, and task name is in flight, the frontend must not invoke `git_worktree_create` again. Duplicate triggers must fail locally with `worktree_create_in_progress` and release the guard on both success and failure.
- A failed `git_worktree_create` response must preserve the final Git error tail. Checkout progress prefixes may be normalized or truncated only after the terminal `fatal`/`error` text remains available to the frontend.

#### Dependency prompt

- Dependency install detection is advisory only. It must not block opening the actual task terminal.
- Automatic dependency install detection is gated by the project-level `worktree_deps_prompt_enabled` flag, which defaults to off for new and existing projects.
- Manual "Install dependencies" actions may still run dependency detection regardless of the automatic prompt flag.
- If dependency install is accepted, create a separate install tab in the worktree path. Do not write the install command into the original task tab.
- Dismissing/skipping the dependency prompt sets `deps_prompt_dismissed` for that worktree, so the same worktree does not repeatedly prompt.
- Once the expected dependency directory exists (`node_modules`, etc.), the detection condition self-heals and should not prompt.

#### Finish task lifecycle

- MVP finish flow commits all worktree changes, merges the worktree branch back into the base branch, then removes the worktree and optionally deletes the branch.
- Before merge, the main project checkout must be clean. Dirty main checkout returns a stable error and performs no Git mutation.
- The merge command receives both `branch` and `baseBranch`; if the checkout is clean but not on the base branch, it may checkout the base branch before merging.
- If the worktree branch and base branch have no content diff, the merge command must return `skipped=true` / `skipReason="no_diff"` and avoid checkout/merge mutation. The frontend should present this as "merge not needed" and still allow cleanup.
- Merge conflicts must be detected, conflict files returned, and `merge --abort` executed immediately. Do not leave the main checkout in a half-merged state.
- Stable backend error codes such as `dirty_main_worktree` are for the frontend contract, not end-user copy. The finish-task dialog must map dirty-main and merge-conflict states to readable guidance that says what happened, whether Git mutated the main checkout, and what the user should do next.
- Cleanup may delete a non-empty directory only when `git worktree list --porcelain` still records the same path and branch. If Git records the path/branch but `git worktree remove --force` reports a stale checkout such as `is not a working tree` or missing `.git`, the backend may remove that registered path, run `git worktree prune`, and then delete the `wt/` branch.
- Branch deletion is allowed only for `wt/` branches and only after explicit UI confirmation or successful finish flow.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| `project_path` missing or not a Git repo | Return `path_not_found` / `open_repo_failed`; frontend opens normally only when validation says false. |
| WSL UNC path or unsupported remote path | Return `unsupported_wsl`; no prompt/auto isolation. |
| `projectWorktreeConfigEnabled=false` | Open the project directly; do not validate Git, prompt, or auto-create a Worktree. Preserve stored project Worktree fields. |
| Invalid task name | Return `invalid_task_name`; no directory or branch is created. |
| Branch already exists | Return Git failure; frontend asks for a different name or auto-generates a collision suffix. |
| Same project/root/task creation already in flight | Return `worktree_create_in_progress` locally; do not issue another Git command or show an unhandled Promise rejection. |
| Worktree path already exists | Return `worktree_path_exists`; frontend must not reuse silently. |
| Main checkout dirty before merge | Return `dirty_main_worktree`; no checkout/merge happens. |
| Worktree branch has no content diff from base branch | Return skipped `no_diff`; no checkout/merge happens; cleanup remains available. |
| Merge branch missing | Return `branch_not_found`; no cleanup happens automatically. |
| Merge conflict | Return conflict error with `conflictFiles`, run `merge --abort`, keep worktree record. |
| Frontend receives `dirty_main_worktree` | Show human-readable text: main worktree has uncommitted changes, no merge ran, the Worktree commit is still safe, and the user should clean/commit/stash the main checkout before retrying. |
| Frontend receives merge conflict result | Show human-readable text: merge was aborted automatically, main checkout returned to pre-merge state, and list `conflictFiles` when present. |
| Remove path not listed in `git worktree list --porcelain` and path is non-empty | Return `worktree_not_registered`; do not delete filesystem path. |
| Remove path not listed in `git worktree list --porcelain` and path is empty | Remove the empty stale directory and delete the requested `wt/` branch only when requested. |
| Remove path listed with matching branch but Git reports missing `.git` / `is not a working tree` | Treat as registered stale worktree: remove the registered directory, run `worktree prune`, and delete the requested `wt/` branch only when requested. |
| Remove path branch mismatch | Return `worktree_branch_mismatch`; do not delete worktree or branch. |
| Delete branch requested for non-`wt/` branch | Return `invalid_branch`; do not delete branch. |

### 5. Good/Base/Bad Cases

- Good: Project A has `cli_tool=codex` and one existing open Project A terminal. Opening another Project A terminal under `prompt` shows a worktree prompt; choosing isolate creates `wt/task-*`, opens the new PTY in that path, and displays a tab badge.
- Good: A fast double-click or simultaneous auto/manual trigger for the same task produces one Git create request; the duplicate is ignored while the first request completes.
- Base: Project A has `worktree_strategy=disabled`. Opening a terminal uses the original project path and existing startup command behavior, even when a CLI tool and same-project terminal already exist.
- Base: global Worktree configuration is disabled while Project A stores `worktree_strategy=prompt` or `always`. Normal and split launches open directly, the project form hides Worktree controls, and the stored strategy remains unchanged.
- Base: Project A has `cli_tool=codex` but no existing same-project terminals. Under `autoParallel`, opening a terminal uses the original project path and existing startup command behavior.
- Base: Project A has no configured CLI tool. Ordinary shell/startup-command terminals never trigger `prompt` or `autoParallel` just because a prior tab exists or a command is running.
- Base: Project A has `worktree_deps_prompt_enabled=0`. Creating/opening a worktree skips automatic dependency detection and never shows the dependency prompt.
- Base: Dependency prompt is dismissed. The worktree opens normally and the same worktree does not prompt again.
- Bad: Writing `npm install` into the original task terminal. This can corrupt the user’s CLI session and is forbidden.
- Bad: Calling `git merge` while the main checkout has uncommitted changes. This mixes unrelated work and must be blocked.
- Bad: Rendering `dirty_main_worktree` or `merge_conflict` raw in the dialog. The codes are correct transport values but not actionable user guidance.
- Bad: Deleting a path passed from the frontend without confirming it is a registered Git worktree. This is a high-risk filesystem deletion and is forbidden.
- Bad: Returning only the first 300 characters of Git output when checkout progress occupies that prefix; the actual fatal cause becomes invisible and cannot be diagnosed.

### 6. Tests Required

- Rust unit tests:
  - task-name validation accepts safe names and rejects empty, whitespace/control, path separators, leading `-`, and Windows reserved device names.
  - default worktree path calculation keeps the task name under the computed root.
  - dependency detection returns the expected command for npm/pnpm/yarn fixtures and no prompt when dependency directories exist.
  - stale worktree directory cleanup retries transient Windows file-lock errors such as `os error 32`.
  - remove/merge helpers reject non-`wt/` branches and branch/path mismatches where feasible.
  - create error formatting keeps a final `fatal`/`error` line after long checkout progress.
- Frontend static checks:
  - `npx tsc --noEmit` must pass after adding `WorktreeRecord`, `TreeNode` union changes, and `TerminalSession.worktreeId`.
  - new project defaults keep `worktree_strategy="disabled"` and `worktree_deps_prompt_enabled=0`.
  - global Worktree configuration disabled gates both normal project opening and split-project opening before `shouldIsolateNewSession` can trigger prompt/auto behavior.
- Rust checks:
  - `cargo check --manifest-path src-tauri/Cargo.toml`.
  - `cargo test --manifest-path src-tauri/Cargo.toml`.
- Manual desktop checks:
  - prompt / disabled / autoParallel / always strategy behavior.
  - split-project launch uses the same isolation decision.
  - automatic dependency detection runs only when the project-level dependency prompt flag is enabled.
  - manual dependency install opens a new tab and original startup command still runs in the task tab regardless of the automatic prompt flag.
  - finish flow succeeds for clean merge and removes worktree/branch.
  - dirty main checkout blocks merge.
  - conflict merge aborts and leaves main checkout clean.

### 7. Wrong vs Correct

#### Wrong

```ts
// Couples worktree isolation to visible runtime state or startup commands.
const busy = isTabVisiblyRunning(session.id) || project.startup_cmd.includes("npm run dev");
```

#### Correct

```ts
// prompt / autoParallel depend on CLI configuration plus an existing same-project PTY session.
const hasCliTool = project.cli_tool.trim() !== "" && project.cli_tool.trim().toLowerCase() !== "none";
const hasSameProjectTerminal = sessions.some((session) => session.projectId === project.id && (session.kind ?? "pty") === "pty");
```

#### Wrong

```rust
// Shell string interpolation allows argument injection.
Command::new("sh").arg("-c").arg(format!("git worktree remove {}", worktree_path));
```

#### Correct

```rust
// Arguments are passed directly, not parsed by a shell.
Command::new("git")
    .current_dir(project_path)
    .args(["worktree", "remove", worktree_path])
    .output()?;
```

#### Wrong

```ts
// Pollutes the user's original AI/CLI session.
await invoke("pty_write", { sessionId: originalTaskSessionId, data: "npm install\r" });
```

#### Correct

```ts
// Create a separate install terminal in the same worktree path.
await createSession(project.id, worktree.path, `Install deps: ${worktree.name}`, installCommand, envVars, shell);
```
