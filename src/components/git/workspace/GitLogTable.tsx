import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, FileDown, GitMerge, ListTree, RotateCcw, Tag, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { GitCommitSummary } from "../../../lib/types";
import { useI18n } from "../../../lib/i18n";
import { TERM, EmptyHint, panelColorTint } from "../../stats/termStatsUi";
import {
  gitGraphColor,
  layoutGitGraph,
  type GitGraphRow,
} from "./gitGraphLayout";

interface GitLogTableProps {
  commits: GitCommitSummary[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  searchActive: boolean;
  selectedId: string | null;
  onSelect: (commitId: string) => void;
  onCommitAction?: (action: GitCommitAction, commit: GitCommitSummary) => void;
  onLoadMore: () => void;
}

export type GitCommitAction = "copy-sha" | "copy-info" | "view-parent" | "export-patch" | "cherry-pick" | "revert" | "reset" | "create-tag";

const ROW_HEIGHT = 34;
const LANE_OFFSET = 9;
const LANE_WIDTH = 14;

function laneX(lane: number): number {
  return LANE_OFFSET + lane * LANE_WIDTH;
}

function segmentPath(
  fromLane: number,
  toLane: number,
  kind: "continuation" | "parent" | "truncated",
): string {
  const fromX = laneX(fromLane);
  const toX = laneX(toLane);
  if (kind === "truncated")
    return `M ${fromX} ${ROW_HEIGHT / 2} L ${fromX} ${ROW_HEIGHT - 4}`;
  const startY = kind === "parent" ? ROW_HEIGHT / 2 : 0;
  if (fromX === toX) return `M ${fromX} ${startY} L ${toX} ${ROW_HEIGHT}`;
  const midY = Math.max(startY + 5, ROW_HEIGHT * 0.7);
  return `M ${fromX} ${startY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${ROW_HEIGHT}`;
}

function CommitGraph({ row }: { row: GitGraphRow }) {
  return (
    <svg
      className="h-[34px] w-[126px] shrink-0 overflow-hidden"
      viewBox="0 0 126 34"
      aria-hidden="true"
    >
      <path
        d={`M ${laneX(row.lane)} 0 L ${laneX(row.lane)} ${ROW_HEIGHT / 2}`}
        stroke={gitGraphColor(row.lane)}
        strokeWidth="1.5"
        fill="none"
      />
      {row.segments.map((segment, index) => (
        <path
          key={`${segment.kind}:${segment.fromLane}:${segment.toLane}:${index}`}
          d={segmentPath(segment.fromLane, segment.toLane, segment.kind)}
          stroke={gitGraphColor(segment.colorLane)}
          strokeWidth="1.5"
          strokeDasharray={segment.kind === "truncated" ? "2 2" : undefined}
          fill="none"
        />
      ))}
      <circle
        cx={laneX(row.lane)}
        cy={ROW_HEIGHT / 2}
        r="4"
        fill={TERM.bg}
        stroke={gitGraphColor(row.lane)}
        strokeWidth="2"
      />
    </svg>
  );
}

export function GitLogTable({
  commits,
  loading,
  error,
  hasMore,
  searchActive,
  selectedId,
  onSelect,
  onCommitAction,
  onLoadMore,
}: GitLogTableProps) {
  const { language, t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const graphRows = useMemo(
    () => layoutGitGraph(commits, { connectOnlyVisible: searchActive }),
    [commits, searchActive],
  );
  const formatDate = useMemo(
    () =>
      new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    [language],
  );
  const rowVirtualizer = useVirtualizer({
    count: commits.length + 1,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (index === commits.length ? 40 : ROW_HEIGHT),
    overscan: 12,
    getItemKey: (index) => commits[index]?.id ?? "git-history-tail",
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const [contextMenu, setContextMenu] = useState<{ commit: GitCommitSummary; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    const lastRow = virtualRows[virtualRows.length - 1];
    if (lastRow && lastRow.index >= commits.length && hasMore && !loading) {
      onLoadMore();
    }
  }, [commits.length, hasMore, loading, onLoadMore, virtualRows]);

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col"
      style={{ backgroundColor: TERM.bg }}
    >
      <div
        className="grid h-8 shrink-0 grid-cols-[minmax(320px,3fr)_minmax(100px,1fr)_176px] items-center border-b px-2 text-[10px] font-semibold uppercase"
        style={{ color: TERM.dim, borderColor: TERM.border }}
      >
        <span>{t("git.workspace.commit")}</span>
        <span>{t("git.workspace.author")}</span>
        <span>{t("git.workspace.date")}</span>
      </div>
      <div
        ref={scrollRef}
        className="ui-thin-scroll min-h-0 flex-1 overflow-auto"
      >
        {commits.length === 0 ? (
          <div className="p-3">
            <EmptyHint
              text={
                loading
                  ? t("common.loading")
                  : error ||
                    (searchActive
                      ? t("git.history.emptySearch")
                      : t("git.history.empty"))
              }
            />
          </div>
        ) : (
          <div
            className="relative min-w-[640px]"
            style={{ height: rowVirtualizer.getTotalSize() }}
          >
            {virtualRows.map((virtualRow) => {
              if (virtualRow.index === commits.length) {
                return (
                  <div
                    key={virtualRow.key}
                    className="absolute left-0 top-0 flex h-10 w-full items-center justify-center text-[10px]"
                    style={{
                      color: TERM.dim,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {loading
                      ? t("common.loading")
                      : hasMore
                        ? t("git.workspace.loadMore")
                        : t("git.workspace.endOfHistory")}
                  </div>
                );
              }
              const commit = commits[virtualRow.index];
              const index = virtualRow.index;
              const selected = selectedId === commit.id;
              return (
                <button
                  key={virtualRow.key}
                  type="button"
                  className="ui-focus-ring absolute left-0 top-0 grid h-[34px] w-full grid-cols-[minmax(320px,3fr)_minmax(100px,1fr)_176px] items-center border-b px-2 text-left text-[11px]"
                  style={{
                    color: TERM.fg,
                    borderColor: panelColorTint(TERM.border, 70),
                    backgroundColor: selected
                      ? panelColorTint(TERM.cyan, 13)
                      : "transparent",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  onClick={() => onSelect(commit.id)}
                  onContextMenu={(event: MouseEvent<HTMLButtonElement>) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setContextMenu({ commit, x: event.clientX, y: event.clientY });
                  }}
                  aria-pressed={selected}
                >
                  <span className="flex min-w-0 items-center">
                    <CommitGraph row={graphRows[index]} />
                    <span className="min-w-0 flex-1 truncate">
                      {commit.title}
                    </span>
                    {commit.refs.slice(0, 3).map((ref) => (
                      <span
                        key={ref}
                        className="ml-1 max-w-28 shrink-0 truncate rounded-sm border px-1 py-px text-[9px]"
                        style={{
                          color: TERM.yellow,
                          borderColor: panelColorTint(TERM.yellow, 45),
                          backgroundColor: panelColorTint(TERM.yellow, 8),
                        }}
                        title={ref}
                      >
                        {ref}
                      </span>
                    ))}
                  </span>
                  <span
                    className="truncate pr-2"
                    title={`${commit.authorName}${commit.authorEmail ? ` <${commit.authorEmail}>` : ""}`}
                  >
                    {commit.authorName}
                  </span>
                  <span className="truncate" style={{ color: TERM.dim }}>
                    {formatDate.format(new Date(commit.authoredAt))}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {contextMenu && onCommitAction && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} aria-hidden="true" />
          <div
            className="fixed z-50 min-w-[190px] overflow-hidden rounded border py-1 shadow-xl"
            style={{
              left: Math.min(contextMenu.x, window.innerWidth - 206),
              top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 292)),
              backgroundColor: TERM.bg,
              borderColor: TERM.dim,
            }}
            role="menu"
          >
            {([
              ["copy-sha", t("git.commit.context.copySha"), <Copy size={12} />],
              ["copy-info", t("git.commit.context.copyInfo"), <Copy size={12} />],
              ["view-parent", t("git.commit.context.viewParent"), <ListTree size={12} />],
              ["export-patch", t("git.commit.context.exportPatch"), <FileDown size={12} />],
              ["cherry-pick", t("git.commit.context.cherryPick"), <GitMerge size={12} />],
              ["revert", t("git.commit.context.revert"), <Undo2 size={12} />],
              ["reset", t("git.commit.context.reset"), <RotateCcw size={12} />],
              ["create-tag", t("git.commit.context.createTag"), <Tag size={12} />],
            ] as [GitCommitAction, string, React.ReactNode][]).map(([action, label, icon]) => (
              <button
                key={action}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-opacity hover:opacity-80"
                style={{ color: TERM.fg }}
                onClick={() => {
                  onCommitAction(action, contextMenu.commit);
                  setContextMenu(null);
                }}
              >
                {icon}
                <span>{label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
