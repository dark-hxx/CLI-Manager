import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { RefreshCw, GitBranch, Undo2, Files, FilePen, FilePlus, FileMinus, GitCommitHorizontal, ArrowUp, ArrowDown, Upload, Download, ChevronDown, GitMerge, Check, X, FolderTree, Layers } from "lucide-react";
import { useGitStore } from "../../stores/gitStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { GitChangesTree } from "./GitChangesTree";
import { StageCheckbox, type StageState } from "./StageCheckbox";
import { STATUS_CONFIG } from "./GitStatusIcon";
import { DiffViewerModal } from "./DiffViewerModal";
import { ConfirmDialog } from "../ConfirmDialog";
import { TERM, EmptyHint, panelColorTint } from "../stats/termStatsUi";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import type { GitTreeNode, GitPullStrategy } from "../../lib/types";

interface GitChangesPanelProps {
  open: boolean;
  projectPath: string | null;
  visible?: boolean;
  embedded?: boolean;
}

// 降级慢轮询间隔：仅当 fs-watcher 初始化失败（网络盘/WSL 等 notify 不可用）时启用。
const FALLBACK_POLL_INTERVAL_MS = 15000;
const FILTER_LABEL_HIDE_WIDTH = 260;
const TERMINAL_PANEL_SCROLLBAR_STYLE = {
  "--ui-scrollbar-thumb": TERM.border,
  "--ui-scrollbar-track": TERM.bg,
} as CSSProperties;

type Translate = ReturnType<typeof useI18n>["t"];

// 把后端 git 网络错误码（形如 "auth_failed: <原文>"）映射为当前语言的 toast。
function formatGitNetError(prefix: string, raw: string, t: Translate): string {
  if (raw.includes("auth_failed")) return t("git.error.authFailed", { prefix });
  if (raw.includes("not_fast_forward")) return t("git.error.notFastForward", { prefix });
  if (raw.includes("no_upstream")) return t("git.error.noUpstream", { prefix });
  if (raw.includes("no_remote")) return t("git.error.noRemote", { prefix });
  if (raw.includes("pull_conflict")) return t("git.error.pullConflict", { prefix });
  if (raw.includes("git_not_found")) return t("git.error.gitNotFound", { prefix });
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

export function GitChangesPanel({ open, projectPath, visible = true, embedded = false }: GitChangesPanelProps) {
  const { t } = useI18n();
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
    discarding,
    stageFile,
    unstageFile,
    stagePaths,
    unstagePaths,
    commit,
    committing,
    branchStatus,
    pushing,
    pulling,
    push,
    pull,
    pullAbort,
    rebaseContinue,
    selectedUntracked,
    setUntrackedSelection,
    clearUntrackedSelection,
    deselectedAdded,
    setAddedDeselection,
  } = useGitStore();
  const { gitGroupBy, update: updateSettings } = useSettingsStore();
  const [diffModalOpen, setDiffModalOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string; status: string } | null>(null);
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<{ path: string; name: string; status: string } | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [pullMenuOpen, setPullMenuOpen] = useState(false);
  const [groupByMenuOpen, setGroupByMenuOpen] = useState(false);
  const [hideFilterLabels, setHideFilterLabels] = useState(false);
  const filterRowRef = useRef<HTMLDivElement | null>(null);
  const panelActive = open && visible;

  useEffect(() => {
    if (panelActive && projectPath) {
      fetchChanges(projectPath);
    } else if (!open) {
      reset();
    }
  }, [panelActive, open, projectPath, fetchChanges, reset]);

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
    if (!panelActive || !projectPath) return;

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
      console.warn("[GitChangesPanel] git_watch_start 失败，降级慢轮询:", err);
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
  }, [panelActive, projectPath, fetchChanges]);

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

  const handleRequestDiscard = (path: string, name: string, status: string) => {
    setDiscardTarget({ path, name, status });
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
        ) : loading && changes.length === 0 ? (
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
                  nodes={tree}
                  treeId="tracked"
                  onFileClick={handleFileClick}
                  onRequestDiscard={handleRequestDiscard}
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
                  nodes={untrackedTree}
                  treeId="untracked"
                  onFileClick={handleFileClick}
                  onRequestDiscard={handleRequestDiscard}
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
        const canPush = !detached && !!branch && (ahead > 0 || !hasUpstream);
        const showPull = !detached && hasUpstream && behind > 0;
        return (
          <div className="flex shrink-0 items-center justify-between gap-2 border-t px-2 py-1.5" style={{ borderColor: TERM.dim }}>
            <span className="flex min-w-0 items-center gap-1.5 text-[11px]" style={{ color: TERM.fg }}>
              <GitBranch size={12} strokeWidth={2} style={{ color: TERM.dim }} className="shrink-0" />
              <span className="truncate">{detached ? "detached HEAD" : branch}</span>
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
      {projectPath && (pendingOp || hasConflicts) && (
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

      {/* Diff Modal */}
      {selectedFile && projectPath && (
        <DiffViewerModal
          open={diffModalOpen}
          onClose={() => setDiffModalOpen(false)}
          projectPath={projectPath}
          filePath={selectedFile.path}
          fileName={selectedFile.name}
          status={selectedFile.status}
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
