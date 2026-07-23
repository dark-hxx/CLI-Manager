import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { RefreshCw, GitBranch, Undo2, Files, FilePen, FilePlus, FileMinus, GitCommitHorizontal, ArrowUp, ArrowDown, Upload, Download, ChevronDown, GitMerge, Check, X, FolderTree, FolderGit2, Layers, Plus, Search } from "lucide-react";
import { useGitStore } from "../../stores/gitStore";
import { useProjectStore } from "../../stores/projectStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { GitChangesTree } from "./GitChangesTree";
import { StageCheckbox, type StageState } from "./StageCheckbox";
import { STATUS_CONFIG } from "./GitStatusIcon";
import { DiffViewerModal } from "./DiffViewerModal";
import { ConfirmDialog } from "../ConfirmDialog";
import { useFileExplorerStore } from "../../stores/fileExplorerStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { TERM, EmptyHint, panelColorTint } from "../stats/termStatsUi";
import { debugConsoleWarn } from "../../lib/debugConsole";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import { findProjectByPath } from "../../lib/terminalProject";
import type { GitTreeNode, GitPullStrategy, GitBranchInfo, Project } from "../../lib/types";
import { buildSshRemoteGitContext } from "../../lib/sshRemoteGit";

interface GitChangesPanelProps {
  open: boolean;
  projectPath: string | null;
  projectId?: string | null;
  visible?: boolean;
  embedded?: boolean;
}

// 降级慢轮询间隔：仅当 fs-watcher 初始化失败（网络盘/WSL 等 notify 不可用）时启用。
const FALLBACK_POLL_INTERVAL_MS = 15000;
const FILTER_LABEL_HIDE_WIDTH = 260;
const BRANCH_MENU_SECTION_LIMIT = 80;
const TERMINAL_PANEL_SCROLLBAR_STYLE = {
  "--ui-scrollbar-thumb": TERM.border,
  "--ui-scrollbar-track": TERM.bg,
} as CSSProperties;

type Translate = ReturnType<typeof useI18n>["t"];

// 把后端 git 网络错误码（形如 "auth_failed: <原文>"）映射为当前语言的 toast。
function formatGitNetError(prefix: string, raw: string, t: Translate): string {
  if (raw.includes("ssh_agent_not_installed")) {
    return t("settings.sshHosts.cliIntegration.agent.code.ssh_agent_not_installed");
  }
  if (raw.includes("auth_failed")) return t("git.error.authFailed", { prefix });
  if (raw.includes("not_fast_forward")) return t("git.error.notFastForward", { prefix });
  if (raw.includes("no_upstream")) return t("git.error.noUpstream", { prefix });
  if (raw.includes("no_remote")) return t("git.error.noRemote", { prefix });
  if (raw.includes("pull_conflict")) return t("git.error.pullConflict", { prefix });
  if (raw.includes("checkout_conflict")) return t("git.error.checkoutConflict", { prefix });
  if (raw.includes("smart_checkout_stash_failed")) return t("git.error.smartCheckoutStashFailed", { prefix });
  if (raw.includes("smart_checkout_stash_empty")) return t("git.error.smartCheckoutStashEmpty", { prefix });
  if (raw.includes("smart_checkout_checkout_failed")) return t("git.error.smartCheckoutCheckoutFailed", { prefix });
  if (raw.includes("smart_checkout_restore_failed")) return t("git.error.smartCheckoutRestoreFailed", { prefix });
  if (raw.includes("smart_checkout_apply_conflict")) return t("git.error.smartCheckoutApplyConflict", { prefix });
  if (raw.includes("invalid_branch")) return t("git.error.invalidBranch", { prefix });
  if (raw.includes("git_not_found")) return t("git.error.gitNotFound", { prefix });
  if (raw.includes("ssh_agent_capability_missing")) return t("git.error.agentCapabilityMissing", { prefix });
  if (raw.includes("remote_git_result_unknown")) return t("git.error.resultUnknown", { prefix });
  return t("git.error.generic", { prefix, message: raw.replace(/^[a-z_]+:\s*/, "") });
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeBranchSearchMatcher(query: string): RegExp | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  return new RegExp(escapeRegExp(trimmed), "i");
}

function branchMatchesSearch(branch: GitBranchInfo, matcher: RegExp | null): boolean {
  if (!matcher) return true;
  return matcher.test(branch.name) || (branch.upstream ? matcher.test(branch.upstream) : false);
}

interface GitBranchMenuProps {
  branches: GitBranchInfo[];
  branchLoading: boolean;
  fetching: boolean;
  branchActionBusy: boolean;
  t: Translate;
  onClose: () => void;
  onFetch: () => void;
  onCheckout: (branch: GitBranchInfo) => void;
  onCreate: (branch: string) => void;
}

function GitBranchMenu({
  branches,
  branchLoading,
  fetching,
  branchActionBusy,
  t,
  onClose,
  onFetch,
  onCheckout,
  onCreate,
}: GitBranchMenuProps) {
  const [branchQuery, setBranchQuery] = useState("");
  const branchSearchMatcher = useMemo(() => makeBranchSearchMatcher(branchQuery), [branchQuery]);
  const branchQueryValue = branchQuery.trim();

  const localBranches = useMemo(
    () => branches.filter((branch) => branch.branchType === "local" && branchMatchesSearch(branch, branchSearchMatcher)),
    [branches, branchSearchMatcher],
  );
  const remoteBranches = useMemo(
    () => branches.filter((branch) => branch.branchType === "remote" && branchMatchesSearch(branch, branchSearchMatcher)),
    [branches, branchSearchMatcher],
  );
  const visibleLocalBranches = localBranches.slice(0, BRANCH_MENU_SECTION_LIMIT);
  const visibleRemoteBranches = remoteBranches.slice(0, BRANCH_MENU_SECTION_LIMIT);
  const firstCheckoutBranch = visibleLocalBranches.find((branch) => !branch.current) ?? visibleRemoteBranches[0] ?? null;
  const localBranchExists = branchQueryValue
    ? branches.some((branch) => branch.branchType === "local" && branch.name === branchQueryValue)
    : false;
  const canCreateBranchFromQuery = branchQueryValue.length > 0 && !localBranchExists;
  const hasSearchResults = localBranches.length > 0 || remoteBranches.length > 0;

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (firstCheckoutBranch) onCheckout(firstCheckoutBranch);
  };

  return (
    <>
      <div className="fixed inset-0 z-[19]" onClick={onClose} aria-hidden="true" />
      <div
        className="ui-thin-scroll absolute bottom-full left-0 z-20 mb-1 flex max-h-[360px] w-[280px] max-w-[calc(100vw-24px)] flex-col overflow-y-auto rounded border py-1 shadow-lg"
        style={{ backgroundColor: TERM.bg, borderColor: TERM.dim }}
        role="menu"
      >
        <div className="flex flex-col gap-1 border-b px-2 pb-2 pt-1.5" style={{ borderColor: TERM.dim }}>
          <button
            type="button"
            onClick={onFetch}
            disabled={branchActionBusy}
            className="ui-focus-ring flex items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px] transition-opacity hover:opacity-80 disabled:opacity-40"
            style={{ color: TERM.cyan, border: `1px solid ${panelColorTint(TERM.cyan, 28)}` }}
          >
            <span className="flex items-center gap-1.5">
              <RefreshCw size={11} className={fetching ? "animate-spin" : ""} />
              {fetching ? t("git.branch.fetching") : t("git.branch.fetch")}
            </span>
          </button>

          <div className="flex items-center gap-1 rounded px-2 py-1" style={{ border: `1px solid ${TERM.dim}` }}>
            <Search size={12} className="shrink-0" style={{ color: TERM.dim }} />
            <input
              value={branchQuery}
              onChange={(event) => setBranchQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={t("git.branch.searchPlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-[11px] outline-none"
              style={{ color: TERM.fg }}
            />
          </div>

          {canCreateBranchFromQuery && (
            <button
              type="button"
              onClick={() => onCreate(branchQueryValue)}
              disabled={branchActionBusy}
              className="ui-focus-ring flex items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{ color: TERM.green, border: `1px solid ${panelColorTint(TERM.green, 34)}` }}
              title={t("git.branch.create")}
              aria-label={t("git.branch.create")}
            >
              <Plus size={12} />
              <span className="min-w-0 flex-1 truncate">{t("git.branch.createFromSearch", { branch: branchQueryValue })}</span>
            </button>
          )}
        </div>

        {!hasSearchResults && branchSearchMatcher ? (
          <div className="px-3 py-2 text-[11px]" style={{ color: TERM.dim }}>{t("git.branch.noSearchResults")}</div>
        ) : (
          <>
            <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: TERM.dim }}>
              {t("git.branch.local")}
            </div>
            {branchLoading && branches.length === 0 ? (
              <div className="px-3 py-1 text-[11px]" style={{ color: TERM.dim }}>{t("common.loading")}</div>
            ) : localBranches.length === 0 ? (
              <div className="px-3 py-1 text-[11px]" style={{ color: TERM.dim }}>{t("git.branch.emptyLocal")}</div>
            ) : (
              <>
                {visibleLocalBranches.map((item) => (
                  <button
                    key={`local:${item.name}`}
                    type="button"
                    role="menuitem"
                    onClick={() => onCheckout(item)}
                    disabled={branchActionBusy || item.current}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-opacity hover:opacity-80 disabled:opacity-50"
                    style={{
                      color: item.current ? TERM.cyan : TERM.fg,
                      backgroundColor: item.current ? panelColorTint(TERM.cyan, 12) : "transparent",
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {item.upstream && <span className="shrink-0 text-[9px]" style={{ color: TERM.dim }}>{item.upstream}</span>}
                    {item.current && <Check size={11} className="shrink-0" />}
                  </button>
                ))}
                {localBranches.length > visibleLocalBranches.length && (
                  <div className="px-3 py-1 text-[10px]" style={{ color: TERM.dim }}>
                    {t("git.branch.moreResults", { count: localBranches.length - visibleLocalBranches.length })}
                  </div>
                )}
              </>
            )}

            <div className="mt-1 border-t px-2 py-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: TERM.dim, borderColor: TERM.dim }}>
              {t("git.branch.remote")}
            </div>
            {remoteBranches.length === 0 ? (
              <div className="px-3 py-1 text-[11px]" style={{ color: TERM.dim }}>{t("git.branch.emptyRemote")}</div>
            ) : (
              <>
                {visibleRemoteBranches.map((item) => (
                  <button
                    key={`remote:${item.name}`}
                    type="button"
                    role="menuitem"
                    onClick={() => onCheckout(item)}
                    disabled={branchActionBusy}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-opacity hover:opacity-80 disabled:opacity-50"
                    style={{ color: TERM.fg }}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    <span className="shrink-0 text-[9px]" style={{ color: TERM.dim }}>{t("git.branch.checkoutRemote")}</span>
                  </button>
                ))}
                {remoteBranches.length > visibleRemoteBranches.length && (
                  <div className="px-3 py-1 text-[10px]" style={{ color: TERM.dim }}>
                    {t("git.branch.moreResults", { count: remoteBranches.length - visibleRemoteBranches.length })}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

export function GitChangesPanel({ open, projectPath, projectId, visible = true, embedded = false }: GitChangesPanelProps) {
  const { t } = useI18n();
  const projects = useProjectStore((state) => state.projects);
  const {
    fetchChanges,
    reset,
    changes,
    tree,
    untrackedTree,
    collapsedDirs,
    loading,
    statusFilter,
    setStatusFilter,
    collapseAllDirs,
    expandAllDirs,
    discardFile,
    discardAll,
    deleteUntrackedPaths,
    discarding,
    loadFileDiff,
    revertHunk,
    revertLines,
    stageFile,
    unstageFile,
    stagePaths,
    unstagePaths,
    commit,
    committing,
    branchStatus,
    branches,
    pushing,
    pulling,
    fetching,
    branchLoading,
    checkingOutBranch,
    creatingBranch,
    error,
    push,
    fetchRemote,
    checkoutBranch,
    smartCheckoutBranch,
    createBranch,
    pull,
    pullAbort,
    rebaseContinue,
    selectedUntracked,
    setUntrackedSelection,
    clearUntrackedSelection,
    deselectedAdded,
    setAddedDeselection,
    repositories,
    activeRepoPath,
    setActiveRepo,
    fetchRepositories,
    fetchBranches,
  } = useGitStore();
  const { gitGroupBy, update: updateSettings } = useSettingsStore();
  const openFileProject = useFileExplorerStore((state) => state.openProject);
  const openFile = useFileExplorerStore((state) => state.openFile);
  const openFileEditorPane = useTerminalStore((state) => state.openFileEditorPane);
  const [diffModalOpen, setDiffModalOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string; status: string } | null>(null);
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<{ path: string; name: string; status: string } | null>(null);
  const [deleteUntrackedTarget, setDeleteUntrackedTarget] = useState<{ paths: string[]; name: string } | null>(null);
  const [smartCheckoutTarget, setSmartCheckoutTarget] = useState<GitBranchInfo | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [pullMenuOpen, setPullMenuOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [groupByMenuOpen, setGroupByMenuOpen] = useState(false);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const [hideFilterLabels, setHideFilterLabels] = useState(false);
  const filterRowRef = useRef<HTMLDivElement | null>(null);
  const panelActive = open && visible;
  const project = useMemo<Project | null>(() => (
    projectId ? projects.find((item) => item.id === projectId) ?? null : findProjectByPath(projects, projectPath)
  ), [projectId, projectPath, projects]);
  const setRemoteContext = useGitStore((state) => state.setRemoteContext);
  const remoteContext = useGitStore((state) => state.remoteContext);
  // 多仓库切换：根仓库显示项目目录名（取不到时回落「根仓库」文案），子仓库显示相对路径。
  const rootRepoLabel = projectPath?.split(/[\\/]/).filter(Boolean).pop() || t("git.repo.root");
  const activeRepo = activeRepoPath ? repositories.find((repo) => repo.absolutePath === activeRepoPath) : null;
  const activeRepoLabel = activeRepo?.relativePath || rootRepoLabel;

  useEffect(() => {
    if (panelActive && projectPath) {
      if (projectId && !project) {
        setContextLoading(false);
        return;
      }
      let cancelled = false;
      const remoteRequired = project?.environment_type === "ssh";
      setContextLoading(true);
      setRemoteContext(null, remoteRequired);
      void (async () => {
        try {
          const nextRemoteContext = remoteRequired && project
            ? await buildSshRemoteGitContext(project)
            : null;
          if (cancelled) return;
          setRemoteContext(nextRemoteContext, remoteRequired);
          fetchChanges(projectPath);
          setContextLoading(false);
          // 枚举项目根下的多仓库（面板打开 / 项目切换时刷新；fetchChanges 已先设定 currentProjectPath）。
          void fetchRepositories(projectPath);
          void fetchBranches(projectPath);
        } catch (err) {
          if (!cancelled) {
            setContextLoading(false);
            toast.error(formatGitNetError(t("git.title"), String(err), t));
          }
        }
      })();
      return () => { cancelled = true; };
    } else if (!open) {
      setContextLoading(false);
      setRemoteContext(null);
      reset();
    }
  }, [panelActive, open, projectPath, project, fetchChanges, fetchRepositories, fetchBranches, reset, setRemoteContext, t]);

  useEffect(() => {
    const filterRow = filterRowRef.current;
    if (!filterRow) return;

    const updateLabelVisibility = (width: number) => {
      setHideFilterLabels(width < FILTER_LABEL_HIDE_WIDTH);
    };

    updateLabelVisibility(filterRow.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateLabelVisibility(entry.contentRect.width);
    });
    observer.observe(filterRow);

    return () => observer.disconnect();
  }, [changes.length]);

  // fs-watcher 驱动刷新：后端监听项目目录，命中当前项目且窗口活跃时静默刷新。
  // 替代旧的固定轮询；watcher 初始化失败时降级为慢轮询。失焦/隐藏不刷新，重新聚焦立即刷新一次。
  useEffect(() => {
    if (!panelActive || !projectPath || project?.environment_type === "ssh") return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    let fallbackTimer: number | undefined;

    const isActive = () => document.visibilityState === "visible" && document.hasFocus();
    const refreshIfActive = () => {
      if (isActive()) void fetchChanges(projectPath, true);
    };
    const startFallback = () => {
      if (fallbackTimer === undefined) {
        fallbackTimer = window.setInterval(refreshIfActive, FALLBACK_POLL_INTERVAL_MS);
      }
    };
    const stopFallback = () => {
      if (fallbackTimer !== undefined) {
        window.clearInterval(fallbackTimer);
        fallbackTimer = undefined;
      }
    };

    // 订阅后端文件变化事件；按 projectPath 过滤（多窗口天然隔离）。
    void listen<{ projectPath: string }>("git-changed", (event) => {
      if (disposed) return;
      if (event.payload.projectPath === projectPath) refreshIfActive();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    // 启动 watcher；失败则降级为慢轮询。
    void invoke("git_watch_start", { projectPath }).catch((err) => {
      debugConsoleWarn("[GitChangesPanel] git_watch_start 失败，降级慢轮询:", err);
      if (!disposed) startFallback();
    });

    // 重新聚焦/变可见时立即刷新一次（事件可能在失焦期间被忽略）。
    const onFocus = () => refreshIfActive();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshIfActive();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      stopFallback();
      if (unlisten) unlisten();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      void invoke("git_watch_stop").catch(() => {});
    };
  }, [panelActive, projectPath, project?.environment_type, fetchChanges]);

  // 远程项目没有本地 watcher：仅在面板可见且窗口聚焦时低频刷新，重新聚焦立即同步。
  useEffect(() => {
    if (!panelActive || !projectPath || project?.environment_type !== "ssh" || !remoteContext) return;
    let disposed = false;
    const isActive = () => !disposed && document.visibilityState === "visible" && document.hasFocus();
    const refreshIfActive = () => { if (isActive()) void fetchChanges(projectPath, true); };
    const timer = window.setInterval(refreshIfActive, FALLBACK_POLL_INTERVAL_MS);
    const onFocus = () => refreshIfActive();
    const onVisibility = () => { if (document.visibilityState === "visible") refreshIfActive(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [panelActive, projectPath, project?.environment_type, remoteContext, fetchChanges]);

  const directoryPaths = useMemo(
    () => [...collectDirectoryPaths(tree, "tracked"), ...collectDirectoryPaths(untrackedTree, "untracked")],
    [tree, untrackedTree]
  );
  const hasDirectories = directoryPaths.length > 0;
  const allCollapsed = hasDirectories && directoryPaths.every((path) => collapsedDirs.has(path));

  if (!open || !visible) return null;

  const handleRefresh = () => {
    if (projectPath) {
      fetchChanges(projectPath);
    }
  };

  const handleGroupByChange = async (mode: "directory" | "module") => {
    setGroupByMenuOpen(false);
    await updateSettings("gitGroupBy", mode);
    // 切换后立即刷新树（gitStore 会自动读取新的 gitGroupBy）
    if (projectPath) void fetchChanges(projectPath, false);
  };

  const handleFileClick = (filePath: string) => {
    const fileName = filePath.split(/[\\/]/).pop() || filePath;
    const fileChange = changes.find(c => c.path === filePath);
    if (fileChange) {
      setSelectedFile({ path: filePath, name: fileName, status: fileChange.status });
      setDiffModalOpen(true);
    }
  };

  const handleOpenSourceFile = async (filePath: string, status: string) => {
    if (!project || status === "D") return;
    const fileName = filePath.split(/[\\/]/).pop() || filePath;
    try {
      await openFileProject(project);
      await openFile({ name: fileName, path: filePath, kind: "file", sizeBytes: 0 });
      openFileEditorPane(project);
    } catch (err) {
      toast.error(t("files.toast.openFileFailed"), { description: String(err) });
    }
  };

  const handleRequestDiscard = (path: string, name: string, status: string) => {
    setDiscardTarget({ path, name, status });
  };

  const handleRequestDeleteUntracked = (paths: string[], name: string) => {
    if (paths.length === 0) return;
    setDeleteUntrackedTarget({ paths, name });
  };

  const allCount = changes.length;
  const modifiedCount = changes.filter((c) => c.status === "M").length;
  const addedCount = changes.filter((c) => c.status === "A" || c.status === "U" || c.status === "??").length;
  const deletedCount = changes.filter((c) => c.status === "D").length;
  // 可回滚（已跟踪）文件数：排除未跟踪 U/??。
  const trackableCount = changes.filter((c) => c.status !== "U" && c.status !== "??").length;
  // 总增删行数聚合（真实 diff 行数，后端 git_get_changes 提供）。
  const totalAdded = changes.reduce((sum, c) => sum + (c.added || 0), 0);
  const totalDeleted = changes.reduce((sum, c) => sum + (c.deleted || 0), 0);
  // 已暂存文件数（真实 git 索引，含 A/M/D/R）。
  const stagedCount = changes.filter((c) => c.staged).length;
  // 被取消勾选的已加入跟踪(A)文件：仍暂存/跟踪，但本次提交不计入。
  const deselectedAddedCount = changes.filter((c) => c.status === "A" && deselectedAdded.has(c.path)).length;
  // 选中的未跟踪文件数（前端态，提交时才 git add）。
  const selectedUntrackedCount = selectedUntracked.size;
  // 待提交总数 = 已暂存 − 取消勾选的 A 文件 + 选中未跟踪。
  const committableCount = stagedCount - deselectedAddedCount + selectedUntrackedCount;
  // 顶部全选三态：以「待提交」与总变更数比较。
  const selectAllState: StageState =
    changes.length === 0 || committableCount === 0
      ? "unchecked"
      : committableCount >= changes.length
        ? "checked"
        : "indeterminate";

  // 各类路径分组，用于全选/全不选。
  const allUntrackedPaths = changes.filter((c) => c.status === "U" || c.status === "??").map((c) => c.path);
  const addedPaths = changes.filter((c) => c.status === "A").map((c) => c.path);
  // 已跟踪且非新增(M/D/R)的路径：全选/全不选时走真实 stage/unstage。
  const trackedModPaths = changes
    .filter((c) => c.status !== "U" && c.status !== "??" && c.status !== "A")
    .map((c) => c.path);

  // 冲突态：存在冲突文件(C) 或 仓库处于合并/变基中 → 显示冲突横幅与中止/继续入口。
  const hasConflicts = changes.some((c) => c.status === "C");
  const pendingOp = branchStatus?.pendingOp ?? null;
  const smartCheckoutConflict = hasConflicts && !!error && error.includes("smart_checkout_apply_conflict");
  const branchActionBusy = fetching || checkingOutBranch || creatingBranch;

  const handleToggleSelectAll = () => {
    if (selectAllState === "checked") {
      // 全部取消：取消暂存 M/D/R + 清空未跟踪选中 + 取消勾选全部 A（A 保持跟踪，不 unstage）。
      if (trackedModPaths.length > 0) {
        void unstagePaths(trackedModPaths).catch(() => toast.error(t("git.toast.unstageAllFailed")));
      }
      clearUntrackedSelection();
      if (addedPaths.length > 0) setAddedDeselection(addedPaths, true);
    } else {
      // 全选：暂存 M/D/R + 选中全部未跟踪 + 勾选回全部 A。
      if (trackedModPaths.length > 0) {
        void stagePaths(trackedModPaths).catch(() => toast.error(t("git.toast.stageAllFailed")));
      }
      if (allUntrackedPaths.length > 0) setUntrackedSelection(allUntrackedPaths, true);
      if (addedPaths.length > 0) setAddedDeselection(addedPaths, false);
    }
  };

  const handleToggleStage = (filePath: string, staged: boolean) => {
    void (staged ? unstageFile(filePath) : stageFile(filePath)).catch(() => {
      toast.error(t("git.toast.stageFailed"));
    });
  };

  const handleToggleStagePaths = (paths: string[], allStaged: boolean) => {
    void (allStaged ? unstagePaths(paths) : stagePaths(paths)).catch(() => {
      toast.error(t("git.toast.batchStageFailed"));
    });
  };

  const handleConfirmDeleteUntracked = async () => {
    if (!deleteUntrackedTarget) return;
    const target = deleteUntrackedTarget;
    setDeleteUntrackedTarget(null);
    try {
      await deleteUntrackedPaths(target.paths);
      toast.success(t("git.toast.deleteUntrackedSuccess", { count: target.paths.length }));
    } catch (err) {
      toast.error(t("git.toast.deleteUntrackedFailed"), { description: String(err) });
    }
  };

  const handleCommit = async () => {
    const msg = commitMsg.trim();
    if (!msg || committableCount === 0 || committing) return;
    try {
      const shortId = await commit(msg);
      setCommitMsg("");
      toast.success(t("git.toast.committed", { shortId }));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (m.includes("no_git_identity")) {
        toast.error(t("git.toast.commitNoIdentity"));
      } else if (m.includes("nothing_staged")) {
        toast.error(t("git.toast.nothingStaged"));
      } else {
        toast.error(t("git.toast.commitFailed", { message: m }));
      }
    }
  };

  const handlePush = async () => {
    if (pushing) return;
    const settingUpstream = !!branchStatus && !branchStatus.hasUpstream;
    try {
      await push();
      toast.success(settingUpstream ? t("git.toast.pushedWithUpstream") : t("git.toast.pushed"));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      toast.error(formatGitNetError(t("git.error.pushFailed"), m, t));
    }
  };

  const handleFetchRemote = async () => {
    if (branchActionBusy) return;
    try {
      await fetchRemote();
      toast.success(t("git.toast.fetched"));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      toast.error(formatGitNetError(t("git.error.fetchFailed"), m, t));
    }
  };

  const handleCheckoutBranch = async (branch: GitBranchInfo) => {
    if (branchActionBusy || branch.current) return;
    try {
      await checkoutBranch(branch.name, branch.branchType === "remote");
      setBranchMenuOpen(false);
      toast.success(t("git.toast.checkedOutBranch", { branch: branch.name }));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (m.includes("checkout_conflict")) {
        setSmartCheckoutTarget(branch);
        return;
      }
      toast.error(formatGitNetError(t("git.error.checkoutFailed"), m, t));
    }
  };

  const handleSmartCheckoutConfirm = async () => {
    if (!smartCheckoutTarget || branchActionBusy) return;
    const target = smartCheckoutTarget;
    try {
      await smartCheckoutBranch(target.name, target.branchType === "remote");
      toast.success(t("git.toast.smartCheckedOutBranch", { branch: target.name }));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      toast.error(formatGitNetError(t("git.error.smartCheckoutFailed"), m, t));
    } finally {
      setSmartCheckoutTarget(null);
      setBranchMenuOpen(false);
    }
  };

  const handleCreateBranch = async (branchName: string) => {
    const branch = branchName.trim();
    if (!branch || branchActionBusy) return;
    try {
      await createBranch(branch);
      setBranchMenuOpen(false);
      toast.success(t("git.toast.createdBranch", { branch }));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      toast.error(formatGitNetError(t("git.error.createBranchFailed"), m, t));
    }
  };

  const handlePull = async (strategy: GitPullStrategy) => {
    if (pulling) return;
    try {
      await pull(strategy);
      toast.success(t("git.toast.pulled"));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (m.includes("pull_conflict")) {
        toast.error(
          strategy === "rebase"
            ? t("git.toast.pullConflictRebase")
            : t("git.toast.pullConflictMerge"),
        );
      } else if (m.includes("not_fast_forward")) {
        toast.error(t("git.toast.notFastForward"));
      } else {
        toast.error(formatGitNetError(t("git.error.pullFailed"), m, t));
      }
    }
  };

  const handlePullAbort = async () => {
    if (pulling) return;
    try {
      await pullAbort();
      toast.success(t("git.toast.aborted"));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      toast.error(formatGitNetError(t("git.error.abortFailed"), m, t));
    }
  };

  const handleRebaseContinue = async () => {
    if (pulling) return;
    try {
      await rebaseContinue();
      toast.success(t("git.toast.rebaseContinued"));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (m.includes("pull_conflict")) {
        toast.error(t("git.toast.unresolvedConflicts"));
      } else {
        toast.error(formatGitNetError(t("git.error.continueRebaseFailed"), m, t));
      }
    }
  };

  const filterButtons: {
    labelKey: TranslationKey;
    value: "all" | "M" | "A" | "D";
    count: number;
    color: string;
    icon: typeof Files;
  }[] = [
    { labelKey: "git.filter.all", value: "all", count: allCount, color: TERM.fg, icon: Files },
    { labelKey: "git.filter.modified", value: "M", count: modifiedCount, color: STATUS_CONFIG.M.color, icon: FilePen },
    { labelKey: "git.filter.added", value: "A", count: addedCount, color: STATUS_CONFIG.A.color, icon: FilePlus },
    { labelKey: "git.filter.deleted", value: "D", count: deletedCount, color: STATUS_CONFIG.D.color, icon: FileMinus },
  ];

  const panelClassName = embedded
    ? "flex h-full min-h-0 flex-col overflow-hidden font-mono"
    : "relative z-[1] flex w-[184px] shrink-0 flex-col overflow-hidden border-l border-border font-mono";
  const Container = embedded ? "div" : "aside";
  return (
    <Container
      className={panelClassName}
      style={{ backgroundColor: TERM.bg, ...TERMINAL_PANEL_SCROLLBAR_STYLE }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b px-2 py-1.5" style={{ borderColor: TERM.dim }}>
        <span className="flex items-center gap-2 text-[11px] font-bold" style={{ color: TERM.fg }}>
          <GitBranch size={12} strokeWidth={2} />
          {t("git.title")}
        </span>
        <span className="flex items-center gap-1.5">
          {/* Group By 切换下拉 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setGroupByMenuOpen(!groupByMenuOpen)}
              className="ui-focus-ring flex items-center gap-1 rounded px-1 py-0.5 text-[10px] transition-colors"
              style={{ color: TERM.cyan, backgroundColor: panelColorTint(TERM.cyan, 7) }}
              title={t("git.groupBy")}
              aria-label={t("git.groupBy")}
            >
              {gitGroupBy === "module" ? <Layers size={10} /> : <FolderTree size={10} />}
              <ChevronDown size={8} />
            </button>
            {groupByMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setGroupByMenuOpen(false)}
                  aria-hidden="true"
                />
                <div
                  className="absolute right-0 top-full z-20 mt-1 flex min-w-[120px] flex-col rounded border py-1 shadow-lg"
                  style={{ backgroundColor: TERM.bg, borderColor: TERM.dim }}
                >
                  <button
                    type="button"
                    onClick={() => handleGroupByChange("directory")}
                    className="flex items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors"
                    style={{
                      color: gitGroupBy === "directory" ? TERM.cyan : TERM.fg,
                      backgroundColor: gitGroupBy === "directory" ? panelColorTint(TERM.cyan, 13) : "transparent",
                    }}
                    onMouseEnter={(e) => {
                      if (gitGroupBy !== "directory") e.currentTarget.style.backgroundColor = panelColorTint(TERM.cyan, 6);
                    }}
                    onMouseLeave={(e) => {
                      if (gitGroupBy !== "directory") e.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    <FolderTree size={12} />
                    <span>Directory</span>
                    {gitGroupBy === "directory" && <Check size={11} style={{ marginLeft: "auto" }} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleGroupByChange("module")}
                    className="flex items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors"
                    style={{
                      color: gitGroupBy === "module" ? TERM.cyan : TERM.fg,
                      backgroundColor: gitGroupBy === "module" ? panelColorTint(TERM.cyan, 13) : "transparent",
                    }}
                    onMouseEnter={(e) => {
                      if (gitGroupBy !== "module") e.currentTarget.style.backgroundColor = panelColorTint(TERM.cyan, 6);
                    }}
                    onMouseLeave={(e) => {
                      if (gitGroupBy !== "module") e.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    <Layers size={12} />
                    <span>Module</span>
                    {gitGroupBy === "module" && <Check size={11} style={{ marginLeft: "auto" }} />}
                  </button>
                </div>
              </>
            )}
          </div>
          {changes.length > 0 && (
            <StageCheckbox
              state={selectAllState}
              onToggle={handleToggleSelectAll}
              title={selectAllState === "checked" ? t("git.unselectAll") : t("git.selectAll")}
            />
          )}
          {hasDirectories && (
            <button
              type="button"
              onClick={allCollapsed ? expandAllDirs : collapseAllDirs}
              className="ui-focus-ring rounded px-1 py-0.5 text-[10px] transition-colors"
              style={{ color: TERM.cyan, backgroundColor: panelColorTint(TERM.cyan, 7) }}
              title={allCollapsed ? t("git.expandTree") : t("git.collapseTree")}
              aria-label={allCollapsed ? t("git.expandTree") : t("git.collapseTree")}
            >
              {allCollapsed ? t("git.expand") : t("git.collapse")}
            </button>
          )}
          {trackableCount > 0 && (
            <button
              type="button"
              onClick={() => setConfirmAllOpen(true)}
              disabled={discarding}
              className="ui-focus-ring rounded p-0.5 disabled:opacity-40"
              style={{ color: TERM.red }}
              title={t("git.discardAllTracked")}
              aria-label={t("git.discardAllTracked")}
            >
              <Undo2 size={11} />
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            className={`ui-focus-ring rounded p-0.5 ${loading ? "animate-spin" : ""}`}
            style={{ color: TERM.cyan }}
            title={t("common.refresh")}
            aria-label={t("git.refresh")}
          >
            <RefreshCw size={11} />
          </button>
        </span>
      </div>

      {/* 仓库切换：项目下检测到多个 Git 仓库时展示下拉（单仓库零 UI 变化） */}
      {repositories.length > 1 && (
        <div className="relative shrink-0 border-b px-2 py-1.5" style={{ borderColor: TERM.dim }}>
          <button
            type="button"
            onClick={() => setRepoMenuOpen(!repoMenuOpen)}
            className="ui-focus-ring flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors"
            style={{ color: TERM.cyan, backgroundColor: panelColorTint(TERM.cyan, 7) }}
            title={t("git.repo.switch")}
            aria-label={t("git.repo.switch")}
            aria-haspopup="menu"
            aria-expanded={repoMenuOpen}
          >
            <FolderGit2 size={10} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{activeRepoLabel}</span>
            <ChevronDown size={8} className="shrink-0" />
          </button>
          {repoMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setRepoMenuOpen(false)}
                aria-hidden="true"
              />
              <div
                className="ui-thin-scroll absolute left-2 right-2 top-full z-20 mt-1 flex max-h-[240px] flex-col overflow-y-auto rounded border py-1 shadow-lg"
                style={{ backgroundColor: TERM.bg, borderColor: TERM.dim }}
                role="menu"
              >
                {repositories.map((repo) => {
                  const isRoot = repo.relativePath === "";
                  const selected = isRoot ? activeRepoPath === null : activeRepoPath === repo.absolutePath;
                  const label = isRoot ? rootRepoLabel : repo.relativePath;
                  return (
                    <button
                      key={repo.absolutePath}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setRepoMenuOpen(false);
                        setActiveRepo(isRoot ? null : repo.absolutePath);
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors"
                      style={{
                        color: selected ? TERM.cyan : TERM.fg,
                        backgroundColor: selected ? panelColorTint(TERM.cyan, 13) : "transparent",
                      }}
                      onMouseEnter={(e) => {
                        if (!selected) e.currentTarget.style.backgroundColor = panelColorTint(TERM.cyan, 6);
                      }}
                      onMouseLeave={(e) => {
                        if (!selected) e.currentTarget.style.backgroundColor = "transparent";
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      {repo.branch && (
                        <span className="shrink-0 text-[9px]" style={{ color: TERM.dim }}>{repo.branch}</span>
                      )}
                      {selected && <Check size={11} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Filter */}
      {changes.length > 0 && (
        <div ref={filterRowRef} className="flex w-full shrink-0 gap-1 border-b px-2 py-1.5" style={{ borderColor: TERM.dim }}>
          {filterButtons.map((btn) => {
            const Icon = btn.icon;
            const active = statusFilter === btn.value;
            const label = t(btn.labelKey);
            const title = `${label} ${btn.count}`;
            return (
              <button
                key={btn.value}
                type="button"
                onClick={() => setStatusFilter(btn.value)}
                className="ui-focus-ring flex min-w-0 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] transition-colors"
                title={title}
                aria-label={title}
                aria-pressed={active}
                style={{
                  backgroundColor: active ? panelColorTint(btn.color, 19) : "transparent",
                  color: active ? btn.color : TERM.dim,
                  border: `1px solid ${active ? btn.color : "transparent"}`,
                }}
              >
                <Icon size={11} strokeWidth={2} style={{ color: btn.color }} />
                {!hideFilterLabels && <span>{label}</span>}
                <span className="font-bold">{btn.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Summary */}
      {changes.length > 0 && (
        <div className="shrink-0 border-b px-2 py-1.5 text-[10px]" style={{ borderColor: TERM.dim, color: TERM.dim }}>
          <span style={{ color: TERM.fg }}>{t("git.summary.files", { count: allCount })}</span>
          {modifiedCount > 0 && (
            <>
              {" · "}
              <span style={{ color: STATUS_CONFIG.M.color }}>{t("git.summary.modified", { count: modifiedCount })}</span>
            </>
          )}
          {addedCount > 0 && (
            <>
              {" · "}
              <span style={{ color: STATUS_CONFIG.A.color }}>{t("git.summary.added", { count: addedCount })}</span>
            </>
          )}
          {deletedCount > 0 && (
            <>
              {" · "}
              <span style={{ color: STATUS_CONFIG.D.color }}>{t("git.summary.deleted", { count: deletedCount })}</span>
            </>
          )}
          {(totalAdded > 0 || totalDeleted > 0) && (
            <>
              {" · "}
              {totalAdded > 0 && <span style={{ color: TERM.green }}>+{totalAdded}</span>}
              {totalAdded > 0 && totalDeleted > 0 && " "}
              {totalDeleted > 0 && <span style={{ color: TERM.red }}>-{totalDeleted}</span>}
            </>
          )}
        </div>
      )}

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2 ui-thin-scroll">
        {!projectPath ? (
          <EmptyHint text={t("git.empty.noProject")} />
        ) : (contextLoading || loading) && changes.length === 0 ? (
          <EmptyHint text={t("common.loading")} />
        ) : changes.length === 0 ? (
          <EmptyHint text={t("git.empty.noChanges")} />
        ) : (
          <>
            {tree.length > 0 && (
              <div>
                <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: TERM.dim }}>
                  {t("git.section.changed")}
                </div>
                <GitChangesTree
                  project={project}
                  nodes={tree}
                  treeId="tracked"
                  onFileClick={handleFileClick}
                  onOpenSourceFile={handleOpenSourceFile}
                  onRequestDiscard={handleRequestDiscard}
                  onRequestDeleteUntracked={handleRequestDeleteUntracked}
                  onToggleStage={handleToggleStage}
                  onToggleStagePaths={handleToggleStagePaths}
                />
              </div>
            )}
            {/* 未跟踪文件单独成组（仿 JetBrains Unversioned Files），M/D 筛选下隐藏 */}
            {untrackedTree.length > 0 && statusFilter !== "M" && statusFilter !== "D" && (
              <div className={tree.length > 0 ? "mt-2 border-t pt-2" : ""} style={{ borderColor: TERM.dim }}>
                <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: TERM.dim }}>
                  {t("git.section.untracked")}
                </div>
                <GitChangesTree
                  project={project}
                  nodes={untrackedTree}
                  treeId="untracked"
                  onFileClick={handleFileClick}
                  onOpenSourceFile={handleOpenSourceFile}
                  onRequestDiscard={handleRequestDiscard}
                  onRequestDeleteUntracked={handleRequestDeleteUntracked}
                  onToggleStage={handleToggleStage}
                  onToggleStagePaths={handleToggleStagePaths}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* 分支状态行：分支名 + ↑ahead ↓behind + 推送/拉取按钮。提交后即使无变更也展示，便于推送已有提交。 */}
      {projectPath && branchStatus && (branchStatus.branch || branchStatus.detached) && (() => {
        const { branch, ahead, behind, hasUpstream, detached } = branchStatus;
        const branchLabel = !detached && branch ? `${activeRepoLabel}/${branch}` : branch;
        const canPush = !detached && !!branch && (ahead > 0 || !hasUpstream);
        const showPull = !detached && hasUpstream && behind > 0;
        return (
          <div className="flex shrink-0 items-center justify-between gap-2 border-t px-2 py-1.5" style={{ borderColor: TERM.dim }}>
            <span className="relative flex min-w-0 items-center gap-1.5 text-[11px]" style={{ color: TERM.fg }}>
              <button
                type="button"
                onClick={() => setBranchMenuOpen((value) => !value)}
                className="ui-focus-ring flex min-w-0 items-center gap-1 rounded px-1 py-0.5 transition-colors"
                style={{ color: TERM.fg, backgroundColor: branchMenuOpen ? panelColorTint(TERM.cyan, 10) : "transparent" }}
                title={t("git.branch.switch")}
                aria-label={t("git.branch.switch")}
                aria-haspopup="menu"
                aria-expanded={branchMenuOpen}
              >
                <GitBranch size={12} strokeWidth={2} style={{ color: TERM.dim }} className="shrink-0" />
                <span className="truncate">{detached ? t("git.branch.detached") : branchLabel}</span>
                <ChevronDown size={10} className="shrink-0" />
              </button>
              {branchMenuOpen && (
                <GitBranchMenu
                  branches={branches}
                  branchLoading={branchLoading}
                  fetching={fetching}
                  branchActionBusy={branchActionBusy}
                  t={t}
                  onClose={() => setBranchMenuOpen(false)}
                  onFetch={() => void handleFetchRemote()}
                  onCheckout={(item) => void handleCheckoutBranch(item)}
                  onCreate={(branch) => void handleCreateBranch(branch)}
                />
              )}
              {!detached && hasUpstream && (
                <span className="flex shrink-0 items-center gap-1.5" style={{ color: TERM.dim }}>
                  <span className="flex items-center" style={{ color: ahead > 0 ? TERM.fg : TERM.dim }}>
                    <ArrowUp size={10} strokeWidth={2} />{ahead}
                  </span>
                  <span className="flex items-center" style={{ color: behind > 0 ? TERM.fg : TERM.dim }}>
                    <ArrowDown size={10} strokeWidth={2} />{behind}
                  </span>
                </span>
              )}
              {!detached && branch && !hasUpstream && (
                <span className="shrink-0 text-[10px]" style={{ color: TERM.dim }}>{t("git.branch.noUpstream")}</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {showPull && (
                <span className="relative flex items-stretch">
                  <button
                    type="button"
                    onClick={() => void handlePull("merge")}
                    disabled={pulling}
                    className="ui-focus-ring flex items-center gap-1 rounded-l px-2 py-0.5 text-[11px] transition-opacity hover:opacity-80 disabled:opacity-40"
                    style={{ color: TERM.cyan, border: `1px solid ${panelColorTint(TERM.cyan, 34)}`, borderRight: "none" }}
                    title={t("git.pull.title")}
                  >
                    <Download size={12} />
                    {pulling ? t("git.pull.loading") : t("git.pull.count", { count: behind })}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPullMenuOpen((v) => !v)}
                    disabled={pulling}
                    className="ui-focus-ring flex items-center justify-center rounded-r px-1 transition-opacity hover:opacity-80 disabled:opacity-40"
                    style={{ color: TERM.cyan, border: `1px solid ${panelColorTint(TERM.cyan, 34)}` }}
                    title={t("git.pull.method")}
                    aria-haspopup="menu"
                    aria-expanded={pullMenuOpen}
                  >
                    <ChevronDown size={12} />
                  </button>
                  {pullMenuOpen && (
                    <>
                      <div className="fixed inset-0 z-[19]" onClick={() => setPullMenuOpen(false)} />
                      <div
                        className="absolute bottom-full right-0 z-20 mb-1 min-w-[148px] overflow-hidden rounded border shadow-lg"
                        style={{ backgroundColor: TERM.bg, borderColor: TERM.dim }}
                        role="menu"
                      >
                        {([
                          { s: "merge", label: t("git.pull.merge"), desc: t("git.pull.mergeDescription") },
                          { s: "rebase", label: t("git.pull.rebase"), desc: t("git.pull.rebaseDescription") },
                          { s: "ff-only", label: t("git.pull.ffOnly"), desc: t("git.pull.ffOnlyDescription") },
                        ] as { s: GitPullStrategy; label: string; desc: string }[]).map((o) => (
                          <button
                            key={o.s}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setPullMenuOpen(false);
                              void handlePull(o.s);
                            }}
                            className="flex w-full items-center justify-between gap-3 px-2 py-1 text-left text-[11px] transition-opacity hover:opacity-80"
                            style={{ color: TERM.fg }}
                          >
                            <span>{o.label}</span>
                            <span className="text-[9px]" style={{ color: TERM.dim }}>{o.desc}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </span>
              )}
              <button
                type="button"
                onClick={() => void handlePush()}
                disabled={pushing || !canPush}
                className="ui-focus-ring flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-opacity hover:opacity-80 disabled:opacity-40"
                style={{ color: TERM.green, border: `1px solid ${panelColorTint(TERM.green, 34)}` }}
                title={hasUpstream ? t("git.push.title") : t("git.push.setUpstreamTitle")}
              >
                <Upload size={12} />
                {pushing ? t("git.push.loading") : ahead > 0 ? t("git.push.count", { count: ahead }) : t("git.push.action")}
              </button>
            </span>
          </div>
        );
      })()}

      {/* 冲突横幅：合并/变基进行中或存在冲突文件时出现，提供「继续」(变基) 与「中止」安全退路。 */}
      {projectPath && pendingOp && (
        <div
          className="flex shrink-0 flex-col gap-1.5 border-t px-2 py-1.5"
          style={{ borderColor: panelColorTint(STATUS_CONFIG.C.color, 34), backgroundColor: panelColorTint(STATUS_CONFIG.C.color, 7) }}
        >
          <span className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: STATUS_CONFIG.C.color }}>
            <GitMerge size={12} strokeWidth={2} />
            {pendingOp === "rebase" ? t("git.conflict.rebaseInProgress") : t("git.conflict.mergeInProgress")}
            {hasConflicts && <span className="font-normal">· {t("git.conflict.hasConflicts")}</span>}
          </span>
          <span className="text-[10px] leading-snug" style={{ color: TERM.dim }}>
            {pendingOp === "rebase"
              ? t("git.conflict.rebaseHint")
              : t("git.conflict.mergeHint")}
          </span>
          <span className="flex items-center gap-1.5">
            {pendingOp === "rebase" && (
              <button
                type="button"
                onClick={() => void handleRebaseContinue()}
                disabled={pulling || hasConflicts}
                className="ui-focus-ring flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-opacity hover:opacity-80 disabled:opacity-40"
                style={{ color: TERM.green, border: `1px solid ${panelColorTint(TERM.green, 34)}` }}
                title={hasConflicts ? t("git.conflict.resolveFirst") : t("git.conflict.continueRebase")}
              >
                <Check size={12} /> {t("git.conflict.continue")}
              </button>
            )}
            <button
              type="button"
              onClick={() => void handlePullAbort()}
              disabled={pulling}
              className="ui-focus-ring flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{ color: STATUS_CONFIG.C.color, border: `1px solid ${panelColorTint(STATUS_CONFIG.C.color, 34)}` }}
              title={t("git.conflict.abort")}
            >
              <X size={12} /> {t("git.conflict.abort")}
            </button>
          </span>
        </div>
      )}

      {projectPath && smartCheckoutConflict && (
        <div
          className="flex shrink-0 flex-col gap-1 border-t px-2 py-1.5"
          style={{ borderColor: panelColorTint(STATUS_CONFIG.C.color, 34), backgroundColor: panelColorTint(STATUS_CONFIG.C.color, 7) }}
        >
          <span className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: STATUS_CONFIG.C.color }}>
            <GitMerge size={12} strokeWidth={2} />
            {t("git.smartCheckout.conflictTitle")}
          </span>
          <span className="text-[10px] leading-snug" style={{ color: TERM.dim }}>
            {t("git.smartCheckout.conflictHint")}
          </span>
        </div>
      )}

      {/* 提交栏：仅文件级 stage + commit（无 AI） */}
      {projectPath && changes.length > 0 && (
        <div className="shrink-0 border-t px-2 py-2" style={{ borderColor: TERM.dim }}>
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Enter 提交
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                void handleCommit();
              }
            }}
            rows={2}
            placeholder={committableCount > 0 ? t("git.commit.placeholder") : t("git.commit.placeholderNoFiles")}
            className="ui-thin-scroll w-full resize-none rounded px-2 py-1 text-[11px] outline-none"
            style={{ backgroundColor: TERM.bg, color: TERM.fg, border: `1px solid ${TERM.dim}` }}
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[10px]" style={{ color: TERM.dim }}>
              {t("git.commit.pendingFiles", { count: committableCount })}
              {selectedUntrackedCount > 0 && (
                <span style={{ color: TERM.dim }}>（{t("git.commit.includesUntracked", { count: selectedUntrackedCount })}）</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => void handleCommit()}
              disabled={committing || committableCount === 0 || commitMsg.trim().length === 0}
              className="ui-focus-ring flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{ color: TERM.green, border: `1px solid ${panelColorTint(TERM.green, 34)}` }}
              title={t("git.commit.title")}
            >
              <GitCommitHorizontal size={12} />
              {committing ? t("git.commit.loading") : `${t("git.commit.action")} (${committableCount})`}
            </button>
          </div>
        </div>
      )}

      {/* Diff Modal：diff 请求指向生效仓库（激活的子仓库或项目根） */}
      {selectedFile && projectPath && (
        <DiffViewerModal
          open={diffModalOpen}
          onClose={() => setDiffModalOpen(false)}
          projectPath={activeRepoPath ?? projectPath}
          filePath={selectedFile.path}
          fileName={selectedFile.name}
          status={selectedFile.status}
          loadDiff={loadFileDiff}
          revertHunk={revertHunk}
          revertLines={revertLines}
          onRequestDiscard={handleRequestDiscard}
        />
      )}

      {/* 单文件回滚确认 */}
      <ConfirmDialog
        open={!!discardTarget}
        title={t("git.confirm.revertTitle")}
        message={discardTarget ? t("git.confirm.revertMessage", { name: discardTarget.name }) : undefined}
        confirmText={t("git.confirm.revert")}
        cancelText={t("common.cancel")}
        danger
        onConfirm={() => {
          if (discardTarget) void discardFile(discardTarget.path, discardTarget.status);
          setDiscardTarget(null);
        }}
        onClose={() => setDiscardTarget(null)}
      />

      <ConfirmDialog
        open={!!deleteUntrackedTarget}
        title={t("git.confirm.deleteUntrackedTitle")}
        message={deleteUntrackedTarget ? t("git.confirm.deleteUntrackedMessage", { name: deleteUntrackedTarget.name, count: deleteUntrackedTarget.paths.length }) : undefined}
        confirmText={t("git.confirm.deleteUntracked")}
        cancelText={t("common.cancel")}
        danger
        onConfirm={() => void handleConfirmDeleteUntracked()}
        onClose={() => setDeleteUntrackedTarget(null)}
      />

      {/* Smart Checkout：用户确认后才 stash 并切换，避免自动移动未提交改动。 */}
      <ConfirmDialog
        open={!!smartCheckoutTarget}
        title={t("git.smartCheckout.title")}
        message={smartCheckoutTarget ? t("git.smartCheckout.message", { branch: smartCheckoutTarget.name }) : undefined}
        confirmText={checkingOutBranch ? t("git.smartCheckout.loading") : t("git.smartCheckout.confirm")}
        cancelText={t("common.cancel")}
        onConfirm={() => void handleSmartCheckoutConfirm()}
        onClose={() => {
          if (!checkingOutBranch) setSmartCheckoutTarget(null);
        }}
      />

      {/* 丢弃全部确认 */}
      <ConfirmDialog
        open={confirmAllOpen}
        title={t("git.confirm.discardAllTitle")}
        message={t("git.confirm.discardAllMessage", { count: trackableCount })}
        confirmText={t("git.confirm.discardAll")}
        cancelText={t("common.cancel")}
        danger
        onConfirm={() => {
          setConfirmAllOpen(false);
          void discardAll();
        }}
        onClose={() => setConfirmAllOpen(false)}
      />
    </Container>
  );
}
