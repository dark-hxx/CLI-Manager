import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { BookCopy, GitCompare, RefreshCw, Search, Star } from "lucide-react";
import { useHistoryStore } from "../stores/historyStore";
import type { HistorySearchHit, HistorySessionView } from "../lib/types";
import { EmptyState } from "./ui/EmptyState";
import { toast } from "sonner";
import { useSettingsStore } from "../stores/settingsStore";
import { PromptLibrary } from "./prompts/PromptLibrary";
import { DiffModal } from "./history/DiffModal";

function formatTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(text: string, query: string): ReactNode {
  const trimmed = query.trim();
  if (!trimmed) return text;
  const regex = new RegExp(`(${escapeRegExp(trimmed)})`, "ig");
  const parts = text.split(regex);
  const normalized = trimmed.toLowerCase();
  return parts.map((part, idx) => {
    if (part.toLowerCase() === normalized) {
      return (
        <mark
          key={`${part}-${idx}`}
          className="px-0.5 rounded-sm"
          style={{ backgroundColor: "var(--warning)", color: "var(--bg-primary)" }}
        >
          {part}
        </mark>
      );
    }
    return <span key={`${part}-${idx}`}>{part}</span>;
  });
}

function makeHitKey(hit: HistorySearchHit): string {
  return `${hit.source}:${hit.session_id}:${hit.file_path}`;
}

function makeSessionLabel(session: HistorySessionView): string {
  if (session.branch && session.branch.trim()) {
    return `${session.project_key} · ${session.branch}`;
  }
  return session.project_key;
}

type TimeGroupLabel = "Today" | "Yesterday" | "This Week" | "This Month" | "Earlier";

function toGroupLabel(ts: number, nowTs: number): TimeGroupLabel {
  if (!Number.isFinite(ts) || ts <= 0) return "Earlier";
  const todayStart = new Date(nowTs);
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  if (ts >= todayMs) return "Today";

  const yesterdayMs = todayMs - 24 * 60 * 60 * 1000;
  if (ts >= yesterdayMs) return "Yesterday";

  const day = todayStart.getDay();
  const mondayOffset = day === 0 ? 6 : day - 1;
  const weekMs = todayMs - mondayOffset * 24 * 60 * 60 * 1000;
  if (ts >= weekMs) return "This Week";

  const monthMs = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1).getTime();
  if (ts >= monthMs) return "This Month";

  return "Earlier";
}

function roleBadge(role: string): { label: string; color: string; bg: string; border: string } {
  const normalized = role.toLowerCase();
  if (normalized === "user") {
    return {
      label: "USER",
      color: "#1d4ed8",
      bg: "rgba(59, 130, 246, 0.12)",
      border: "rgba(59, 130, 246, 0.35)",
    };
  }
  if (normalized === "assistant") {
    return {
      label: "ASSISTANT",
      color: "#047857",
      bg: "rgba(16, 185, 129, 0.12)",
      border: "rgba(16, 185, 129, 0.3)",
    };
  }
  if (normalized === "system") {
    return {
      label: "SYSTEM",
      color: "#7c3aed",
      bg: "rgba(124, 58, 237, 0.12)",
      border: "rgba(124, 58, 237, 0.35)",
    };
  }
  return {
    label: normalized.toUpperCase(),
    color: "var(--text-secondary)",
    bg: "var(--bg-tertiary)",
    border: "var(--border)",
  };
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
  const messageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const sidebarRef = useRef<HTMLElement | null>(null);
  const isResizing = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const resizingWidthRef = useRef(historySidebarWidth);

  const [aliasDraft, setAliasDraft] = useState("");
  const [tagsDraft, setTagsDraft] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);
  const [promptOpen, setPromptOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

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
    if (!globalSearchRef.current) return;
    globalSearchRef.current.focus();
    globalSearchRef.current.select();
  }, [focusGlobalSearchSeq]);

  useEffect(() => {
    if (!sessionSearchRef.current) return;
    sessionSearchRef.current.focus();
    sessionSearchRef.current.select();
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

  const groupedSessions = useMemo(() => {
    const order: TimeGroupLabel[] = ["Today", "Yesterday", "This Week", "This Month", "Earlier"];
    const map = new Map<TimeGroupLabel, HistorySessionView[]>();
    const nowTs = Date.now();
    for (const item of filteredSessions) {
      const label = toGroupLabel(item.updated_at, nowTs);
      const list = map.get(label) ?? [];
      list.push(item);
      map.set(label, list);
    }
    return order
      .map((label) => ({ label, items: map.get(label) ?? [] }))
      .filter((group) => group.items.length > 0);
  }, [filteredSessions]);

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
    if (matchIndices.length === 0) return;
    const targetIdx = matchIndices[Math.min(matchCursor, matchIndices.length - 1)];
    const target = messageRefs.current[targetIdx];
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [matchCursor, matchIndices]);

  useEffect(() => {
    if (focusedMessageIndex === null) return;
    const target = messageRefs.current[focusedMessageIndex];
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusedMessageSeq, focusedMessageIndex, activeSession?.session_id]);

  const saveMeta = async () => {
    if (!activeView) return;
    const tags = tagsDraft
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    try {
      await updateMeta(activeView.sessionKey, {
        alias: aliasDraft,
        tags,
      });
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
    <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
      <aside
        ref={sidebarRef}
        className="relative border-r flex flex-col min-h-0 min-w-[220px] max-w-[70%]"
        style={{
          width: historySidebarWidth,
          borderColor: "var(--border)",
          backgroundColor: "var(--bg-secondary)",
        }}
      >
        <div className="p-3 border-b" style={{ borderColor: "var(--border)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={closeHistory}
              className="text-xs rounded-md border px-2 py-1 shrink-0"
              style={{
                borderColor: "var(--border)",
                color: "var(--text-secondary)",
                backgroundColor: "var(--bg-tertiary)",
              }}
            >
              关闭
            </button>
            <select
              className="text-xs rounded-md border px-2 py-1 outline-none shrink-0"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--bg-tertiary)",
                color: "var(--text-primary)",
              }}
              value={sourceFilter}
              onChange={(e) => {
                void setSourceFilter(e.target.value as "all" | "claude" | "codex");
              }}
            >
              <option value="all">全部来源</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
            <button
              onClick={() => {
                void loadSessions().catch((err) => {
                  toast.error("刷新失败", { description: String(err) });
                });
              }}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border shrink-0"
              style={{
                borderColor: "var(--border)",
                color: "var(--text-secondary)",
                backgroundColor: "var(--bg-tertiary)",
              }}
              title="刷新会话列表"
            >
              <RefreshCw size={12} />
              刷新
            </button>
          </div>
          <div
            className="mt-2 flex items-center gap-2 px-2 py-1 rounded-md border"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "var(--bg-tertiary)",
              color: "var(--text-secondary)",
            }}
          >
            <Search size={13} />
            <input
              ref={globalSearchRef}
              value={globalQuery}
              onChange={(e) => setGlobalQuery(e.target.value)}
              placeholder="全局搜索（标题/消息/标签）"
              className="flex-1 bg-transparent text-xs outline-none"
              style={{ color: "var(--text-primary)" }}
            />
          </div>
          <div className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
            Ctrl+K 打开全局搜索
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loadingSessions && (
            <div className="px-3 py-4 text-xs" style={{ color: "var(--text-muted)" }}>
              正在加载会话...
            </div>
          )}

          {!loadingSessions && normalizedGlobal && searching && (
            <div className="px-3 py-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
              正在搜索...
            </div>
          )}

          {!loadingSessions && normalizedGlobal && searchHits.length > 0 && (
            <div className="pb-2 border-b" style={{ borderColor: "var(--border)" }}>
              <div className="px-3 py-2 text-[11px] font-semibold" style={{ color: "var(--text-muted)" }}>
                搜索命中 {searchHits.length} 条
              </div>
              {searchHits.map((hit, idx) => (
                <button
                  key={`${hit.file_path}-${idx}`}
                  onClick={() => {
                    void openByHit(hit);
                  }}
                  className="w-full text-left px-3 py-2 border-t hover:opacity-90"
                  style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
                >
                  <div className="text-xs font-semibold truncate" style={{ color: "var(--text-primary)" }}>
                    {hit.title}
                  </div>
                  <div className="text-[11px] truncate mt-0.5">{hit.snippet}</div>
                  <div className="text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>
                    {hit.source} · {hit.project_key} · {hit.role}
                  </div>
                </button>
              ))}
            </div>
          )}

          {!loadingSessions &&
            groupedSessions.map((group) => (
              <div key={group.label}>
                <div
                  className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide border-y"
                  style={{
                    color: "var(--text-muted)",
                    borderColor: "var(--border)",
                    backgroundColor: "var(--bg-tertiary)",
                  }}
                >
                  {group.label}
                </div>
                {group.items.map((item) => (
                  <button
                    key={item.sessionKey}
                    onClick={() => {
                      void openSession(item.sessionKey).catch((err) => {
                        toast.error("打开会话失败", { description: String(err) });
                      });
                    }}
                    className="w-full text-left px-3 py-2 border-b hover:opacity-90 transition-opacity"
                    style={{
                      borderColor: "var(--border)",
                      backgroundColor:
                        item.sessionKey === activeSessionKey ? "var(--bg-tertiary)" : "transparent",
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      {item.starred && (
                        <Star size={12} style={{ color: "var(--warning)" }} fill="currentColor" />
                      )}
                      <span className="text-xs font-semibold truncate" style={{ color: "var(--text-primary)" }}>
                        {item.displayTitle}
                      </span>
                    </div>
                    <div className="mt-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
                      {item.source} · {makeSessionLabel(item)} · {item.message_count} 条消息
                    </div>
                    <div className="mt-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
                      更新于 {formatTime(item.updated_at)}
                    </div>
                  </button>
                ))}
              </div>
            ))}

          {!loadingSessions && filteredSessions.length === 0 && (
            <div className="px-3 py-6 text-xs text-center" style={{ color: "var(--text-muted)" }}>
              未找到匹配会话
            </div>
          )}
        </div>

        <div
          onMouseDown={startResize}
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-[var(--accent)] transition-colors"
          style={{ opacity: 0.35 }}
        />
      </aside>

      <section
        className="relative flex-1 min-h-0 min-w-0 grid grid-rows-[auto_1fr] overflow-hidden"
        style={{ backgroundColor: "var(--bg-primary)" }}
      >
        {!activeView && (
          <div className="row-span-2 flex items-center justify-center min-h-0">
            <EmptyState
              icon={<Search size={34} strokeWidth={1.5} />}
              title="未选择会话"
              description="从左侧选择会话查看详情"
            />
          </div>
        )}

        {activeView && (
          <>
            <div className="p-3 border-b shrink-0 overflow-y-auto min-h-0" style={{ borderColor: "var(--border)" }}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>
                    {activeView.displayTitle}
                  </h3>
                  <div className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>
                    {activeView.source} · {makeSessionLabel(activeView)} · 更新于 {formatTime(activeView.updated_at)}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => setPromptOpen(true)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs"
                    style={{
                      borderColor: "var(--border)",
                      backgroundColor: "var(--bg-secondary)",
                      color: "var(--text-secondary)",
                    }}
                    title="历史 Prompt 库"
                  >
                    <BookCopy size={12} />
                    历史Prompt
                  </button>
                  <button
                    onClick={() => setDiffOpen(true)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs"
                    style={{
                      borderColor: "var(--border)",
                      backgroundColor: "var(--bg-secondary)",
                      color: "var(--text-secondary)",
                    }}
                    title="Diff 视图"
                  >
                    <GitCompare size={12} />
                    Diff
                  </button>
                  <button
                    onClick={() => {
                      void toggleStar();
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs"
                    style={{
                      borderColor: "var(--border)",
                      backgroundColor: "var(--bg-secondary)",
                      color: activeView.starred ? "var(--warning)" : "var(--text-secondary)",
                    }}
                    title="收藏"
                  >
                    <Star size={12} fill={activeView.starred ? "currentColor" : "none"} />
                    {activeView.starred ? "已收藏" : "收藏"}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                <input
                  value={aliasDraft}
                  onChange={(e) => setAliasDraft(e.target.value)}
                  placeholder="会话别名（重命名）"
                  className="px-2 py-1 rounded-md border text-xs outline-none"
                  style={{
                    borderColor: "var(--border)",
                    backgroundColor: "var(--bg-secondary)",
                    color: "var(--text-primary)",
                  }}
                />
                <input
                  value={tagsDraft}
                  onChange={(e) => setTagsDraft(e.target.value)}
                  placeholder="标签，逗号分隔"
                  className="px-2 py-1 rounded-md border text-xs outline-none"
                  style={{
                    borderColor: "var(--border)",
                    backgroundColor: "var(--bg-secondary)",
                    color: "var(--text-primary)",
                  }}
                />
              </div>
              <div className="mt-2">
                <button
                  onClick={() => {
                    void saveMeta();
                  }}
                  className="text-xs px-2.5 py-1 rounded-md"
                  style={{ backgroundColor: "var(--accent)", color: "#fff" }}
                >
                  保存元数据
                </button>
              </div>

              <div
                className="mt-2 px-2 py-1 rounded-md border"
                style={{
                  borderColor: "var(--border)",
                  backgroundColor: "var(--bg-secondary)",
                }}
              >
                <div className="flex items-center gap-2">
                  <Search size={12} style={{ color: "var(--text-muted)" }} />
                  <input
                    ref={sessionSearchRef}
                    value={sessionQuery}
                    onChange={(e) => setSessionQuery(e.target.value)}
                    placeholder="会话内搜索"
                    className="flex-1 min-w-0 bg-transparent text-xs outline-none"
                    style={{ color: "var(--text-primary)" }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-end gap-2">
                  <button
                    onClick={jumpPrev}
                    className="text-[11px] px-2 py-0.5 rounded border shrink-0"
                    style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
                    title="上一个匹配"
                  >
                    ↑
                  </button>
                  <button
                    onClick={jumpNext}
                    className="text-[11px] px-2 py-0.5 rounded border shrink-0"
                    style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
                    title="下一个匹配"
                  >
                    ↓
                  </button>
                  <span className="text-[10px] shrink-0" style={{ color: "var(--text-muted)" }}>
                    {matchIndices.length === 0 ? "0" : `${Math.min(matchCursor + 1, matchIndices.length)}/${matchIndices.length}`}
                  </span>
                </div>
              </div>
            </div>

            <div className="min-h-0 overflow-y-auto overflow-x-hidden p-3 space-y-2">
              {loadingSessionDetail && (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  正在读取会话详情...
                </div>
              )}
              {!loadingSessionDetail && activeSession?.messages.length === 0 && (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  当前会话没有可显示的消息
                </div>
              )}
              {!loadingSessionDetail &&
                activeSession?.messages.map((msg, idx) => {
                  const isMatched = matchIndices.includes(idx);
                  const isFocused = focusedMessageIndex === idx;
                  const badge = roleBadge(msg.role);
                  return (
                    <div
                      key={`${msg.role}-${idx}`}
                      ref={(el) => {
                        messageRefs.current[idx] = el;
                      }}
                      className="rounded-md border p-2"
                      style={{
                        borderColor: isFocused
                          ? "var(--warning)"
                          : isMatched
                            ? "var(--accent)"
                            : "var(--border)",
                        backgroundColor: "var(--bg-secondary)",
                      }}
                    >
                      <div
                        className="text-[11px] mb-1 flex items-center justify-between"
                        style={{ color: "var(--text-muted)" }}
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
                        <span>{msg.timestamp ?? "-"}</span>
                      </div>
                      <pre
                        className="text-xs whitespace-pre-wrap break-words font-mono m-0 overflow-x-auto"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {highlightText(msg.content, sessionQuery)}
                      </pre>
                    </div>
                  );
                })}
            </div>
          </>
        )}

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
