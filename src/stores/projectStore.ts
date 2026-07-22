import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getDb, batchUpdateSortOrder, batchUpdateProjectShell as dbBatchUpdateProjectShell } from "../lib/db";
import { resolveProjectFetchPolicy, type ProjectFetchReason } from "../lib/projectLoadPolicy";
import { useSettingsStore } from "./settingsStore";
import { logWarn } from "../lib/logger";
import { getClaudeProviderOverride, getCodexProviderOverride, getProviderSwitchAppType } from "../lib/providerSwitching";
import { defaultShellForOs, getOsPlatform, normalizeShellForOs, normalizeShellKey } from "../lib/shell";
import { projectSupportsCapability } from "../lib/projectCapabilities";
import { validateSshToolConfigRoot } from "../lib/sshToolIntegration";
import type {
  Project, CreateProjectInput, UpdateProjectInput,
  Group, CreateGroupInput, TreeNode, WorktreeRecord,
} from "../lib/types";

let inflightFetchAll: Promise<void> | null = null;
let providerBadgeRefreshSeq = 0;

interface CcSwitchProjectBadge {
  path: string;
  hasOverride: boolean;
  providerName: string | null;
  vendorHint: string | null;
}

interface CodexProfileCleanupResult {
  deletedProfileNames: string[];
}

export interface ProviderBadge {
  /** 匹配到的 cc-switch 供应商名；null 表示有覆盖但未匹配到（自定义配置） */
  providerName: string | null;
  vendorHint?: string | null;
}

interface ProjectStore {
  projects: Project[];
  groups: Group[];
  worktrees: WorktreeRecord[];
  tree: TreeNode[];
  loaded: boolean;
  searchQuery: string;
  projectHealth: Record<string, boolean>;
  /** 仅含存在项目级供应商覆盖的项目，key 为 project.id */
  providerBadges: Record<string, ProviderBadge>;
  setSearchQuery: (q: string) => void;
  fetchAll: (reason?: ProjectFetchReason) => Promise<void>;
  fetchProjects: () => Promise<void>;
  fetchGroups: () => Promise<void>;
  refreshProjectDiagnostics: () => Promise<void>;
  refreshProviderBadges: () => Promise<void>;
  cleanupUnusedCodexProfiles: () => Promise<void>;
  createProject: (input: CreateProjectInput) => Promise<Project>;
  updateProject: (id: string, input: UpdateProjectInput) => Promise<void>;
  batchUpdateProjectShell: (ids: string[], shell: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  createGroup: (input: CreateGroupInput) => Promise<Group>;
  renameGroup: (id: string, name: string) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  reorderItems: (parentId: string | null, orderedIds: string[]) => Promise<void>;
  moveProjectToGroup: (projectId: string, targetGroupId: string | null) => Promise<void>;
  moveGroupToParent: (groupId: string, targetParentId: string | null) => Promise<void>;
}

function buildTree(groups: Group[], projects: Project[], search: string, worktrees: WorktreeRecord[] = []): TreeNode[] {
  const lowerSearch = search.toLowerCase();
  const matchingProjects = search
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(lowerSearch) ||
          p.cli_tool.toLowerCase().includes(lowerSearch) ||
          worktrees.some((worktree) =>
            worktree.project_id === p.id &&
            (worktree.name.toLowerCase().includes(lowerSearch) || worktree.branch.toLowerCase().includes(lowerSearch))
          )
      )
    : projects;

  const groupMap = new Map<string, Group>(groups.map((g) => [g.id, g]));
  const childGroups = new Map<string | null, Group[]>();
  const groupProjects = new Map<string | null, Project[]>();
  const worktreesByProject = new Map<string, WorktreeRecord[]>();
  for (const worktree of worktrees) {
    const arr = worktreesByProject.get(worktree.project_id) ?? [];
    arr.push(worktree);
    worktreesByProject.set(worktree.project_id, arr);
  }

  for (const g of groups) {
    const key = g.parent_id;
    const arr = childGroups.get(key) ?? [];
    arr.push(g);
    childGroups.set(key, arr);
  }

  for (const p of matchingProjects) {
    const key = p.group_id;
    const arr = groupProjects.get(key) ?? [];
    arr.push(p);
    groupProjects.set(key, arr);
  }

  // When searching, collect all group IDs that have matching projects (or ancestors thereof)
  const visibleGroupIds = new Set<string>();
  if (search) {
    for (const p of matchingProjects) {
      let gid = p.group_id;
      while (gid) {
        if (visibleGroupIds.has(gid)) break;
        visibleGroupIds.add(gid);
        gid = groupMap.get(gid)?.parent_id ?? null;
      }
    }
  }

  function buildLevel(parentId: string | null): TreeNode[] {
    const nodes: TreeNode[] = [];

    const subGroups = (childGroups.get(parentId) ?? []).sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    );

    for (const g of subGroups) {
      if (search && !visibleGroupIds.has(g.id)) continue;
      const children = buildLevel(g.id);
      nodes.push({ type: "group", group: g, children });
    }

    const projs = (groupProjects.get(parentId) ?? []).sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    );
    for (const p of projs) {
      const projectWorktrees = (worktreesByProject.get(p.id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      nodes.push({ type: "project", project: p, worktrees: projectWorktrees });
    }

    return nodes;
  }

  return buildLevel(null);
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

async function selectWorktreesOrEmpty(db: Awaited<ReturnType<typeof getDb>>): Promise<WorktreeRecord[]> {
  try {
    return await db.select<WorktreeRecord[]>("SELECT * FROM worktrees ORDER BY created_at DESC");
  } catch (err) {
    if (!isMissingWorktreesTableError(err)) throw err;
    logWarn("worktree table is not available yet", err);
    return [];
  }
}

function collectActiveCodexProfileNames(projects: Project[], worktrees: WorktreeRecord[] = []): string[] {
  const profileNames = new Set<string>();
  for (const project of projects) {
    if (getProviderSwitchAppType(project) !== "codex") continue;
    const override = getCodexProviderOverride(project);
    if (override?.profileName) {
      profileNames.add(override.profileName);
    }
  }
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  for (const worktree of worktrees) {
    const project = projectsById.get(worktree.project_id);
    if (!project || getProviderSwitchAppType(project) !== "codex") continue;
    const override = getCodexProviderOverride(worktree);
    if (override?.profileName) {
      profileNames.add(override.profileName);
    }
  }
  return Array.from(profileNames);
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  groups: [],
  worktrees: [],
  tree: [],
  loaded: false,
  searchQuery: "",
  projectHealth: {},
  providerBadges: {},

  setSearchQuery: (q) => {
    set({ searchQuery: q });
    const { groups, projects, worktrees } = get();
    set({ tree: buildTree(groups, projects, q, worktrees) });
  },

  fetchAll: async (reason = "interactive") => {
    if (inflightFetchAll) return inflightFetchAll;
    inflightFetchAll = (async () => {
      try {
        const policy = resolveProjectFetchPolicy(reason);
        const db = await getDb();
        const [groups, projects, worktrees] = await Promise.all([
          db.select<Group[]>("SELECT * FROM groups ORDER BY sort_order, name"),
          db.select<Project[]>("SELECT * FROM projects ORDER BY sort_order, name"),
          selectWorktreesOrEmpty(db),
        ]);
        // Path health check
        let projectHealth = get().projectHealth;
        if (policy.includePathHealth && projects.length > 0) {
          try {
            const localProjects = projects.filter((project) => project.environment_type !== "ssh");
            const paths = localProjects.map((project) => project.path);
            const results = await invoke<boolean[]>("check_paths_exist", { paths });
            const health: Record<string, boolean> = {};
            localProjects.forEach((project, index) => { health[project.id] = results[index]; });
            projectHealth = health;
          } catch { /* ignore */ }
        }

        const tree = buildTree(groups, projects, get().searchQuery, worktrees);
        set({ groups, projects, worktrees, tree, projectHealth, loaded: true });
        if (policy.refreshProviderBadges) {
          // 供应商徽标刷新不阻塞项目树加载，失败也静默
          void get().refreshProviderBadges();
        }
      } finally {
        inflightFetchAll = null;
      }
    })();
    return inflightFetchAll;
  },

  refreshProjectDiagnostics: async () => {
    const projects = get().projects;
    if (projects.length > 0) {
      try {
        const localProjects = projects.filter((project) => project.environment_type !== "ssh");
        const paths = localProjects.map((project) => project.path);
        const results = await invoke<boolean[]>("check_paths_exist", { paths });
        const projectHealth: Record<string, boolean> = {};
        localProjects.forEach((project, index) => {
          projectHealth[project.id] = results[index];
        });
        set({ projectHealth });
      } catch {
        // ignore diagnostics refresh failures
      }
    }

    await get().refreshProviderBadges();
  },

  refreshProviderBadges: async () => {
    const refreshSeq = ++providerBadgeRefreshSeq;
    const projects = get().projects;
    const providerProjects = projects.filter((project) => projectSupportsCapability(project, "providerSwitch"));
    const worktrees = get().worktrees;
    const claudeProjects = providerProjects.filter((p) => getProviderSwitchAppType(p) === "claude");
    const codexProjects = providerProjects.filter((p) => getProviderSwitchAppType(p) === "codex");
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const providerBadges: Record<string, ProviderBadge> = {};

    for (const project of codexProjects) {
      const override = getCodexProviderOverride(project);
      if (override) {
        providerBadges[project.id] = {
          providerName: override.providerName,
          vendorHint: override.vendorHint,
        };
      }
    }

    for (const project of claudeProjects) {
      const override = getClaudeProviderOverride(project);
      if (override) {
        providerBadges[project.id] = {
          providerName: override.providerName,
          vendorHint: override.vendorHint,
        };
      }
    }

    for (const worktree of worktrees) {
      const project = projectsById.get(worktree.project_id);
      if (!project) continue;
      const appType = getProviderSwitchAppType(project);
      const override = appType === "codex"
        ? getCodexProviderOverride(worktree)
        : appType === "claude"
          ? getClaudeProviderOverride(worktree)
          : null;
      if (override) {
        providerBadges[`wt:${worktree.id}`] = {
          providerName: override.providerName,
          vendorHint: override.vendorHint,
        };
      }
    }

    const legacyClaudeProjects = claudeProjects.filter((project) => !getClaudeProviderOverride(project));
    if (legacyClaudeProjects.length > 0) {
      try {
        const badges = await invoke<CcSwitchProjectBadge[]>("ccswitch_probe_projects", {
          projectPaths: legacyClaudeProjects.map((p) => p.path),
          dbPath: useSettingsStore.getState().ccSwitchDbPath ?? undefined,
        });
        const byPath = new Map(badges.map((b) => [b.path, b]));
        for (const p of legacyClaudeProjects) {
          const badge = byPath.get(p.path);
          if (badge?.hasOverride) {
            providerBadges[p.id] = {
              providerName: badge.providerName,
              vendorHint: badge.vendorHint,
            };
          }
        }
      } catch (err) {
        // db 不存在等任何失败：静默清空 claude 徽标，绝不打扰用户；codex 本地覆盖仍保留
        logWarn("ccswitch probe projects failed", err);
      }
    }

    if (refreshSeq === providerBadgeRefreshSeq) {
      set({ providerBadges });
    }
  },

  cleanupUnusedCodexProfiles: async () => {
    try {
      await invoke<CodexProfileCleanupResult>("ccswitch_cleanup_codex_profiles", {
        keepProfileNames: collectActiveCodexProfileNames(get().projects, get().worktrees),
        codexConfigDir: useSettingsStore.getState().codexHookConfigDir ?? undefined,
      });
    } catch (err) {
      logWarn("ccswitch cleanup codex profiles failed", err);
    }
  },

  fetchProjects: async () => {
    await get().fetchAll();
  },

  fetchGroups: async () => {
    await get().fetchAll();
  },

  createProject: async (input) => {
    const db = await getDb();
    const id = crypto.randomUUID();
    const ts = Date.now().toString();
    const os = await getOsPlatform();
    const isSshProject = input.environment_type === "ssh";
    if (isSshProject && (!input.ssh_host_id || !input.remote_path?.trim())) {
      throw new Error("ssh_project_location_required");
    }
    const rawShell = input.shell?.trim() ?? "";
    const cliConfigRoot = isSshProject ? input.cli_config_root?.trim() ?? "" : "";
    const cliConfigRootError = validateSshToolConfigRoot(cliConfigRoot);
    if (cliConfigRootError) throw new Error(cliConfigRootError);
    const shell = isSshProject ? "" :
      normalizeShellForOs(rawShell, os) ??
      (rawShell && !normalizeShellKey(rawShell)
        ? rawShell
        : normalizeShellForOs(useSettingsStore.getState().defaultShell, os) ?? defaultShellForOs(os));
    const project: Project = {
      id,
      name: input.name,
      path: isSshProject ? "" : input.path,
      group_name: input.group_name ?? "",
      group_id: input.group_id ?? null,
      sort_order: 0,
      cli_tool: input.cli_tool ?? "",
      cli_args: input.cli_args ?? "",
      startup_cmd: input.startup_cmd ?? "",
      env_vars: input.env_vars ?? "{}",
      shell,
      provider_overrides: input.provider_overrides ?? "{}",
      worktree_strategy: isSshProject ? "disabled" : input.worktree_strategy ?? "disabled",
      worktree_root: isSshProject ? "" : input.worktree_root ?? "",
      worktree_deps_prompt_enabled: isSshProject ? 0 : input.worktree_deps_prompt_enabled ?? 0,
      environment_type: input.environment_type ?? "local",
      ssh_host_id: isSshProject ? input.ssh_host_id ?? null : null,
      remote_path: isSshProject ? input.remote_path?.trim() ?? "" : "",
      cli_config_root: cliConfigRoot,
      created_at: ts,
      updated_at: ts,
    };
    await db.execute(
      `INSERT INTO projects (
         id, name, path, group_name, group_id, sort_order,
         cli_tool, cli_args, startup_cmd, env_vars, shell, provider_overrides,
         worktree_strategy, worktree_root, worktree_deps_prompt_enabled,
         environment_type, ssh_host_id, remote_path, cli_config_root, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        project.id,
        project.name,
        project.path,
        project.group_name,
        project.group_id,
        project.sort_order,
        project.cli_tool,
        project.cli_args,
        project.startup_cmd,
        project.env_vars,
        project.shell,
        project.provider_overrides,
        project.worktree_strategy,
        project.worktree_root,
        project.worktree_deps_prompt_enabled,
        project.environment_type,
        project.ssh_host_id,
        project.remote_path,
        project.cli_config_root,
        project.created_at,
        project.updated_at,
      ]
    );
    await get().fetchAll();
    return project;
  },

  updateProject: async (id, input) => {
    const db = await getDb();
    const ts = Date.now().toString();
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    const shouldCleanupCodexProfiles =
      input.provider_overrides !== undefined || input.cli_tool !== undefined;
    const currentProject = get().projects.find((project) => project.id === id);
    const nextEnvironmentType = input.environment_type ?? currentProject?.environment_type ?? "local";
    const normalizedInput: UpdateProjectInput = { ...input };
    if (input.cli_config_root !== undefined || nextEnvironmentType !== "ssh") {
      const cliConfigRoot = nextEnvironmentType === "ssh" ? input.cli_config_root?.trim() ?? "" : "";
      const cliConfigRootError = validateSshToolConfigRoot(cliConfigRoot);
      if (cliConfigRootError) throw new Error(cliConfigRootError);
      normalizedInput.cli_config_root = cliConfigRoot;
    }

    for (const [key, val] of Object.entries(normalizedInput)) {
      if (val !== undefined) {
        fields.push(`${key} = $${idx}`);
        values.push(val);
        idx++;
      }
    }
    fields.push(`updated_at = $${idx}`);
    values.push(ts);
    idx++;
    values.push(id);

    await db.execute(
      `UPDATE projects SET ${fields.join(", ")} WHERE id = $${idx}`,
      values
    );
    await get().fetchAll();
    if (shouldCleanupCodexProfiles) {
      await get().cleanupUnusedCodexProfiles();
    }
  },

  batchUpdateProjectShell: async (ids, shell) => {
    const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    const trimmed = shell.trim();
    if (uniqueIds.length === 0 || !trimmed) return;
    const os = await getOsPlatform();
    const resolved =
      normalizeShellForOs(trimmed, os) ??
      (!normalizeShellKey(trimmed) ? trimmed : defaultShellForOs(os));
    const db = await getDb();
    await dbBatchUpdateProjectShell(db, uniqueIds, resolved, Date.now().toString());
    await get().fetchAll();
  },

  deleteProject: async (id) => {
    const db = await getDb();
    const project = get().projects.find((item) => item.id === id);
    const shouldCleanupCodexProfiles =
      Boolean(project && getProviderSwitchAppType(project) === "codex") ||
      Boolean(project && getCodexProviderOverride(project));
    await db.execute("DELETE FROM projects WHERE id = $1", [id]);
    await get().fetchAll();
    if (shouldCleanupCodexProfiles) {
      await get().cleanupUnusedCodexProfiles();
    }
  },

  createGroup: async (input) => {
    const db = await getDb();
    const id = crypto.randomUUID();
    const ts = Date.now().toString();
    const group: Group = {
      id,
      name: input.name,
      parent_id: input.parent_id ?? null,
      sort_order: 0,
      created_at: ts,
    };
    await db.execute(
      `INSERT INTO groups (id, name, parent_id, sort_order, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [group.id, group.name, group.parent_id, group.sort_order, group.created_at]
    );
    await get().fetchAll();
    return group;
  },

  renameGroup: async (id, name) => {
    const db = await getDb();
    await db.execute("UPDATE groups SET name = $1 WHERE id = $2", [name, id]);
    await get().fetchAll();
  },

  deleteGroup: async (id) => {
    const db = await getDb();
    // Move child projects to ungrouped, then delete group (CASCADE deletes sub-groups)
    await db.execute("UPDATE projects SET group_id = NULL WHERE group_id = $1", [id]);
    // Also ungroup projects in sub-groups before cascade
    await db.execute(
      `UPDATE projects SET group_id = NULL WHERE group_id IN (
        WITH RECURSIVE sg(gid) AS (
          SELECT id FROM groups WHERE parent_id = $1
          UNION ALL
          SELECT g.id FROM groups g JOIN sg ON g.parent_id = sg.gid
        ) SELECT gid FROM sg
      )`,
      [id]
    );
    await db.execute("DELETE FROM groups WHERE id = $1", [id]);
    await get().fetchAll();
  },

  reorderItems: async (_parentId, orderedIds) => {
    if (orderedIds.length === 0) return;
    const { groups, projects, worktrees, searchQuery, tree } = get();
    const groupIds = new Set(groups.map((g) => g.id));
    const orderById = new Map(orderedIds.map((id, index) => [id, index]));
    const nextGroups = groups.map((group) => {
      const sortOrder = orderById.get(group.id);
      return sortOrder === undefined ? group : { ...group, sort_order: sortOrder };
    });
    const nextProjects = projects.map((project) => {
      const sortOrder = orderById.get(project.id);
      return sortOrder === undefined ? project : { ...project, sort_order: sortOrder };
    });

    set({
      groups: nextGroups,
      projects: nextProjects,
      tree: buildTree(nextGroups, nextProjects, searchQuery, worktrees),
    });

    const groupUpdates: Array<[string, number]> = [];
    const projectUpdates: Array<[string, number]> = [];
    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      if (groupIds.has(id)) {
        groupUpdates.push([id, i]);
      } else {
        projectUpdates.push([id, i]);
      }
    }

    try {
      const db = await getDb();
      // 合并成单条 CASE WHEN UPDATE：从 N 次 execute（N 次 fsync）变成 1 次。
      await batchUpdateSortOrder(db, "groups", groupUpdates);
      await batchUpdateSortOrder(db, "projects", projectUpdates);
      await get().fetchAll();
    } catch (err) {
      set({ groups, projects, tree });
      throw err;
    }
  },

  moveProjectToGroup: async (projectId, targetGroupId) => {
    const { groups, projects, worktrees, searchQuery, tree } = get();
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    if (project.group_id === targetGroupId) return;

    const siblings = projects.filter((p) => p.group_id === targetGroupId && p.id !== projectId);
    const maxOrder = siblings.reduce((m, p) => Math.max(m, p.sort_order ?? 0), -1);
    const nextOrder = maxOrder + 1;
    const ts = Date.now().toString();
    const nextProjects = projects.map((item) =>
      item.id === projectId
        ? { ...item, group_id: targetGroupId, sort_order: nextOrder, updated_at: ts }
        : item
    );

    set({
      projects: nextProjects,
      tree: buildTree(groups, nextProjects, searchQuery, worktrees),
    });

    try {
      const db = await getDb();
      await db.execute(
        "UPDATE projects SET group_id = $1, sort_order = $2, updated_at = $3 WHERE id = $4",
        [targetGroupId, nextOrder, ts, projectId]
      );
      await get().fetchAll();
    } catch (err) {
      set({ projects, tree });
      throw err;
    }
  },

  moveGroupToParent: async (groupId, targetParentId) => {
    if (groupId === targetParentId) return;
    const { groups, projects, worktrees, searchQuery, tree } = get();
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    if (group.parent_id === targetParentId) return;

    // Reject moving a group into itself or any of its descendants
    if (targetParentId) {
      const descendantIds = new Set<string>();
      const stack = [groupId];
      const childMap = new Map<string | null, Group[]>();
      for (const g of groups) {
        const arr = childMap.get(g.parent_id) ?? [];
        arr.push(g);
        childMap.set(g.parent_id, arr);
      }
      while (stack.length > 0) {
        const id = stack.pop()!;
        descendantIds.add(id);
        for (const child of childMap.get(id) ?? []) {
          stack.push(child.id);
        }
      }
      if (descendantIds.has(targetParentId)) return;
    }

    const siblings = groups.filter((g) => g.parent_id === targetParentId && g.id !== groupId);
    const maxOrder = siblings.reduce((m, g) => Math.max(m, g.sort_order ?? 0), -1);
    const nextOrder = maxOrder + 1;
    const nextGroups = groups.map((item) =>
      item.id === groupId
        ? { ...item, parent_id: targetParentId, sort_order: nextOrder }
        : item
    );

    set({
      groups: nextGroups,
      tree: buildTree(nextGroups, projects, searchQuery, worktrees),
    });

    try {
      const db = await getDb();
      await db.execute(
        "UPDATE groups SET parent_id = $1, sort_order = $2 WHERE id = $3",
        [targetParentId, nextOrder, groupId]
      );
      await get().fetchAll();
    } catch (err) {
      set({ groups, tree });
      throw err;
    }
  },
}));
