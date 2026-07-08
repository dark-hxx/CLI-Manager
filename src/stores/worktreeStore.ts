import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { getDb } from "../lib/db";
import { logWarn } from "../lib/logger";
import type { Project, TerminalSession, WorktreeIsolationStrategy, WorktreeRecord } from "../lib/types";
import { useProjectStore } from "./projectStore";
import { useTerminalStore } from "./terminalStore";

export interface GitWorktreeCreateResult {
  name: string;
  branch: string;
  path: string;
  baseBranch: string;
}

export interface GitWorktreeDepsCheckResult {
  needsInstall: boolean;
  command: string | null;
  reason: string | null;
}

export interface GitWorktreeMergeResult {
  merged: boolean;
  output: string;
  conflictFiles: string[];
  skipped: boolean;
  skipReason: string | null;
}

export type WorktreeIsolationDecision = "prompt" | "auto" | "none";

const RESERVED_WINDOWS_WORKTREE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
  "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);
const UNCONFIGURED_CLI_TOOL_VALUES = new Set(["none", "未选择"]);

const WORKTREE_SESSION_RELEASE_DELAY_MS = 350;

function waitForSessionRelease(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WORKTREE_SESSION_RELEASE_DELAY_MS));
}

interface ProjectGitValidationCacheEntry {
  key: string;
  valid: boolean;
}

interface WorktreeStore {
  worktrees: WorktreeRecord[];
  loaded: boolean;
  validatingProjects: Record<string, ProjectGitValidationCacheEntry>;
  loadWorktrees: () => Promise<void>;
  createWorktreeForProject: (project: Project, name?: string) => Promise<WorktreeRecord>;
  shouldIsolateNewSession: (
    project: Project,
    sessions: TerminalSession[]
  ) => WorktreeIsolationDecision;
  validateProjectGit: (project: Project) => Promise<boolean>;
  updateWorktreeProviderOverrides: (worktreeId: string, providerOverrides: string) => Promise<void>;
  checkDeps: (worktree: WorktreeRecord) => Promise<GitWorktreeDepsCheckResult>;
  dismissDepsPrompt: (worktreeId: string) => Promise<void>;
  mergeWorktree: (worktree: WorktreeRecord) => Promise<GitWorktreeMergeResult>;
  removeWorktree: (worktree: WorktreeRecord, deleteBranch: boolean) => Promise<void>;
  markMissingWorktrees: () => Promise<void>;
}

function normalizeStrategy(value: string | null | undefined): WorktreeIsolationStrategy {
  return value === "prompt" || value === "autoParallel" || value === "always" ? value : "disabled";
}

function isMissingWorktreesTableError(err: unknown): boolean {
  const message = String(err).toLowerCase();
  if (!message.includes("no such table: worktrees")) return false;
  return !(
    message.includes("migration") ||
    message.includes("checksum") ||
    message.includes("previously applied") ||
    message.includes("modified") ||
    message.includes("initialization") ||
    message.includes("init failed")
  );
}

function hasConfiguredCliTool(project: Project): boolean {
  const cliTool = project.cli_tool.trim().toLowerCase();
  return cliTool.length > 0 && !UNCONFIGURED_CLI_TOOL_VALUES.has(cliTool);
}

function hasSameProjectTerminalSession(projectId: string, sessions: TerminalSession[]): boolean {
  return sessions.some((session) => session.projectId === projectId && (session.kind ?? "pty") === "pty");
}

function createDefaultTaskName(existingNames: Set<string>): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const base = `task-${mm}${dd}-${hh}${min}`;
  if (!existingNames.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

export function createDefaultWorktreeTaskName(projectId: string): string {
  const existingNames = new Set(
    useWorktreeStore
      .getState()
      .worktrees.filter((worktree) => worktree.project_id === projectId)
      .map((worktree) => worktree.name)
  );
  return createDefaultTaskName(existingNames);
}

export function sanitizeWorktreeTaskName(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+/, "").slice(0, 64);
}

export function validateWorktreeTaskName(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(trimmed) && !RESERVED_WINDOWS_WORKTREE_NAMES.has(trimmed.toUpperCase());
}

function mapCreateResultToRecord(projectId: string, result: GitWorktreeCreateResult): WorktreeRecord {
  const ts = Date.now().toString();
  return {
    id: crypto.randomUUID(),
    project_id: projectId,
    name: result.name,
    branch: result.branch,
    path: result.path,
    base_branch: result.baseBranch,
    deps_prompt_dismissed: 0,
    provider_overrides: "{}",
    status: "active",
    created_at: ts,
    updated_at: ts,
  };
}

async function saveWorktreeRecord(record: WorktreeRecord): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO worktrees (id, project_id, name, branch, path, base_branch, deps_prompt_dismissed, provider_overrides, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      record.id,
      record.project_id,
      record.name,
      record.branch,
      record.path,
      record.base_branch,
      record.deps_prompt_dismissed,
      record.provider_overrides,
      record.status,
      record.created_at,
      record.updated_at,
    ]
  );
}

export const useWorktreeStore = create<WorktreeStore>((set, get) => ({
  worktrees: [],
  loaded: false,
  validatingProjects: {},

  loadWorktrees: async () => {
    const db = await getDb();
    try {
      const worktrees = await db.select<WorktreeRecord[]>("SELECT * FROM worktrees ORDER BY created_at DESC");
      set({ worktrees, loaded: true });
    } catch (err) {
      if (!isMissingWorktreesTableError(err)) throw err;
      logWarn("worktree table is not available yet", err);
      set({ worktrees: [], loaded: true });
    }
  },

  markMissingWorktrees: async () => {
    const active = get().worktrees.filter((worktree) => worktree.status === "active");
    if (active.length === 0) return;
    let exists: boolean[];
    try {
      exists = await invoke<boolean[]>("check_paths_exist", { paths: active.map((worktree) => worktree.path) });
    } catch {
      return;
    }
    const missingIds = active.filter((_, index) => !exists[index]).map((worktree) => worktree.id);
    if (missingIds.length === 0) return;
    const db = await getDb();
    const ts = Date.now().toString();
    for (const id of missingIds) {
      await db.execute("UPDATE worktrees SET status = $1, updated_at = $2 WHERE id = $3", ["missing", ts, id]);
    }
    await get().loadWorktrees();
    await useProjectStore.getState().fetchAll("startup");
  },

  createWorktreeForProject: async (project, name) => {
    const existingNames = new Set(
      get().worktrees
        .filter((worktree) => worktree.project_id === project.id)
        .map((worktree) => worktree.name)
    );
    const taskName = sanitizeWorktreeTaskName(name ?? createDefaultTaskName(existingNames));
    if (!validateWorktreeTaskName(taskName)) {
      throw new Error("task_name_invalid");
    }
    const result = await invoke<GitWorktreeCreateResult>("git_worktree_create", {
      req: {
        projectPath: project.path,
        taskName,
        worktreeRoot: project.worktree_root.trim() || null,
      },
    });
    const record = mapCreateResultToRecord(project.id, result);
    await saveWorktreeRecord(record);
    set((state) => ({ worktrees: [record, ...state.worktrees] }));
    await useProjectStore.getState().fetchAll("interactive");
    return record;
  },

  shouldIsolateNewSession: (project, sessions) => {
    const strategy = normalizeStrategy(project.worktree_strategy);
    if (strategy === "disabled") return "none";
    if (strategy === "always") return "auto";
    if (!hasConfiguredCliTool(project)) return "none";
    if (!hasSameProjectTerminalSession(project.id, sessions)) return "none";
    return strategy === "autoParallel" ? "auto" : "prompt";
  },

  validateProjectGit: async (project) => {
    const key = `${project.id}:${project.path}`;
    const cached = get().validatingProjects[project.id];
    if (cached?.key === key) return cached.valid;
    let valid = false;
    try {
      valid = await invoke<boolean>("git_worktree_validate", { projectPath: project.path });
    } catch {
      valid = false;
    }
    set((state) => ({
      validatingProjects: {
        ...state.validatingProjects,
        [project.id]: { key, valid },
      },
    }));
    return valid;
  },

  updateWorktreeProviderOverrides: async (worktreeId, providerOverrides) => {
    const db = await getDb();
    const ts = Date.now().toString();
    await db.execute("UPDATE worktrees SET provider_overrides = $1, updated_at = $2 WHERE id = $3", [
      providerOverrides,
      ts,
      worktreeId,
    ]);
    set((state) => ({
      worktrees: state.worktrees.map((worktree) =>
        worktree.id === worktreeId
          ? { ...worktree, provider_overrides: providerOverrides, updated_at: ts }
          : worktree
      ),
    }));
    await useProjectStore.getState().fetchAll("interactive");
    await useProjectStore.getState().cleanupUnusedCodexProfiles();
  },

  checkDeps: async (worktree) => {
    return invoke<GitWorktreeDepsCheckResult>("git_worktree_check_deps", { worktreePath: worktree.path });
  },

  dismissDepsPrompt: async (worktreeId) => {
    const ts = Date.now().toString();
    const db = await getDb();
    await db.execute("UPDATE worktrees SET deps_prompt_dismissed = 1, updated_at = $1 WHERE id = $2", [ts, worktreeId]);
    set((state) => ({
      worktrees: state.worktrees.map((worktree) =>
        worktree.id === worktreeId
          ? { ...worktree, deps_prompt_dismissed: 1, updated_at: ts }
          : worktree
      ),
    }));
    await useProjectStore.getState().fetchAll("interactive");
  },

  mergeWorktree: async (worktree) => {
    const project = useProjectStore.getState().projects.find((item) => item.id === worktree.project_id);
    if (!project) throw new Error("project_not_found");
    return invoke<GitWorktreeMergeResult>("git_worktree_merge", {
      projectPath: project.path,
      worktreeBranch: worktree.branch,
      baseBranch: worktree.base_branch,
    });
  },

  removeWorktree: async (worktree, deleteBranch) => {
    const project = useProjectStore.getState().projects.find((item) => item.id === worktree.project_id);
    if (!project) throw new Error("project_not_found");
    const terminalStore = useTerminalStore.getState();
    const linkedSessionIds = terminalStore.sessions
      .filter((session) => session.worktreeId === worktree.id)
      .map((session) => session.id);
    for (const sessionId of linkedSessionIds) {
      await terminalStore.closeSession(sessionId);
    }
    if (linkedSessionIds.length > 0) {
      await waitForSessionRelease();
    }
    await invoke<string>("git_worktree_remove", {
      projectPath: project.path,
      worktreePath: worktree.path,
      branch: worktree.branch,
      deleteBranch,
    });
    const db = await getDb();
    await db.execute("DELETE FROM worktrees WHERE id = $1", [worktree.id]);
    set((state) => ({ worktrees: state.worktrees.filter((item) => item.id !== worktree.id) }));
    await useProjectStore.getState().fetchAll("interactive");
  },
}));
