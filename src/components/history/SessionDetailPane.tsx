import { useVirtualizer } from "@tanstack/react-virtual";
import { BookCopy, ChevronDown, ChevronRight, Copy, GitCompare, Star, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import type { HistoryMessage, HistorySessionDetail, HistorySessionView } from "../../lib/types";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import { EmptyState } from "../ui/EmptyState";
import { SessionTranscriptContent } from "./SessionTranscriptContent";
import { MetaEditor } from "./MetaEditor";
import { formatTime, makeSessionLabel, roleBadge } from "./historyViewUtils";
import { SessionTimelineView } from "./SessionTimelineView";
import { SessionContextView } from "./SessionContextView";
import { SessionFileChangesView } from "./SessionFileChangesView";
import { SessionToolDiagnosticsView } from "./SessionToolDiagnosticsView";
import { SessionSubtaskTreeView } from "./SessionSubtaskTreeView";
import type { SessionProcessModel } from "./sessionEvents";

export type HistoryDetailView = "transcript" | "timeline" | "context" | "changes" | "tools" | "subtasks";

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
  focusedMessageSeq: number;
  visibleMessages: HistoryMessage[];
  visibleMessageCount: number;
  hasMoreMessages: boolean;
  totalMessageCount: number;
  processModel: SessionProcessModel;
  detailView: HistoryDetailView;
  messageListRef: RefObject<HTMLDivElement | null>;
  sessionSearchRef: RefObject<HTMLInputElement | null>;
  messageRefs: RefObject<Record<number, HTMLDivElement | null>>;
  onDetailViewChange: (view: HistoryDetailView) => void;
  onMessageListScroll: () => void;
  onAliasDraftChange: (value: string) => void;
  onTagsDraftChange: (value: string) => void;
  onSessionQueryChange: (value: string) => void;
  onSaveMeta: () => void;
  onJumpPrev: () => void;
  onJumpNext: () => void;
  onOpenPrompt: () => void;
  onOpenDiff: () => void;
  onResumeSession: () => void;
  onJumpToMessage: (messageIndex: number) => void;
  onToggleStar: () => void;
  onLoadMoreMessages: () => void;
}

const DETAIL_VIEWS: Array<{ id: HistoryDetailView; labelKey: TranslationKey }> = [
  { id: "transcript", labelKey: "history.detail.view.transcript" },
  { id: "timeline", labelKey: "history.detail.view.timeline" },
  { id: "context", labelKey: "history.detail.view.context" },
  { id: "changes", labelKey: "history.detail.view.changes" },
  { id: "tools", labelKey: "history.detail.view.tools" },
  { id: "subtasks", labelKey: "history.detail.view.subtasks" },
];

function isInjectedPromptContent(content: string): boolean {
  const trimmed = content.trimStart();
  const lowerTrimmed = trimmed.toLowerCase();
  const firstLine = lowerTrimmed.split(/\r?\n/, 1)[0]?.replace(/^#+\s*/, "").trim() ?? "";
  return (
    firstLine.startsWith("agents.md instructions for ") ||
    firstLine.startsWith("system prompt") ||
    firstLine.startsWith("developer instructions") ||
    lowerTrimmed.startsWith("<system-reminder") ||
    lowerTrimmed.startsWith("<codex_internal_context") ||
    lowerTrimmed.startsWith("<session-context")
  );
}

function shouldAutoCollapseMessage(message: HistoryMessage): boolean {
  if (isInjectedPromptContent(message.content)) return true;
  const role = message.role;
  const normalized = role.toLowerCase();
  return normalized !== "user";
}

function getCollapsedMessagePreview(content: string, fallback: string): string[] {
  const lines: string[] = [];
  let start = 0;

  for (let i = 0; i <= content.length && lines.length < 2; i++) {
    if (i < content.length && content[i] !== "\n") continue;
    const line = content.slice(start, i).replace(/\r$/, "").trim();
    if (line) lines.push(line);
    start = i + 1;
  }

  return lines.length > 0 ? lines : [fallback];
}

function AutoCollapsedMessageContent({
  message,
  query,
  open,
}: {
  message: HistoryMessage;
  query: string;
  open: boolean;
}) {
  const { t } = useI18n();
  if (!shouldAutoCollapseMessage(message)) {
    return <SessionTranscriptContent content={message.content} query={query} />;
  }

  const previewLines = getCollapsedMessagePreview(message.content, t("history.detail.noText"));

  if (open) {
    return (
      <div className="ui-history-message-collapse">
        <SessionTranscriptContent content={message.content} query={query} />
      </div>
    );
  }

  return (
    <div className="ui-history-message-collapse">
      <span className="ui-history-message-collapse-preview">
        {previewLines.map((line, index) => (
          <span key={index}>{line}</span>
        ))}
      </span>
    </div>
  );
}

function HistoryMessageCard({
  message,
  index,
  isMatched,
  isFocused,
  badge,
  query,
  messageRefs,
  measureElement,
}: {
  message: HistoryMessage;
  index: number;
  isMatched: boolean;
  isFocused: boolean;
  badge: ReturnType<typeof roleBadge>;
  query: string;
  messageRefs: RefObject<Record<number, HTMLDivElement | null>>;
  measureElement: (element: Element) => void;
}) {
  const { t } = useI18n();
  const forceOpen = isMatched || isFocused;
  const collapsible = shouldAutoCollapseMessage(message);
  const [open, setOpen] = useState(forceOpen);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  useEffect(() => {
    if (cardRef.current) measureElement(cardRef.current);
  }, [measureElement, open]);

  const setCardRef = (element: HTMLDivElement | null) => {
    cardRef.current = element;
    messageRefs.current[index] = element;
    if (element) measureElement(element);
  };
  const toggleTitle = open ? t("history.detail.collapse") : t("history.detail.expand");

  return (
    <div
      data-index={index}
      ref={setCardRef}
      className="ui-history-message-card absolute left-0 top-0 w-full p-2.5"
      style={{
        borderColor: isFocused ? "var(--warning)" : isMatched ? "var(--accent)" : "var(--border)",
      }}
    >
      {collapsible ? (
        <button
          type="button"
          className="ui-history-message-header ui-dev-label mb-1 flex w-full items-center justify-between text-[11px] text-text-muted"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          title={toggleTitle}
        >
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
          <span className="flex min-w-0 items-center gap-2">
            <span>{message.timestamp ?? "-"}</span>
            <span className="ui-history-message-collapse-icon" aria-hidden="true">
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          </span>
        </button>
      ) : (
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
          <span>{message.timestamp ?? "-"}</span>
        </div>
      )}
      <AutoCollapsedMessageContent message={message} query={query} open={open} />
    </div>
  );
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
  focusedMessageSeq,
  visibleMessages,
  visibleMessageCount,
  hasMoreMessages,
  totalMessageCount,
  processModel,
  detailView,
  messageListRef,
  sessionSearchRef,
  messageRefs,
  onDetailViewChange,
  onMessageListScroll,
  onAliasDraftChange,
  onTagsDraftChange,
  onSessionQueryChange,
  onSaveMeta,
  onJumpPrev,
  onJumpNext,
  onOpenPrompt,
  onOpenDiff,
  onResumeSession,
  onJumpToMessage,
  onToggleStar,
  onLoadMoreMessages,
}: SessionDetailPaneProps) {
  const { t, language } = useI18n();
  // matchIndices.includes(idx) 在 visibleMessages.map 内对每个可见消息做 O(N) 扫描，
  // 当匹配数 N 和可见消息数 M 都达到几百时累计 O(N·M)。改 Set 后是 O(1) lookup。
  const matchSet = useMemo(() => new Set(matchIndices), [matchIndices]);
  const activeMatchIndex = matchIndices[Math.min(matchCursor, Math.max(0, matchIndices.length - 1))];
  const messageVirtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => messageListRef.current,
    estimateSize: () => 220,
    overscan: 6,
    getItemKey: (index) => `${visibleMessages[index]?.role ?? "message"}:${index}`,
  });

  useEffect(() => {
    if (activeMatchIndex === undefined) return;
    if (detailView === "transcript" && activeMatchIndex < visibleMessages.length) {
      messageVirtualizer.scrollToIndex(activeMatchIndex, { align: "center" });
    }
  }, [activeMatchIndex, detailView, messageVirtualizer, visibleMessages.length]);

  useEffect(() => {
    if (focusedMessageIndex === null || focusedMessageIndex >= visibleMessages.length) return;
    if (detailView === "transcript") messageVirtualizer.scrollToIndex(focusedMessageIndex, { align: "center" });
  }, [detailView, focusedMessageIndex, focusedMessageSeq, messageVirtualizer, visibleMessages.length]);

  if (!activeView) {
    return (
      <div className="row-span-2 flex min-h-0 items-center justify-center">
        <EmptyState
          icon={<BookCopy size={34} strokeWidth={1.5} />}
          title={t("history.detail.noSelectionTitle")}
          description={t("history.detail.noSelectionDescription")}
        />
      </div>
    );
  }

  const copyText = (text: string, label: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success(t("history.detail.copySuccess", { label })))
      .catch((err) => toast.error(t("history.detail.copyFailed"), { description: String(err) }));
  };

  const locationText = [
    `sessionId=${activeView.session_id}`,
    `source=${activeView.source}`,
    `project=${activeView.project_key}`,
    `filePath=${activeView.file_path}`,
  ].join("\n");

  return (
    <>
      <div className="ui-history-detail-top [grid-row:1] min-h-0 shrink-0 overflow-y-auto p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-text-primary">{activeView.displayTitle}</h3>
            <div className="ui-dev-label mt-1 text-[11px] text-text-muted">
              {activeView.source} · {makeSessionLabel(activeView)} · {t("history.detail.updatedAt", { time: formatTime(activeView.updated_at, language) })}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
              <span className="ui-dev-label max-w-full truncate rounded border border-border bg-bg-secondary px-1.5 py-0.5">
                sessionId: {activeView.session_id}
              </span>
              <button
                onClick={() => copyText(activeView.session_id, "sessionId")}
                className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
                style={{ color: "var(--accent)" }}
                title={t("history.detail.copySessionId")}
              >
                <Copy size={11} />
                {t("history.detail.copyId")}
              </button>
              <button
                onClick={() => copyText(locationText, t("history.detail.copyLocationLabel"))}
                className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
                style={{ color: "var(--primary)" }}
                title={t("history.detail.copyLocation")}
              >
                <Copy size={11} />
                {t("history.detail.copyLocationShort")}
              </button>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={onResumeSession}
              disabled={loadingSessionDetail || !activeSession}
              aria-label={t("history.detail.resume")}
              className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact ui-history-detail-resume-action"
              title={t("history.detail.resumeTitle")}
            >
              <Terminal size={12} />
              {t("history.detail.resume")}
            </button>
            <button
              onClick={onOpenPrompt}
              aria-label={t("history.detail.openPrompt")}
              className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
              style={{ color: "var(--success)" }}
              title={t("history.detail.promptLibrary")}
            >
              <BookCopy size={12} />
              {t("history.detail.promptShort")}
            </button>
            <button
              onClick={onOpenDiff}
              aria-label={t("history.detail.openDiff")}
              className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
              style={{ color: "var(--danger)" }}
              title={t("history.detail.diffView")}
            >
              <GitCompare size={12} />
              Diff
            </button>
            <button
              onClick={onToggleStar}
              aria-label={activeView.starred ? t("history.detail.unstar") : t("history.detail.star")}
              className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
              style={{
                color: activeView.starred
                  ? "var(--warning)"
                  : "color-mix(in srgb, var(--warning) 78%, var(--on-surface-variant))",
              }}
              title={t("history.detail.starTitle")}
            >
              <Star size={12} fill={activeView.starred ? "currentColor" : "none"} />
              {activeView.starred ? t("history.detail.starred") : t("history.detail.starTitle")}
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

        <div className="ui-history-detail-tabs" role="tablist" aria-label={t("history.detail.viewsAria")}>
          {DETAIL_VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={detailView === item.id}
              data-active={detailView === item.id}
              onClick={() => onDetailViewChange(item.id)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div ref={messageListRef} onScroll={onMessageListScroll} className="[grid-row:2] min-h-0 h-full overflow-x-hidden overflow-y-auto p-3">
        {loadingSessionDetail && <div className="text-xs text-text-muted">{t("history.detail.loading")}</div>}

        {!loadingSessionDetail && activeSession?.messages.length === 0 && (
          <div className="text-xs text-text-muted">{t("history.detail.noMessages")}</div>
        )}

        {!loadingSessionDetail && detailView === "transcript" && visibleMessages.length > 0 && (
          <div className="relative w-full" style={{ height: messageVirtualizer.getTotalSize() }}>
            {messageVirtualizer.getVirtualItems().map((virtualRow) => {
              const msg = visibleMessages[virtualRow.index];
              if (!msg) return null;
              const isMatched = matchSet.has(virtualRow.index);
              const isFocused = focusedMessageIndex === virtualRow.index;
              const badge = roleBadge(msg.role);
              return (
                <div key={virtualRow.key} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${virtualRow.start}px)` }}>
                  <HistoryMessageCard
                    message={msg}
                    index={virtualRow.index}
                    isMatched={isMatched}
                    isFocused={isFocused}
                    badge={badge}
                    query={sessionQuery}
                    messageRefs={messageRefs}
                    measureElement={messageVirtualizer.measureElement}
                  />
                </div>
              );
            })}
          </div>
        )}

        {!loadingSessionDetail && detailView === "timeline" && (
          <SessionTimelineView model={processModel} onJumpToMessage={onJumpToMessage} />
        )}

        {!loadingSessionDetail && detailView === "context" && <SessionContextView session={activeSession} />}

        {!loadingSessionDetail && detailView === "changes" && (
          <SessionFileChangesView model={processModel} onJumpToMessage={onJumpToMessage} onOpenDiff={onOpenDiff} />
        )}

        {!loadingSessionDetail && detailView === "tools" && (
          <SessionToolDiagnosticsView
            model={processModel}
            builtinCalls={activeSession?.usage?.builtin_calls ?? []}
            mcpCalls={activeSession?.usage?.mcp_calls ?? []}
            skillCalls={activeSession?.usage?.skill_calls ?? []}
            toolEvents={activeSession?.tool_events ?? []}
            onJumpToMessage={onJumpToMessage}
          />
        )}

        {!loadingSessionDetail && detailView === "subtasks" && (
          <SessionSubtaskTreeView model={processModel} onJumpToMessage={onJumpToMessage} />
        )}

        {!loadingSessionDetail && detailView === "transcript" && hasMoreMessages && (
          <button onClick={onLoadMoreMessages} className="ui-btn mt-2.5 w-full" aria-label={t("history.detail.loadMoreMessages")}>
            {t("history.detail.loadMoreMessagesCount", { visible: visibleMessageCount, total: totalMessageCount })}
          </button>
        )}
      </div>
    </>
  );
}
