import { BookCopy, GitCompare, Star } from "lucide-react";
import type { HistoryMessage, HistorySessionDetail, HistorySessionView } from "../../lib/types";
import { EmptyState } from "../ui/EmptyState";
import { MetaEditor } from "./MetaEditor";
import { formatTime, highlightText, makeSessionLabel, roleBadge } from "./historyViewUtils";
import type { RefObject } from "react";

interface SessionDetailPaneProps {
  activeView: HistorySessionView | null;
  activeSession: HistorySessionDetail | null;
  loadingSessionDetail: boolean;
  aliasDraft: string;
  tagsDraft: string;
  sessionQuery: string;
  matchIndices: number[];
  matchCursor: number;
  focusedMessageIndex: number | null;
  visibleMessages: HistoryMessage[];
  visibleMessageCount: number;
  hasMoreMessages: boolean;
  totalMessageCount: number;
  messageListRef: RefObject<HTMLDivElement | null>;
  sessionSearchRef: RefObject<HTMLInputElement | null>;
  messageRefs: RefObject<Record<number, HTMLDivElement | null>>;
  onMessageListScroll: () => void;
  onAliasDraftChange: (value: string) => void;
  onTagsDraftChange: (value: string) => void;
  onSessionQueryChange: (value: string) => void;
  onSaveMeta: () => void;
  onJumpPrev: () => void;
  onJumpNext: () => void;
  onOpenPrompt: () => void;
  onOpenDiff: () => void;
  onToggleStar: () => void;
  onLoadMoreMessages: () => void;
}

export function SessionDetailPane({
  activeView,
  activeSession,
  loadingSessionDetail,
  aliasDraft,
  tagsDraft,
  sessionQuery,
  matchIndices,
  matchCursor,
  focusedMessageIndex,
  visibleMessages,
  visibleMessageCount,
  hasMoreMessages,
  totalMessageCount,
  messageListRef,
  sessionSearchRef,
  messageRefs,
  onMessageListScroll,
  onAliasDraftChange,
  onTagsDraftChange,
  onSessionQueryChange,
  onSaveMeta,
  onJumpPrev,
  onJumpNext,
  onOpenPrompt,
  onOpenDiff,
  onToggleStar,
  onLoadMoreMessages,
}: SessionDetailPaneProps) {
  if (!activeView) {
    return (
      <div className="row-span-2 flex min-h-0 items-center justify-center">
        <EmptyState
          icon={<BookCopy size={34} strokeWidth={1.5} />}
          title="未选择会话"
          description="从左侧选择会话查看详情"
        />
      </div>
    );
  }

  return (
    <>
      <div className="min-h-0 shrink-0 overflow-y-auto border-b border-border p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-text-primary">{activeView.displayTitle}</h3>
            <div className="ui-dev-label mt-1 text-[11px] text-text-muted">
              {activeView.source} · {makeSessionLabel(activeView)} · 更新于 {formatTime(activeView.updated_at)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button onClick={onOpenPrompt} aria-label="打开历史 Prompt 库" className="ui-btn" title="历史 Prompt 库">
              <BookCopy size={12} />
              历史Prompt
            </button>
            <button onClick={onOpenDiff} aria-label="打开 Diff 视图" className="ui-btn" title="Diff 视图">
              <GitCompare size={12} />
              Diff
            </button>
            <button
              onClick={onToggleStar}
              aria-label={activeView.starred ? "取消收藏会话" : "收藏会话"}
              className="ui-btn"
              style={{ color: activeView.starred ? "var(--warning)" : undefined }}
              title="收藏"
            >
              <Star size={12} fill={activeView.starred ? "currentColor" : "none"} />
              {activeView.starred ? "已收藏" : "收藏"}
            </button>
          </div>
        </div>

        <MetaEditor
          aliasDraft={aliasDraft}
          tagsDraft={tagsDraft}
          sessionQuery={sessionQuery}
          sessionSearchRef={sessionSearchRef}
          matchCursor={matchCursor}
          matchCount={matchIndices.length}
          onAliasDraftChange={onAliasDraftChange}
          onTagsDraftChange={onTagsDraftChange}
          onSessionQueryChange={onSessionQueryChange}
          onSaveMeta={onSaveMeta}
          onJumpPrev={onJumpPrev}
          onJumpNext={onJumpNext}
        />
      </div>

      <div ref={messageListRef} onScroll={onMessageListScroll} className="min-h-0 space-y-2 overflow-x-hidden overflow-y-auto p-3">
        {loadingSessionDetail && <div className="text-xs text-text-muted">正在读取会话详情...</div>}

        {!loadingSessionDetail && activeSession?.messages.length === 0 && (
          <div className="text-xs text-text-muted">当前会话没有可显示的消息</div>
        )}

        {!loadingSessionDetail &&
          visibleMessages.map((msg, idx) => {
            const isMatched = matchIndices.includes(idx);
            const isFocused = focusedMessageIndex === idx;
            const badge = roleBadge(msg.role);
            return (
              <div
                key={`${msg.role}-${idx}`}
                ref={(el) => {
                  messageRefs.current[idx] = el;
                }}
                className="rounded-md border border-border bg-bg-secondary p-2"
                style={{
                  borderColor: isFocused ? "var(--warning)" : isMatched ? "var(--accent)" : "var(--border)",
                }}
              >
                <div className="ui-dev-label mb-1 flex items-center justify-between text-[11px] text-text-muted">
                  <span
                    className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide"
                    style={{
                      color: badge.color,
                      backgroundColor: badge.bg,
                      border: `1px solid ${badge.border}`,
                    }}
                  >
                    {badge.label}
                  </span>
                  <span>{msg.timestamp ?? "-"}</span>
                </div>
                <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-text-primary">
                  {highlightText(msg.content, sessionQuery)}
                </pre>
              </div>
            );
          })}

        {!loadingSessionDetail && hasMoreMessages && (
          <button onClick={onLoadMoreMessages} className="ui-btn w-full" aria-label="加载更多消息">
            加载更多消息 ({visibleMessageCount}/{totalMessageCount})
          </button>
        )}
      </div>
    </>
  );
}
