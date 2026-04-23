import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { toast } from "sonner";
import { useHistoryStore } from "../stores/historyStore";
import type { HistorySearchHit, HistorySessionView, HistorySourceFilter } from "../lib/types";
import { useSettingsStore } from "../stores/settingsStore";
import { PromptLibrary } from "./prompts/PromptLibrary";
import { DiffModal } from "./history/DiffModal";
import { HistoryListPane } from "./history/HistoryListPane";
import { SessionDetailPane } from "./history/SessionDetailPane";
import { toGroupLabel, type TimeGroupLabel } from "./history/historyViewUtils";

const SESSION_PAGE_SIZE = 200;
const MESSAGE_PAGE_SIZE = 160;
const LOAD_MORE_THRESHOLD_PX = 220;

function makeHitKey(hit: HistorySearchHit): string {
  return `${hit.source}:${hit.session_id}:${hit.file_path}`;
}

export function HistoryWorkspace() {
  const loadingSessions = useHistoryStore((s) => s.loadingSessions);
  const loadingSessionDetail = useHistoryStore((s) => s.loadingSessionDetail);
  const searching = useHistoryStore((s) => s.searching);
  const sourceFilter = useHistoryStore((s) => s.sourceFilter);
  const sessions = useHistoryStore((s) => s.sessions);
  const activeSessionKey = useHistoryStore((s) => s.activeSessionKey);
  const activeSession = useHistoryStore((s) => s.activeSession);
  const globalQuery = useHistoryStore((s) => s.globalQuery);
  const sessionQuery = useHistoryStore((s) => s.sessionQuery);
  const searchHits = useHistoryStore((s) => s.searchHits);
  const focusedMessageIndex = useHistoryStore((s) => s.focusedMessageIndex);
  const focusedMessageSeq = useHistoryStore((s) => s.focusedMessageSeq);
  const focusGlobalSearchSeq = useHistoryStore((s) => s.focusGlobalSearchSeq);
  const focusSessionSearchSeq = useHistoryStore((s) => s.focusSessionSearchSeq);
  const closeHistory = useHistoryStore((s) => s.closeHistory);
  const setSourceFilter = useHistoryStore((s) => s.setSourceFilter);
  const loadSessions = useHistoryStore((s) => s.loadSessions);
  const openSession = useHistoryStore((s) => s.openSession);
  const setGlobalQuery = useHistoryStore((s) => s.setGlobalQuery);
  const runGlobalSearch = useHistoryStore((s) => s.runGlobalSearch);
  const setSessionQuery = useHistoryStore((s) => s.setSessionQuery);
  const openSessionAtMessage = useHistoryStore((s) => s.openSessionAtMessage);
  const clearFocusedMessage = useHistoryStore((s) => s.clearFocusedMessage);
  const updateMeta = useHistoryStore((s) => s.updateMeta);
  const historySidebarWidth = useSettingsStore((s) => s.historySidebarWidth);
  const updateSetting = useSettingsStore((s) => s.update);

  const globalSearchRef = useRef<HTMLInputElement | null>(null);
  const sessionSearchRef = useRef<HTMLInputElement | null>(null);
  const sessionListRef = useRef<HTMLDivElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const pendingScrollMessageRef = useRef<number | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const isResizing = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const resizingWidthRef = useRef(historySidebarWidth);

  const [aliasDraft, setAliasDraft] = useState("");
  const [tagsDraft, setTagsDraft] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);
  const [promptOpen, setPromptOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [visibleSessionCount, setVisibleSessionCount] = useState(SESSION_PAGE_SIZE);
  const [visibleMessageCount, setVisibleMessageCount] = useState(MESSAGE_PAGE_SIZE);

  const activeView = useMemo(
    () => sessions.find((item) => item.sessionKey === activeSessionKey) ?? null,
    [sessions, activeSessionKey]
  );

  const activeTagText = useMemo(() => (activeView ? activeView.tags.join(", ") : ""), [activeView]);

  const startResize = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      resizingWidthRef.current = historySidebarWidth;
      const onMove = (ev: MouseEvent) => {
        if (!isResizing.current) return;
        const left = sidebarRef.current?.getBoundingClientRect().left ?? 0;
        const rawWidth = ev.clientX - left;
        const nextWidth = Math.max(220, Math.min(520, rawWidth));
        resizingWidthRef.current = nextWidth;
        if (resizeFrameRef.current !== null) return;
        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          if (sidebarRef.current) {
            sidebarRef.current.style.width = `${resizingWidthRef.current}px`;
          }
        });
      };
      const onUp = () => {
        isResizing.current = false;
        if (resizeFrameRef.current !== null) {
          window.cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        if (sidebarRef.current) {
          sidebarRef.current.style.width = `${resizingWidthRef.current}px`;
        }
        void updateSetting("historySidebarWidth", resizingWidthRef.current);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [historySidebarWidth, updateSetting]
  );

  useEffect(() => {
    void loadSessions().catch((err) => {
      toast.error("加载历史会话失败", { description: String(err) });
    });
  }, [loadSessions]);

  useEffect(() => {
    setAliasDraft(activeView?.alias ?? "");
    setTagsDraft(activeTagText);
  }, [activeView?.sessionKey, activeView?.alias, activeTagText]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void runGlobalSearch(globalQuery);
    }, 220);
    return () => clearTimeout(timer);
  }, [globalQuery, runGlobalSearch, sourceFilter]);

  useEffect(() => {
    globalSearchRef.current?.focus();
    globalSearchRef.current?.select();
  }, [focusGlobalSearchSeq]);

  useEffect(() => {
    sessionSearchRef.current?.focus();
    sessionSearchRef.current?.select();
  }, [focusSessionSearchSeq]);

  const normalizedGlobal = globalQuery.trim().toLowerCase();

  const filteredSessions = useMemo(() => {
    return sessions.filter((item) => {
      if (!normalizedGlobal) return true;
      const title = item.displayTitle.toLowerCase();
      const project = item.project_key.toLowerCase();
      const tags = item.tags.join(" ").toLowerCase();
      return (
        title.includes(normalizedGlobal) ||
        project.includes(normalizedGlobal) ||
        tags.includes(normalizedGlobal)
      );
    });
  }, [sessions, normalizedGlobal]);

  useEffect(() => {
    setVisibleSessionCount(Math.min(SESSION_PAGE_SIZE, filteredSessions.length));
  }, [filteredSessions.length]);

  const visibleFilteredSessions = useMemo(
    () => filteredSessions.slice(0, visibleSessionCount),
    [filteredSessions, visibleSessionCount]
  );

  const hasMoreSessions = visibleSessionCount < filteredSessions.length;

  const groupedSessions = useMemo(() => {
    const order: TimeGroupLabel[] = ["Today", "Yesterday", "This Week", "This Month", "Earlier"];
    const map = new Map<TimeGroupLabel, HistorySessionView[]>();
    const nowTs = Date.now();
    for (const item of visibleFilteredSessions) {
      const label = toGroupLabel(item.updated_at, nowTs);
      const list = map.get(label) ?? [];
      list.push(item);
      map.set(label, list);
    }
    return order
      .map((label) => ({ label, items: map.get(label) ?? [] }))
      .filter((group) => group.items.length > 0);
  }, [visibleFilteredSessions]);

  const handleSessionListScroll = useCallback(() => {
    const container = sessionListRef.current;
    if (!container || !hasMoreSessions) return;
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (remaining > LOAD_MORE_THRESHOLD_PX) return;
    setVisibleSessionCount((prev) => Math.min(filteredSessions.length, prev + SESSION_PAGE_SIZE));
  }, [filteredSessions.length, hasMoreSessions]);

  const matchIndices = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    if (!query || !activeSession) return [];
    const indices: number[] = [];
    activeSession.messages.forEach((msg, idx) => {
      if (msg.content.toLowerCase().includes(query)) {
        indices.push(idx);
      }
    });
    return indices;
  }, [activeSession, sessionQuery]);

  useEffect(() => {
    setMatchCursor(0);
  }, [sessionQuery, activeSession?.session_id]);

  useEffect(() => {
    setVisibleMessageCount(MESSAGE_PAGE_SIZE);
    pendingScrollMessageRef.current = null;
    messageRefs.current = {};
  }, [activeSession?.session_id]);

  const visibleMessages = useMemo(
    () => (activeSession?.messages ?? []).slice(0, visibleMessageCount),
    [activeSession?.messages, visibleMessageCount]
  );

  const hasMoreMessages = visibleMessageCount < (activeSession?.messages.length ?? 0);

  const ensureMessageRendered = useCallback(
    (index: number) => {
      if (index < 0) return false;
      const total = activeSession?.messages.length ?? 0;
      if (index >= total) return false;
      if (index >= visibleMessageCount) {
        pendingScrollMessageRef.current = index;
        setVisibleMessageCount((prev) => Math.min(total, Math.max(prev, index + 40)));
        return false;
      }
      return true;
    },
    [activeSession?.messages.length, visibleMessageCount]
  );

  useEffect(() => {
    const pendingIndex = pendingScrollMessageRef.current;
    if (pendingIndex === null || pendingIndex >= visibleMessageCount) return;
    pendingScrollMessageRef.current = null;
    requestAnimationFrame(() => {
      messageRefs.current[pendingIndex]?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [visibleMessageCount]);

  useEffect(() => {
    if (matchIndices.length === 0) return;
    const targetIdx = matchIndices[Math.min(matchCursor, matchIndices.length - 1)];
    if (!ensureMessageRendered(targetIdx)) return;
    messageRefs.current[targetIdx]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [ensureMessageRendered, matchCursor, matchIndices]);

  useEffect(() => {
    if (focusedMessageIndex === null) return;
    if (!ensureMessageRendered(focusedMessageIndex)) return;
    messageRefs.current[focusedMessageIndex]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [ensureMessageRendered, focusedMessageSeq, focusedMessageIndex, activeSession?.session_id]);

  const handleMessageListScroll = useCallback(() => {
    const container = messageListRef.current;
    if (!container || !hasMoreMessages) return;
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (remaining > LOAD_MORE_THRESHOLD_PX) return;
    setVisibleMessageCount((prev) => Math.min(activeSession?.messages.length ?? 0, prev + MESSAGE_PAGE_SIZE));
  }, [activeSession?.messages.length, hasMoreMessages]);

  const saveMeta = async () => {
    if (!activeView) return;
    const tags = tagsDraft
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    try {
      await updateMeta(activeView.sessionKey, { alias: aliasDraft, tags });
      toast.success("会话元数据已保存");
    } catch (err) {
      toast.error("保存失败", { description: String(err) });
    }
  };

  const toggleStar = async () => {
    if (!activeView) return;
    try {
      await updateMeta(activeView.sessionKey, { starred: !activeView.starred });
      toast.success(activeView.starred ? "已取消收藏" : "已收藏");
    } catch (err) {
      toast.error("收藏操作失败", { description: String(err) });
    }
  };

  const openByHit = async (hit: HistorySearchHit) => {
    const key = makeHitKey(hit);
    try {
      await openSession(key);
      clearFocusedMessage();
      setSessionQuery(globalQuery.trim());
    } catch (err) {
      toast.error("打开搜索命中失败", { description: String(err) });
    }
  };

  const openSessionSafe = useCallback(
    (sessionKey: string) => {
      void openSession(sessionKey).catch((err) => {
        toast.error("打开会话失败", { description: String(err) });
      });
    },
    [openSession]
  );

  const jumpToMessage = async (messageIndex: number) => {
    if (!activeView) return;
    try {
      await openSessionAtMessage(activeView.sessionKey, messageIndex);
    } catch (err) {
      toast.error("定位消息失败", { description: String(err) });
    }
  };

  const jumpNext = () => {
    if (matchIndices.length === 0) return;
    setMatchCursor((prev) => (prev + 1) % matchIndices.length);
  };

  const jumpPrev = () => {
    if (matchIndices.length === 0) return;
    setMatchCursor((prev) => (prev - 1 + matchIndices.length) % matchIndices.length);
  };

  return (
    <div id="history-workspace" className="ui-history-shell flex h-full min-h-0 min-w-0 overflow-hidden rounded-2xl">
      <HistoryListPane
        historySidebarWidth={historySidebarWidth}
        sidebarRef={sidebarRef}
        sessionListRef={sessionListRef}
        sourceFilter={sourceFilter}
        globalQuery={globalQuery}
        activeSessionKey={activeSessionKey}
        loadingSessions={loadingSessions}
        searching={searching}
        normalizedGlobal={normalizedGlobal}
        groupedSessions={groupedSessions}
        filteredSessionCount={filteredSessions.length}
        hasMoreSessions={hasMoreSessions}
        visibleSessionCount={visibleSessionCount}
        searchHits={searchHits}
        globalSearchRef={globalSearchRef}
        onClose={closeHistory}
        onRefresh={() => {
          void loadSessions().catch((err) => {
            toast.error("刷新失败", { description: String(err) });
          });
        }}
        onSourceFilterChange={(value) => {
          void setSourceFilter(value as HistorySourceFilter);
        }}
        onGlobalQueryChange={setGlobalQuery}
        onOpenSession={openSessionSafe}
        onOpenHit={(hit) => {
          void openByHit(hit);
        }}
        onLoadMoreSessions={() =>
          setVisibleSessionCount((prev) => Math.min(filteredSessions.length, prev + SESSION_PAGE_SIZE))
        }
        onSessionListScroll={handleSessionListScroll}
        onStartResize={startResize}
      />

      <section className="ui-history-detail relative grid min-h-0 min-w-0 flex-1 grid-rows-[auto_1fr] overflow-hidden">
        <SessionDetailPane
          activeView={activeView}
          activeSession={activeSession}
          loadingSessionDetail={loadingSessionDetail}
          aliasDraft={aliasDraft}
          tagsDraft={tagsDraft}
          sessionQuery={sessionQuery}
          matchIndices={matchIndices}
          matchCursor={matchCursor}
          focusedMessageIndex={focusedMessageIndex}
          visibleMessages={visibleMessages}
          visibleMessageCount={visibleMessageCount}
          hasMoreMessages={hasMoreMessages}
          totalMessageCount={activeSession?.messages.length ?? 0}
          messageListRef={messageListRef}
          sessionSearchRef={sessionSearchRef}
          messageRefs={messageRefs}
          onMessageListScroll={handleMessageListScroll}
          onAliasDraftChange={setAliasDraft}
          onTagsDraftChange={setTagsDraft}
          onSessionQueryChange={setSessionQuery}
          onSaveMeta={() => {
            void saveMeta();
          }}
          onJumpPrev={jumpPrev}
          onJumpNext={jumpNext}
          onOpenPrompt={() => setPromptOpen(true)}
          onOpenDiff={() => setDiffOpen(true)}
          onToggleStar={() => {
            void toggleStar();
          }}
          onLoadMoreMessages={() =>
            setVisibleMessageCount((prev) => Math.min(activeSession?.messages.length ?? 0, prev + MESSAGE_PAGE_SIZE))
          }
        />

        <PromptLibrary
          open={promptOpen}
          sessions={sessions}
          activeSessionKey={activeSessionKey}
          onClose={() => setPromptOpen(false)}
          onJumpToPrompt={async (sessionKey, messageIndex) => {
            await openSessionAtMessage(sessionKey, messageIndex);
          }}
        />

        <DiffModal
          open={diffOpen}
          messages={activeSession?.messages ?? []}
          onClose={() => setDiffOpen(false)}
          onJumpToMessage={(messageIndex) => {
            void jumpToMessage(messageIndex);
          }}
        />
      </section>
    </div>
  );
}
