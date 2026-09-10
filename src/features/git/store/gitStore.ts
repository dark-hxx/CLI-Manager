import { create } from "zustand";
import { debugConsoleWarn } from "../../../shared/platform/debugConsole";
import type { GitFileChange, GitTreeNode, GitBranchStatus, GitPullStrategy, GitBranchInfo, GitPendingOperation } from "../../../shared/types/index";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import {
  type GitFileDiffPayload,
  type GitRepositoryRef,
  type GitTransport,
} from "../lib/gitTransport";
import type { GitDiffOptions } from "../../../shared/lib/gitDiffOptions";

import { isUntracked, sameGitChanges, type GitStatusFilter, type GitTreeGrouping } from "../lib/gitTreeModel";
import { buildGitTreesAsync } from "../lib/gitTreeBuilder";
import { GitChangesRefreshQueue } from "../lib/gitChangesRefreshQueue";

/** 项目根下枚举出的 Git 仓库（后端 git_list_repositories 返回）。 */
export type GitRepoInfo = GitRepositoryRef;

interface GitStore {
  transport: GitTransport | null;
  remoteRequired: boolean;
  asOf: number | null;
  changes: GitFileChange[];
  tree: GitTreeNode[];
  untrackedTree: GitTreeNode[];
  collapsedDirs: Set<string>;
  /** 未跟踪文件的「选中」集合（前端态）：勾选不立即 git add，提交时才统一 add。 */
  selectedUntracked: Set<string>;
  /** 已加入跟踪（状态 A）但被取消勾选的文件：保持暂存/跟踪，仅本次提交不包含。 */
  deselectedAdded: Set<string>;
  loading: boolean;
  discarding: boolean;
  committing: boolean;
  pushing: boolean;
  pulling: boolean;
  fetching: boolean;
  branchLoading: boolean;
  checkingOutBranch: boolean;
  creatingBranch: boolean;
  branchStatus: GitBranchStatus | null;
  branches: GitBranchInfo[];
  error: string | null;
  currentProjectPath: string | null;
  statusFilter: GitStatusFilter;
  /** 项目根下枚举出的全部 Git 仓库（根仓库在首位）。 */
  repositories: GitRepoInfo[];
  /** 当前激活的子仓库绝对路径；null 表示项目根仓库。 */
  activeRepoPath: string | null;
  setTransport: (transport: GitTransport | null, remoteRequired?: boolean) => void;
  refreshIfContext: (contextKey: string) => Promise<void>;

  fetchChanges: (projectPath: string, silent?: boolean) => Promise<void>;
  fetchBranchStatus: (projectPath: string) => Promise<void>;
  fetchBranches: (projectPath: string, silent?: boolean) => Promise<void>;
  /** 枚举项目根下的 Git 仓库列表；项目切换时清空旧的激活态与列表再拉取。 */
  fetchRepositories: (projectPath: string) => Promise<void>;
  /** 切换生效仓库（null = 项目根），并立刻刷新变更列表与分支状态。 */
  setActiveRepo: (absolutePath: string | null) => void;
  discardFile: (filePath: string, status: string) => Promise<void>;
  discardAll: () => Promise<void>;
  deleteUntrackedPaths: (paths: string[]) => Promise<void>;
  loadFileDiff: (filePath: string, status: string, options?: GitDiffOptions) => Promise<GitFileDiffPayload>;
  revertHunk: (filePath: string, diffText: string, hunkIndex: number) => Promise<void>;
  revertLines: (filePath: string, diffText: string, selectedLines: { side: "old" | "new"; lineNumber: number }[]) => Promise<void>;
  stageFile: (filePath: string) => Promise<void>;
  unstageFile: (filePath: string) => Promise<void>;
  stagePaths: (paths: string[]) => Promise<void>;
  unstagePaths: (paths: string[]) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  /** 设置一组未跟踪文件的选中态（仅前端）。 */
  setUntrackedSelection: (paths: string[], selected: boolean) => void;
  /** 切换一组未跟踪文件：全选中→全取消，否则全选中。 */
  toggleUntrackedSelection: (paths: string[]) => void;
  /** 清空未跟踪选中集合。 */
  clearUntrackedSelection: () => void;
  /** 切换一组已加入跟踪(A)文件的「取消勾选」态：不动 git 索引，仅影响本次提交是否包含。 */
  toggleAddedDeselection: (paths: string[]) => void;
  /** 设置一组 A 文件的取消勾选态（true=取消勾选/不提交，false=勾选/提交）。 */
  setAddedDeselection: (paths: string[], deselected: boolean) => void;
  commit: (message: string) => Promise<string>;
  push: () => Promise<string>;
  fetchRemote: () => Promise<string>;
  checkoutBranch: (branch: string, remote: boolean) => Promise<string>;
  smartCheckoutBranch: (branch: string, remote: boolean) => Promise<string>;
  createBranch: (branch: string) => Promise<string>;
  /** 按策略拉取（merge/rebase/ff-only）。分叉时 merge/rebase 可直接拉取，冲突抛 pull_conflict。 */
  pull: (strategy: GitPullStrategy) => Promise<string>;
  /** 中止进行中的合并/变基，恢复到拉取前。 */
  pullAbort: () => Promise<void>;
  /** 变基冲突解决并暂存后继续。 */
  rebaseContinue: () => Promise<string>;
  operationContinue: (operation: GitPendingOperation) => Promise<string>;
  operationAbort: (operation: GitPendingOperation) => Promise<string>;
  toggleDir: (path: string) => void;
  collapseAllDirs: () => void;
  expandAllDirs: () => void;
  setStatusFilter: (filter: GitStatusFilter) => void;
  reset: () => void;
}

function collectDirectoryPaths(nodes: GitTreeNode[], treeId: string): string[] {
  const paths: string[] = [];

  const visit = (items: GitTreeNode[]) => {
    for (const node of items) {
      if (node.type !== "directory") continue;
      paths.push(`${treeId}:${node.path}`);
      visit(node.children ?? []);
    }
  };

  visit(nodes);
  return paths;
}

/**
 * 生效仓库路径：激活子仓库时指向子仓库，否则项目根（null = 无项目）。
 * 所有 git invoke 的 projectPath 参数统一走此处；currentProjectPath 仍保留项目根身份，
 * 用于竞态守卫与 git-changed 事件过滤。
 */
function effectiveRepoPath(): string | null {
  const { activeRepoPath, currentProjectPath, remoteRequired } = useGitStore.getState();
  return activeRepoPath ?? (remoteRequired ? "" : currentProjectPath);
}

function currentTransport(projectPath?: string | null): GitTransport {
  const state = useGitStore.getState();
  const root = projectPath ?? state.currentProjectPath;
  if (!root) throw new Error("no_project");
  if (!state.transport) {
    throw new Error(state.remoteRequired ? "ssh_agent_context_unavailable" : "git_transport_unavailable");
  }
  return state.transport;
}

function requestStillCurrent(projectPath: string, repoPath: string, contextKey: string): boolean {
  const state = useGitStore.getState();
  if (state.currentProjectPath !== projectPath || effectiveRepoPath() !== repoPath) return false;
  return state.transport?.contextKey === contextKey;
}

async function refreshIfResultUnknown(projectPath: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("remote_git_result_unknown")) return;
  const store = useGitStore.getState();
  await store.fetchChanges(projectPath, true);
  await store.fetchBranchStatus(projectPath);
}

const changesQueue = new GitChangesRefreshQueue();
let changesEpoch = 0;
let appliedGrouping: GitTreeGrouping | undefined;
let filterBuild: AbortController | null = null;
const treeBuilds = new Set<AbortController>();

// 生命周期代次覆盖 A→B→A；取消建树可释放 Worker，底层不可取消的 IPC 结果仅丢弃。
function invalidateChangesLifecycle(): void {
  changesEpoch++;
  appliedGrouping = undefined;
  for (const controller of treeBuilds) controller.abort();
  treeBuilds.clear();
}

// 查询期间筛选可能改变，提交树前重新核对选项，避免新快照配上旧筛选。
async function prepareCurrentTrees(changes: GitFileChange[], current: () => boolean, controller: AbortController) {
  treeBuilds.add(controller);
  try {
    while (current()) {
      const filter = useGitStore.getState().statusFilter;
      const groupBy = useSettingsStore.getState().gitGroupBy;
      const trees = await buildGitTreesAsync(changes, filter, groupBy, controller.signal);
      if (!current()) return null;
      if (filter === useGitStore.getState().statusFilter && groupBy === useSettingsStore.getState().gitGroupBy) {
        return { ...trees, groupBy };
      }
    }
    return null;
  } finally { treeBuilds.delete(controller); }
}

// 选择集合已与快照一致时保留引用，避免给每个选择订阅者制造无效更新。
function retainSelection(selection: Set<string>, paths: Set<string>): Set<string> {
  const kept = [...selection].filter(path => paths.has(path));
  return kept.length === selection.size ? selection : new Set(kept);
}

export const useGitStore = create<GitStore>((set, get) => ({
  transport: null,
  remoteRequired: false,
  asOf: null,
  changes: [],
  tree: [],
  untrackedTree: [],
  collapsedDirs: new Set(),
  selectedUntracked: new Set(),
  deselectedAdded: new Set(),
  loading: false,
  discarding: false,
  committing: false,
  pushing: false,
  pulling: false,
  fetching: false,
  branchLoading: false,
  checkingOutBranch: false,
  creatingBranch: false,
  branchStatus: null,
  branches: [],
  error: null,
  currentProjectPath: null,
  statusFilter: "all",
  repositories: [],
  activeRepoPath: null,
  setTransport: (transport, remoteRequired = transport?.remote ?? false) => set((state) => {
    if (state.remoteRequired === remoteRequired && state.transport?.contextKey === transport?.contextKey) {
      return { transport };
    }
    invalidateChangesLifecycle();
    return {
      transport,
      remoteRequired,
      changes: [],
      tree: [],
      untrackedTree: [],
      branchStatus: null,
      branches: [],
      asOf: null,
      repositories: [],
      activeRepoPath: null,
      selectedUntracked: new Set<string>(),
      deselectedAdded: new Set<string>(),
    };
  }),

  refreshIfContext: async (contextKey) => {
    const state = get();
    if (state.transport?.contextKey !== contextKey || !state.currentProjectPath) return;
    await state.fetchChanges(state.currentProjectPath, true);
  },

  fetchChanges: async (projectPath: string, silent = false) => {
    const projectChanged = get().currentProjectPath !== projectPath;
    if (projectChanged) {
      invalidateChangesLifecycle();
      set({ currentProjectPath: projectPath, activeRepoPath: null, repositories: [], changes: [], tree: [], untrackedTree: [],
        selectedUntracked: new Set(), deselectedAdded: new Set() });
    }
    const epoch = changesEpoch;
    const repoPath = get().activeRepoPath ?? (get().remoteRequired ? "" : projectPath);
    const contextKey = get().transport?.contextKey ?? null;
    const current = () => epoch === changesEpoch && get().currentProjectPath === projectPath
      && effectiveRepoPath() === repoPath && (get().transport?.contextKey ?? null) === contextKey;
    if (!silent) set({ loading: true, error: null });
    // 以实际仓库身份串行；即使 A→B→A，新的 A 也排在旧 A 查询之后而不并发扫描。
    await changesQueue.request(JSON.stringify([projectPath, repoPath, contextKey]), async reportError => {
      if (!current()) return;
      try {
        const transport = currentTransport(projectPath);
        const snapshot = await transport.getChanges(repoPath);
        if (!current()) return;
        const changes = snapshot.value;
        const unchanged = sameGitChanges(get().changes, changes);
        if (!unchanged || appliedGrouping !== useSettingsStore.getState().gitGroupBy) {
          const controller = new AbortController();
          const prepared = await prepareCurrentTrees(changes, current, controller);
          if (!prepared || !current()) return;
          const untrackedNow = new Set(changes.filter(c => isUntracked(c.status)).map(c => c.path));
          const addedNow = new Set(changes.filter(c => c.status === "A").map(c => c.path));
          appliedGrouping = prepared.groupBy;
          set({ changes, tree: prepared.tree, untrackedTree: prepared.untrackedTree,
            selectedUntracked: retainSelection(get().selectedUntracked, untrackedNow),
            deselectedAdded: retainSelection(get().deselectedAdded, addedNow) });
        }
        set({ loading: false, ...(reportError ? { error: null } : {}), ...(snapshot.asOf !== undefined ? { asOf: snapshot.asOf } : {}) });
      } catch (err) {
        if (!current()) return;
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[GitStore] 获取 Git 变更失败:`, err);
        if (reportError) set({ error: errorMsg, loading: false, changes: [], tree: [], untrackedTree: [] });
        else set({ loading: false });
      }
      if (current()) void get().fetchBranchStatus(projectPath);
    }, !silent);
  },

  fetchBranchStatus: async (projectPath: string) => {
    const repoPath = effectiveRepoPath() ?? projectPath;
    let contextKey: string | null = null;
    try {
      const transport = currentTransport(projectPath);
      contextKey = transport.contextKey;
      const snapshot = await transport.getBranchStatus(repoPath);
      const branchStatus = snapshot.value;
      // 仅当仍是当前项目且生效仓库未变时写入，避免切换项目/子仓库时的竞态覆盖。
      if (contextKey !== null && requestStillCurrent(projectPath, repoPath, contextKey)) {
        set({ branchStatus, ...(snapshot.asOf !== undefined ? { asOf: snapshot.asOf } : {}) });
      }
    } catch (err) {
      debugConsoleWarn(`[GitStore] 获取分支状态失败:`, err);
      // 与成功路径同守卫：stale 请求（项目/子仓库已切换）失败时不得清掉新仓库的有效状态。
      const scopeStillCurrent = get().currentProjectPath === projectPath && effectiveRepoPath() === repoPath;
      if (scopeStillCurrent && (contextKey === null || requestStillCurrent(projectPath, repoPath, contextKey))) {
        set({ branchStatus: null });
      }
    }
  },

  fetchBranches: async (projectPath: string, silent = false) => {
    const repoPath = effectiveRepoPath() ?? projectPath;
    let contextKey: string | null = null;
    if (!silent) set({ branchLoading: true, error: null });
    try {
      const transport = currentTransport(projectPath);
      contextKey = transport.contextKey;
      const snapshot = await transport.listBranches(repoPath);
      const branches = snapshot.value;
      if (contextKey !== null && requestStillCurrent(projectPath, repoPath, contextKey)) {
        set({ branches, branchLoading: false, ...(snapshot.asOf !== undefined ? { asOf: snapshot.asOf } : {}) });
      }
    } catch (err) {
      debugConsoleWarn(`[GitStore] 获取分支列表失败:`, err);
      const scopeStillCurrent = get().currentProjectPath === projectPath && effectiveRepoPath() === repoPath;
      if (scopeStillCurrent && (contextKey === null || requestStillCurrent(projectPath, repoPath, contextKey))) {
        set({ branches: [], branchLoading: false });
      }
    }
  },

  fetchRepositories: async (projectPath: string) => {
    // 项目切换（currentProjectPath 尚未指向本项目）：先清空旧激活态与列表。
    if (get().currentProjectPath !== projectPath) {
      set({ repositories: [], activeRepoPath: null });
    }
    try {
      const transport = currentTransport(projectPath);
      const contextKey = transport.contextKey;
      const snapshot = await transport.listRepositories();
      const repositories = snapshot.value;
      // 竞态守卫：仅当仍是当前项目时写入（面板总是先 fetchChanges 再 fetchRepositories）。
      if (!requestStillCurrent(projectPath, effectiveRepoPath() ?? projectPath, contextKey)) return;
      const { activeRepoPath } = get();
      // 激活的子仓库已不在列表（被删除等）→ 回落到根仓库。
      const activeStillExists =
        activeRepoPath === null || repositories.some((repo) => repo.absolutePath === activeRepoPath);
      set(activeStillExists ? { repositories, ...(snapshot.asOf !== undefined ? { asOf: snapshot.asOf } : {}) } : { repositories, activeRepoPath: null, ...(snapshot.asOf !== undefined ? { asOf: snapshot.asOf } : {}) });
    } catch (err) {
      debugConsoleWarn(`[GitStore] 枚举 Git 仓库失败:`, err);
      if (get().currentProjectPath === projectPath) {
        set({ repositories: [] });
      }
    }
  },

  setActiveRepo: (absolutePath: string | null) => {
    const { currentProjectPath, activeRepoPath } = get();
    // 根仓库归一化为 null，保证「未激活子仓库 = 项目根」单一表示。
    const next = absolutePath === currentProjectPath ? null : absolutePath;
    if (next === activeRepoPath) return;
    invalidateChangesLifecycle();
    // 未跟踪选中 / A 文件取消勾选集合与各自仓库的相对路径绑定，切换时清空。
    set({ activeRepoPath: next, changes: [], tree: [], untrackedTree: [], selectedUntracked: new Set(), deselectedAdded: new Set() });
    // 立刻刷新变更列表与分支状态（fetchChanges 内部会解析生效仓库路径并联动分支状态）。
    if (currentProjectPath) void get().fetchChanges(currentProjectPath);
    if (currentProjectPath) void get().fetchBranches(currentProjectPath);
  },

  discardFile: async (filePath: string, status: string) => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) return;
    set({ discarding: true, error: null });
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) return;
      await currentTransport(currentProjectPath).discardFile(repoPath, filePath, status);
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 回滚文件失败:`, err);
      set({ error: errorMsg });
      await refreshIfResultUnknown(currentProjectPath, err);
      throw err;
    } finally {
      set({ discarding: false });
    }
  },

  discardAll: async () => {
    const { currentProjectPath, changes } = get();
    if (!currentProjectPath) return;
    // 仅回滚已跟踪改动，排除未跟踪文件（U/??）。
    const trackable = changes.filter((c) => c.status !== "U" && c.status !== "??");
    if (trackable.length === 0) return;
    set({ discarding: true, error: null });
    try {
      for (const c of trackable) {
        const repoPath = effectiveRepoPath();
        if (repoPath === null) return;
        await currentTransport(currentProjectPath).discardFile(repoPath, c.path, c.status);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 批量回滚失败:`, err);
      set({ error: errorMsg });
    } finally {
      // 无论成功或部分失败都刷新，反映真实状态。
      await get().fetchChanges(currentProjectPath, true);
      set({ discarding: false });
    }
  },

  deleteUntrackedPaths: async (paths: string[]) => {
    const { currentProjectPath } = get();
    const repoPath = effectiveRepoPath();
    if (!currentProjectPath || repoPath === null || paths.length === 0) return;
    set({ discarding: true, error: null });
    try {
      await currentTransport(currentProjectPath).deleteUntracked(repoPath, paths);
      set((state) => {
        const selectedUntracked = new Set(state.selectedUntracked);
        for (const path of paths) {
          selectedUntracked.delete(path);
        }
        return { selectedUntracked };
      });
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 删除未跟踪文件失败:`, err);
      set({ error: errorMsg });
      await refreshIfResultUnknown(currentProjectPath, err);
      throw err;
    } finally {
      set({ discarding: false });
    }
  },

  loadFileDiff: async (filePath: string, status: string, options?: GitDiffOptions) => {
    const { currentProjectPath } = get();
    const repoPath = effectiveRepoPath();
    if (!currentProjectPath || repoPath === null) throw new Error("no_project");
    return (await currentTransport(currentProjectPath).getFileDiff(repoPath, filePath, status, options)).value;
  },

  revertHunk: async (filePath: string, diffText: string, hunkIndex: number) => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) return;
    set({ discarding: true, error: null });
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) return;
      await currentTransport(currentProjectPath).revertHunk(repoPath, filePath, diffText, hunkIndex);
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 回滚 hunk 失败:`, err);
      set({ error: errorMsg });
      await refreshIfResultUnknown(currentProjectPath, err);
      throw err;
    } finally {
      set({ discarding: false });
    }
  },

  revertLines: async (filePath, diffText, selectedLines) => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) return;
    set({ discarding: true, error: null });
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) return;
      await currentTransport(currentProjectPath).revertLines(repoPath, filePath, diffText, selectedLines);
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 回滚选中行失败:`, err);
      set({ error: errorMsg });
      await refreshIfResultUnknown(currentProjectPath, err);
      throw err;
    } finally {
      set({ discarding: false });
    }
  },

  stageFile: async (filePath: string) => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) return;
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) return;
      await currentTransport(currentProjectPath).stage(repoPath, [filePath]);
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 暂存文件失败:`, err);
      set({ error: errorMsg });
      await refreshIfResultUnknown(currentProjectPath, err);
      throw err;
    }
  },

  unstageFile: async (filePath: string) => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) return;
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) return;
      await currentTransport(currentProjectPath).unstage(repoPath, [filePath]);
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 取消暂存文件失败:`, err);
      set({ error: errorMsg });
      await refreshIfResultUnknown(currentProjectPath, err);
      throw err;
    }
  },

  stageAll: async () => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) return;
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) return;
      await currentTransport(currentProjectPath).stageAll(repoPath);
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 全部暂存失败:`, err);
      set({ error: errorMsg });
      await refreshIfResultUnknown(currentProjectPath, err);
      throw err;
    }
  },

  stagePaths: async (paths: string[]) => {
    const { currentProjectPath } = get();
    if (!currentProjectPath || paths.length === 0) return;
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) return;
      await currentTransport(currentProjectPath).stage(repoPath, paths);
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 批量暂存失败:`, err);
      set({ error: errorMsg });
      await refreshIfResultUnknown(currentProjectPath, err);
      throw err;
    }
  },

  unstagePaths: async (paths: string[]) => {
    const { currentProjectPath } = get();
    if (!currentProjectPath || paths.length === 0) return;
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) return;
      await currentTransport(currentProjectPath).unstage(repoPath, paths);
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 批量取消暂存失败:`, err);
      set({ error: errorMsg });
      await refreshIfResultUnknown(currentProjectPath, err);
      throw err;
    }
  },

  unstageAll: async () => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) return;
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) return;
      await currentTransport(currentProjectPath).unstageAll(repoPath);
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 全部取消暂存失败:`, err);
      set({ error: errorMsg });
      await refreshIfResultUnknown(currentProjectPath, err);
      throw err;
    }
  },

  setUntrackedSelection: (paths: string[], selected: boolean) => {
    if (paths.length === 0) return;
    set((state) => {
      const next = new Set(state.selectedUntracked);
      for (const p of paths) {
        if (selected) next.add(p);
        else next.delete(p);
      }
      return { selectedUntracked: next };
    });
  },

  toggleUntrackedSelection: (paths: string[]) => {
    if (paths.length === 0) return;
    const selected = get().selectedUntracked;
    const allSelected = paths.every((p) => selected.has(p));
    get().setUntrackedSelection(paths, !allSelected);
  },

  clearUntrackedSelection: () => {
    if (get().selectedUntracked.size === 0) return;
    set({ selectedUntracked: new Set() });
  },

  toggleAddedDeselection: (paths: string[]) => {
    if (paths.length === 0) return;
    const deselected = get().deselectedAdded;
    // 全部已取消勾选 → 重新勾选；否则全部取消勾选。
    const allDeselected = paths.every((p) => deselected.has(p));
    get().setAddedDeselection(paths, !allDeselected);
  },

  setAddedDeselection: (paths: string[], deselected: boolean) => {
    if (paths.length === 0) return;
    set((state) => {
      const next = new Set(state.deselectedAdded);
      for (const p of paths) {
        if (deselected) next.add(p);
        else next.delete(p);
      }
      return { deselectedAdded: next };
    });
  },

  commit: async (message: string) => {
    const { currentProjectPath, selectedUntracked, deselectedAdded, changes } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ committing: true, error: null });
    try {
      // 提交前先 add 选中的未跟踪文件（延迟到此刻才真正 git add）。
      const toAdd = [...selectedUntracked];
      if (toAdd.length > 0) {
        const repoPath = effectiveRepoPath();
        if (repoPath === null) throw new Error("no_project");
        await currentTransport(currentProjectPath).stage(repoPath, toAdd);
      }

      let shortId: string;
      const repoPath = effectiveRepoPath();
      if (repoPath === null) throw new Error("no_project");
      if (deselectedAdded.size === 0) {
        // 无「取消勾选的 A 文件」→ 走整库索引提交（保持既有语义）。
        shortId = await currentTransport(currentProjectPath).commit(repoPath, message);
      } else {
        // 有取消勾选的 A 文件 → 仅提交选中的路径（pathspec），被取消勾选者保持暂存不提交。
        const includedStaged = changes
          .filter((c) => c.staged && !(c.status === "A" && deselectedAdded.has(c.path)))
          .map((c) => c.path);
        const commitPaths = [...new Set([...includedStaged, ...toAdd])];
        if (commitPaths.length === 0) throw new Error("nothing_staged");
        shortId = await currentTransport(currentProjectPath).commit(repoPath, message, commitPaths);
      }

      set({ selectedUntracked: new Set() });
      await get().fetchChanges(currentProjectPath, true);
      return shortId;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 提交失败:`, err);
      set({ error: errorMsg });
      // 失败后刷新一次：若已 add 部分未跟踪，让 UI 反映真实索引状态。
      await get().fetchChanges(currentProjectPath, true);
      throw err;
    } finally {
      set({ committing: false });
    }
  },

  push: async () => {
    const { currentProjectPath, branchStatus } = get();
    if (!currentProjectPath) throw new Error("no_project");
    // 无 upstream 时建立跟踪：push -u origin <branch>。
    const setUpstream = !!branchStatus && !branchStatus.hasUpstream;
    const branch = branchStatus?.branch ?? null;
    if (setUpstream && !branch) throw new Error("empty_branch");
    set({ pushing: true, error: null });
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) throw new Error("no_project");
      const out = await currentTransport(currentProjectPath).push(repoPath, setUpstream, setUpstream ? branch : null);
      await get().fetchBranchStatus(currentProjectPath);
      return out;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 推送失败:`, err);
      set({ error: errorMsg });
      // 推送被拒可能因落后远端，刷新状态以便展示 behind / 拉取入口。
      void get().fetchBranchStatus(currentProjectPath);
      throw err;
    } finally {
      set({ pushing: false });
    }
  },

  fetchRemote: async () => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ fetching: true, error: null });
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) throw new Error("no_project");
      const out = await currentTransport(currentProjectPath).fetch(repoPath);
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      await get().fetchBranches(currentProjectPath, true);
      await get().fetchRepositories(currentProjectPath);
      return out;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 获取远端更新失败:`, err);
      set({ error: errorMsg });
      await refreshIfResultUnknown(currentProjectPath, err);
      throw err;
    } finally {
      set({ fetching: false });
    }
  },

  checkoutBranch: async (branch: string, remote: boolean) => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ checkingOutBranch: true, error: null });
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) throw new Error("no_project");
      const out = await currentTransport(currentProjectPath).checkout(repoPath, branch, remote);
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      await get().fetchBranches(currentProjectPath, true);
      await get().fetchRepositories(currentProjectPath);
      return out;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 切换分支失败:`, err);
      set({ error: errorMsg });
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      await get().fetchBranches(currentProjectPath, true);
      throw err;
    } finally {
      set({ checkingOutBranch: false });
    }
  },

  smartCheckoutBranch: async (branch: string, remote: boolean) => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ checkingOutBranch: true, error: null });
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) throw new Error("no_project");
      const out = await currentTransport(currentProjectPath).checkout(repoPath, branch, remote, true);
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      await get().fetchBranches(currentProjectPath, true);
      await get().fetchRepositories(currentProjectPath);
      return out;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] Smart Checkout 失败:`, err);
      set({ error: errorMsg });
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      await get().fetchBranches(currentProjectPath, true);
      throw err;
    } finally {
      set({ checkingOutBranch: false });
    }
  },

  createBranch: async (branch: string) => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ creatingBranch: true, error: null });
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) throw new Error("no_project");
      const out = await currentTransport(currentProjectPath).createBranch(repoPath, branch);
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      await get().fetchBranches(currentProjectPath, true);
      await get().fetchRepositories(currentProjectPath);
      return out;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 新建分支失败:`, err);
      set({ error: errorMsg });
      await refreshIfResultUnknown(currentProjectPath, err);
      throw err;
    } finally {
      set({ creatingBranch: false });
    }
  },

  pull: async (strategy) => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ pulling: true, error: null });
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) throw new Error("no_project");
      const out = await currentTransport(currentProjectPath).pull(repoPath, strategy);
      // 拉取改动工作区与提交，需同时刷新变更列表与分支状态。
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      return out;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 拉取失败:`, err);
      set({ error: errorMsg });
      // 冲突等失败也刷新：让冲突文件(C)与 pendingOp 在 UI 呈现，驱动横幅与中止/继续。
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      throw err;
    } finally {
      set({ pulling: false });
    }
  },

  pullAbort: async () => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ pulling: true, error: null });
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) throw new Error("no_project");
      await currentTransport(currentProjectPath).pullAbort(repoPath);
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 中止拉取失败:`, err);
      set({ error: errorMsg });
      await refreshIfResultUnknown(currentProjectPath, err);
      throw err;
    } finally {
      set({ pulling: false });
    }
  },

  rebaseContinue: async () => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ pulling: true, error: null });
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) throw new Error("no_project");
      const out = await currentTransport(currentProjectPath).rebaseContinue(repoPath);
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      return out;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 继续变基失败:`, err);
      set({ error: errorMsg });
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      throw err;
    } finally {
      set({ pulling: false });
    }
  },

  operationContinue: async (operation) => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ pulling: true, error: null });
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) throw new Error("no_project");
      const out = await currentTransport(currentProjectPath).operationContinue(repoPath, operation);
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      return out;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      set({ error: errorMsg });
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      throw err;
    } finally {
      set({ pulling: false });
    }
  },

  operationAbort: async (operation) => {
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ pulling: true, error: null });
    try {
      const repoPath = effectiveRepoPath();
      if (repoPath === null) throw new Error("no_project");
      const out = await currentTransport(currentProjectPath).operationAbort(repoPath, operation);
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      return out;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      set({ error: errorMsg });
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      throw err;
    } finally {
      set({ pulling: false });
    }
  },

  toggleDir: (path: string) => {
    set((state) => {
      const newCollapsed = new Set(state.collapsedDirs);
      if (newCollapsed.has(path)) {
        newCollapsed.delete(path);
      } else {
        newCollapsed.add(path);
      }
      return { collapsedDirs: newCollapsed };
    });
  },

  collapseAllDirs: () => {
    set((state) => ({
      collapsedDirs: new Set([
        ...collectDirectoryPaths(state.tree, "tracked"),
        ...collectDirectoryPaths(state.untrackedTree, "untracked"),
      ]),
    }));
  },

  expandAllDirs: () => {
    set({ collapsedDirs: new Set() });
  },

  setStatusFilter: (filter: GitStatusFilter) => {
    filterBuild?.abort();
    const controller = new AbortController();
    filterBuild = controller;
    const changes = get().changes;
    const epoch = changesEpoch;
    set({ statusFilter: filter });
    const current = () => !controller.signal.aborted && changesEpoch === epoch && get().changes === changes;
    void prepareCurrentTrees(changes, current, controller).then(prepared => {
      if (!prepared || !current()) return;
      appliedGrouping = prepared.groupBy;
      set({ tree: prepared.tree, untrackedTree: prepared.untrackedTree });
    }).catch(error => {
      if (current()) set({ error: error instanceof Error ? error.message : String(error) });
    });
  },

  reset: () => {
    invalidateChangesLifecycle();
    set({
      changes: [],
      tree: [],
      untrackedTree: [],
      collapsedDirs: new Set(),
      selectedUntracked: new Set(),
      deselectedAdded: new Set(),
      loading: false,
      discarding: false,
      committing: false,
      pushing: false,
      pulling: false,
      fetching: false,
      branchLoading: false,
      checkingOutBranch: false,
      creatingBranch: false,
      branchStatus: null,
      branches: [],
      error: null,
      currentProjectPath: null,
      statusFilter: "all",
      repositories: [],
      activeRepoPath: null,
      transport: null,
      remoteRequired: false,
      asOf: null,
    });
  },
}));
