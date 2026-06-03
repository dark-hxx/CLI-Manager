import { Select } from "@/components/ui/select";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RefreshCw, Search, Star } from "lucide-react";
import { useMemo, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type { HistorySearchHit, HistorySessionView, HistorySourceFilter } from "../../lib/types";
import { formatTime, makeSessionLabel } from "./historyViewUtils";

interface SessionGroup {
  label: string;
  items: HistorySessionView[];
}

type HistoryListRow =
  | { type: "loading"; id: string }
  | { type: "searching"; id: string }
  | { type: "searchHeader"; id: string; count: number }
  | { type: "searchHit"; id: string; hit: HistorySearchHit }
  | { type: "group"; id: string; label: string }
  | { type: "session"; id: string; item: HistorySessionView }
  | { type: "empty"; id: string }
  | { type: "loadMore"; id: string };

interface HistoryListPaneProps {
  historySidebarWidth: number;
  sidebarRef: RefObject<HTMLElement | null>;
  sessionListRef: RefObject<HTMLDivElement | null>;
  sourceFilter: HistorySourceFilter;
  globalQuery: string;
  activeSessionKey: string | null;
  loadingSessions: boolean;
  loadingMoreSessions: boolean;
  searching: boolean;
  normalizedGlobal: string;
  groupedSessions: SessionGroup[];
  filteredSessionCount: number;
  hasMoreSessions: boolean;
  loadMoreSessionMode: "local" | "backend";
  visibleSessionCount: number;
  searchHits: HistorySearchHit[];
  globalSearchRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onRefresh: () => void;
  onSourceFilterChange: (value: HistorySourceFilter) => void;
  onGlobalQueryChange: (value: string) => void;
  onOpenSession: (sessionKey: string) => void;
  onOpenHit: (hit: HistorySearchHit) => void;
  onLoadMoreSessions: () => void;
  onSessionListScroll: () => void;
  onStartResize: (e: ReactMouseEvent) => void;
}

function rowHeight(row: HistoryListRow): number {
  if (row.type === "group" || row.type === "searchHeader" || row.type === "searching") return 32;
  if (row.type === "loading" || row.type === "empty" || row.type === "loadMore") return 56;
  if (row.type === "searchHit") return 72;
  return 76;
}

export function HistoryListPane({
  historySidebarWidth,
  sidebarRef,
  sessionListRef,
  sourceFilter,
  globalQuery,
  activeSessionKey,
  loadingSessions,
  loadingMoreSessions,
  searching,
  normalizedGlobal,
  groupedSessions,
  filteredSessionCount,
  hasMoreSessions,
  loadMoreSessionMode,
  visibleSessionCount,
  searchHits,
  globalSearchRef,
  onClose,
  onRefresh,
  onSourceFilterChange,
  onGlobalQueryChange,
  onOpenSession,
  onOpenHit,
  onLoadMoreSessions,
  onSessionListScroll,
  onStartResize,
}: HistoryListPaneProps) {
  const rows = useMemo<HistoryListRow[]>(() => {
    if (loadingSessions) return [{ type: "loading", id: "loading" }];

    const next: HistoryListRow[] = [];
    if (normalizedGlobal && searching) {
      next.push({ type: "searching", id: "searching" });
    }
    if (normalizedGlobal && searchHits.length > 0) {
      next.push({ type: "searchHeader", id: "search-header", count: searchHits.length });
      searchHits.forEach((hit, index) => {
        next.push({ type: "searchHit", id: `hit:${hit.file_path}:${index}`, hit });
      });
    }

    for (const group of groupedSessions) {
      next.push({ type: "group", id: `group:${group.label}`, label: group.label });
      for (const item of group.items) {
        next.push({ type: "session", id: `session:${item.sessionKey}`, item });
      }
    }

    if (filteredSessionCount === 0) {
      next.push({ type: "empty", id: "empty" });
    }
    if (hasMoreSessions) {
      next.push({ type: "loadMore", id: "load-more" });
    }
    return next;
  }, [filteredSessionCount, groupedSessions, hasMoreSessions, loadingSessions, normalizedGlobal, searchHits, searching]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => sessionListRef.current,
    estimateSize: (index) => rowHeight(rows[index] ?? { type: "loading", id: "fallback" }),
    overscan: 10,
    getItemKey: (index) => rows[index]?.id ?? index,
  });

  return (
    <aside
      ref={sidebarRef}
      className="ui-history-sidebar relative flex min-h-0 min-w-[220px] max-w-[70%] flex-col"
      style={{ width: historySidebarWidth }}
    >
      <div className="ui-history-sidebar-top p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onClose}
            aria-label="关闭历史会话面板"
            className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact shrink-0"
          >
            关闭
          </button>

          <Select
            className="h-8 shrink-0 text-[12px]"
            value={sourceFilter}
            onChange={(e) => onSourceFilterChange(e.target.value as HistorySourceFilter)}
            aria-label="历史来源过滤"
          >
            <option value="all">全部来源</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </Select>

          <button
            onClick={onRefresh}
            aria-label="刷新历史会话列表"
            className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact shrink-0"
            title="刷新会话列表"
          >
            <RefreshCw size={12} />
            刷新
          </button>
        </div>

        <div className="ui-history-search-shell mt-2 gap-2 px-2.5 py-1.5 text-text-secondary">
          <Search size={13} />
          <input
            ref={globalSearchRef}
            value={globalQuery}
            onChange={(e) => onGlobalQueryChange(e.target.value)}
            aria-label="全局搜索历史会话"
            placeholder="全局搜索（标题/消息/标签）"
            className="flex-1 bg-transparent text-[12px] outline-none"
          />
        </div>

        <div className="mt-1 text-[12px] text-text-muted">Ctrl+K 打开全局搜索</div>
      </div>

      <div ref={sessionListRef} onScroll={onSessionListScroll} className="flex-1 overflow-y-auto">
        <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            return (
              <div
                key={virtualRow.key}
                className="absolute left-0 top-0 w-full"
                style={{
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {row.type === "loading" && <div className="px-3 py-4 text-xs text-text-muted">正在加载会话...</div>}

                {row.type === "searching" && (
                  <div className="px-3 py-2 text-[11px] text-text-muted">正在搜索...</div>
                )}

                {row.type === "searchHeader" && (
                  <div className="px-3 py-2 text-[11px] font-semibold text-text-muted">
                    搜索命中 {row.count} 条
                  </div>
                )}

                {row.type === "searchHit" && (
                  <button
                    onClick={() => onOpenHit(row.hit)}
                    className="ui-list-row w-full border-t border-border px-3 py-2 text-left"
                  >
                    <div className="truncate text-xs font-semibold text-text-primary">{row.hit.title}</div>
                    <div className="mt-0.5 truncate text-[11px] text-text-secondary">{row.hit.snippet}</div>
                    <div className="ui-dev-label mt-1 text-[10px] text-text-muted">
                      {row.hit.source} · {row.hit.project_key} · {row.hit.role}
                    </div>
                  </button>
                )}

                {row.type === "group" && (
                  <div className="ui-history-section-label ui-dev-label px-3 py-1.5 text-[11px] font-semibold tracking-[0.04em] text-text-muted">
                    {row.label}
                  </div>
                )}

                {row.type === "session" && (
                  <button
                    onClick={() => onOpenSession(row.item.sessionKey)}
                    className="ui-list-row w-full border-b border-border px-3 py-2 text-left"
                    style={{ backgroundColor: row.item.sessionKey === activeSessionKey ? "var(--bg-tertiary)" : "transparent" }}
                  >
                    <div className="flex items-center gap-1.5">
                      {row.item.starred && <Star size={12} style={{ color: "var(--warning)" }} fill="currentColor" />}
                      <span className="truncate text-[13px] font-semibold text-text-primary">{row.item.displayTitle}</span>
                    </div>
                    <div className="ui-dev-label mt-1 text-[11px] text-text-muted">
                      {row.item.source} · {makeSessionLabel(row.item)} · {row.item.message_count} 条消息
                    </div>
                    <div className="ui-dev-label mt-1 text-[11px] text-text-muted">更新于 {formatTime(row.item.updated_at)}</div>
                  </button>
                )}

                {row.type === "empty" && (
                  <div className="px-3 py-6 text-center text-xs text-text-muted">未找到匹配会话</div>
                )}

                {row.type === "loadMore" && (
                  <div className="p-2">
                    <button
                      onClick={onLoadMoreSessions}
                      className="ui-btn w-full"
                      aria-label="加载更多历史会话"
                      disabled={loadingMoreSessions}
                    >
                      {loadingMoreSessions
                        ? "正在加载更多..."
                        : loadMoreSessionMode === "local"
                          ? `显示更多匹配会话（${visibleSessionCount}/${filteredSessionCount}）`
                          : `继续扫描更多历史（已载入 ${filteredSessionCount} 条）`}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div
        onMouseDown={onStartResize}
        className="ui-history-resize-handle absolute bottom-0 right-0 top-0 z-10 w-1.5 cursor-col-resize transition-colors"
        style={{ opacity: 0.6 }}
      />
    </aside>
  );
}
