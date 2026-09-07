import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileCode2, GitCommitHorizontal, RefreshCw, Search } from "lucide-react";
import type { GitTransport } from "../../lib/gitTransport";
import type { GitCommitDetail, GitCommitFile, GitCommitPage, GitCommitSummary } from "../../lib/types";
import { useI18n } from "../../lib/i18n";
import { TERM, EmptyHint, panelColorTint } from "../stats/termStatsUi";
import { DiffViewerModal } from "./DiffViewerModal";
import { STATUS_CONFIG } from "./GitStatusIcon";

interface GitHistoryViewProps {
  active: boolean;
  transport: GitTransport | null;
  repositoryId: string | null;
  branchContext: string;
}

function errorMessage(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ssh_agent_capability_missing:gitHistory")) {
    return t("git.history.sshUpgradeRequired");
  }
  if (message.includes("not_git_repository")) return t("git.error.notRepo", { prefix: t("git.history.title") });
  return t("git.error.generic", { prefix: t("git.history.title"), message });
}

function fileName(path: string): string {
  return path.split("/").pop() || path;
}

export function GitHistoryView({ active, transport, repositoryId, branchContext }: GitHistoryViewProps) {
  const { language, t } = useI18n();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<GitCommitPage>({ commits: [], nextCursor: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<GitCommitFile | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const listGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);

  const cursor = cursorStack[pageIndex] ?? null;
  const contextKey = `${transport?.contextKey ?? "none"}:${repositoryId ?? "none"}:${branchContext}`;

  useEffect(() => {
    setCursorStack([null]);
    setPageIndex(0);
    setPage({ commits: [], nextCursor: null });
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    setSelectedFile(null);
  }, [contextKey, search]);

  useEffect(() => {
    if (!active || !transport || repositoryId === null) return;
    const generation = ++listGenerationRef.current;
    setLoading(true);
    setError(null);
    void transport.listCommits(repositoryId, cursor, search).then((result) => {
      if (generation !== listGenerationRef.current) return;
      setPage(result.value);
      setSelectedId((current) => result.value.commits.some((item) => item.id === current) ? current : null);
    }).catch((reason) => {
      if (generation !== listGenerationRef.current) return;
      setPage({ commits: [], nextCursor: null });
      setSelectedId(null);
      setError(errorMessage(reason, t));
    }).finally(() => {
      if (generation === listGenerationRef.current) setLoading(false);
    });
    return () => { listGenerationRef.current += 1; };
  }, [active, cursor, refreshToken, repositoryId, search, t, transport]);

  useEffect(() => {
    if (!active || !transport || repositoryId === null || !selectedId) {
      setDetail(null);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    const generation = ++detailGenerationRef.current;
    setDetailLoading(true);
    setDetail(null);
    setDetailError(null);
    void transport.getCommitDetail(repositoryId, selectedId).then((result) => {
      if (generation === detailGenerationRef.current) setDetail(result.value);
    }).catch((reason) => {
      if (generation === detailGenerationRef.current) setDetailError(errorMessage(reason, t));
    }).finally(() => {
      if (generation === detailGenerationRef.current) setDetailLoading(false);
    });
    return () => { detailGenerationRef.current += 1; };
  }, [active, refreshToken, repositoryId, selectedId, t, transport]);

  const formatDate = useMemo(() => new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }), [language]);

  const submitSearch = useCallback(() => setSearch(query.trim()), [query]);
  const loadSelectedFileDiff = useCallback((filePath: string) => {
    if (!transport || repositoryId === null || !selectedId) {
      return Promise.reject(new Error("git_history_diff_context_missing"));
    }
    return transport.getCommitFileDiff(
      repositoryId,
      selectedId,
      filePath,
      selectedFile?.oldPath,
    ).then((result) => result.value);
  }, [repositoryId, selectedFile?.oldPath, selectedId, transport]);
  const nextPage = () => {
    if (!page.nextCursor) return;
    const nextIndex = pageIndex + 1;
    setCursorStack((current) => [...current.slice(0, nextIndex), page.nextCursor]);
    setPageIndex(nextIndex);
  };

  if (!transport || repositoryId === null) {
    return <div className="min-h-0 flex-1 p-2"><EmptyHint text={t("git.empty.noProject")} /></div>;
  }

  return (
    <>
      <div className="flex shrink-0 gap-1 border-b px-2 py-1.5" style={{ borderColor: TERM.dim }}>
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded px-1.5" style={{ border: `1px solid ${TERM.dim}` }}>
          <Search size={11} className="shrink-0" style={{ color: TERM.dim }} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") submitSearch(); }}
            placeholder={t("git.history.searchPlaceholder")}
            aria-label={t("git.history.searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent py-1 text-[10px] outline-none"
            style={{ color: TERM.fg }}
          />
        </div>
        <button type="button" onClick={submitSearch} className="ui-focus-ring rounded px-1.5 text-[10px]" style={{ color: TERM.cyan }}>
          {t("git.history.search")}
        </button>
        <button
          type="button"
          onClick={() => setRefreshToken((value) => value + 1)}
          className="ui-focus-ring rounded p-1"
          title={t("git.history.refresh")}
          aria-label={t("git.history.refresh")}
          style={{ color: TERM.cyan }}
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="ui-thin-scroll min-h-0 flex-1 overflow-y-auto">
        {loading && page.commits.length === 0 ? (
          <div className="p-2"><EmptyHint text={t("common.loading")} /></div>
        ) : error && page.commits.length === 0 ? (
          <div className="p-2"><EmptyHint text={error} /></div>
        ) : page.commits.length === 0 ? (
          <div className="p-2"><EmptyHint text={search ? t("git.history.emptySearch") : t("git.history.empty")} /></div>
        ) : (
          <div className="py-1">
            {page.commits.map((commit) => {
              const selected = commit.id === selectedId;
              return (
                <div key={commit.id}>
                  <CommitRow
                    commit={commit}
                    selected={selected}
                    date={formatDate.format(new Date(commit.authoredAt))}
                    onSelect={() => setSelectedId((current) => current === commit.id ? null : commit.id)}
                  />
                  {selected && (
                    <div className="border-y px-2 py-2" style={{ borderColor: TERM.dim }}>
                      <div className="mb-1 text-[10px] font-bold uppercase" style={{ color: TERM.dim }}>{t("git.history.changedFiles")}</div>
                      {detailLoading ? (
                        <div className="py-2 text-[10px]" style={{ color: TERM.dim }}>{t("common.loading")}</div>
                      ) : detailError ? (
                        <div className="py-2 text-[10px]" style={{ color: TERM.red }}>{detailError}</div>
                      ) : detail?.files.length ? detail.files.map((file) => (
                        <button
                          key={`${file.oldPath ?? ""}:${file.path}`}
                          type="button"
                          onClick={() => setSelectedFile(file)}
                          className="ui-focus-ring flex w-full items-center gap-1.5 px-1 py-1 text-left text-[10px] hover:opacity-80"
                          title={file.path}
                        >
                          <span className="w-3 shrink-0 font-bold" style={{ color: STATUS_CONFIG[file.status]?.color ?? TERM.fg }}>{file.status}</span>
                          <FileCode2 size={10} className="shrink-0" style={{ color: TERM.dim }} />
                          <span className="min-w-0 flex-1 truncate" style={{ color: TERM.fg }}>{file.path}</span>
                          {file.binary ? <span style={{ color: TERM.dim }}>{t("git.history.binary")}</span> : (
                            <span className="shrink-0"><span style={{ color: TERM.green }}>+{file.added}</span> <span style={{ color: TERM.red }}>-{file.deleted}</span></span>
                          )}
                        </button>
                      )) : (
                        <div className="py-2 text-[10px]" style={{ color: TERM.dim }}>{t("git.history.noFiles")}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t px-2 py-1.5 text-[10px]" style={{ borderColor: TERM.dim, color: TERM.dim }}>
        <button type="button" disabled={pageIndex === 0 || loading} onClick={() => setPageIndex((value) => Math.max(0, value - 1))} className="ui-focus-ring rounded p-1 disabled:opacity-30" aria-label={t("git.history.previousPage")}><ChevronLeft size={12} /></button>
        <span>{t("git.history.page", { page: pageIndex + 1 })}</span>
        <button type="button" disabled={!page.nextCursor || loading} onClick={nextPage} className="ui-focus-ring rounded p-1 disabled:opacity-30" aria-label={t("git.history.nextPage")}><ChevronRight size={12} /></button>
      </div>

      {selectedFile && selectedId && (
        <DiffViewerModal
          open
          onClose={() => setSelectedFile(null)}
          projectPath={repositoryId}
          filePath={selectedFile.path}
          fileName={fileName(selectedFile.path)}
          status={selectedFile.status}
          loadDiff={loadSelectedFileDiff}
          useTerminalTheme
        />
      )}
    </>
  );
}

function CommitRow({ commit, selected, date, onSelect }: { commit: GitCommitSummary; selected: boolean; date: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="ui-focus-ring flex w-full flex-col gap-0.5 border-l-2 px-2 py-1.5 text-left"
      style={{ borderColor: selected ? TERM.yellow : "transparent", backgroundColor: selected ? panelColorTint(TERM.yellow, 8) : "transparent" }}
    >
      <span className="flex w-full items-start gap-1">
        <GitCommitHorizontal size={11} className="mt-0.5 shrink-0" style={{ color: TERM.yellow }} />
        <span className="min-w-0 flex-1 break-words text-[11px] leading-tight" style={{ color: TERM.fg }}>{commit.title || commit.shortId}</span>
      </span>
      <span className="flex w-full items-center gap-1 pl-4 text-[9px]" style={{ color: TERM.dim }}>
        <span style={{ color: TERM.cyan }}>{commit.shortId}</span>
        <span className="min-w-0 flex-1 truncate">{commit.authorName}</span>
        <span className="shrink-0">{date}</span>
      </span>
      {commit.refs.length > 0 && (
        <span className="flex max-w-full flex-wrap gap-1 pl-4">
          {commit.refs.slice(0, 3).map((ref) => <span key={ref} className="max-w-full truncate rounded px-1 text-[8px]" style={{ color: TERM.green, backgroundColor: panelColorTint(TERM.green, 10) }}>{ref}</span>)}
        </span>
      )}
    </button>
  );
}
