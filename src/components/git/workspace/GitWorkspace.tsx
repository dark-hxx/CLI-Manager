import { RefreshCw, Search, X } from "lucide-react";
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
  Project,
} from "../../../lib/types";
import { useGitTransportLease } from "../../../hooks/useGitTransportLease";
import { useI18n } from "../../../lib/i18n";
import { TERM, EmptyHint, panelColorTint } from "../../stats/termStatsUi";
import { GitChangesPanel } from "../GitChangesPanel";
import { GitCommitDetails } from "./GitCommitDetails";
import { GitLogTable } from "./GitLogTable";
import { GitRefTree } from "./GitRefTree";

interface GitWorkspaceProps {
  active: boolean;
  project: Project | null;
  projectPath: string | null;
  onClose: () => void;
}

type WorkspaceView = "log" | "changes";

function workspaceError(
  error: unknown,
  fallback: string,
  sshUpgrade: string,
  notRepository: string,
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ssh_agent_capability_missing:gitHistory"))
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

export function GitWorkspace({
  active,
  project,
  projectPath,
  onClose,
}: GitWorkspaceProps) {
  const { t } = useI18n();
  const [view, setView] = useState<WorkspaceView>("log");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [repositories, setRepositories] = useState<GitRepositoryRef[]>([]);
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
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
  const [leftWidth, setLeftWidth] = useState(230);
  const [rightWidth, setRightWidth] = useState(330);
  const repositoryGenerationRef = useRef(0);
  const refGenerationRef = useRef(0);
  const commitGenerationRef = useRef(0);
  const repositoryContextKeyRef = useRef<string | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
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
  const tags = useMemo(() => {
    const branchNames = new Set(branches.map((branch) => branch.name));
    return [
      ...new Set(
        commits
          .flatMap((commit) => commit.refs)
          .flatMap((rawRef) => {
            const ref = rawRef.trim();
            const decoratedTag = /^tag:\s*(.+)$/i.exec(ref)?.[1];
            if (decoratedTag) return [decoratedTag];
            if (
              !ref ||
              ref === "HEAD" ||
              ref.includes("HEAD ->") ||
              branchNames.has(ref)
            )
              return [];
            return [ref];
          }),
      ),
    ].sort();
  }, [branches, commits]);
  const contextKey = `${transport?.contextKey ?? "none"}:${repositoryId ?? "none"}:${search}`;
  const loadingContext = loadingRepositories || loadingRefs;

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useEffect(() => {
    const transportContextChanged =
      repositoryContextKeyRef.current !== (transport?.contextKey ?? null);
    repositoryContextKeyRef.current = transport?.contextKey ?? null;
    setRepositories([]);
    if (transportContextChanged) setRepositoryId(null);
    setBranches([]);
    setBranchStatus(null);
    setCommits([]);
    setNextCursor(null);
    setSelectedId(null);
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
    ])
      .then(([branchResult, statusResult]) => {
        if (generation !== refGenerationRef.current) return;
        setBranches(branchResult.value);
        setBranchStatus(statusResult.value);
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
      .listCommits(repositoryId, null, search)
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
  ]);

  const loadMore = useCallback(() => {
    if (!transport || repositoryId === null || !nextCursor || loadingCommits)
      return;
    const generation = commitGenerationRef.current;
    setLoadingCommits(true);
    void transport
      .listCommits(repositoryId, nextCursor, search)
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
  }, [loadingCommits, nextCursor, repositoryId, search, t, transport]);

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
                tags={tags}
                loading={loadingContext}
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
                searchActive={Boolean(search)}
                selectedId={selectedId}
                onSelect={(commitId) =>
                  setSelectedId((current) =>
                    current === commitId ? null : commitId,
                  )
                }
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
    </div>
  );
}
