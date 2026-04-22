import { RefreshCw, Search, Star } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import type { HistorySearchHit, HistorySessionView, HistorySourceFilter } from "../../lib/types";
import { SearchHitsPanel } from "./SearchHitsPanel";
import { formatTime, makeSessionLabel } from "./historyViewUtils";

interface SessionGroup {
  label: string;
  items: HistorySessionView[];
}

interface HistoryListPaneProps {
  historySidebarWidth: number;
  sidebarRef: RefObject<HTMLElement | null>;
  sessionListRef: RefObject<HTMLDivElement | null>;
  sourceFilter: HistorySourceFilter;
  globalQuery: string;
  activeSessionKey: string | null;
  loadingSessions: boolean;
  searching: boolean;
  normalizedGlobal: string;
  groupedSessions: SessionGroup[];
  filteredSessionCount: number;
  hasMoreSessions: boolean;
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

export function HistoryListPane({
  historySidebarWidth,
  sidebarRef,
  sessionListRef,
  sourceFilter,
  globalQuery,
  activeSessionKey,
  loadingSessions,
  searching,
  normalizedGlobal,
  groupedSessions,
  filteredSessionCount,
  hasMoreSessions,
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
  return (
    <aside
      ref={sidebarRef}
      className="relative flex min-h-0 min-w-[220px] max-w-[70%] flex-col border-r border-border bg-bg-secondary"
      style={{ width: historySidebarWidth }}
    >
      <div className="border-b border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={onClose} aria-label="关闭历史会话面板" className="ui-btn shrink-0">
            关闭
          </button>

          <select
            className="ui-input shrink-0 px-2 py-1 text-[12px]"
            value={sourceFilter}
            onChange={(e) => onSourceFilterChange(e.target.value as HistorySourceFilter)}
            aria-label="历史来源过滤"
          >
            <option value="all">全部来源</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>

          <button
            onClick={onRefresh}
            aria-label="刷新历史会话列表"
            className="ui-btn shrink-0"
            title="刷新会话列表"
          >
            <RefreshCw size={12} />
            刷新
          </button>
        </div>

        <div className="ui-input mt-2 flex items-center gap-2 px-2 py-1 text-text-secondary">
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
        {loadingSessions && <div className="px-3 py-4 text-xs text-text-muted">正在加载会话...</div>}

        {!loadingSessions && normalizedGlobal && searching && (
          <div className="px-3 py-2 text-[11px] text-text-muted">正在搜索...</div>
        )}

        {!loadingSessions && normalizedGlobal && (
          <SearchHitsPanel searchHits={searchHits} onOpenHit={onOpenHit} />
        )}

        {!loadingSessions &&
          groupedSessions.map((group) => (
            <div key={group.label}>
              <div className="ui-dev-label border-y border-border bg-bg-tertiary px-3 py-1.5 text-[11px] font-semibold tracking-[0.04em] text-text-muted">
                {group.label}
              </div>
              {group.items.map((item) => (
                <button
                  key={item.sessionKey}
                  onClick={() => onOpenSession(item.sessionKey)}
                  className="ui-list-row w-full border-b border-border px-3 py-2 text-left"
                  style={{ backgroundColor: item.sessionKey === activeSessionKey ? "var(--bg-tertiary)" : "transparent" }}
                >
                  <div className="flex items-center gap-1.5">
                    {item.starred && <Star size={12} style={{ color: "var(--warning)" }} fill="currentColor" />}
                    <span className="truncate text-[13px] font-semibold text-text-primary">{item.displayTitle}</span>
                  </div>
                  <div className="ui-dev-label mt-1 text-[11px] text-text-muted">
                    {item.source} · {makeSessionLabel(item)} · {item.message_count} 条消息
                  </div>
                  <div className="ui-dev-label mt-1 text-[11px] text-text-muted">更新于 {formatTime(item.updated_at)}</div>
                </button>
              ))}
            </div>
          ))}

        {!loadingSessions && filteredSessionCount === 0 && (
          <div className="px-3 py-6 text-center text-xs text-text-muted">未找到匹配会话</div>
        )}

        {!loadingSessions && hasMoreSessions && (
          <div className="p-2">
            <button onClick={onLoadMoreSessions} className="ui-btn w-full" aria-label="加载更多历史会话">
              加载更多 ({visibleSessionCount}/{filteredSessionCount})
            </button>
          </div>
        )}
      </div>

      <div
        onMouseDown={onStartResize}
        className="absolute bottom-0 right-0 top-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-[var(--accent)]"
        style={{ opacity: 0.35 }}
      />
    </aside>
  );
}
