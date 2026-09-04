import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Download, MoreHorizontal, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { GitRepositoryRef } from "../../../lib/gitTransport";
import type {
  GitBranchInfo,
  GitBranchStatus,
  GitCommitSummary,
  GitHistoryFilters,
  GitTagInfo,
  Project,
  WorktreeRecord,
} from "../../../lib/types";
import { useGitTransportLease } from "../../../hooks/useGitTransportLease";
import { useI18n } from "../../../lib/i18n";
import { TERM, EmptyHint, panelColorTint } from "../../stats/termStatsUi";
import { GitChangesPanel } from "../GitChangesPanel";
import { GitCommitDetails } from "./GitCommitDetails";
import { GitLogTable, type GitCommitAction } from "./GitLogTable";
import { GitRefTree, type GitBranchAction } from "./GitRefTree";
import { GitCompareDialog } from "./GitCompareDialog";
import { GitPowerToolsDialog } from "./GitPowerToolsDialog";
import { useWorktreeStore } from "../../../stores/worktreeStore";
import { WorktreeFinishDialog } from "../../worktree/WorktreeFinishDialog";

interface GitWorkspaceProps {
  active: boolean;
  project: Project | null;
  projectPath: string | null;
  onClose: () => void;
  onOpenWorktreeSession?: (worktree: WorktreeRecord) => void | Promise<void>;
}

type WorkspaceView = "log" | "changes";

type PendingOperation = {
  operation: string;
  branch?: string;
  target?: string;
  mode?: string;
  title: string;
  description: string;
  inputLabel?: string;
  placeholder?: string;
  dangerous?: boolean;
};

function workspaceError(
  error: unknown,
  fallback: string,
  sshUpgrade: string,
  notRepository: string,
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ssh_agent_capability_missing:gitHistory") || message.includes("ssh_agent_capability_missing:gitWorkspaceTools"))
    return sshUpgrade;
  if (message.includes("not_git_repository")) return notRepository;
  return message || fallback;
}

function effectiveProject(
  project: Project | null,
  projectPath: string | null,
): Project | null {
  if (!project || !projectPath) return project;
  if (project.environment_type === "ssh") {
    return project.remote_path === projectPath
      ? project
      : { ...project, remote_path: projectPath };
  }
  return project.path === projectPath
    ? project
    : { ...project, path: projectPath };
}

function dateInputValue(value: number | null): string {
  if (!value) return "";
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function GitWorkspace({
  active,
  project,
  projectPath,
  onClose,
  onOpenWorktreeSession,
}: GitWorkspaceProps) {
  const { t } = useI18n();
  const [view, setView] = useState<WorkspaceView>("log");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [historyRef, setHistoryRef] = useState<string | null>(null);
  const [historyFilters, setHistoryFilters] = useState<GitHistoryFilters>({ scope: "current", references: [], author: "", since: null, until: null, path: "" });
  const [showFilters, setShowFilters] = useState(false);
  const [powerToolsOpen, setPowerToolsOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [repositories, setRepositories] = useState<GitRepositoryRef[]>([]);
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [tags, setTags] = useState<GitTagInfo[]>([]);
  const [branchStatus, setBranchStatus] = useState<GitBranchStatus | null>(
    null,
  );
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingRepositories, setLoadingRepositories] = useState(false);
  const [loadingRefs, setLoadingRefs] = useState(false);
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedBranchName, setSelectedBranchName] = useState<string | null>(null);
  const [compareDialog, setCompareDialog] = useState<{ title: string; content: string } | null>(null);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  const [operationInput, setOperationInput] = useState("");
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [worktreeCreateOpen, setWorktreeCreateOpen] = useState(false);
  const [worktreeName, setWorktreeName] = useState("");
  const [finishWorktree, setFinishWorktree] = useState<WorktreeRecord | null>(null);
  const [recentBranches, setRecentBranches] = useState<string[]>([]);
  const [favoriteBranches, setFavoriteBranches] = useState<string[]>([]);
  const [leftWidth, setLeftWidth] = useState(230);
  const [rightWidth, setRightWidth] = useState(330);
  const repositoryGenerationRef = useRef(0);
  const refGenerationRef = useRef(0);
  const commitGenerationRef = useRef(0);
  const repositoryContextKeyRef = useRef<string | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const worktrees = useWorktreeStore((state) => state.worktrees);
  const loadWorktrees = useWorktreeStore((state) => state.loadWorktrees);
  const createWorktreeForProject = useWorktreeStore((state) => state.createWorktreeForProject);
  const removeWorktree = useWorktreeStore((state) => state.removeWorktree);
  const renameWorktree = useWorktreeStore((state) => state.renameWorktree);
  const resolvedProject = useMemo(
    () => effectiveProject(project, projectPath),
    [project, projectPath],
  );
  const {
    lease,
    loading: transportLoading,
    error: transportError,
  } = useGitTransportLease(resolvedProject, active && Boolean(projectPath));
  const transport = lease?.transport ?? null;
  const selectedRepository = useMemo(
    () =>
      repositories.find(
        (repository) => repository.absolutePath === repositoryId,
      ) ?? null,
    [repositories, repositoryId],
  );
  const selectedCommit = useMemo(
    () => commits.find((commit) => commit.id === selectedId) ?? null,
    [commits, selectedId],
  );
  const preferenceKey = `${transport?.contextKey ?? "none"}:${repositoryId ?? "none"}`;
  const contextKey = `${preferenceKey}:${search}:${JSON.stringify(historyFilters)}`;
  const loadingContext = loadingRepositories || loadingRefs;
  const filterActive = historyFilters.scope !== "current" || Boolean(historyFilters.author || historyFilters.since || historyFilters.until || historyFilters.path);
  const displayTags = useMemo(() => {
    const byName = new Map(tags.map((tag) => [tag.name, tag]));
    commits.flatMap((commit) => commit.refs).forEach((rawRef) => {
      const name = /^tag:\s*(.+)$/i.exec(rawRef.trim())?.[1];
      if (name && !byName.has(name)) byName.set(name, { name, target: "", annotated: false, message: "" });
    });
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [commits, tags]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useEffect(() => {
    const transportContextChanged =
      repositoryContextKeyRef.current !== (transport?.contextKey ?? null);
    repositoryContextKeyRef.current = transport?.contextKey ?? null;
    setRepositories([]);
    if (transportContextChanged) setRepositoryId(null);
    setBranches([]);
    setTags([]);
    setBranchStatus(null);
    setCommits([]);
    setNextCursor(null);
    setSelectedId(null);
    setHistoryRef(null);
    setSelectedBranchName(null);
    setHistoryFilters({ scope: "current", references: [], author: "", since: null, until: null, path: "" });
    setError(null);
    setLoadingRepositories(false);
    if (!active || !transport) return;

    const generation = ++repositoryGenerationRef.current;
    setLoadingRepositories(true);
    void transport
      .listRepositories()
      .then((result) => {
        if (generation !== repositoryGenerationRef.current) return;
        setRepositories(result.value);
        setRepositoryId((current) =>
          current !== null &&
          result.value.some((repository) => repository.absolutePath === current)
            ? current
            : (result.value[0]?.absolutePath ?? null),
        );
      })
      .catch((reason) => {
        if (generation === repositoryGenerationRef.current) {
          setError(
            workspaceError(
              reason,
              t("git.workspace.loadFailed"),
              t("git.history.sshUpgradeRequired"),
              t("git.empty.notRepoTitle"),
            ),
          );
        }
      })
      .finally(() => {
        if (generation === repositoryGenerationRef.current)
          setLoadingRepositories(false);
      });
    return () => {
      repositoryGenerationRef.current += 1;
    };
  }, [active, refreshToken, t, transport]);

  useEffect(() => {
    setBranches([]);
    setBranchStatus(null);
    setLoadingRefs(false);
    if (!active || !transport || repositoryId === null) return;
    const generation = ++refGenerationRef.current;
    setLoadingRefs(true);
    void Promise.all([
      transport.listBranches(repositoryId),
      transport.getBranchStatus(repositoryId),
      transport.listTags(repositoryId).catch((reason) => {
        if (String(reason).includes("ssh_agent_capability_missing:gitWorkspaceTools")) return { value: [] as GitTagInfo[] };
        throw reason;
      }),
    ])
      .then(([branchResult, statusResult, tagResult]) => {
        if (generation !== refGenerationRef.current) return;
        setBranches(branchResult.value);
        setBranchStatus(statusResult.value);
        setTags(tagResult.value);
      })
      .catch((reason) => {
        if (generation === refGenerationRef.current) {
          setError(
            workspaceError(
              reason,
              t("git.workspace.loadFailed"),
              t("git.history.sshUpgradeRequired"),
              t("git.empty.notRepoTitle"),
            ),
          );
        }
      })
      .finally(() => {
        if (generation === refGenerationRef.current) setLoadingRefs(false);
      });
    return () => {
      refGenerationRef.current += 1;
    };
  }, [active, refreshToken, repositoryId, t, transport]);

  useEffect(() => {
    setCommits([]);
    setNextCursor(null);
    setSelectedId(null);
    setLoadingCommits(false);
    if (!active || view !== "log" || !transport || repositoryId === null)
      return;
    const generation = ++commitGenerationRef.current;
    setLoadingCommits(true);
    setError(null);
    void transport
      .listCommits(repositoryId, null, search, historyRef, filterActive ? historyFilters : null)
      .then((result) => {
        if (generation !== commitGenerationRef.current) return;
        setCommits(result.value.commits);
        setNextCursor(result.value.nextCursor);
      })
      .catch((reason) => {
        if (generation === commitGenerationRef.current) {
          setError(
            workspaceError(
              reason,
              t("git.workspace.loadFailed"),
              t("git.history.sshUpgradeRequired"),
              t("git.empty.notRepoTitle"),
            ),
          );
        }
      })
      .finally(() => {
        if (generation === commitGenerationRef.current)
          setLoadingCommits(false);
      });
    return () => {
      commitGenerationRef.current += 1;
    };
  }, [
    active,
    contextKey,
    refreshToken,
    repositoryId,
    search,
    t,
    transport,
    view,
    historyRef,
    historyFilters,
    filterActive,
  ]);

  const loadMore = useCallback(() => {
    if (!transport || repositoryId === null || !nextCursor || loadingCommits)
      return;
    const generation = commitGenerationRef.current;
    setLoadingCommits(true);
    void transport
      .listCommits(repositoryId, nextCursor, search, historyRef, filterActive ? historyFilters : null)
      .then((result) => {
        if (generation !== commitGenerationRef.current) return;
        setCommits((current) => {
          const known = new Set(current.map((commit) => commit.id));
          return [
            ...current,
            ...result.value.commits.filter((commit) => !known.has(commit.id)),
          ];
        });
        setNextCursor(result.value.nextCursor);
      })
      .catch((reason) => {
        if (generation === commitGenerationRef.current) {
          setError(
            workspaceError(
              reason,
              t("git.workspace.loadFailed"),
              t("git.history.sshUpgradeRequired"),
              t("git.empty.notRepoTitle"),
            ),
          );
        }
      })
      .finally(() => {
        if (generation === commitGenerationRef.current)
          setLoadingCommits(false);
      });
  }, [filterActive, historyFilters, historyRef, loadingCommits, nextCursor, repositoryId, search, t, transport]);

  useEffect(() => {
    try {
      const recent = JSON.parse(localStorage.getItem(`git:recent:${preferenceKey}`) ?? "[]");
      const favorite = JSON.parse(localStorage.getItem(`git:favorite:${preferenceKey}`) ?? "[]");
      setRecentBranches(Array.isArray(recent) ? recent.filter((item): item is string => typeof item === "string").slice(0, 8) : []);
      setFavoriteBranches(Array.isArray(favorite) ? favorite.filter((item): item is string => typeof item === "string") : []);
    } catch {
      setRecentBranches([]);
      setFavoriteBranches([]);
    }
  }, [preferenceKey]);

  const rememberBranch = useCallback((name: string) => {
    setRecentBranches((current) => {
      const next = [name, ...current.filter((item) => item !== name)].slice(0, 8);
      localStorage.setItem(`git:recent:${preferenceKey}`, JSON.stringify(next));
      return next;
    });
  }, [preferenceKey]);

  const toggleFavoriteBranch = useCallback((branch: GitBranchInfo) => {
    setFavoriteBranches((current) => {
      const next = current.includes(branch.name) ? current.filter((item) => item !== branch.name) : [...current, branch.name];
      localStorage.setItem(`git:favorite:${preferenceKey}`, JSON.stringify(next));
      return next;
    });
  }, [preferenceKey]);

  useEffect(() => {
    if (branchStatus?.branch) rememberBranch(branchStatus.branch);
  }, [branchStatus?.branch, rememberBranch]);

  useEffect(() => {
    void loadWorktrees().catch(() => undefined);
  }, [loadWorktrees]);

  const projectWorktrees = useMemo(
    () => worktrees.filter((worktree) => worktree.project_id === project?.id && worktree.status === "active"),
    [project?.id, worktrees],
  );

  const copyText = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("git.workspace.copied"));
    } catch {
      toast.error(t("git.workspace.copyFailed"));
    }
  }, [t]);

  const openOperation = useCallback((operation: PendingOperation, input = "") => {
    setOperationError(null);
    setOperationInput(input);
    setPendingOperation(operation);
  }, []);

  const handleBranchAction = useCallback(async (action: GitBranchAction, branch: GitBranchInfo) => {
    setSelectedBranchName(branch.name);
    if (!transport || repositoryId === null) return;
    if (action === "copy-name") {
      await copyText(branch.name);
      return;
    }
    if (action === "checkout") {
      if (branch.current) return;
      try {
        await transport.checkout(repositoryId, branch.name, branch.branchType === "remote");
        rememberBranch(branch.name);
        setRefreshToken((value) => value + 1);
        toast.success(t("git.workspace.checkedOut", { branch: branch.name }));
      } catch (reason) {
        toast.error(workspaceError(reason, t("git.workspace.operationFailed"), t("git.history.sshUpgradeRequired"), t("git.empty.notRepoTitle")));
      }
      return;
    }
    if (action === "history") {
      setHistoryRef(branch.name);
      setHistoryFilters((current) => ({ ...current, scope: "selected", references: [branch.name] }));
      setSearch("");
      setQuery("");
      setView("log");
      return;
    }
    if (action === "compare-current") {
      const current = branchStatus?.branch;
      if (!current || current === branch.name) {
        toast.info(t("git.workspace.sameBranch"));
        return;
      }
      try {
        const result = await transport.compareRefs(repositoryId, current, branch.name);
        setCompareDialog({ title: t("git.workspace.compareBranches", { base: current, target: branch.name }), content: result.value.content });
      } catch (reason) {
        toast.error(workspaceError(reason, t("git.workspace.operationFailed"), t("git.history.sshUpgradeRequired"), t("git.empty.notRepoTitle")));
      }
      return;
    }
    if (action === "compare-worktree") {
      try {
        const result = await transport.compareRefs(repositoryId, branch.name, null);
        setCompareDialog({ title: t("git.workspace.compareWorktree", { branch: branch.name }), content: result.value.content });
      } catch (reason) {
        toast.error(workspaceError(reason, t("git.workspace.operationFailed"), t("git.history.sshUpgradeRequired"), t("git.empty.notRepoTitle")));
      }
      return;
    }
    if (action === "create-branch") {
      openOperation({ operation: "create-branch", target: branch.name, title: t("git.operation.createBranch"), description: t("git.operation.createBranchDescription"), inputLabel: t("git.operation.branchName"), placeholder: "feature/example" });
      return;
    }
    if (action === "rename") {
      openOperation({ operation: "rename-branch", branch: branch.name, title: t("git.operation.renameBranch"), description: t("git.operation.renameBranchDescription"), inputLabel: t("git.operation.newBranchName"), placeholder: branch.name });
      return;
    }
    if (action === "set-upstream") {
      openOperation({ operation: "set-upstream", branch: branch.name, title: t("git.operation.setUpstream"), description: t("git.operation.setUpstreamDescription"), inputLabel: t("git.operation.upstream"), placeholder: `origin/${branch.name}`, }, branch.upstream ?? `origin/${branch.name}`);
      return;
    }
    if (action === "delete") {
      openOperation({ operation: "delete-branch", branch: branch.name, title: t("git.operation.deleteBranch"), description: t("git.operation.deleteBranchDescription", { branch: branch.name }), dangerous: true });
      return;
    }
    if (action === "merge" || action === "rebase") {
      openOperation({ operation: action, branch: branch.name, title: t(`git.operation.${action}` as "git.operation.merge" | "git.operation.rebase"), description: t(`git.operation.${action}Description` as "git.operation.mergeDescription" | "git.operation.rebaseDescription") });
    }
  }, [branchStatus?.branch, copyText, openOperation, rememberBranch, repositoryId, t, transport]);

  const handleCommitAction = useCallback((action: GitCommitAction, commit: GitCommitSummary) => {
    if (action === "copy-sha") {
      void copyText(commit.id);
      return;
    }
    if (action === "copy-info") {
      void copyText(`${commit.id} ${commit.title}\n${commit.authorName}${commit.authorEmail ? ` <${commit.authorEmail}>` : ""}`);
      return;
    }
    if (action === "view-parent") {
      const parent = commit.parents[0];
      if (!parent) return;
      setHistoryRef(parent);
      setHistoryFilters((current) => ({ ...current, scope: "selected", references: [parent] }));
      return;
    }
    if (action === "export-patch") {
      if (!transport || repositoryId === null) return;
      void transport.getCommitPatch(repositoryId, commit.id).then(async (result) => {
        const path = await invoke<string>("git_save_generated_patch", { commitId: commit.id, content: result.value });
        toast.success(t("git.patch.saved"), { description: path });
      }).catch((reason) => toast.error(workspaceError(reason, t("git.workspace.operationFailed"), t("git.history.sshUpgradeRequired"), t("git.empty.notRepoTitle"))));
      return;
    }
    if (action === "create-tag") {
      openOperation({ operation: "create-tag", target: commit.id, title: t("git.operation.createTag"), description: t("git.operation.createTagDescription", { commit: commit.shortId }), inputLabel: t("git.operation.tagName"), placeholder: "v1.0.0" });
      return;
    }
    if (action === "reset") {
      openOperation({ operation: "reset", target: commit.id, mode: "mixed", title: t("git.operation.reset"), description: t("git.operation.resetDescription", { commit: commit.shortId }), inputLabel: t("git.operation.resetMode"), placeholder: "mixed", dangerous: true }, "mixed");
      return;
    }
    const operation = action === "cherry-pick" ? "cherryPick" : "revert";
    openOperation({ operation: action, target: commit.id, title: t(`git.operation.${operation}` as "git.operation.cherryPick" | "git.operation.revert"), description: t(`git.operation.${operation}Description` as "git.operation.cherryPickDescription" | "git.operation.revertDescription", { commit: commit.shortId }) });
  }, [copyText, openOperation, repositoryId, t, transport]);

  const handleTagAction = useCallback(async (action: "checkout" | "create-branch" | "copy-name" | "push" | "delete", tag: string) => {
    if (!transport || repositoryId === null) return;
    if (action === "copy-name") {
      await copyText(tag);
      return;
    }
    if (action === "checkout") {
      try {
        await transport.checkout(repositoryId, tag, false);
        setRefreshToken((value) => value + 1);
        toast.success(t("git.workspace.checkedOut", { branch: tag }));
      } catch (reason) {
        toast.error(workspaceError(reason, t("git.workspace.operationFailed"), t("git.history.sshUpgradeRequired"), t("git.empty.notRepoTitle")));
      }
      return;
    }
    if (action === "create-branch") {
      openOperation({ operation: "create-branch", target: tag, title: t("git.operation.createBranch"), description: t("git.operation.createBranchDescription"), inputLabel: t("git.operation.branchName"), placeholder: "feature/example" });
      return;
    }
    if (action === "push") {
      openOperation({ operation: "push-tag", branch: tag, title: t("git.tag.push"), description: t("git.tag.pushDescription", { tag }), inputLabel: t("git.remote.name"), placeholder: "origin" }, "origin");
      return;
    }
    openOperation({ operation: "delete-tag", branch: tag, title: t("git.operation.deleteTag"), description: t("git.operation.deleteTagDescription", { tag }), dangerous: true });
  }, [copyText, openOperation, repositoryId, t, transport]);

  const executePendingOperation = useCallback(async () => {
    if (!pendingOperation || operationBusy) return;
    const operation = pendingOperation;
    const input = operationInput.trim();
    if (operation.inputLabel && !input) {
      setOperationError(t("git.operation.inputRequired"));
      return;
    }
    setOperationBusy(true);
    setOperationError(null);
    try {
      if (operation.operation === "delete-worktree") {
        const target = projectWorktrees.find((item) => item.id === operation.target);
        if (!target) throw new Error("worktree_not_found");
        await removeWorktree(target, true);
      } else if (operation.operation === "rename-worktree") {
        if (!operation.target) throw new Error("worktree_not_found");
        await renameWorktree(operation.target, input);
      } else if (operation.operation === "create-worktree") {
        if (!project) throw new Error("project_not_found");
        await createWorktreeForProject(project, input || undefined);
      } else if (operation.operation === "push-tag") {
        if (!transport || repositoryId === null || !operation.branch) throw new Error("git_operation_context_missing");
        await transport.pushTag(repositoryId, input, operation.branch);
      } else {
        if (!transport || repositoryId === null) throw new Error("git_operation_context_missing");
        const branch = operation.operation === "create-branch" || operation.operation === "create-tag" ? input : operation.branch;
        const target = operation.operation === "rename-branch" || operation.operation === "set-upstream" ? input : operation.target;
        const mode = operation.operation === "reset" ? (input || operation.mode || "mixed") : operation.mode;
        await transport.executeOperation(repositoryId, operation.operation, branch, target, mode);
      }
      setPendingOperation(null);
      setOperationInput("");
      setRefreshToken((value) => value + 1);
      toast.success(t("git.workspace.operationDone"));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setOperationError(workspaceError(message, t("git.workspace.operationFailed"), t("git.history.sshUpgradeRequired"), t("git.empty.notRepoTitle")));
      setRefreshToken((value) => value + 1);
    } finally {
      setOperationBusy(false);
    }
  }, [createWorktreeForProject, operationBusy, operationInput, pendingOperation, project, projectWorktrees, removeWorktree, renameWorktree, repositoryId, t, transport]);

  const openWorktreeDirectory = useCallback(async (worktree: WorktreeRecord) => {
    try {
      await invoke("open_folder_in_explorer", { path: worktree.path });
    } catch (reason) {
      toast.error(t("git.workspace.openWorktreeFailed"), { description: String(reason) });
    }
  }, [t]);

  const requestCreateWorktree = useCallback(() => {
    setWorktreeName("");
    setWorktreeCreateOpen(true);
  }, []);

  const confirmCreateWorktree = useCallback(async () => {
    if (!project || !worktreeCreateOpen) return;
    setOperationBusy(true);
    try {
      await createWorktreeForProject(project, worktreeName.trim() || undefined);
      setWorktreeCreateOpen(false);
      toast.success(t("git.workspace.worktreeCreated"));
    } catch (reason) {
      setOperationError(workspaceError(reason, t("git.workspace.operationFailed"), t("git.history.sshUpgradeRequired"), t("git.empty.notRepoTitle")));
    } finally {
      setOperationBusy(false);
    }
  }, [createWorktreeForProject, project, t, worktreeCreateOpen, worktreeName]);

  const beginResize = useCallback(
    (side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      resizeCleanupRef.current?.();
      const startX = event.clientX;
      const startWidth = side === "left" ? leftWidth : rightWidth;
      const onMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX;
        const next = side === "left" ? startWidth + delta : startWidth - delta;
        if (side === "left") setLeftWidth(Math.max(176, Math.min(360, next)));
        else setRightWidth(Math.max(260, Math.min(480, next)));
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", cleanup);
        resizeCleanupRef.current = null;
      };
      resizeCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", cleanup, { once: true });
    },
    [leftWidth, rightWidth],
  );

  const submitSearch = () => setSearch(query.trim());
  const selectedRepoForChanges = selectedRepository?.relativePath
    ? selectedRepository.absolutePath
    : null;

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden border font-mono"
      style={{
        color: TERM.fg,
        backgroundColor: TERM.bg,
        borderColor: TERM.border,
      }}
    >
      <header
        className="flex h-10 shrink-0 items-center gap-2 border-b px-2"
        style={{ borderColor: TERM.border, backgroundColor: TERM.card }}
      >
        <div
          className="flex items-center gap-1 rounded p-0.5"
          style={{ backgroundColor: panelColorTint(TERM.border, 45) }}
        >
          {(["log", "changes"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className="ui-focus-ring rounded-sm px-3 py-1 text-[11px]"
              style={{
                color: view === item ? TERM.fg : TERM.dim,
                backgroundColor: view === item ? TERM.bg : "transparent",
              }}
              onClick={() => setView(item)}
              aria-pressed={view === item}
            >
              {t(item === "log" ? "git.workspace.log" : "git.view.changes")}
            </button>
          ))}
        </div>
        <select
          value={
            repositoryId === null ? "__none__" : repositoryId || "__root__"
          }
          onChange={(event) => {
            const value = event.currentTarget.value;
            setRepositoryId(
              value === "__none__" ? null : value === "__root__" ? "" : value,
            );
          }}
          className="ui-focus-ring max-w-56 rounded-sm border bg-transparent px-2 py-1 text-[11px] outline-none"
          style={{
            color: TERM.fg,
            borderColor: TERM.border,
            backgroundColor: TERM.card,
          }}
          aria-label={t("git.workspace.repository")}
          disabled={repositories.length === 0}
        >
          {repositories.length === 0 && (
            <option value="__none__">{t("git.workspace.noRepository")}</option>
          )}
          {repositories.map((repository) => (
            <option
              key={repository.absolutePath || "__root__"}
              value={repository.absolutePath || "__root__"}
            >
              {repository.relativePath || project?.name || t("git.repo.root")}
            </option>
          ))}
        </select>
        {view === "log" && branchStatus && (
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" className="ui-focus-ring flex items-center gap-1 rounded-sm border px-1.5 py-1 text-[10px] disabled:opacity-40" style={{ color: TERM.cyan, borderColor: panelColorTint(TERM.cyan, 35) }} onClick={() => { if (transport && repositoryId !== null) { void transport.fetch(repositoryId).then(() => { setRefreshToken((value) => value + 1); toast.success(t("git.workspace.fetched")); }).catch((reason) => toast.error(String(reason))); } }} disabled={!transport || repositoryId === null || loadingContext} title={t("git.branch.fetch")}>
              <Download size={11} />
              <span>{t("git.branch.fetch")}</span>
            </button>
            <button type="button" className="ui-focus-ring flex items-center gap-1 rounded-sm border px-1.5 py-1 text-[10px] disabled:opacity-40" style={{ color: TERM.green, borderColor: panelColorTint(TERM.green, 35) }} onClick={() => { if (transport && repositoryId !== null && branchStatus.upstream) { void transport.pull(repositoryId, "merge").then(() => { setRefreshToken((value) => value + 1); toast.success(t("git.workspace.pulled")); }).catch((reason) => toast.error(String(reason))); } }} disabled={!transport || repositoryId === null || !branchStatus.upstream} title={t("git.pull.title")}>
              <ArrowDown size={11} />
              <span>{t("git.pull.action")}</span>
            </button>
            <button type="button" className="ui-focus-ring flex items-center gap-1 rounded-sm border px-1.5 py-1 text-[10px] disabled:opacity-40" style={{ color: TERM.yellow, borderColor: panelColorTint(TERM.yellow, 35) }} onClick={() => { if (transport && repositoryId !== null && branchStatus.branch) { void transport.push(repositoryId, !branchStatus.hasUpstream, branchStatus.branch).then(() => { setRefreshToken((value) => value + 1); toast.success(t("git.workspace.pushed")); }).catch((reason) => toast.error(String(reason))); } }} disabled={!transport || repositoryId === null || !branchStatus.branch} title={t("git.push.title")}>
              <ArrowUp size={11} />
              <span>{t("git.push.action")}</span>
            </button>
          </div>
        )}
        {view === "log" && (
          <div
            className="ml-auto flex min-w-40 max-w-80 flex-1 items-center rounded-sm border px-2"
            style={{ borderColor: TERM.border, backgroundColor: TERM.bg }}
          >
            <Search
              size={12}
              className="shrink-0"
              style={{ color: TERM.dim }}
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
              className="min-w-0 flex-1 bg-transparent px-2 py-1 text-[11px] outline-none"
              placeholder={t("git.history.searchPlaceholder")}
              aria-label={t("git.history.searchPlaceholder")}
              style={{ color: TERM.fg }}
            />
          </div>
        )}
        {view === "log" && (
          <button
            type="button"
            className="ui-focus-ring rounded-sm p-1.5"
            onClick={() => setShowFilters((value) => !value)}
            title={t("git.filters.title")}
            aria-label={t("git.filters.title")}
            aria-pressed={showFilters}
            style={{ color: filterActive ? TERM.yellow : TERM.dim }}
          >
            <SlidersHorizontal size={13} />
          </button>
        )}
        <button
          type="button"
          className="ui-focus-ring rounded-sm p-1.5"
          onClick={() => setPowerToolsOpen(true)}
          title={t("git.tools.title")}
          aria-label={t("git.tools.title")}
          style={{ color: TERM.dim }}
          disabled={repositoryId === null}
        >
          <MoreHorizontal size={14} />
        </button>
        <button
          type="button"
          className="ui-focus-ring rounded-sm p-1.5"
          onClick={() => setRefreshToken((value) => value + 1)}
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
          style={{ color: TERM.cyan }}
        >
          <RefreshCw
            size={13}
            className={
              loadingContext || loadingCommits || transportLoading
                ? "animate-spin"
                : ""
            }
          />
        </button>
        <button
          type="button"
          className="ui-focus-ring rounded-sm p-1.5"
          onClick={onClose}
          title={t("common.close")}
          aria-label={t("common.close")}
          style={{ color: TERM.dim }}
        >
          <X size={14} />
        </button>
      </header>

      {view === "log" && showFilters && (
        <div className="flex shrink-0 flex-wrap items-end gap-2 border-b px-2 py-2 text-[10px]" style={{ borderColor: TERM.border, backgroundColor: TERM.card }}>
          <label className="grid gap-1" style={{ color: TERM.dim }}>
            <span>{t("git.filters.scope")}</span>
            <select value={historyFilters.scope} onChange={(event) => setHistoryFilters((current) => ({ ...current, scope: event.currentTarget.value as GitHistoryFilters["scope"] }))} className="rounded-sm border px-2 py-1 outline-none" style={{ color: TERM.fg, borderColor: TERM.border, backgroundColor: TERM.bg }}>
              <option value="current">{t("git.filters.current")}</option>
              <option value="all">{t("git.filters.all")}</option>
              <option value="selected">{t("git.filters.selected")}</option>
            </select>
          </label>
          {historyFilters.scope === "selected" && (
            <label className="grid min-w-52 flex-1 gap-1" style={{ color: TERM.dim }}>
              <span>{t("git.filters.references")}</span>
              <input value={historyFilters.references.join(", ")} onChange={(event) => setHistoryFilters((current) => ({ ...current, references: event.currentTarget.value.split(",").map((value) => value.trim()).filter(Boolean) }))} className="rounded-sm border bg-transparent px-2 py-1 outline-none" style={{ color: TERM.fg, borderColor: TERM.border }} placeholder="main, origin/main" />
            </label>
          )}
          <label className="grid min-w-36 gap-1" style={{ color: TERM.dim }}>
            <span>{t("git.filters.author")}</span>
            <input value={historyFilters.author} onChange={(event) => setHistoryFilters((current) => ({ ...current, author: event.currentTarget.value }))} className="rounded-sm border bg-transparent px-2 py-1 outline-none" style={{ color: TERM.fg, borderColor: TERM.border }} />
          </label>
          <label className="grid gap-1" style={{ color: TERM.dim }}>
            <span>{t("git.filters.since")}</span>
            <input type="date" value={dateInputValue(historyFilters.since)} onChange={(event) => setHistoryFilters((current) => ({ ...current, since: event.currentTarget.value ? new Date(`${event.currentTarget.value}T00:00:00`).getTime() : null }))} className="rounded-sm border px-2 py-1 outline-none" style={{ color: TERM.fg, borderColor: TERM.border, backgroundColor: TERM.bg }} />
          </label>
          <label className="grid gap-1" style={{ color: TERM.dim }}>
            <span>{t("git.filters.until")}</span>
            <input type="date" value={dateInputValue(historyFilters.until)} onChange={(event) => setHistoryFilters((current) => ({ ...current, until: event.currentTarget.value ? new Date(`${event.currentTarget.value}T23:59:59.999`).getTime() : null }))} className="rounded-sm border px-2 py-1 outline-none" style={{ color: TERM.fg, borderColor: TERM.border, backgroundColor: TERM.bg }} />
          </label>
          <label className="grid min-w-40 flex-1 gap-1" style={{ color: TERM.dim }}>
            <span>{t("git.filters.path")}</span>
            <input value={historyFilters.path} onChange={(event) => setHistoryFilters((current) => ({ ...current, path: event.currentTarget.value }))} className="rounded-sm border bg-transparent px-2 py-1 outline-none" style={{ color: TERM.fg, borderColor: TERM.border }} placeholder="src/" />
          </label>
          <button type="button" className="ui-focus-ring rounded-sm border px-2 py-1" style={{ color: TERM.dim, borderColor: TERM.border }} onClick={() => { setHistoryRef(null); setHistoryFilters({ scope: "current", references: [], author: "", since: null, until: null, path: "" }); }}>{t("git.filters.clear")}</button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {!project || !projectPath ? (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyHint text={t("git.empty.noProject")} />
          </div>
        ) : transportError ? (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyHint
              text={workspaceError(
                transportError,
                t("git.workspace.loadFailed"),
                t("git.history.sshUpgradeRequired"),
                t("git.empty.notRepoTitle"),
              )}
            />
          </div>
        ) : view === "changes" ? (
          <GitChangesPanel
            key={`${project.id}:${projectPath}:${refreshToken}`}
            open={active}
            projectPath={projectPath}
            projectId={project.id}
            embedded
            workspaceMode
            activeRepositoryPath={selectedRepoForChanges}
          />
        ) : (
          <div className="ui-thin-scroll h-full min-h-0 overflow-x-auto overflow-y-hidden">
            <div
              className="grid h-full min-h-0 min-w-[760px]"
              style={{
                gridTemplateColumns: `${leftWidth}px 4px minmax(360px, 1fr) 4px ${rightWidth}px`,
              }}
            >
              <GitRefTree
                branches={branches}
                status={branchStatus}
                tags={displayTags}
                loading={loadingContext}
                selectedBranchName={selectedBranchName}
                onSelectBranch={(branch) => setSelectedBranchName(branch.name)}
                onBranchAction={(action, branch) => void handleBranchAction(action, branch)}
                worktrees={projectWorktrees}
                onCreateWorktree={requestCreateWorktree}
                onOpenWorktree={(worktree) => void (onOpenWorktreeSession ? onOpenWorktreeSession(worktree) : openWorktreeDirectory(worktree))}
                onFinishWorktree={(worktree) => setFinishWorktree(worktree)}
                onRenameWorktree={(worktree) => openOperation({ operation: "rename-worktree", target: worktree.id, title: t("git.workspace.renameWorktree"), description: t("git.workspace.renameWorktreeDescription", { name: worktree.name }), inputLabel: t("git.operation.worktreeName"), placeholder: worktree.name }, worktree.name)}
                onRemoveWorktree={(worktree) => openOperation({ operation: "delete-worktree", target: worktree.id, title: t("git.operation.removeWorktree"), description: t("git.operation.removeWorktreeDescription", { name: worktree.name }), dangerous: true })}
                onTagAction={handleTagAction}
                recentBranches={recentBranches}
                favoriteBranches={favoriteBranches}
                onToggleFavorite={toggleFavoriteBranch}
              />
              <div
                className="cursor-col-resize"
                style={{ backgroundColor: TERM.border }}
                onPointerDown={(event) => beginResize("left", event)}
                role="separator"
                aria-orientation="vertical"
                aria-label={t("git.workspace.resizeRefs")}
              />
              <GitLogTable
                commits={commits}
                loading={loadingCommits}
                error={error}
                hasMore={Boolean(nextCursor)}
                searchActive={Boolean(search) || filterActive}
                selectedId={selectedId}
                onSelect={(commitId) =>
                  setSelectedId((current) =>
                    current === commitId ? null : commitId,
                  )
                }
                onCommitAction={handleCommitAction}
                onLoadMore={loadMore}
              />
              <div
                className="cursor-col-resize"
                style={{ backgroundColor: TERM.border }}
                onPointerDown={(event) => beginResize("right", event)}
                role="separator"
                aria-orientation="vertical"
                aria-label={t("git.workspace.resizeDetails")}
              />
              <GitCommitDetails
                transport={transport}
                repositoryId={repositoryId}
                commit={selectedCommit}
                refreshToken={refreshToken}
              />
            </div>
          </div>
        )}
      </div>
      <GitCompareDialog
        open={Boolean(compareDialog)}
        title={compareDialog?.title ?? "Git compare"}
        projectPath={repositoryId ?? projectPath ?? ""}
        content={compareDialog?.content ?? ""}
        onClose={() => setCompareDialog(null)}
      />
      <GitPowerToolsDialog
        open={powerToolsOpen}
        transport={transport}
        repositoryId={repositoryId}
        branches={branches}
        tags={displayTags}
        commits={commits}
        branchStatus={branchStatus}
        onClose={() => setPowerToolsOpen(false)}
        onChanged={() => setRefreshToken((value) => value + 1)}
      />

      {worktreeCreateOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border p-4 shadow-2xl" style={{ backgroundColor: TERM.card, borderColor: TERM.border }}>
            <h2 className="text-sm font-semibold" style={{ color: TERM.fg }}>{t("git.operation.createWorktree")}</h2>
            <p className="mt-1 text-[11px]" style={{ color: TERM.dim }}>{t("git.operation.createWorktreeDescription")}</p>
            <label className="mt-4 block text-[11px]" style={{ color: TERM.dim }}>{t("git.operation.worktreeName")}</label>
            <input value={worktreeName} onChange={(event) => setWorktreeName(event.currentTarget.value)} placeholder={t("git.operation.worktreeNamePlaceholder")} autoFocus className="mt-1 w-full rounded border bg-transparent px-2 py-1.5 text-xs outline-none" style={{ color: TERM.fg, borderColor: TERM.dim }} onKeyDown={(event) => { if (event.key === "Enter") void confirmCreateWorktree(); if (event.key === "Escape") setWorktreeCreateOpen(false); }} />
            {operationError && <div className="mt-2 text-[11px]" style={{ color: TERM.red }}>{operationError}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="ui-focus-ring rounded border px-3 py-1 text-[11px]" style={{ color: TERM.dim, borderColor: TERM.dim }} onClick={() => setWorktreeCreateOpen(false)} disabled={operationBusy}>{t("common.cancel")}</button>
              <button type="button" className="ui-focus-ring rounded border px-3 py-1 text-[11px]" style={{ color: TERM.green, borderColor: panelColorTint(TERM.green, 40) }} onClick={() => void confirmCreateWorktree()} disabled={operationBusy}>{operationBusy ? t("common.processing") : t("git.operation.confirm")}</button>
            </div>
          </div>
        </div>
      )}

      {pendingOperation && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border p-4 shadow-2xl" style={{ backgroundColor: TERM.card, borderColor: pendingOperation.dangerous ? panelColorTint(TERM.red, 45) : TERM.border }}>
            <h2 className="text-sm font-semibold" style={{ color: pendingOperation.dangerous ? TERM.red : TERM.fg }}>{pendingOperation.title}</h2>
            <p className="mt-1 whitespace-pre-wrap text-[11px]" style={{ color: TERM.dim }}>{pendingOperation.description}</p>
            {pendingOperation.inputLabel && pendingOperation.operation === "reset" ? (
              <label className="mt-4 block text-[11px]" style={{ color: TERM.dim }}>
                {pendingOperation.inputLabel}
                <select value={operationInput} onChange={(event) => setOperationInput(event.currentTarget.value)} className="mt-1 w-full rounded border bg-transparent px-2 py-1.5 text-xs outline-none" style={{ color: TERM.fg, borderColor: TERM.dim, backgroundColor: TERM.bg }}>
                  <option value="soft">soft</option>
                  <option value="mixed">mixed</option>
                  <option value="hard">hard</option>
                </select>
              </label>
            ) : pendingOperation.inputLabel ? (
              <label className="mt-4 block text-[11px]" style={{ color: TERM.dim }}>
                {pendingOperation.inputLabel}
                <input value={operationInput} onChange={(event) => setOperationInput(event.currentTarget.value)} placeholder={pendingOperation.placeholder} autoFocus className="mt-1 w-full rounded border bg-transparent px-2 py-1.5 text-xs outline-none" style={{ color: TERM.fg, borderColor: TERM.dim }} onKeyDown={(event) => { if (event.key === "Enter") void executePendingOperation(); if (event.key === "Escape") setPendingOperation(null); }} />
              </label>
            ) : null}
            {operationError && <div className="mt-2 whitespace-pre-wrap text-[11px]" style={{ color: TERM.red }}>{operationError}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="ui-focus-ring rounded border px-3 py-1 text-[11px]" style={{ color: TERM.dim, borderColor: TERM.dim }} onClick={() => setPendingOperation(null)} disabled={operationBusy}>{t("common.cancel")}</button>
              <button type="button" className="ui-focus-ring rounded border px-3 py-1 text-[11px]" style={{ color: pendingOperation.dangerous ? TERM.red : TERM.green, borderColor: panelColorTint(pendingOperation.dangerous ? TERM.red : TERM.green, 40) }} onClick={() => void executePendingOperation()} disabled={operationBusy}>{operationBusy ? t("common.processing") : t("git.operation.confirm")}</button>
            </div>
          </div>
        </div>
      )}

      <WorktreeFinishDialog
        open={Boolean(finishWorktree)}
        project={project}
        worktree={finishWorktree}
        onClose={() => setFinishWorktree(null)}
      />
    </div>
  );
}
