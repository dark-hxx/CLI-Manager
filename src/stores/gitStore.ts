import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { debugConsoleLog, debugConsoleWarn } from "../lib/debugConsole";
import type { GitFileChange, GitTreeNode, GitBranchStatus, GitPullStrategy, GitBranchInfo } from "../lib/types";
import { useSettingsStore } from "./settingsStore";
import {
  sshRemoteGitBranchStatus,
  sshRemoteGitBranches,
  sshRemoteGitChanges,
  sshRemoteGitListRepositories,
  type SshRemoteGitContext,
} from "../lib/sshRemoteGit";

type GitStatusFilter = "all" | "M" | "A" | "D" | "U";

/** 项目根下枚举出的 Git 仓库（后端 git_list_repositories 返回）。 */
export interface GitRepoInfo {
  /** 相对项目根路径：根仓库为空串，子仓库如 "sub-repo-a"、"tools/sub-repo-c"（'/' 分隔）。 */
  relativePath: string;
  absolutePath: string;
  branch: string | null;
}

// 判断已跟踪文件是否匹配当前筛选。未跟踪(U/??)单独成组展示，不参与此处筛选。
function matchTrackedFilter(status: string, filter: GitStatusFilter): boolean {
  if (filter === "all" || filter === "U") return true;
  return status === filter;
}

function isUntracked(status: string): boolean {
  return status === "U" || status === "??";
}

interface GitStore {
  remoteContext: SshRemoteGitContext | null;
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
  setRemoteContext: (context: SshRemoteGitContext | null) => void;

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
  revertHunk: (diffText: string, hunkIndex: number) => Promise<void>;
  revertLines: (diffText: string, selectedLines: { side: "old" | "new"; lineNumber: number }[]) => Promise<void>;
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
  toggleDir: (path: string) => void;
  collapseAllDirs: () => void;
  expandAllDirs: () => void;
  setStatusFilter: (filter: GitStatusFilter) => void;
  reset: () => void;
}

function buildTree(changes: GitFileChange[]): GitTreeNode[] {
  const root: GitTreeNode[] = [];
  const dirMap = new Map<string, GitTreeNode>();

  // 按路径排序
  const sorted = [...changes].sort((a, b) => a.path.localeCompare(b.path));

  for (const change of sorted) {
    const parts = change.path.split(/[/\\]/);
    let currentLevel = root;
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (i === parts.length - 1) {
        // 文件节点
        currentLevel.push({
          type: "file",
          name: part,
          path: currentPath,
          change,
        });
      } else {
        // 目录节点
        let dir = dirMap.get(currentPath);
        if (!dir) {
          dir = {
            type: "directory",
            name: part,
            path: currentPath,
            children: [],
          };
          dirMap.set(currentPath, dir);
          currentLevel.push(dir);
        }
        currentLevel = dir.children!;
      }
    }
  }

  return root;
}

// 按模块分组构建树：第一级目录视为模块，每个模块是顶层节点。
function buildTreeByModule(changes: GitFileChange[]): GitTreeNode[] {
  const moduleMap = new Map<string, GitFileChange[]>();

  // 按第一级目录分组
  for (const change of changes) {
    const parts = change.path.split(/[/\\]/);
    const moduleName = parts[0];
    if (!moduleMap.has(moduleName)) {
      moduleMap.set(moduleName, []);
    }
    moduleMap.get(moduleName)!.push(change);
  }

  // 为每个模块构建子树
  const modules: GitTreeNode[] = [];
  for (const [moduleName, moduleChanges] of Array.from(moduleMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const moduleSubtree = buildTree(moduleChanges);

    // 如果模块内只有一个顶层节点且就是该模块名本身，直接用它并标记为模块根
    if (moduleSubtree.length === 1 && moduleSubtree[0].name === moduleName) {
      modules.push({ ...moduleSubtree[0], isModuleRoot: true });
    } else {
      // 否则创建一个模块根节点包裹子树
      modules.push({
        type: "directory",
        name: moduleName,
        path: moduleName,
        children: moduleSubtree,
        isModuleRoot: true,
      });
    }
  }

  return modules;
}

// 构建「已跟踪变更树」与「未跟踪文件树」。未跟踪文件单独成组（仿 JetBrains Unversioned Files）。
function rebuildTrees(
  changes: GitFileChange[],
  filter: GitStatusFilter,
  groupBy: "directory" | "module" = "directory"
): { tree: GitTreeNode[]; untrackedTree: GitTreeNode[] } {
  const tracked = changes.filter((c) => !isUntracked(c.status) && matchTrackedFilter(c.status, filter));
  const untracked = changes.filter((c) => isUntracked(c.status));

  const buildFn = groupBy === "module" ? buildTreeByModule : buildTree;
  return { tree: buildFn(tracked), untrackedTree: buildFn(untracked) };
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

const inFlightChangeRequests = new Map<string, Promise<GitFileChange[]>>();
const inFlightBranchStatusRequests = new Map<string, Promise<GitBranchStatus>>();
const inFlightBranchListRequests = new Map<string, Promise<GitBranchInfo[]>>();

/**
 * 生效仓库路径：激活子仓库时指向子仓库，否则项目根（null = 无项目）。
 * 所有 git invoke 的 projectPath 参数统一走此处；currentProjectPath 仍保留项目根身份，
 * 用于竞态守卫与 git-changed 事件过滤。
 */
function effectiveRepoPath(): string | null {
  const { activeRepoPath, currentProjectPath } = useGitStore.getState();
  return activeRepoPath ?? currentProjectPath;
}

function assertGitWritable(): void {
  if (useGitStore.getState().remoteContext) throw new Error("remote_git_read_only");
}

function invokeGitChanges(projectPath: string): Promise<GitFileChange[]> {
  const existing = inFlightChangeRequests.get(projectPath);
  if (existing) return existing;

  const request = invoke<GitFileChange[]>("git_get_changes", { projectPath }).finally(() => {
    if (inFlightChangeRequests.get(projectPath) === request) {
      inFlightChangeRequests.delete(projectPath);
    }
  });
  inFlightChangeRequests.set(projectPath, request);
  return request;
}

function invokeGitBranchStatus(projectPath: string): Promise<GitBranchStatus> {
  const existing = inFlightBranchStatusRequests.get(projectPath);
  if (existing) return existing;

  const request = invoke<GitBranchStatus>("git_branch_status", { projectPath }).finally(() => {
    if (inFlightBranchStatusRequests.get(projectPath) === request) {
      inFlightBranchStatusRequests.delete(projectPath);
    }
  });
  inFlightBranchStatusRequests.set(projectPath, request);
  return request;
}

function invokeGitBranches(projectPath: string): Promise<GitBranchInfo[]> {
  const existing = inFlightBranchListRequests.get(projectPath);
  if (existing) return existing;

  const request = invoke<GitBranchInfo[]>("git_list_branches", { projectPath }).finally(() => {
    if (inFlightBranchListRequests.get(projectPath) === request) {
      inFlightBranchListRequests.delete(projectPath);
    }
  });
  inFlightBranchListRequests.set(projectPath, request);
  return request;
}

export const useGitStore = create<GitStore>((set, get) => ({
  remoteContext: null,
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
  setRemoteContext: (remoteContext) => set({ remoteContext }),

  fetchChanges: async (projectPath: string, silent = false) => {
    // 项目切换：清空子仓库激活态与列表，避免带着上个项目的 activeRepoPath 查错仓库。
    const projectChanged = get().currentProjectPath !== projectPath;
    const switchPatch = projectChanged ? { activeRepoPath: null, repositories: [] as GitRepoInfo[] } : {};
    // silent 模式用于聚焦轮询：不 set loading，避免每次刷新闪烁 spinner。
    if (silent) {
      set({ currentProjectPath: projectPath, ...switchPatch });
    } else {
      debugConsoleLog(`[GitStore] 开始获取 Git 变更, projectPath: "${projectPath}"`);
      set({ loading: true, error: null, currentProjectPath: projectPath, ...switchPatch });
    }

    const remoteContext = get().remoteContext;
    const repoPath = get().activeRepoPath ?? (remoteContext ? "" : projectPath);
    try {
      const remoteSnapshot = remoteContext ? await sshRemoteGitChanges(remoteContext, repoPath) : null;
      const changes = remoteSnapshot?.value ?? await invokeGitChanges(repoPath);
      if (get().currentProjectPath !== projectPath) return;
      // 等待期间切换了子仓库 → 丢弃过期结果（新一轮 fetchChanges 已在路上）。
      if ((get().activeRepoPath ?? (remoteContext ? "" : projectPath)) !== repoPath) return;

      // 应用筛选并拆分已跟踪 / 未跟踪两棵树，使用当前分组模式
      const { statusFilter } = get();
      const groupBy = useSettingsStore.getState().gitGroupBy;
      const { tree, untrackedTree } = rebuildTrees(changes, statusFilter, groupBy);
      // 选中集合按当前未跟踪文件裁剪：已被 add/删除的路径不再保留，避免悬挂选中。
      const untrackedNow = new Set(changes.filter((c) => isUntracked(c.status)).map((c) => c.path));
      const prevSelected = get().selectedUntracked;
      const selectedUntracked = new Set([...prevSelected].filter((p) => untrackedNow.has(p)));
      // 取消勾选集合按当前 A 文件裁剪：已提交/已不再是 A 的路径移除。
      const addedNow = new Set(changes.filter((c) => c.status === "A").map((c) => c.path));
      const prevDeselected = get().deselectedAdded;
      const deselectedAdded = new Set([...prevDeselected].filter((p) => addedNow.has(p)));
      set({ changes, tree, untrackedTree, selectedUntracked, deselectedAdded, loading: false, ...(remoteSnapshot ? { asOf: remoteSnapshot.asOf } : {}) });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 获取 Git 变更失败:`, err);
      // silent 失败（轮询）不清空已有数据、不弹错，避免打扰；仅非静默时显式报错。
      if (get().currentProjectPath !== projectPath) return;
      if ((get().activeRepoPath ?? (remoteContext ? "" : projectPath)) !== repoPath) return;
      if (silent) {
        set({ loading: false });
      } else {
        set({ error: errorMsg, loading: false, changes: [], tree: [], untrackedTree: [] });
      }
    }

    // 分支状态独立刷新，失败不影响变更列表展示。
    if (get().currentProjectPath === projectPath) {
      void get().fetchBranchStatus(projectPath);
    }
  },

  fetchBranchStatus: async (projectPath: string) => {
    const remoteContext = get().remoteContext;
    const repoPath = get().activeRepoPath ?? (remoteContext ? "" : projectPath);
    try {
      const remoteSnapshot = remoteContext ? await sshRemoteGitBranchStatus(remoteContext, repoPath) : null;
      const branchStatus = remoteSnapshot?.value ?? await invokeGitBranchStatus(repoPath);
      // 仅当仍是当前项目且生效仓库未变时写入，避免切换项目/子仓库时的竞态覆盖。
      if (get().currentProjectPath === projectPath && (get().activeRepoPath ?? (remoteContext ? "" : projectPath)) === repoPath) {
        set({ branchStatus, ...(remoteSnapshot ? { asOf: remoteSnapshot.asOf } : {}) });
      }
    } catch (err) {
      debugConsoleWarn(`[GitStore] 获取分支状态失败:`, err);
      // 与成功路径同守卫：stale 请求（项目/子仓库已切换）失败时不得清掉新仓库的有效状态。
      if (get().currentProjectPath === projectPath && (get().activeRepoPath ?? (remoteContext ? "" : projectPath)) === repoPath) {
        set({ branchStatus: null });
      }
    }
  },

  fetchBranches: async (projectPath: string, silent = false) => {
    const remoteContext = get().remoteContext;
    const repoPath = get().activeRepoPath ?? (remoteContext ? "" : projectPath);
    if (!silent) set({ branchLoading: true, error: null });
    try {
      const remoteSnapshot = remoteContext ? await sshRemoteGitBranches(remoteContext, repoPath) : null;
      const branches = remoteSnapshot?.value ?? await invokeGitBranches(repoPath);
      if (get().currentProjectPath === projectPath && (get().activeRepoPath ?? (remoteContext ? "" : projectPath)) === repoPath) {
        set({ branches, branchLoading: false, ...(remoteSnapshot ? { asOf: remoteSnapshot.asOf } : {}) });
      }
    } catch (err) {
      debugConsoleWarn(`[GitStore] 获取分支列表失败:`, err);
      if (get().currentProjectPath === projectPath && (get().activeRepoPath ?? (remoteContext ? "" : projectPath)) === repoPath) {
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
      const remoteSnapshot = get().remoteContext ? await sshRemoteGitListRepositories(get().remoteContext!) : null;
      const repositories = remoteSnapshot
        ? remoteSnapshot.value.map((repo) => ({
            relativePath: repo.relativePath,
            absolutePath: repo.repoId,
            branch: repo.branch,
          }))
        : await invoke<GitRepoInfo[]>("git_list_repositories", { projectPath });
      // 竞态守卫：仅当仍是当前项目时写入（面板总是先 fetchChanges 再 fetchRepositories）。
      if (get().currentProjectPath !== projectPath) return;
      const { activeRepoPath } = get();
      // 激活的子仓库已不在列表（被删除等）→ 回落到根仓库。
      const activeStillExists =
        activeRepoPath === null || repositories.some((repo) => repo.absolutePath === activeRepoPath);
      set(activeStillExists ? { repositories, ...(remoteSnapshot ? { asOf: remoteSnapshot.asOf } : {}) } : { repositories, activeRepoPath: null, ...(remoteSnapshot ? { asOf: remoteSnapshot.asOf } : {}) });
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
    // 未跟踪选中 / A 文件取消勾选集合与各自仓库的相对路径绑定，切换时清空。
    set({ activeRepoPath: next, selectedUntracked: new Set(), deselectedAdded: new Set() });
    // 立刻刷新变更列表与分支状态（fetchChanges 内部会解析生效仓库路径并联动分支状态）。
    if (currentProjectPath) void get().fetchChanges(currentProjectPath);
    if (currentProjectPath) void get().fetchBranches(currentProjectPath);
  },

  discardFile: async (filePath: string, status: string) => {
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath) return;
    set({ discarding: true, error: null });
    try {
      await invoke("git_discard_file", { projectPath: effectiveRepoPath(), filePath, status });
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 回滚文件失败:`, err);
      set({ error: errorMsg });
      throw err;
    } finally {
      set({ discarding: false });
    }
  },

  discardAll: async () => {
    assertGitWritable();
    const { currentProjectPath, changes } = get();
    if (!currentProjectPath) return;
    // 仅回滚已跟踪改动，排除未跟踪文件（U/??）。
    const trackable = changes.filter((c) => c.status !== "U" && c.status !== "??");
    if (trackable.length === 0) return;
    set({ discarding: true, error: null });
    try {
      for (const c of trackable) {
        await invoke("git_discard_file", {
          projectPath: effectiveRepoPath(),
          filePath: c.path,
          status: c.status,
        });
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
    assertGitWritable();
    const { currentProjectPath } = get();
    const repoPath = effectiveRepoPath();
    if (!currentProjectPath || !repoPath || paths.length === 0) return;
    set({ discarding: true, error: null });
    try {
      await invoke("git_delete_untracked_paths", { projectPath: repoPath, paths });
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
      throw err;
    } finally {
      set({ discarding: false });
    }
  },

  revertHunk: async (diffText: string, hunkIndex: number) => {
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath) return;
    set({ discarding: true, error: null });
    try {
      await invoke("git_revert_hunk", { projectPath: effectiveRepoPath(), diffText, hunkIndex });
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 回滚 hunk 失败:`, err);
      set({ error: errorMsg });
      throw err;
    } finally {
      set({ discarding: false });
    }
  },

  revertLines: async (diffText, selectedLines) => {
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath) return;
    set({ discarding: true, error: null });
    try {
      await invoke("git_revert_lines", { projectPath: effectiveRepoPath(), diffText, selectedLines });
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 回滚选中行失败:`, err);
      set({ error: errorMsg });
      throw err;
    } finally {
      set({ discarding: false });
    }
  },

  stageFile: async (filePath: string) => {
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath) return;
    try {
      await invoke("git_stage_file", { projectPath: effectiveRepoPath(), filePath });
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 暂存文件失败:`, err);
      set({ error: errorMsg });
      throw err;
    }
  },

  unstageFile: async (filePath: string) => {
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath) return;
    try {
      await invoke("git_unstage_file", { projectPath: effectiveRepoPath(), filePath });
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 取消暂存文件失败:`, err);
      set({ error: errorMsg });
      throw err;
    }
  },

  stageAll: async () => {
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath) return;
    try {
      await invoke("git_stage_all", { projectPath: effectiveRepoPath() });
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 全部暂存失败:`, err);
      set({ error: errorMsg });
      throw err;
    }
  },

  stagePaths: async (paths: string[]) => {
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath || paths.length === 0) return;
    try {
      await invoke("git_stage_paths", { projectPath: effectiveRepoPath(), paths });
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 批量暂存失败:`, err);
      set({ error: errorMsg });
      throw err;
    }
  },

  unstagePaths: async (paths: string[]) => {
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath || paths.length === 0) return;
    try {
      await invoke("git_unstage_paths", { projectPath: effectiveRepoPath(), paths });
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 批量取消暂存失败:`, err);
      set({ error: errorMsg });
      throw err;
    }
  },

  unstageAll: async () => {
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath) return;
    try {
      await invoke("git_unstage_all", { projectPath: effectiveRepoPath() });
      await get().fetchChanges(currentProjectPath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 全部取消暂存失败:`, err);
      set({ error: errorMsg });
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
    assertGitWritable();
    const { currentProjectPath, selectedUntracked, deselectedAdded, changes } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ committing: true, error: null });
    try {
      // 提交前先 add 选中的未跟踪文件（延迟到此刻才真正 git add）。
      const toAdd = [...selectedUntracked];
      if (toAdd.length > 0) {
        await invoke("git_stage_paths", { projectPath: effectiveRepoPath(), paths: toAdd });
      }

      let shortId: string;
      if (deselectedAdded.size === 0) {
        // 无「取消勾选的 A 文件」→ 走整库索引提交（保持既有语义）。
        shortId = await invoke<string>("git_commit", { projectPath: effectiveRepoPath(), message });
      } else {
        // 有取消勾选的 A 文件 → 仅提交选中的路径（pathspec），被取消勾选者保持暂存不提交。
        const includedStaged = changes
          .filter((c) => c.staged && !(c.status === "A" && deselectedAdded.has(c.path)))
          .map((c) => c.path);
        const commitPaths = [...new Set([...includedStaged, ...toAdd])];
        if (commitPaths.length === 0) throw new Error("nothing_staged");
        shortId = await invoke<string>("git_commit_paths", {
          projectPath: effectiveRepoPath(),
          message,
          paths: commitPaths,
        });
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
    assertGitWritable();
    const { currentProjectPath, branchStatus } = get();
    if (!currentProjectPath) throw new Error("no_project");
    // 无 upstream 时建立跟踪：push -u origin <branch>。
    const setUpstream = !!branchStatus && !branchStatus.hasUpstream;
    const branch = branchStatus?.branch ?? null;
    if (setUpstream && !branch) throw new Error("empty_branch");
    set({ pushing: true, error: null });
    try {
      const out = await invoke<string>("git_push", {
        projectPath: effectiveRepoPath(),
        setUpstream,
        branch: setUpstream ? branch : null,
      });
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
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ fetching: true, error: null });
    try {
      const out = await invoke<string>("git_fetch", { projectPath: effectiveRepoPath() });
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      await get().fetchBranches(currentProjectPath, true);
      await get().fetchRepositories(currentProjectPath);
      return out;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 获取远端更新失败:`, err);
      set({ error: errorMsg });
      throw err;
    } finally {
      set({ fetching: false });
    }
  },

  checkoutBranch: async (branch: string, remote: boolean) => {
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ checkingOutBranch: true, error: null });
    try {
      const out = await invoke<string>("git_checkout_branch", {
        projectPath: effectiveRepoPath(),
        branch,
        remote,
      });
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
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ checkingOutBranch: true, error: null });
    try {
      const out = await invoke<string>("git_smart_checkout_branch", {
        projectPath: effectiveRepoPath(),
        branch,
        remote,
      });
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
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ creatingBranch: true, error: null });
    try {
      const out = await invoke<string>("git_create_branch", {
        projectPath: effectiveRepoPath(),
        branch,
      });
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
      await get().fetchBranches(currentProjectPath, true);
      await get().fetchRepositories(currentProjectPath);
      return out;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 新建分支失败:`, err);
      set({ error: errorMsg });
      throw err;
    } finally {
      set({ creatingBranch: false });
    }
  },

  pull: async (strategy) => {
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ pulling: true, error: null });
    try {
      const out = await invoke<string>("git_pull", { projectPath: effectiveRepoPath(), strategy });
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
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ pulling: true, error: null });
    try {
      await invoke<string>("git_pull_abort", { projectPath: effectiveRepoPath() });
      await get().fetchChanges(currentProjectPath, true);
      await get().fetchBranchStatus(currentProjectPath);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[GitStore] 中止拉取失败:`, err);
      set({ error: errorMsg });
      throw err;
    } finally {
      set({ pulling: false });
    }
  },

  rebaseContinue: async () => {
    assertGitWritable();
    const { currentProjectPath } = get();
    if (!currentProjectPath) throw new Error("no_project");
    set({ pulling: true, error: null });
    try {
      const out = await invoke<string>("git_rebase_continue", { projectPath: effectiveRepoPath() });
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
    set((state) => {
      const groupBy = useSettingsStore.getState().gitGroupBy;
      const { tree, untrackedTree } = rebuildTrees(state.changes, filter, groupBy);
      return { statusFilter: filter, tree, untrackedTree };
    });
  },

  reset: () => {
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
      remoteContext: null,
      asOf: null,
    });
  },
}));
