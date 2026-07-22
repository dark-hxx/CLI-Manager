import type { CreateProjectInput, Project, TerminalSession } from "./types";
import { detectCliResumeKind } from "../stores/terminalStore";
import { stripResumeCliArgs } from "./resumeCliArgs";

/**
 * Validate a CLI session id per resolveResumeCommand contract in
 * externalSessionSyncStore.ts:279-283: trimmed non-empty, no whitespace,
 * no CR/LF. Returns the trimmed id, or null when invalid.
 */
function normalizeSessionId(sessionId: string): string | null {
  const trimmed = sessionId.trim();
  if (!trimmed) return null;
  if (/\s/.test(trimmed) || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

// WSL wrapper detection: matches `wsl` or `wsl.exe` as its own token at the
// head of a command (or after a leading space). Used to preserve the wrapper
// when we rewrite a startup_cmd-driven source into a resume startup_cmd, so
// `wsl claude ...` sources still enter WSL after save.
const WSL_WRAPPER_PATTERN = /(?:^|\s)wsl(?:\.exe)?\s/i;

/**
 * Build the resume-form startup command that replaces a startup_cmd-driven
 * source's launch when saving to sidebar. Mirrors buildCliResumeStartupCommand
 * in terminalStore.ts (~970) but always has a valid session id (callers gate
 * on normalizeSessionId first) and preserves any leading `wsl `/`wsl.exe `
 * wrapper so WSL-wrapped sources still enter WSL after save. All other free-
 * text extras from the source startup_cmd (custom flags, one-shot prompts,
 * `--settings ...`) are intentionally dropped: startup_cmd is unstructured
 * free text with no safe splitter (see comment at projectStartupCommand.ts
 * :107), and re-appending arbitrary extras could re-inject a one-shot prompt
 * on every resume.
 */
function buildResumeStartupCmd(
  kind: "claude" | "codex",
  id: string,
  sourceStartupCmd: string,
): string {
  const resumeCore = kind === "codex"
    ? `codex resume --no-alt-screen ${id}`
    : `claude --resume ${id}`;
  return WSL_WRAPPER_PATTERN.test(sourceStartupCmd) ? `wsl ${resumeCore}` : resumeCore;
}

/**
 * Build the `cli_args` string for a saved-session project.
 *
 * Contract (mirrors resolveResumeCommand in externalSessionSyncStore.ts:282):
 * - `claude` → `<sourceCliArgs trimmed> --resume <id>`
 * - `codex`  → `<sourceCliArgs trimmed> resume --no-alt-screen <id>`
 *
 * Pre-existing resume fragments in `sourceCliArgs` are stripped first so
 * re-saving a saved session does not double-append. Invalid session ids
 * (empty, whitespace-containing, CR/LF-containing) return null.
 */
export function buildResumeCliArgs(
  kind: "claude" | "codex",
  sourceCliArgs: string,
  sessionId: string,
): string | null {
  const id = normalizeSessionId(sessionId);
  if (!id) return null;
  const base = stripResumeCliArgs(sourceCliArgs);
  const suffix = kind === "codex" ? ` resume --no-alt-screen ${id}` : ` --resume ${id}`;
  return `${base}${suffix}`;
}

/**
 * True iff `session` carries a valid cliSessionId AND we can resolve a
 * CLI resume kind (`claude` | `codex`) from the session's startup command
 * / owning project. When false, the "save to sidebar" affordance must be
 * disabled — createProject would either fail validation or produce a
 * useless entry.
 */
export function canSaveSessionToSidebar(
  session: TerminalSession,
  project: Project | null,
): boolean {
  if (!normalizeSessionId(session.cliSessionId ?? "")) return false;
  const kind = detectCliResumeKind(
    project?.startup_cmd ?? session.startupCmd,
    project ?? undefined,
  );
  return kind !== null;
}

/**
 * Reason codes for buildSavedSessionProjectInput failure. Callers surface
 * these to the user via i18n keys `saveSession.reason.*` so the failure
 * toast description explains *why* the save was aborted instead of just
 * showing a generic "Failed to save session" line. Kept as a string literal
 * union rather than an enum to stay tsc --noEmit-clean without extra runtime.
 */
export type BuildSavedSessionFailureReason =
  | "no_kind"
  | "no_session_id"
  | "no_path";

export type BuildSavedSessionResult =
  | { ok: true; input: CreateProjectInput }
  | { ok: false; reason: BuildSavedSessionFailureReason };

/**
 * Build a CreateProjectInput describing "save this live session as a
 * sidebar project". The new project inherits every field the parent
 * project already carries (group, env, shell, provider overrides, worktree
 * config, ssh location) so createProject validation passes on SSH sources
 * and reruns behave identically.
 *
 * Field-mapping branch on how the source project drives its CLI, because the
 * sidebar launch path (resolveProjectStartupCommand in projectStartupCommand
 * .ts:87-104) returns a non-empty `startup_cmd` early and never reads
 * `cli_args`:
 *  - cli_tool-driven source (project?.startup_cmd empty): the saved row
 *    keeps startup_cmd="" and launches via cli_tool + resume-appended
 *    cli_args. This is the common case.
 *  - startup_cmd-driven source (project?.startup_cmd non-empty, incl.
 *    'claude', 'claude --settings ...', 'wsl claude', 'wsl codex'): the
 *    saved row's startup_cmd is REWRITTEN to a resume command (mirroring
 *    buildCliResumeStartupCommand in terminalStore.ts). A leading `wsl `/
 *    `wsl.exe ` wrapper is preserved so WSL-launched sources still enter
 *    WSL. Other free-text extras (custom flags, one-shot prompts,
 *    `--settings ...`) are intentionally DROPPED — startup_cmd is
 *    unstructured free text with no safe splitter (comment at
 *    projectStartupCommand.ts:107), and re-appending arbitrary extras could
 *    re-inject a one-shot prompt on every resume. cli_args still receives
 *    the resume fragment for symmetry (harmless: ignored when startup_cmd
 *    non-empty).
 *
 * Returns a discriminated result. `{ ok: false, reason }` cases:
 * - `no_kind`: `detectCliResumeKind` cannot decide claude vs codex (no way
 *   to resume).
 * - `no_session_id`: the session id is missing / whitespace / CR-LF (per
 *   resolveResumeCommand contract in externalSessionSyncStore.ts:279-283).
 * - `no_path`: the resulting `path` would be empty (createProject requires
 *   a path for non-ssh projects, and even for ssh we prefer a non-empty
 *   display path).
 */
export function buildSavedSessionProjectInput(args: {
  name: string;
  session: TerminalSession;
  project: Project | null;
}): BuildSavedSessionResult {
  const { name, session, project } = args;

  const kind = detectCliResumeKind(
    project?.startup_cmd ?? session.startupCmd,
    project ?? undefined,
  );
  if (!kind) return { ok: false, reason: "no_kind" };

  const normalizedId = normalizeSessionId(session.cliSessionId ?? "");
  if (!normalizedId) return { ok: false, reason: "no_session_id" };

  const resumeCliArgs = buildResumeCliArgs(
    kind,
    project?.cli_args ?? "",
    session.cliSessionId ?? "",
  );
  // Defensive: buildResumeCliArgs re-validates the id and can only return
  // null when normalizeSessionId would have failed above, so this branch is
  // unreachable in practice. Guard preserved for type safety.
  if (resumeCliArgs === null) return { ok: false, reason: "no_session_id" };

  const path = session.cwd?.trim() || project?.path || "";
  if (!path) return { ok: false, reason: "no_path" };

  const sourceStartupCmd = project?.startup_cmd ?? "";
  const savedStartupCmd = sourceStartupCmd.trim()
    ? buildResumeStartupCmd(kind, normalizedId, sourceStartupCmd)
    : "";

  const input: CreateProjectInput = {
    name,
    path,
    group_id: project?.group_id ?? null,
    group_name: project?.group_name ?? "",
    cli_tool: (project?.cli_tool && project.cli_tool.length > 0) ? project.cli_tool : kind,
    cli_args: resumeCliArgs,
    startup_cmd: savedStartupCmd,
    env_vars: project?.env_vars ?? "{}",
    shell: project?.shell ?? session.shell ?? "",
    provider_overrides: project?.provider_overrides ?? "{}",
  };

  if (project?.worktree_strategy !== undefined) {
    input.worktree_strategy = project.worktree_strategy;
  }
  if (project?.worktree_root !== undefined) {
    input.worktree_root = project.worktree_root;
  }
  if (project?.worktree_deps_prompt_enabled !== undefined) {
    input.worktree_deps_prompt_enabled = project.worktree_deps_prompt_enabled;
  }
  if (project?.environment_type !== undefined) {
    input.environment_type = project.environment_type;
  }
  if (project?.ssh_host_id !== undefined) {
    input.ssh_host_id = project.ssh_host_id;
  }
  if (project?.remote_path !== undefined) {
    input.remote_path = project.remote_path;
  }

  return { ok: true, input };
}
