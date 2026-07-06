import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { toast } from "sonner";
import { useHistoryStore } from "../stores/historyStore";
import { useTerminalStore } from "../stores/terminalStore";
import type { HistoryMessage, HistorySearchHit, HistorySessionDetail, HistorySessionView, HistorySourceFilter, Project } from "../lib/types";
import { useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import { useExternalSessionSyncStore } from "../stores/externalSessionSyncStore";
import { useI18n } from "../lib/i18n";
import { PromptLibrary } from "./prompts/PromptLibrary";
import { DiffModal } from "./history/DiffModal";
import { HistoryListPane } from "./history/HistoryListPane";
import { SessionDetailPane, type HistoryDetailView } from "./history/SessionDetailPane";
import { ConfirmDialog } from "./ConfirmDialog";
import { buildHistorySessionChildMap, toGroupLabel, type TimeGroupLabel } from "./history/historyViewUtils";
import { buildSessionProcessModel, type SessionProcessModel } from "./history/sessionEvents";

const SESSION_PAGE_SIZE = 20;
const MESSAGE_PAGE_SIZE = 160;
const LOAD_MORE_THRESHOLD_PX = 220;
const HISTORY_SIDEBAR_DEFAULT_WIDTH = 276;
const HISTORY_SIDEBAR_OLD_DEFAULT_WIDTH = 300;
// 稳定的空数组引用：避免每次 render 都用 `?? []` 生成新数组、击穿下游 memo。
const EMPTY_MESSAGES: HistoryMessage[] = [];
const EMPTY_PROCESS_MODEL: SessionProcessModel = {
  events: [],
  diffBlocks: [],
  fileGroups: [],
  toolEvents: [],
  errorEvents: [],
  subtaskEvents: [],
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHistorySidebarWidth(width: number): number {
  return width === HISTORY_SIDEBAR_OLD_DEFAULT_WIDTH ? HISTORY_SIDEBAR_DEFAULT_WIDTH : width;
}

function normalizePathKey(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
}

function makeSearchHitKey(hit: HistorySearchHit): string {
  return `${hit.source.toLowerCase()}:${hit.session_id}:${hit.file_path}`;
}

function matchesSourceFilter(source: string, sourceFilter: HistorySourceFilter): boolean {
  return sourceFilter === "all" || source.toLowerCase() === sourceFilter;
}

function projectPathName(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized.split("/").filter(Boolean).pop() ?? "";
}

function claudeProjectKeyFromPath(path: string): string {
  return path
    .trim()
    .replace(/:/g, "-")
    .replace(/[\\/]/g, "-")
    .replace(/-+$/g, "")
    .toLowerCase();
}

function isAbsolutePathLike(value: string): boolean {
  const trimmed = value.trim();
  return /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\") || trimmed.startsWith("/");
}

function parseProjectEnvVars(project?: Project | null): Record<string, string> | undefined {
  if (!project) return undefined;
  try {
    const parsed = JSON.parse(project.env_vars || "{}");
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  } catch {
    return undefined;
  }
}

function findHistoryProject(session: HistorySessionView | HistorySessionDetail, projects: Project[]): Project | null {
  const cwd = "cwd" in session ? session.cwd?.trim() : null;
  if (cwd) {
    const normalizedCwd = normalizePathKey(cwd);
    const cwdProject = projects.find((project) => normalizePathKey(project.path) === normalizedCwd);
    if (cwdProject) return cwdProject;
  }

  const normalizedProjectKey = normalizePathKey(session.project_key);
  if (!normalizedProjectKey) return null;
  const normalizedProjectKeyLower = normalizedProjectKey.toLowerCase();

  return projects.find((project) => {
    const projectPath = normalizePathKey(project.path);
    const projectName = project.name.trim().toLowerCase();
    return (
      projectPath === normalizedProjectKey ||
      claudeProjectKeyFromPath(project.path) === normalizedProjectKeyLower ||
      projectPathName(project.path).toLowerCase() === normalizedProjectKeyLower ||
      projectName === normalizedProjectKeyLower
    );
  }) ?? null;
}

function resolveResumeCommand(session: HistorySessionView | HistorySessionDetail): string | null {
  const sessionId = session.session_id.trim();
  if (!sessionId || /\s/.test(sessionId) || /[\r\n]/.test(sessionId)) return null;
  if (session.source === "claude") return `claude --resume ${sessionId}`;
  if (session.source === "codex") return `codex resume ${sessionId}`;
  return null;
}

function resolveHistoryResumeCwd(session: HistorySessionView | HistorySessionDetail, project?: Project | null): string | undefined {
  const cwd = "cwd" in session ? session.cwd?.trim() : null;
  if (cwd) return cwd;
  if (project) return project.path;
  return isAbsolutePathLike(session.project_key) ? session.project_key.trim() : undefined;
}

interface HistoryWorkspaceProps {
  active?: boolean;
}

type DeleteIntent =
  | { type: "single"; session: HistorySessionView }
  | { type: "bulk"; sessionKeys: string[] };

export function HistoryWorkspace({ active = true }: HistoryWorkspaceProps) {
  const { t } = useI18n();
  const loadingSessions = useHistoryStore((s) => s.loadingSessions);
  const loadingMoreSessions = useHistoryStore((s) => s.loadingMoreSessions);
  const loadingSessionDetail = useHistoryStore((s) => s.loadingSessionDetail);
  const searching = useHistoryStore((s) => s.searching);
  const sourceFilter = useHistoryStore((s) => s.sourceFilter);
  const projectPathFilter = useHistoryStore((s) => s.projectPathFilter);
  const sessions = useHistoryStore((s) => s.sessions);
  const metaMap = useHistoryStore((s) => s.metaMap);
  const activeSessionKey = useHistoryStore((s) => s.activeSessionKey);
  const activeSession = useHistoryStore((s) => s.activeSession);
  const globalQuery = useHistoryStore((s) => s.globalQuery);
  const sessionQuery = useHistoryStore((s) => s.sessionQuery);
  const searchHits = useHistoryStore((s) => s.searchHits);
  const backendHasMoreSessions = useHistoryStore((s) => s.hasMoreSessions);
  const focusedMessageIndex = useHistoryStore((s) => s.focusedMessageIndex);
  const focusedMessageSeq = useHistoryStore((s) => s.focusedMessageSeq);
  const focusGlobalSearchSeq = useHistoryStore((s) => s.focusGlobalSearchSeq);
  const focusSessionSearchSeq = useHistoryStore((s) => s.focusSessionSearchSeq);
  const closeHistory = useHistoryStore((s) => s.closeHistory);
  const setSourceFilter = useHistoryStore((s) => s.setSourceFilter);
  const setProjectPathFilter = useHistoryStore((s) => s.setProjectPathFilter);
  const loadSessions = useHistoryStore((s) => s.loadSessions);
  const loadMoreSessions = useHistoryStore((s) => s.loadMoreSessions);
  const openSession = useHistoryStore((s) => s.openSession);
  const deleteSession = useHistoryStore((s) => s.deleteSession);
  const openSearchHit = useHistoryStore((s) => s.openSearchHit);
  const setGlobalQuery = useHistoryStore((s) => s.setGlobalQuery);
  const runGlobalSearch = useHistoryStore((s) => s.runGlobalSearch);
  const setSessionQuery = useHistoryStore((s) => s.setSessionQuery);
  const openSessionAtMessage = useHistoryStore((s) => s.openSessionAtMessage);
  const clearFocusedMessage = useHistoryStore((s) => s.clearFocusedMessage);
  const updateMeta = useHistoryStore((s) => s.updateMeta);
  const storedHistorySidebarWidth = useSettingsStore((s) => s.historySidebarWidth);
  const historySidebarWidth = normalizeHistorySidebarWidth(storedHistorySidebarWidth);
  const updateSetting = useSettingsStore((s) => s.update);
  const projects = useProjectStore((s) => s.projects);
  const groups = useProjectStore((s) => s.groups);
  const createSession = useTerminalStore((s) => s.createSession);

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
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [diffContainer, setDiffContainer] = useState<HTMLElement | null>(null);
  const [detailView, setDetailView] = useState<HistoryDetailView>("transcript");
  const [visibleSessionCount, setVisibleSessionCount] = useState(SESSION_PAGE_SIZE);
  const [visibleMessageCount, setVisibleMessageCount] = useState(MESSAGE_PAGE_SIZE);
  const [debouncedSessionQuery, setDebouncedSessionQuery] = useState(sessionQuery);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedSessionKeys, setSelectedSessionKeys] = useState<Set<string>>(new Set());
  const [deleteIntent, setDeleteIntent] = useState<DeleteIntent | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSessionQuery(sessionQuery), 150);
    return () => clearTimeout(timer);
  }, [sessionQuery]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (document.querySelector(".ui-history-transcript-image-preview")) return;
      event.preventDefault();
      event.stopPropagation();
      if (diffOpen) {
        setDiffOpen(false);
        return;
      }
      if (promptOpen) {
        setPromptOpen(false);
        return;
      }
      closeHistory();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, closeHistory, diffOpen, promptOpen]);

  const activeView = useMemo(
    () => sessions.find((item) => item.sessionKey === activeSessionKey) ?? null,
    [sessions, activeSessionKey]
  );

  const tagSuggestions = useMemo(() => {
    const tags = new Set<string>();
    for (const session of sessions) {
      for (const tag of session.tags) {
        const trimmed = tag.trim();
        if (trimmed) tags.add(trimmed);
      }
    }
    for (const meta of Object.values(metaMap)) {
      try {
        const parsed = JSON.parse(meta.tags_json);
        if (!Array.isArray(parsed)) continue;
        for (const tag of parsed) {
          if (typeof tag !== "string") continue;
          const trimmed = tag.trim();
          if (trimmed) tags.add(trimmed);
        }
      } catch {
        // Ignore malformed legacy metadata; visible session tags still participate.
      }
    }
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }, [metaMap, sessions]);

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
    setAliasDraft(activeView?.alias ?? "");
    setTagsDraft(activeTagText);
  }, [activeView?.sessionKey, activeView?.alias, activeTagText]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void runGlobalSearch(globalQuery);
    }, 220);
    return () => clearTimeout(timer);
  }, [globalQuery, projectPathFilter, runGlobalSearch, sourceFilter]);

  useEffect(() => {
    if (!active) return;
    globalSearchRef.current?.focus();
    globalSearchRef.current?.select();
  }, [active, focusGlobalSearchSeq]);

  useEffect(() => {
    if (!active) return;
    sessionSearchRef.current?.focus();
    sessionSearchRef.current?.select();
  }, [active, focusSessionSearchSeq]);

  const normalizedGlobal = globalQuery.trim().toLowerCase();

  const favoriteSearchScope = useMemo(() => {
    const keys = new Set<string>();
    const sourceSessions = new Set<string>();
    const sourcePaths = new Set<string>();
    const addFavorite = (source: string, sessionId: string, filePath: string) => {
      const normalizedSource = source.toLowerCase();
      if (sessionId) sourceSessions.add(`${normalizedSource}:${sessionId}`);
      if (filePath) sourcePaths.add(`${normalizedSource}:${normalizePathKey(filePath)}`);
      if (sessionId && filePath) keys.add(`${normalizedSource}:${sessionId}:${filePath}`);
    };

    for (const item of sessions) {
      if (item.starred) addFavorite(item.source, item.session_id, item.file_path);
    }
    for (const meta of Object.values(metaMap)) {
      if (meta.starred === 1) addFavorite(meta.source, meta.session_id, meta.file_path);
    }

    return { keys, sourceSessions, sourcePaths };
  }, [metaMap, sessions]);

  const visibleSearchHits = useMemo(() => {
    const sourceFilteredHits = searchHits.filter((hit) => matchesSourceFilter(hit.source, sourceFilter));
    if (!favoriteOnly) return sourceFilteredHits;
    return sourceFilteredHits.filter((hit) => {
      const source = hit.source.toLowerCase();
      return (
        favoriteSearchScope.keys.has(makeSearchHitKey(hit)) ||
        favoriteSearchScope.sourceSessions.has(`${source}:${hit.session_id}`) ||
        favoriteSearchScope.sourcePaths.has(`${source}:${normalizePathKey(hit.file_path)}`)
      );
    });
  }, [favoriteOnly, favoriteSearchScope, searchHits, sourceFilter]);

  const filteredSessions = useMemo(() => {
    const sourceFilteredSessions = sessions.filter((item) => matchesSourceFilter(item.source, sourceFilter));
    const baseSessions = favoriteOnly ? sourceFilteredSessions.filter((item) => item.starred) : sourceFilteredSessions;
    if (!normalizedGlobal) return baseSessions;
    const result: HistorySessionView[] = [];
    for (const item of baseSessions) {
      const haystack = `${item.displayTitle.toLowerCase()}${item.project_key.toLowerCase()}${item.tags.join(" ").toLowerCase()}`;
      if (haystack.includes(normalizedGlobal)) {
        result.push(item);
      }
    }
    return result;
  }, [favoriteOnly, sessions, normalizedGlobal, sourceFilter]);

  useEffect(() => {
    setVisibleSessionCount(SESSION_PAGE_SIZE);
  }, [favoriteOnly, normalizedGlobal, projectPathFilter, sourceFilter, loadingSessions]);

  const visibleFilteredSessions = useMemo(
    () => filteredSessions.slice(0, visibleSessionCount),
    [filteredSessions, visibleSessionCount]
  );
  const childSessionKeyMap = useMemo(() => {
    const childrenByParentKey = buildHistorySessionChildMap(filteredSessions);
    const map = new Map<string, string[]>();
    for (const [parentSessionKey, children] of childrenByParentKey.entries()) {
      map.set(parentSessionKey, children.map((item) => item.sessionKey));
    }
    return map;
  }, [filteredSessions]);
  const visibleSessionKeys = useMemo(() => visibleFilteredSessions.map((item) => item.sessionKey), [visibleFilteredSessions]);
  const visibleSelectableSessionKeys = useMemo(() => {
    const next = new Set<string>();
    for (const sessionKey of visibleSessionKeys) {
      next.add(sessionKey);
      const childKeys = childSessionKeyMap.get(sessionKey) ?? [];
      for (const childKey of childKeys) next.add(childKey);
    }
    return [...next];
  }, [childSessionKeyMap, visibleSessionKeys]);
  const allVisibleSelected = useMemo(
    () => visibleSelectableSessionKeys.length > 0 && visibleSelectableSessionKeys.every((key) => selectedSessionKeys.has(key)),
    [selectedSessionKeys, visibleSelectableSessionKeys]
  );

  const hasMoreVisibleSessions = visibleSessionCount < filteredSessions.length;
  const hasMoreSessions = hasMoreVisibleSessions || backendHasMoreSessions;
  const loadMoreSessionMode = hasMoreVisibleSessions ? "local" : "backend";

  useEffect(() => {
    if (!selectionMode) return;
    const allowedKeys = new Set(filteredSessions.map((item) => item.sessionKey));
    setSelectedSessionKeys((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const key of prev) {
        if (allowedKeys.has(key)) next.add(key);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filteredSessions, selectionMode]);

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

  const handleLoadMoreSessions = useCallback(() => {
    if (hasMoreVisibleSessions) {
      setVisibleSessionCount((prev) => Math.min(filteredSessions.length, prev + SESSION_PAGE_SIZE));
      return;
    }
    if (backendHasMoreSessions && !loadingMoreSessions) {
      void loadMoreSessions()
        .then(() => {
          setVisibleSessionCount((prev) => prev + SESSION_PAGE_SIZE);
        })
        .catch((err) => {
          toast.error("加载更多会话失败", { description: String(err) });
        });
    }
  }, [backendHasMoreSessions, filteredSessions.length, hasMoreVisibleSessions, loadMoreSessions, loadingMoreSessions]);

  const handleSessionListScroll = useCallback(() => {
    const container = sessionListRef.current;
    if (!container || !hasMoreSessions) return;
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (remaining > LOAD_MORE_THRESHOLD_PX) return;
    handleLoadMoreSessions();
  }, [handleLoadMoreSessions, hasMoreSessions]);

  const handleRefreshSessions = useCallback(() => {
    void (async () => {
      await loadSessions();
      const query = globalQuery.trim();
      if (query) {
        await runGlobalSearch(query);
      }
      await useExternalSessionSyncStore.getState().openManualDialog();
    })().catch((err) => {
      toast.error(t("history.toast.refreshFailed"), { description: String(err) });
    });
  }, [globalQuery, loadSessions, runGlobalSearch, t]);

  const matchIndices = useMemo(() => {
    const query = debouncedSessionQuery.trim();
    if (!query || !activeSession) return [];
    const matcher = new RegExp(escapeRegExp(query), "i");
    const indices: number[] = [];
    for (let i = 0; i < activeSession.messages.length; i++) {
      if (matcher.test(activeSession.messages[i].content)) {
        indices.push(i);
      }
    }
    return indices;
  }, [activeSession, debouncedSessionQuery]);

  useEffect(() => {
    setMatchCursor(0);
  }, [debouncedSessionQuery, activeSession?.session_id]);

  useEffect(() => {
    setVisibleMessageCount(MESSAGE_PAGE_SIZE);
    setDetailView("transcript");
    pendingScrollMessageRef.current = null;
    messageRefs.current = {};
  }, [activeSession?.session_id]);

  const visibleMessages = useMemo(
    () => (activeSession?.messages ?? EMPTY_MESSAGES).slice(0, visibleMessageCount),
    [activeSession?.messages, visibleMessageCount]
  );

  const processModel = useMemo(() => {
    if (!activeSession) return EMPTY_PROCESS_MODEL;
    if (detailView === "transcript" || detailView === "context") return EMPTY_PROCESS_MODEL;
    return buildSessionProcessModel(activeSession, t);
  }, [activeSession, detailView, t]);

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
      toast.success(t("history.meta.saveSuccess"));
    } catch (err) {
      toast.error(t("history.meta.saveFailed"), { description: String(err) });
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

  const resumeConversation = useCallback(async () => {
    if (!activeSession) {
      toast.error("会话详情尚未加载完成");
      return;
    }

    const command = resolveResumeCommand(activeSession);
    if (!command) {
      toast.error("无法继续对话", { description: "历史会话缺少有效的 sessionId 或来源不受支持" });
      return;
    }

    const project = findHistoryProject(activeSession, projects);
    const cwd = resolveHistoryResumeCwd(activeSession, project);
    if (!cwd) {
      toast.error("无法继续对话", { description: "未能识别该历史会话的项目目录" });
      return;
    }

    try {
      const titlePrefix = activeSession.source === "claude" ? "Claude" : "Codex";
      const title = `${titlePrefix} 继续：${activeView?.displayTitle ?? activeSession.title}`;
      const shell = project?.shell && project.shell !== "powershell" ? project.shell : undefined;
      await createSession(project?.id, cwd, title, command, parseProjectEnvVars(project), shell);
      closeHistory();
      toast.success("已创建继续对话终端");
    } catch (err) {
      toast.error("继续对话失败", { description: String(err) });
    }
  }, [activeSession, activeView?.displayTitle, closeHistory, createSession, projects]);

  const openByHit = async (hit: HistorySearchHit) => {
    try {
      await openSearchHit(hit);
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

  const confirmDeleteSession = useCallback(() => {
    if (!deleteIntent) return;
    const intent = deleteIntent;
    void (async () => {
      let deletedCount = 0;
      try {
        if (intent.type === "single") {
          await deleteSession(intent.session.sessionKey);
          toast.success(t("history.toast.deleteSuccess"));
          return;
        }

        for (const sessionKey of intent.sessionKeys) {
          await deleteSession(sessionKey);
          deletedCount += 1;
        }

        setSelectionMode(false);
        setSelectedSessionKeys(new Set());
        toast.success(t("history.toast.bulkDeleteSuccess", { count: deletedCount }));
      } catch (err) {
        if (intent.type === "bulk" && deletedCount > 0) {
          toast.error(t("history.toast.bulkDeletePartialFailed", { deleted: deletedCount, total: intent.sessionKeys.length }), {
            description: String(err),
          });
          return;
        }
        toast.error(intent.type === "single" ? t("history.toast.deleteFailed") : t("history.toast.bulkDeleteFailed"), {
          description: String(err),
        });
      } finally {
        setDeleteIntent(null);
      }
    })();
  }, [deleteIntent, deleteSession, t]);

  const handleToggleSessionSelection = useCallback((sessionKey: string) => {
    setSelectedSessionKeys((prev) => {
      const next = new Set(prev);
      const childKeys = childSessionKeyMap.get(sessionKey) ?? [];
      if (next.has(sessionKey)) {
        next.delete(sessionKey);
        for (const childKey of childKeys) next.delete(childKey);
      } else {
        next.add(sessionKey);
        for (const childKey of childKeys) next.add(childKey);
      }
      return next;
    });
  }, [childSessionKeyMap]);

  const handleToggleSelectAllVisible = useCallback(() => {
    setSelectedSessionKeys((prev) => {
      const next = new Set(prev);
      const shouldClear = visibleSelectableSessionKeys.length > 0 && visibleSelectableSessionKeys.every((key) => next.has(key));
      for (const key of visibleSelectableSessionKeys) {
        if (shouldClear) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }, [visibleSelectableSessionKeys]);

  const handleCancelSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedSessionKeys(new Set());
  }, []);

  const handleRequestBulkDelete = useCallback(() => {
    if (selectedSessionKeys.size === 0) return;
    const sessionKeys = filteredSessions.filter((item) => selectedSessionKeys.has(item.sessionKey)).map((item) => item.sessionKey);
    if (sessionKeys.length === 0) return;
    setDeleteIntent({ type: "bulk", sessionKeys });
  }, [filteredSessions, selectedSessionKeys]);

  const deleteDialogTitle = deleteIntent?.type === "bulk" ? t("history.bulk.confirmDeleteTitle", { count: deleteIntent.sessionKeys.length }) : t("history.deleteSession");
  const deleteDialogMessage = deleteIntent
    ? deleteIntent.type === "bulk"
      ? t("history.bulk.confirmDeleteMessage", { count: deleteIntent.sessionKeys.length })
      : t("history.confirmDeleteMessage", { title: deleteIntent.session.displayTitle })
    : "";

  const resumeSessionInTerminal = useCallback(
    (session: HistorySessionView) => {
      const command = resolveResumeCommand(session);
      if (!command) {
        toast.error(t("history.toast.resumeTerminalFailed"), { description: "历史会话缺少有效的 sessionId 或来源不受支持" });
        return;
      }

      const project = findHistoryProject(session, projects);
      const cwd = resolveHistoryResumeCwd(session, project);
      if (!cwd) {
        toast.error(t("history.toast.resumeTerminalFailed"), { description: "未能识别该历史会话的项目目录" });
        return;
      }

      const shell = project?.shell && project.shell !== "powershell" ? project.shell : undefined;
      const title = `${session.source === "claude" ? "Claude" : "Codex"}: ${session.displayTitle || session.session_id}`;

      void createSession(project?.id, cwd, title, command, parseProjectEnvVars(project), shell)
        .then(() => {
          closeHistory();
        })
        .catch((err) => {
          toast.error(t("history.toast.resumeTerminalFailed"), { description: String(err) });
        });
    },
    [closeHistory, createSession, projects, t]
  );

  const jumpToMessage = async (messageIndex: number) => {
    if (!activeView) return;
    try {
      setDetailView("transcript");
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
    <>
      <div id="history-workspace" className="ui-history-shell flex h-full min-h-0 min-w-0 overflow-hidden rounded-2xl">
        <HistoryListPane
          historySidebarWidth={historySidebarWidth}
          sidebarRef={sidebarRef}
          sessionListRef={sessionListRef}
          sourceFilter={sourceFilter}
          projectPathFilter={projectPathFilter}
          projects={projects}
          groups={groups}
          globalQuery={globalQuery}
          favoriteOnly={favoriteOnly}
          activeSessionKey={activeSessionKey}
          loadingSessions={loadingSessions}
          loadingMoreSessions={loadingMoreSessions}
          searching={searching}
          normalizedGlobal={normalizedGlobal}
          groupedSessions={groupedSessions}
          filteredSessionCount={filteredSessions.length}
          hasMoreSessions={hasMoreSessions}
          loadMoreSessionMode={loadMoreSessionMode}
          visibleSessionCount={Math.min(visibleSessionCount, filteredSessions.length)}
          searchHits={visibleSearchHits}
          globalSearchRef={globalSearchRef}
          selectionMode={selectionMode}
          selectedCount={selectedSessionKeys.size}
          allVisibleSelected={allVisibleSelected}
          selectedSessionKeys={selectedSessionKeys}
          onRefresh={handleRefreshSessions}
          onClose={closeHistory}
          onSourceFilterChange={(value) => {
            void setSourceFilter(value as HistorySourceFilter);
          }}
          onProjectPathFilterChange={(value) => {
            void setProjectPathFilter(value);
          }}
          onGlobalQueryChange={setGlobalQuery}
          onFavoriteOnlyChange={setFavoriteOnly}
          onEnterSelectionMode={() => setSelectionMode(true)}
          onCancelSelectionMode={handleCancelSelectionMode}
          onToggleSelectAllVisible={handleToggleSelectAllVisible}
          onToggleSessionSelection={handleToggleSessionSelection}
          onOpenSession={openSessionSafe}
          onResumeSession={resumeSessionInTerminal}
          onDeleteSession={(session) => setDeleteIntent({ type: "single", session })}
          onDeleteSelected={handleRequestBulkDelete}
          onOpenHit={(hit) => {
            void openByHit(hit);
          }}
          onLoadMoreSessions={handleLoadMoreSessions}
          onSessionListScroll={handleSessionListScroll}
          onStartResize={startResize}
        />

        <section
        ref={(el) => {
          setDiffContainer(el);
        }}
        className="ui-history-detail relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_1fr] overflow-hidden">
          <SessionDetailPane
            activeView={activeView}
            activeSession={activeSession}
            loadingSessionDetail={loadingSessionDetail}
            aliasDraft={aliasDraft}
            tagsDraft={tagsDraft}
            tagSuggestions={tagSuggestions}
            sessionQuery={sessionQuery}
            matchIndices={matchIndices}
            matchCursor={matchCursor}
            focusedMessageIndex={focusedMessageIndex}
            focusedMessageSeq={focusedMessageSeq}
            visibleMessages={visibleMessages}
            visibleMessageCount={visibleMessageCount}
            hasMoreMessages={hasMoreMessages}
            totalMessageCount={activeSession?.messages.length ?? 0}
            processModel={processModel}
            detailView={detailView}
            messageListRef={messageListRef}
            sessionSearchRef={sessionSearchRef}
            messageRefs={messageRefs}
            onDetailViewChange={setDetailView}
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
            onResumeSession={() => {
              void resumeConversation();
            }}
            onJumpToMessage={(messageIndex) => {
              void jumpToMessage(messageIndex);
            }}
            onToggleStar={() => {
              void toggleStar();
            }}
            onLoadMoreMessages={() =>
              setVisibleMessageCount((prev) => Math.min(activeSession?.messages.length ?? 0, prev + MESSAGE_PAGE_SIZE))
            }
          />
        </div>

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
          messages={activeSession?.messages ?? EMPTY_MESSAGES}
          container={diffContainer}
          onClose={() => setDiffOpen(false)}
          onJumpToMessage={(messageIndex) => {
            void jumpToMessage(messageIndex);
          }}
        />
      </section>
    </div>

      <ConfirmDialog
        open={deleteIntent !== null}
        title={deleteDialogTitle}
        message={deleteDialogMessage}
        confirmText={t("common.delete")}
        cancelText={t("common.cancel")}
        danger
        onConfirm={confirmDeleteSession}
        onClose={() => setDeleteIntent(null)}
      />
    </>
  );
}
