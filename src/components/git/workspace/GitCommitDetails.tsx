import { GitCommitHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitTransport } from "../../../lib/gitTransport";
import type {
  GitCommitDetail,
  GitCommitFile,
  GitCommitSummary,
} from "../../../lib/types";
import { useI18n } from "../../../lib/i18n";
import { TERM, EmptyHint } from "../../stats/termStatsUi";
import { DiffViewerModal } from "../DiffViewerModal";
import { GitChangedFilesTree } from "./GitChangedFilesTree";

interface GitCommitDetailsProps {
  transport: GitTransport | null;
  repositoryId: string | null;
  commit: GitCommitSummary | null;
  refreshToken: number;
}

function fileName(path: string): string {
  return path.split("/").pop() || path;
}

export function GitCommitDetails({
  transport,
  repositoryId,
  commit,
  refreshToken,
}: GitCommitDetailsProps) {
  const { language, t } = useI18n();
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<GitCommitFile | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    setSelectedFile(null);
    if (!transport || repositoryId === null || !commit) {
      setDetail(null);
      setLoading(false);
      setError(null);
      return;
    }
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    void transport
      .getCommitDetail(repositoryId, commit.id)
      .then((result) => {
        if (generation === generationRef.current) setDetail(result.value);
      })
      .catch((reason) => {
        if (generation === generationRef.current)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (generation === generationRef.current) setLoading(false);
      });
    return () => {
      generationRef.current += 1;
    };
  }, [commit, refreshToken, repositoryId, transport]);

  const formatDate = useMemo(
    () =>
      new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }),
    [language],
  );
  const loadSelectedFileDiff = useCallback(
    (filePath: string) => {
      if (!transport || repositoryId === null || !commit || !selectedFile) {
        return Promise.reject(new Error("git_history_diff_context_missing"));
      }
      return transport
        .getCommitFileDiff(
          repositoryId,
          commit.id,
          filePath,
          selectedFile.oldPath,
        )
        .then((result) => result.value);
    },
    [commit, repositoryId, selectedFile, transport],
  );

  if (!commit) {
    return (
      <aside
        className="h-full border-l p-3"
        style={{ borderColor: TERM.border, backgroundColor: TERM.card }}
      >
        <EmptyHint text={t("git.workspace.selectCommit")} />
      </aside>
    );
  }

  return (
    <aside
      className="flex h-full min-h-0 flex-col border-l"
      style={{ borderColor: TERM.border, backgroundColor: TERM.card }}
    >
      <div className="border-b p-3" style={{ borderColor: TERM.border }}>
        <div className="flex items-start gap-2">
          <GitCommitHorizontal
            size={15}
            className="mt-0.5 shrink-0"
            style={{ color: TERM.yellow }}
          />
          <div className="min-w-0">
            <div
              className="text-xs font-semibold leading-5"
              style={{ color: TERM.fg }}
            >
              {commit.title}
            </div>
            <div
              className="mt-1 font-mono text-[10px]"
              style={{ color: TERM.dim }}
            >
              {commit.id}
            </div>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-[68px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[10px]">
          <dt style={{ color: TERM.dim }}>{t("git.workspace.author")}</dt>
          <dd className="truncate" style={{ color: TERM.fg }}>
            {commit.authorName}
          </dd>
          <dt style={{ color: TERM.dim }}>{t("git.workspace.date")}</dt>
          <dd style={{ color: TERM.fg }}>
            {formatDate.format(new Date(commit.authoredAt))}
          </dd>
          <dt style={{ color: TERM.dim }}>{t("git.workspace.parents")}</dt>
          <dd className="truncate font-mono" style={{ color: TERM.fg }}>
            {commit.parents.map((id) => id.slice(0, 8)).join(", ") ||
              t("git.workspace.rootCommit")}
          </dd>
        </dl>
      </div>
      <div
        className="px-3 py-2 text-[10px] font-semibold uppercase"
        style={{ color: TERM.dim }}
      >
        {t("git.history.changedFiles")}
      </div>
      <div className="ui-thin-scroll min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {loading ? (
          <EmptyHint text={t("common.loading")} />
        ) : error ? (
          <EmptyHint text={error} />
        ) : detail?.files.length ? (
          <GitChangedFilesTree files={detail.files} onSelect={setSelectedFile} selectedFile={selectedFile} />
        ) : (
          <EmptyHint text={t("git.history.noFiles")} />
        )}
      </div>
      {selectedFile && repositoryId !== null && (
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
    </aside>
  );
}
