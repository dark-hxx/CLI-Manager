import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useShallow } from "zustand/shallow";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTerminalStore, type SplitTerminalOptions, type TabNotificationState } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import type { TerminalPaneDropEdge, TerminalPaneLeaf, TerminalPaneSplitDirection } from "../stores/terminalPaneTree";
import { collectPaneLeaves } from "../stores/terminalPaneTree";
import { SplitTerminalView } from "./SplitTerminalView";
import { XTermTerminal } from "./XTermTerminal";
import { CommandTemplatePanel } from "./CommandTemplatePanel";
import { CommandHistoryPanel } from "./CommandHistoryPanel";
import { openWindowsTerminal } from "../lib/externalTerminal";
import { Terminal, Plus, Search, X, Maximize2, Minimize2, ChevronDown, ChevronRight } from "./icons";
import { EmptyState } from "./ui/EmptyState";
import { useHistoryStore } from "../stores/historyStore";
import type { HistorySourceFilter, Project, TerminalSession } from "../lib/types";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "./ui/context-menu";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "./ui/popover";
import { getTerminalTheme } from "../lib/terminalThemes";

const HistoryWorkspace = lazy(() =>
  import("./HistoryWorkspace").then((module) => ({ default: module.HistoryWorkspace }))
);

const TAB_NOTIFICATION_COLORS: Record<TabNotificationState, string> = {
  none: "#565f89",
  running: "#8b5cf6",
  attention: "#ff9e64",
  done: "#8fbf7f",
  failed: "#f7768e",
};

const TAB_NOTIFICATION_LABELS: Record<TabNotificationState, string> = {
  none: "无运行状态",
  running: "运行中",
  attention: "待审批",
  done: "已完成",
  failed: "异常退出",
};

const PULSING_TAB_STATES = new Set<TabNotificationState>(["running", "attention"]);
const PANE_DROP_PREFIX = "pane-drop:";
const PANE_CENTER_DROP_PREFIX = "pane-center:";
const PANE_EDGE_DROP_PREFIX = "pane-edge:";
const PANE_DROP_EDGES: TerminalPaneDropEdge[] = ["left", "right", "top", "bottom"];
const SPLIT_PICKER_OUTSIDE_GUARD_MS = 250;

type SplitPickerState = {
  sessionId: string;
  direction: TerminalPaneSplitDirection;
  x: number;
  y: number;
} | null;

type PaneDropTarget =
  | { type: "center"; paneId: string }
  | { type: "edge"; paneId: string; edge: TerminalPaneDropEdge };

type PaneDropPreview = { paneId: string; edge: TerminalPaneDropEdge } | null;

function isTerminalPaneDropEdge(value: string): value is TerminalPaneDropEdge {
  return PANE_DROP_EDGES.includes(value as TerminalPaneDropEdge);
}

function parsePaneDropTarget(id: string): PaneDropTarget | null {
  if (id.startsWith(PANE_CENTER_DROP_PREFIX)) return { type: "center", paneId: id.slice(PANE_CENTER_DROP_PREFIX.length) };
  if (id.startsWith(PANE_DROP_PREFIX)) return { type: "center", paneId: id.slice(PANE_DROP_PREFIX.length) };
  if (!id.startsWith(PANE_EDGE_DROP_PREFIX)) return null;

  const payload = id.slice(PANE_EDGE_DROP_PREFIX.length);
  const [paneId, edge] = payload.split(":");
  if (!paneId || !edge || !isTerminalPaneDropEdge(edge)) return null;
  return { type: "edge", paneId, edge };
}

function isPaneDropCollisionId(id: string): boolean {
  return id.startsWith(PANE_EDGE_DROP_PREFIX) || id.startsWith(PANE_CENTER_DROP_PREFIX) || id.startsWith(PANE_DROP_PREFIX);
}

const terminalTabCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  const edgeCollision = pointerCollisions.find((collision) => String(collision.id).startsWith(PANE_EDGE_DROP_PREFIX));
  if (edgeCollision) return [edgeCollision];

  const centerCollision = pointerCollisions.find((collision) => String(collision.id).startsWith(PANE_CENTER_DROP_PREFIX));
  if (centerCollision) return [centerCollision];

  const closestCollisions = closestCenter(args);
  const tabCollision = closestCollisions.find((collision) => !isPaneDropCollisionId(String(collision.id)));
  if (tabCollision) return [tabCollision];

  const paneBarCollision = pointerCollisions.find((collision) => String(collision.id).startsWith(PANE_DROP_PREFIX));
  return paneBarCollision ? [paneBarCollision] : closestCollisions;
};

function resolveHistorySourceFilter(cliTool: string | null | undefined): HistorySourceFilter {
  const normalized = cliTool?.trim().toLowerCase();
  if (!normalized) return "all";
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex") || normalized === "code") return "codex";
  return "all";
}

function formatTabStatusUpdatedAt(value: string | null | undefined): string {
  if (!value) return "无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function buildProjectSplitOptions(project: Project): SplitTerminalOptions {
  const cmd = project.startup_cmd || project.cli_tool || undefined;
  const shell = project.shell && project.shell !== "powershell" ? project.shell : undefined;
  let envVars: Record<string, string> | undefined;
  try {
    const parsed = JSON.parse(project.env_vars || "{}");
    if (typeof parsed === "object" && parsed !== null) {
      const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string");
      if (entries.length > 0) envVars = Object.fromEntries(entries);
    }
  } catch {
    // ignore invalid env json
  }

  return {
    projectId: project.id,
    cwd: project.path,
    title: project.cli_tool ? `${project.name} (${project.cli_tool})` : project.name,
    startupCmd: cmd,
    envVars,
    shell,
  };
}

interface SortableTabProps {
  id: string;
  paneId: string;
  title: string;
  isActive: boolean;
  isEditing: boolean;
  notification: TabNotificationState;
  statusUpdatedAt: string | null;
  onActivate: () => void;
  onClose: () => void;
  onStartEdit: () => void;
  onSubmitEdit: (title: string) => void;
  onCancelEdit: () => void;
  menuContent: (getAnchor: () => DOMRect | undefined) => ReactNode;
}

function SortableTab({
  id,
  paneId,
  title,
  isActive,
  isEditing,
  notification,
  statusUpdatedAt,
  onActivate,
  onClose,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
  menuContent,
}: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, data: { paneId } });
  const tabElementRef = useRef<HTMLDivElement | null>(null);
  const [editValue, setEditValue] = useState(title);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const skipNextBlurSubmitRef = useRef(false);
  const statusLabel = TAB_NOTIFICATION_LABELS[notification];
  const statusTitle = `状态：${statusLabel}\n会话：${title}\n更新时间：${formatTabStatusUpdatedAt(statusUpdatedAt)}`;
  const tabMinWidthClass = notification === "none" ? "min-w-[92px]" : "min-w-[118px]";

  const submitEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed) onSubmitEdit(trimmed);
    else onCancelEdit();
  }, [editValue, onCancelEdit, onSubmitEdit]);

  const cancelEdit = useCallback(() => {
    onCancelEdit();
  }, [onCancelEdit]);

  useEffect(() => {
    if (!isEditing) return;
    setEditValue(title);
    skipNextBlurSubmitRef.current = false;
    window.requestAnimationFrame(() => {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    });
  }, [isEditing, title]);

  const horizontalTransform = transform ? { ...transform, y: 0 } : transform;
  const style = {
    transform: isDragging ? undefined : CSS.Transform.toString(horizontalTransform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0.45 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const setTabNodeRef = useCallback((node: HTMLDivElement | null) => {
    tabElementRef.current = node;
    setNodeRef(node);
  }, [setNodeRef]);

  const getTabAnchor = useCallback(() => tabElementRef.current?.getBoundingClientRect(), []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setTabNodeRef}
          style={style}
          className={`ui-interactive ui-tab-trigger mx-1 flex h-7 ${tabMinWidthClass} max-w-[180px] shrink-0 cursor-pointer items-center gap-2 rounded-lg px-3 text-[12px] font-medium`}
          data-terminal-tab-id={id}
          data-selected={isActive ? "true" : "false"}
          onClick={onActivate}
          onDoubleClick={onStartEdit}
          aria-selected={isActive}
          {...attributes}
          {...listeners}
        >
          <span
            className="ui-tab-runtime-dot w-2 h-2 rounded-full shrink-0"
            data-pulsing={PULSING_TAB_STATES.has(notification) ? "true" : "false"}
            style={{ backgroundColor: TAB_NOTIFICATION_COLORS[notification], color: TAB_NOTIFICATION_COLORS[notification] }}
            role="status"
            aria-label={statusLabel}
            title={statusTitle}
          />
          {isEditing ? (
            <input
              ref={editInputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerMove={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  skipNextBlurSubmitRef.current = true;
                  submitEdit();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  skipNextBlurSubmitRef.current = true;
                  cancelEdit();
                }
              }}
              onBlur={() => {
                if (skipNextBlurSubmitRef.current) {
                  skipNextBlurSubmitRef.current = false;
                  return;
                }
                submitEdit();
              }}
              className="ui-input h-5 min-w-0 flex-1 rounded-md px-1.5 py-0 text-[12px] text-on-surface outline-none"
              aria-label={`重命名终端 ${title}`}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate tracking-[0.01em]" title={statusTitle}>{title}</span>
          )}
          {notification !== "none" && (
            <span className="shrink-0 text-[10px] leading-none text-on-surface-variant" title={statusTitle}>
              {statusLabel}
            </span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            className="ui-terminal-tab-close ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-[background-color,color,opacity,box-shadow] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
            aria-label={`关闭终端 ${title}`}
            title={`关闭终端 ${title}`}
          >
            <X size={13} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>{menuContent(getTabAnchor)}</ContextMenuContent>
    </ContextMenu>
  );
}

function DragOverlayTab({
  title,
  notification,
  statusUpdatedAt,
}: {
  title: string;
  notification: TabNotificationState;
  statusUpdatedAt: string | null;
}) {
  const statusLabel = TAB_NOTIFICATION_LABELS[notification];
  const statusTitle = `状态：${statusLabel}\n会话：${title}\n更新时间：${formatTabStatusUpdatedAt(statusUpdatedAt)}`;
  const tabMinWidthClass = notification === "none" ? "min-w-[92px]" : "min-w-[118px]";

  return (
    <div
      className={`ui-tab-trigger ui-terminal-drag-overlay-tab mx-1 flex h-7 ${tabMinWidthClass} max-w-[180px] items-center gap-2 rounded-lg px-3 text-[12px] font-medium`}
      data-selected="true"
      title={statusTitle}
    >
      <span
        className="ui-tab-runtime-dot w-2 h-2 rounded-full shrink-0"
        data-pulsing={PULSING_TAB_STATES.has(notification) ? "true" : "false"}
        style={{ backgroundColor: TAB_NOTIFICATION_COLORS[notification], color: TAB_NOTIFICATION_COLORS[notification] }}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate tracking-[0.01em]">{title}</span>
      {notification !== "none" && <span className="shrink-0 text-[10px] leading-none text-on-surface-variant">{statusLabel}</span>}
    </div>
  );
}

interface PaneTabBarProps {
  pane: TerminalPaneLeaf;
  sessions: TerminalSession[];
  allPanes: TerminalPaneLeaf[];
  activeSessionId: string | null;
  editingSessionId: string | null;
  tabNotifications: Record<string, TabNotificationState>;
  tabStatusDetails: Record<string, { updatedAt: string | null }>;
  terminalBackgroundEnabled: boolean;
  terminalBackgroundImagePath: string | null;
  hiddenBackgroundSessionIds: Set<string>;
  onActivateSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onStartEdit: (sessionId: string) => void;
  onSubmitEdit: (sessionId: string, title: string) => void;
  onCancelEdit: () => void;
  onNewTab: () => void;
  onOpenSplitPicker: (sessionId: string, direction: TerminalPaneSplitDirection, anchor?: DOMRect) => void;
  onUnsplit: (sessionId: string) => void;
  onMoveToPane: (sessionId: string, paneId: string) => void;
  onHideBackground: (sessionId: string) => void;
  onShowBackground: (sessionId: string) => void;
  toolbarActions?: ReactNode;
  variant?: "global" | "pane";
}

function PaneTabBar({
  pane,
  sessions,
  allPanes,
  activeSessionId,
  editingSessionId,
  tabNotifications,
  tabStatusDetails,
  terminalBackgroundEnabled,
  terminalBackgroundImagePath,
  hiddenBackgroundSessionIds,
  onActivateSession,
  onCloseSession,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
  onNewTab,
  onOpenSplitPicker,
  onUnsplit,
  onMoveToPane,
  onHideBackground,
  onShowBackground,
  toolbarActions,
  variant = "pane",
}: PaneTabBarProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `${PANE_DROP_PREFIX}${pane.id}` });
  const tabScrollRef = useRef<HTMLDivElement | null>(null);
  const tabScrollUpdateTimeoutRef = useRef<number | null>(null);
  const [tabListOpen, setTabListOpen] = useState(false);
  const [tabScrollState, setTabScrollState] = useState({
    isOverflowing: false,
    canScrollLeft: false,
    canScrollRight: false,
  });
  const paneSessions = pane.sessionIds
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is TerminalSession => Boolean(session));
  const otherPanes = allPanes.filter((item) => item.id !== pane.id && item.sessionIds.length > 0);
  const tabScrollSignature = paneSessions
    .map((session) => `${session.id}:${session.title}:${tabNotifications[session.id] ?? "none"}`)
    .join("|");

  const updateTabScrollState = useCallback(() => {
    const element = tabScrollRef.current;
    if (!element) {
      setTabScrollState((current) => {
        if (!current.isOverflowing && !current.canScrollLeft && !current.canScrollRight) return current;
        return { isOverflowing: false, canScrollLeft: false, canScrollRight: false };
      });
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    const scrollLeft = Math.max(0, element.scrollLeft);
    const nextState = {
      isOverflowing: maxScrollLeft > 1,
      canScrollLeft: scrollLeft > 1,
      canScrollRight: scrollLeft < maxScrollLeft - 1,
    };

    setTabScrollState((current) => {
      if (
        current.isOverflowing === nextState.isOverflowing &&
        current.canScrollLeft === nextState.canScrollLeft &&
        current.canScrollRight === nextState.canScrollRight
      ) {
        return current;
      }
      return nextState;
    });
  }, []);

  const scrollPaneTabs = useCallback((direction: -1 | 1) => {
    const element = tabScrollRef.current;
    if (!element) return;
    const distance = Math.max(Math.floor(element.clientWidth * 0.72), 160);
    element.scrollBy({ left: distance * direction, behavior: "smooth" });
    window.requestAnimationFrame(updateTabScrollState);
    if (tabScrollUpdateTimeoutRef.current !== null) window.clearTimeout(tabScrollUpdateTimeoutRef.current);
    tabScrollUpdateTimeoutRef.current = window.setTimeout(() => {
      tabScrollUpdateTimeoutRef.current = null;
      updateTabScrollState();
    }, 220);
  }, [updateTabScrollState]);

  const scrollActivePaneTabIntoView = useCallback(() => {
    const element = tabScrollRef.current;
    const activeSessionId = pane.activeSessionId;
    if (!element || !activeSessionId) {
      updateTabScrollState();
      return;
    }

    const activeTab = Array.from(element.querySelectorAll<HTMLElement>("[data-terminal-tab-id]"))
      .find((node) => node.dataset.terminalTabId === activeSessionId);
    if (!activeTab) {
      updateTabScrollState();
      return;
    }

    const containerRect = element.getBoundingClientRect();
    const activeRect = activeTab.getBoundingClientRect();
    let nextScrollLeft = element.scrollLeft;

    if (activeRect.left < containerRect.left) {
      nextScrollLeft -= containerRect.left - activeRect.left;
    } else if (activeRect.right > containerRect.right) {
      nextScrollLeft += activeRect.right - containerRect.right;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    const clampedScrollLeft = Math.min(maxScrollLeft, Math.max(0, nextScrollLeft));
    if (Math.abs(clampedScrollLeft - element.scrollLeft) > 0.5) {
      element.scrollTo({ left: clampedScrollLeft, behavior: "smooth" });
    }

    window.requestAnimationFrame(updateTabScrollState);
    if (tabScrollUpdateTimeoutRef.current !== null) window.clearTimeout(tabScrollUpdateTimeoutRef.current);
    tabScrollUpdateTimeoutRef.current = window.setTimeout(() => {
      tabScrollUpdateTimeoutRef.current = null;
      updateTabScrollState();
    }, 220);
  }, [pane.activeSessionId, updateTabScrollState]);

  const activatePaneSessionAt = useCallback((index: number) => {
    const session = paneSessions[index];
    if (!session) return;
    onActivateSession(session.id);
  }, [onActivateSession, paneSessions]);

  const closePaneSessions = useCallback((sessionIds: string[]) => {
    sessionIds.forEach((sessionId) => onCloseSession(sessionId));
  }, [onCloseSession]);

  const closeOtherPaneSessions = useCallback((sessionId: string) => {
    const index = pane.sessionIds.indexOf(sessionId);
    if (index < 0) return;
    closePaneSessions(pane.sessionIds.filter((id) => id !== sessionId));
  }, [closePaneSessions, pane.sessionIds]);

  const closePaneSessionsToLeft = useCallback((sessionId: string) => {
    const index = pane.sessionIds.indexOf(sessionId);
    if (index <= 0) return;
    closePaneSessions(pane.sessionIds.slice(0, index));
  }, [closePaneSessions, pane.sessionIds]);

  const closePaneSessionsToRight = useCallback((sessionId: string) => {
    const index = pane.sessionIds.indexOf(sessionId);
    if (index < 0) return;
    closePaneSessions(pane.sessionIds.slice(index + 1));
  }, [closePaneSessions, pane.sessionIds]);

  useEffect(() => {
    setTabListOpen(false);
  }, [pane.id, pane.activeSessionId]);

  useEffect(() => {
    if (!tabScrollState.isOverflowing) setTabListOpen(false);
  }, [tabScrollState.isOverflowing]);

  useEffect(() => {
    const element = tabScrollRef.current;
    let frameId: number | null = null;
    const scheduleUpdate = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        updateTabScrollState();
      });
    };

    scheduleUpdate();
    if (!element) return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };

    element.addEventListener("scroll", scheduleUpdate, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    observer?.observe(element);

    return () => {
      element.removeEventListener("scroll", scheduleUpdate);
      observer?.disconnect();
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      if (tabScrollUpdateTimeoutRef.current !== null) {
        window.clearTimeout(tabScrollUpdateTimeoutRef.current);
        tabScrollUpdateTimeoutRef.current = null;
      }
    };
  }, [tabScrollSignature, updateTabScrollState]);

  useEffect(() => {
    scrollActivePaneTabIntoView();
  }, [pane.activeSessionId, pane.sessionIds.length, scrollActivePaneTabIntoView]);

  return (
    <div
      ref={setNodeRef}
      className={`ui-terminal-chrome ${variant === "global" ? "ui-terminal-global-chrome" : "ui-terminal-pane-chrome"} relative flex h-10 shrink-0 items-center`}
      data-drop-target={isOver ? "true" : "false"}
      data-chrome-variant={variant}
    >
      {variant === "pane" && tabScrollState.isOverflowing && (
        <button
          type="button"
          className="ui-terminal-tab-scroll-button ui-terminal-tab-scroll-button-left"
          onClick={() => scrollPaneTabs(-1)}
          disabled={!tabScrollState.canScrollLeft}
          aria-label="向左滚动终端标签"
          title="向左滚动终端标签"
        >
          <ChevronRight size={14} strokeWidth={1.8} className="rotate-180" aria-hidden="true" />
        </button>
      )}
      <div
        ref={tabScrollRef}
        className="ui-terminal-tab-scroll flex h-full min-w-0 flex-1 items-center overflow-x-auto px-1.5"
        data-can-scroll-left={tabScrollState.canScrollLeft ? "true" : "false"}
        data-can-scroll-right={tabScrollState.canScrollRight ? "true" : "false"}
      >
        <SortableContext items={pane.sessionIds} strategy={horizontalListSortingStrategy}>
          {paneSessions.map((session) => (
            <SortableTab
              key={session.id}
              id={session.id}
              paneId={pane.id}
              title={session.title}
              isActive={session.id === activeSessionId}
              isEditing={editingSessionId === session.id}
              notification={tabNotifications[session.id] ?? "none"}
              statusUpdatedAt={tabStatusDetails[session.id]?.updatedAt ?? null}
              onActivate={() => onActivateSession(session.id)}
              onClose={() => onCloseSession(session.id)}
              onStartEdit={() => onStartEdit(session.id)}
              onSubmitEdit={(title) => onSubmitEdit(session.id, title)}
              onCancelEdit={onCancelEdit}
              menuContent={(getAnchor) => (
                <>
                  <ContextMenuItem onSelect={() => onCloseSession(session.id)}>关闭终端</ContextMenuItem>
                  <ContextMenuItem onSelect={() => closeOtherPaneSessions(session.id)}>关闭其它终端</ContextMenuItem>
                  <ContextMenuItem onSelect={() => closePaneSessionsToLeft(session.id)}>关闭左侧终端</ContextMenuItem>
                  <ContextMenuItem onSelect={() => closePaneSessionsToRight(session.id)}>关闭右侧终端</ContextMenuItem>
                  <ContextMenuItem onSelect={onNewTab}>新建终端</ContextMenuItem>
                  {terminalBackgroundEnabled && terminalBackgroundImagePath && (
                    hiddenBackgroundSessionIds.has(session.id) ? (
                      <ContextMenuItem onSelect={() => onShowBackground(session.id)}>显示背景图</ContextMenuItem>
                    ) : (
                      <ContextMenuItem onSelect={() => onHideBackground(session.id)}>隐藏背景图</ContextMenuItem>
                    )
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => onOpenSplitPicker(session.id, "horizontal", getAnchor())}>
                    Split Right
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onOpenSplitPicker(session.id, "vertical", getAnchor())}>
                    Split Down
                  </ContextMenuItem>
                  {allPanes.length > 1 && <ContextMenuItem onSelect={() => onUnsplit(session.id)}>Unsplit</ContextMenuItem>}
                  {otherPanes.length > 0 && (
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>Move to Other Split</ContextMenuSubTrigger>
                      <ContextMenuSubContent>
                        {otherPanes.map((targetPane, index) => (
                          <ContextMenuItem key={targetPane.id} onSelect={() => onMoveToPane(session.id, targetPane.id)}>
                            Pane {index + 1}
                          </ContextMenuItem>
                        ))}
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                  )}
                </>
              )}
            />
          ))}
        </SortableContext>
      </div>
      {variant === "pane" && tabScrollState.isOverflowing && (
        <>
          <button
            type="button"
            className="ui-terminal-tab-scroll-button ui-terminal-tab-scroll-button-right"
            onClick={() => scrollPaneTabs(1)}
            disabled={!tabScrollState.canScrollRight}
            aria-label="向右滚动终端标签"
            title="向右滚动终端标签"
          >
            <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <Popover open={tabListOpen && tabScrollState.isOverflowing} onOpenChange={setTabListOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="ui-terminal-tab-list-button"
                aria-label="打开终端标签列表"
                aria-expanded={tabListOpen && tabScrollState.isOverflowing}
                title="终端标签列表"
              >
                <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-64 p-1.5"
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <div className="px-2 py-1 text-[11px] font-semibold text-on-surface">终端标签</div>
              <div className="max-h-72 overflow-y-auto">
                {paneSessions.map((session, index) => {
                  const notification = tabNotifications[session.id] ?? "none";
                  const statusLabel = TAB_NOTIFICATION_LABELS[notification];
                  return (
                    <button
                      key={session.id}
                      type="button"
                      className="ui-interactive flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-on-surface-variant"
                      data-selected={session.id === pane.activeSessionId ? "true" : "false"}
                      onClick={() => {
                        activatePaneSessionAt(index);
                        setTabListOpen(false);
                      }}
                      title={`${session.title} · ${statusLabel}`}
                    >
                      <span
                        className="ui-tab-runtime-dot h-2 w-2 shrink-0 rounded-full"
                        data-pulsing={PULSING_TAB_STATES.has(notification) ? "true" : "false"}
                        style={{ backgroundColor: TAB_NOTIFICATION_COLORS[notification], color: TAB_NOTIFICATION_COLORS[notification] }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{session.title}</span>
                      {notification !== "none" && <span className="shrink-0 text-[10px] text-text-muted">{statusLabel}</span>}
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        </>
      )}
      {toolbarActions}
    </div>
  );
}

interface PaneLeafViewProps {
  pane: TerminalPaneLeaf;
  sessions: TerminalSession[];
  allPanes: TerminalPaneLeaf[];
  activeSessionId: string | null;
  historyActive: boolean;
  editingSessionId: string | null;
  tabNotifications: Record<string, TabNotificationState>;
  tabStatusDetails: Record<string, { updatedAt: string | null }>;
  fontSize: number;
  fontFamily: string;
  resolvedTheme: "dark" | "light";
  terminalThemeName: string;
  lightThemePalette: ReturnType<typeof useSettingsStore.getState>["lightThemePalette"];
  darkThemePalette: ReturnType<typeof useSettingsStore.getState>["darkThemePalette"];
  terminalBackgroundEnabled: boolean;
  terminalBackgroundImagePath: string | null;
  hiddenBackgroundSessionIds: Set<string>;
  activeDropPreview?: PaneDropPreview;
  onActivateSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onStartEdit: (sessionId: string) => void;
  onSubmitEdit: (sessionId: string, title: string) => void;
  onCancelEdit: () => void;
  onNewTab: () => void;
  onOpenSplitPicker: (sessionId: string, direction: TerminalPaneSplitDirection, anchor?: DOMRect) => void;
  onUnsplit: (sessionId: string) => void;
  onMoveToPane: (sessionId: string, paneId: string) => void;
  onHideBackground: (sessionId: string) => void;
  onShowBackground: (sessionId: string) => void;
  toolbarActions?: ReactNode;
  hideTabBar?: boolean;
}

function PaneLeafView({
  pane,
  sessions,
  allPanes,
  activeSessionId,
  historyActive,
  editingSessionId,
  tabNotifications,
  tabStatusDetails,
  fontSize,
  fontFamily,
  resolvedTheme,
  terminalThemeName,
  lightThemePalette,
  darkThemePalette,
  terminalBackgroundEnabled,
  terminalBackgroundImagePath,
  hiddenBackgroundSessionIds,
  activeDropPreview,
  onActivateSession,
  onCloseSession,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
  onNewTab,
  onOpenSplitPicker,
  onUnsplit,
  onMoveToPane,
  onHideBackground,
  onShowBackground,
  toolbarActions,
  hideTabBar = false,
}: PaneLeafViewProps) {
  const paneSessions = pane.sessionIds
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is TerminalSession => Boolean(session));

  return (
    <div className="ui-terminal-pane flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {!hideTabBar && (
        <PaneTabBar
          pane={pane}
          sessions={sessions}
          allPanes={allPanes}
          activeSessionId={activeSessionId}
          editingSessionId={editingSessionId}
          tabNotifications={tabNotifications}
          tabStatusDetails={tabStatusDetails}
          terminalBackgroundEnabled={terminalBackgroundEnabled}
          terminalBackgroundImagePath={terminalBackgroundImagePath}
          hiddenBackgroundSessionIds={hiddenBackgroundSessionIds}
          onActivateSession={onActivateSession}
          onCloseSession={onCloseSession}
          onStartEdit={onStartEdit}
          onSubmitEdit={onSubmitEdit}
          onCancelEdit={onCancelEdit}
          onNewTab={onNewTab}
          onOpenSplitPicker={onOpenSplitPicker}
          onUnsplit={onUnsplit}
          onMoveToPane={onMoveToPane}
          onHideBackground={onHideBackground}
          onShowBackground={onShowBackground}
          toolbarActions={toolbarActions}
        />
      )}
      <div
        className="ui-terminal-pane-content relative min-h-0 flex-1 overflow-hidden"
        onMouseDownCapture={() => {
          if (pane.activeSessionId && pane.activeSessionId !== activeSessionId) onActivateSession(pane.activeSessionId);
        }}
      >
        {paneSessions.map((session) => (
          <div
            key={session.id}
            className="absolute inset-0"
            style={{ display: session.id === pane.activeSessionId ? "block" : "none" }}
          >
            <XTermTerminal
              sessionId={session.id}
              isActive={!historyActive && session.id === activeSessionId}
              fontSize={fontSize}
              fontFamily={fontFamily}
              resolvedTheme={resolvedTheme}
              terminalThemeName={terminalThemeName}
              lightThemePalette={lightThemePalette}
              darkThemePalette={darkThemePalette}
            />
          </div>
        ))}
        <PaneContentDropZones paneId={pane.id} activeDropPreview={activeDropPreview} />
      </div>
    </div>
  );
}

function PaneContentDropZones({ paneId, activeDropPreview }: { paneId: string; activeDropPreview?: PaneDropPreview }) {
  const centerDrop = useDroppable({ id: `${PANE_CENTER_DROP_PREFIX}${paneId}` });
  const leftDrop = useDroppable({ id: `${PANE_EDGE_DROP_PREFIX}${paneId}:left` });
  const rightDrop = useDroppable({ id: `${PANE_EDGE_DROP_PREFIX}${paneId}:right` });
  const topDrop = useDroppable({ id: `${PANE_EDGE_DROP_PREFIX}${paneId}:top` });
  const bottomDrop = useDroppable({ id: `${PANE_EDGE_DROP_PREFIX}${paneId}:bottom` });
  const activeEdge = activeDropPreview?.paneId === paneId ? activeDropPreview.edge : null;

  return (
    <>
      <div ref={centerDrop.setNodeRef} className="ui-terminal-pane-center-drop" aria-hidden="true" />
      <div ref={leftDrop.setNodeRef} className="ui-terminal-pane-edge-drop ui-terminal-pane-edge-drop-left" aria-hidden="true" />
      <div ref={rightDrop.setNodeRef} className="ui-terminal-pane-edge-drop ui-terminal-pane-edge-drop-right" aria-hidden="true" />
      <div ref={topDrop.setNodeRef} className="ui-terminal-pane-edge-drop ui-terminal-pane-edge-drop-top" aria-hidden="true" />
      <div ref={bottomDrop.setNodeRef} className="ui-terminal-pane-edge-drop ui-terminal-pane-edge-drop-bottom" aria-hidden="true" />
      {activeEdge && <div className="ui-terminal-pane-drop-preview" data-edge={activeEdge} aria-hidden="true" />}
    </>
  );
}

interface SplitProjectPickerProps {
  picker: SplitPickerState;
  projects: Project[];
  onSelectEmpty: () => void;
  onSelectProject: (project: Project) => void;
  onClose: () => void;
  shouldIgnoreOutsideInteraction: () => boolean;
}

function SplitProjectPicker({ picker, projects, onSelectEmpty, onSelectProject, onClose, shouldIgnoreOutsideInteraction }: SplitProjectPickerProps) {
  const anchorStyle: CSSProperties = picker
    ? { position: "fixed", left: picker.x, top: picker.y, width: 1, height: 1 }
    : { position: "fixed", left: 0, top: 0, width: 1, height: 1 };

  return (
    <Popover open={picker !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <PopoverAnchor asChild>
        <span className="pointer-events-none" style={anchorStyle} aria-hidden="true" />
      </PopoverAnchor>
      <PopoverContent
        align="end"
        className="w-80 p-2"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (shouldIgnoreOutsideInteraction()) event.preventDefault();
        }}
      >
        <div className="px-2 py-1 text-xs font-semibold text-on-surface">选择分屏终端</div>
        <button
          type="button"
          onClick={onSelectEmpty}
          className="ui-interactive mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-on-surface"
        >
          <Terminal size={13} strokeWidth={1.8} />
          <span>空终端</span>
        </button>
        <div className="mt-1 max-h-72 overflow-y-auto">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => onSelectProject(project)}
              className="ui-interactive flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-on-surface-variant"
              title={project.path}
            >
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {project.cli_tool && <span className="shrink-0 text-[10px] text-text-muted">{project.cli_tool}</span>}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface TerminalTabsProps {
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export function TerminalTabs({ fullscreen = false, onToggleFullscreen }: TerminalTabsProps = {}) {
  const { sessions, activeSessionId, paneTree, tabNotifications, tabStatusDetails } = useTerminalStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      paneTree: s.paneTree,
      tabNotifications: s.tabNotifications,
      tabStatusDetails: s.tabStatusDetails,
    }))
  );
  const setActive = useTerminalStore((s) => s.setActive);
  const closeSession = useTerminalStore((s) => s.closeSession);
  const createSession = useTerminalStore((s) => s.createSession);
  const reorderSessions = useTerminalStore((s) => s.reorderSessions);
  const moveSessionToPane = useTerminalStore((s) => s.moveSessionToPane);
  const splitSessionToPaneEdge = useTerminalStore((s) => s.splitSessionToPaneEdge);
  const renameSession = useTerminalStore((s) => s.renameSession);
  const splitTerminal = useTerminalStore((s) => s.splitTerminal);
  const unsplitTerminal = useTerminalStore((s) => s.unsplitTerminal);
  const hiddenBackgroundSessionIds = useTerminalStore((s) => s.hiddenBackgroundSessionIds);
  const hideBackgroundForSession = useTerminalStore((s) => s.hideBackgroundForSession);
  const showBackgroundForSession = useTerminalStore((s) => s.showBackgroundForSession);
  const projects = useProjectStore((s) => s.projects);
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const terminalThemeMode = useSettingsStore((s) => s.terminalThemeMode);
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const terminalBackgroundEnabled = useSettingsStore((s) => s.terminalBackground.enabled);
  const terminalBackgroundImagePath = useSettingsStore((s) => s.terminalBackground.imagePath);
  const terminalToolbarVisibility = useSettingsStore((s) => s.terminalToolbarVisibility);
  const sessionHistoryShortcut = useSettingsStore((s) => s.keyboardShortcuts.sessionHistory);
  const sessionHistoryShortcutHint = sessionHistoryShortcut.trim() || "未设置快捷键";
  const historyOpen = useHistoryStore((s) => s.isOpen);
  const openHistory = useHistoryStore((s) => s.openHistory);
  const closeHistory = useHistoryStore((s) => s.closeHistory);
  const focusGlobalSearchSeq = useHistoryStore((s) => s.focusGlobalSearchSeq);
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<"terminal" | "history">("terminal");
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [splitPicker, setSplitPicker] = useState<SplitPickerState>(null);
  const [activeDragSessionId, setActiveDragSessionId] = useState<string | null>(null);
  const [activeDropPreview, setActiveDropPreview] = useState<PaneDropPreview>(null);
  const splitPickerOpenFrameRef = useRef<number | null>(null);
  const splitPickerOpenTimerRef = useRef<number | null>(null);
  const splitPickerOutsideGuardUntilRef = useRef(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const allPanes = useMemo(() => collectPaneLeaves(paneTree), [paneTree]);
  const activeDragSession = useMemo(
    () => activeDragSessionId ? sessions.find((session) => session.id === activeDragSessionId) ?? null : null,
    [activeDragSessionId, sessions]
  );
  const effectiveTerminalThemeName = terminalThemeMode === "follow-app" ? "auto" : terminalThemeName;
  const terminalTheme = useMemo(
    () => getTerminalTheme(effectiveTerminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette),
    [darkThemePalette, effectiveTerminalThemeName, lightThemePalette, resolvedTheme]
  );
  const terminalThemeBackground = terminalTheme.background ?? (resolvedTheme === "dark" ? "#0c0e10" : "#ffffff");
  const terminalThemeForeground = terminalTheme.foreground ?? (resolvedTheme === "dark" ? "#f8fafc" : "#1e293b");
  const terminalThemeAccent = terminalTheme.blue ?? terminalTheme.cursor ?? terminalThemeForeground;
  const terminalThemeMuted = terminalTheme.brightBlack ?? terminalTheme.white ?? terminalThemeForeground;
  const terminalThemeSelection = terminalTheme.selectionBackground ?? terminalThemeAccent;
  const terminalWellStyle = {
    "--terminal-bridge-color": terminalThemeBackground,
    "--terminal-theme-background": terminalThemeBackground,
    "--terminal-theme-foreground": terminalThemeForeground,
    "--terminal-theme-muted": terminalThemeMuted,
    "--terminal-theme-accent": terminalThemeAccent,
    "--terminal-theme-selection": terminalThemeSelection,
  } as CSSProperties;
  const historyActive = historyOpen && activeWorkspaceTab === "history";
  const showToolbarText = terminalToolbarVisibility.showText;

  useEffect(() => {
    if (!historyOpen && activeWorkspaceTab === "history") setActiveWorkspaceTab("terminal");
  }, [activeWorkspaceTab, historyOpen]);

  useEffect(() => {
    if (!historyOpen) return;
    setActiveWorkspaceTab("history");
  }, [focusGlobalSearchSeq, historyOpen]);

  const clearSplitPickerOpenSchedule = useCallback(() => {
    if (splitPickerOpenFrameRef.current !== null) {
      window.cancelAnimationFrame(splitPickerOpenFrameRef.current);
      splitPickerOpenFrameRef.current = null;
    }
    if (splitPickerOpenTimerRef.current !== null) {
      window.clearTimeout(splitPickerOpenTimerRef.current);
      splitPickerOpenTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearSplitPickerOpenSchedule, [clearSplitPickerOpenSchedule]);

  const handleCloseSplitPicker = useCallback(() => {
    clearSplitPickerOpenSchedule();
    splitPickerOutsideGuardUntilRef.current = 0;
    setSplitPicker(null);
  }, [clearSplitPickerOpenSchedule]);

  const shouldIgnoreSplitPickerOutsideInteraction = useCallback(() => {
    return Date.now() < splitPickerOutsideGuardUntilRef.current;
  }, []);

  const handleNewTab = useCallback(async () => {
    if (useExternalTerminal) {
      await openWindowsTerminal([{ title: "Terminal" }]);
      return;
    }
    await createSession(undefined, undefined, "Terminal");
    setActiveWorkspaceTab("terminal");
  }, [useExternalTerminal, createSession]);

  const handleActivateSession = useCallback((sessionId: string) => {
    setActiveWorkspaceTab("terminal");
    setActive(sessionId);
  }, [setActive]);

  const handleOpenHistoryTab = useCallback(() => {
    if (historyOpen) {
      closeHistory();
      return;
    }

    const activeSession = sessions.find((session) => session.id === activeSessionId);
    const project = activeSession?.projectId ? projects.find((item) => item.id === activeSession.projectId) : undefined;
    setActiveWorkspaceTab("history");
    void openHistory({
      sourceFilter: resolveHistorySourceFilter(project?.cli_tool),
      projectPath: project?.path ?? null,
    });
  }, [activeSessionId, closeHistory, historyOpen, openHistory, projects, sessions]);

  const handleOpenSplitPicker = useCallback((sessionId: string, direction: TerminalPaneSplitDirection, anchor?: DOMRect) => {
    clearSplitPickerOpenSchedule();
    const x = anchor ? Math.min(Math.max(anchor.right, 16), window.innerWidth - 16) : window.innerWidth - 24;
    const y = anchor ? Math.min(Math.max(anchor.bottom, 44), window.innerHeight - 16) : 56;
    splitPickerOpenFrameRef.current = window.requestAnimationFrame(() => {
      splitPickerOpenFrameRef.current = null;
      splitPickerOpenTimerRef.current = window.setTimeout(() => {
        splitPickerOpenTimerRef.current = null;
        splitPickerOutsideGuardUntilRef.current = Date.now() + SPLIT_PICKER_OUTSIDE_GUARD_MS;
        setSplitPicker({ sessionId, direction, x, y });
      }, 0);
    });
  }, [clearSplitPickerOpenSchedule]);

  const handleSplitEmpty = useCallback(() => {
    if (!splitPicker) return;
    void splitTerminal(splitPicker.sessionId, splitPicker.direction, { title: "Terminal" });
    handleCloseSplitPicker();
    setActiveWorkspaceTab("terminal");
  }, [handleCloseSplitPicker, splitPicker, splitTerminal]);

  const handleSplitProject = useCallback((project: Project) => {
    if (!splitPicker) return;
    void splitTerminal(splitPicker.sessionId, splitPicker.direction, buildProjectSplitOptions(project));
    handleCloseSplitPicker();
    setActiveWorkspaceTab("terminal");
  }, [handleCloseSplitPicker, splitPicker, splitTerminal]);

  const findPaneForSession = useCallback((sessionId: string) => {
    return allPanes.find((pane) => pane.sessionIds.includes(sessionId)) ?? null;
  }, [allPanes]);

  const canSplitSessionToPaneEdge = useCallback((sessionId: string, targetPaneId: string) => {
    const sourcePane = findPaneForSession(sessionId);
    const targetPane = allPanes.find((pane) => pane.id === targetPaneId) ?? null;
    if (!sourcePane || !targetPane) return false;
    return sourcePane.id !== targetPane.id || sourcePane.sessionIds.length > 1;
  }, [allPanes, findPaneForSession]);

  const clearDragState = useCallback(() => {
    setActiveDragSessionId(null);
    setActiveDropPreview(null);
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const sessionId = String(event.active.id);
    if (!sessions.some((session) => session.id === sessionId)) return;
    setActiveDragSessionId(sessionId);
    setActiveWorkspaceTab("terminal");
  }, [sessions]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (!activeDragSessionId || !event.over) {
      setActiveDropPreview(null);
      return;
    }

    const dropTarget = parsePaneDropTarget(String(event.over.id));
    if (dropTarget?.type === "edge" && canSplitSessionToPaneEdge(activeDragSessionId, dropTarget.paneId)) {
      setActiveDropPreview({ paneId: dropTarget.paneId, edge: dropTarget.edge });
      return;
    }

    setActiveDropPreview(null);
  }, [activeDragSessionId, canSplitSessionToPaneEdge]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    clearDragState();
    if (!over || active.id === over.id) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    const sourcePane = findPaneForSession(activeId);
    if (!sourcePane) return;

    const dropTarget = parsePaneDropTarget(overId);
    if (dropTarget?.type === "edge") {
      if (canSplitSessionToPaneEdge(activeId, dropTarget.paneId)) {
        splitSessionToPaneEdge(activeId, dropTarget.paneId, dropTarget.edge);
        setActiveWorkspaceTab("terminal");
      }
      return;
    }

    if (dropTarget?.type === "center") {
      if (dropTarget.paneId !== sourcePane.id) {
        moveSessionToPane(activeId, dropTarget.paneId);
        setActiveWorkspaceTab("terminal");
      }
      return;
    }

    const targetPane = findPaneForSession(overId);
    if (!targetPane) return;
    if (targetPane.id === sourcePane.id) {
      reorderSessions(activeId, overId);
      return;
    }
    moveSessionToPane(activeId, targetPane.id, overId);
    setActiveWorkspaceTab("terminal");
  }, [canSplitSessionToPaneEdge, clearDragState, findPaneForSession, moveSessionToPane, reorderSessions, splitSessionToPaneEdge]);

  const renderToolbarActions = useCallback(() => (
    <div className="ui-terminal-actions flex h-full shrink-0 items-center gap-2 px-2.5">
      <button
        onClick={handleNewTab}
        className="ui-flat-action ui-toolbar-button ui-primary-action"
        title="新建终端"
        aria-label="新建终端"
      >
        <Plus size={12} strokeWidth={2} />
        <Terminal size={14} strokeWidth={1.5} />
        <span>新建</span>
      </button>
      {terminalToolbarVisibility.templates && <CommandTemplatePanel showText={showToolbarText} />}
      {terminalToolbarVisibility.commandHistory && <CommandHistoryPanel compact showText={showToolbarText} />}
      {terminalToolbarVisibility.fullscreen && onToggleFullscreen && (
        <button
          onClick={onToggleFullscreen}
          className={showToolbarText ? "ui-flat-action ui-toolbar-button" : "ui-focus-ring ui-icon-action"}
          data-active={fullscreen ? "true" : "false"}
          title={fullscreen ? "退出沉浸式全屏" : "沉浸式全屏"}
          aria-label={fullscreen ? "退出沉浸式全屏" : "进入沉浸式全屏"}
          aria-pressed={fullscreen}
        >
          {fullscreen ? <Minimize2 size={14} strokeWidth={1.8} /> : <Maximize2 size={14} strokeWidth={1.8} />}
          {showToolbarText && <span>{fullscreen ? "退出全屏" : "全屏"}</span>}
        </button>
      )}
      {terminalToolbarVisibility.sessionHistory && (
        <button
          onClick={handleOpenHistoryTab}
          className={
            showToolbarText
              ? `ui-flat-action ui-toolbar-button ${historyOpen ? "ui-primary-action" : "ui-history-primary"}`
              : "ui-focus-ring ui-icon-action"
          }
          data-active={historyOpen ? "true" : "false"}
          title={`会话历史（${sessionHistoryShortcutHint}）`}
          aria-label={historyOpen ? "关闭会话历史" : "打开会话历史"}
          aria-controls="history-workspace"
          aria-expanded={historyOpen}
        >
          <Search size={13} strokeWidth={1.8} />
          {showToolbarText && <span>会话历史</span>}
        </button>
      )}
    </div>
  ), [
    fullscreen,
    handleNewTab,
    handleOpenHistoryTab,
    historyOpen,
    onToggleFullscreen,
    sessionHistoryShortcut,
    showToolbarText,
    terminalToolbarVisibility.commandHistory,
    terminalToolbarVisibility.fullscreen,
    terminalToolbarVisibility.sessionHistory,
    terminalToolbarVisibility.templates,
  ]);

  const renderLeaf = useCallback((pane: TerminalPaneLeaf) => (
    <PaneLeafView
      key={pane.id}
      pane={pane}
      sessions={sessions}
      allPanes={allPanes}
      activeSessionId={activeSessionId}
      historyActive={historyActive}
      editingSessionId={editingSessionId}
      tabNotifications={tabNotifications}
      tabStatusDetails={tabStatusDetails}
      fontSize={fontSize}
      fontFamily={fontFamily}
      resolvedTheme={resolvedTheme}
      terminalThemeName={effectiveTerminalThemeName}
      lightThemePalette={lightThemePalette}
      darkThemePalette={darkThemePalette}
      terminalBackgroundEnabled={terminalBackgroundEnabled}
      terminalBackgroundImagePath={terminalBackgroundImagePath}
      hiddenBackgroundSessionIds={hiddenBackgroundSessionIds}
      activeDropPreview={activeDropPreview}
      onActivateSession={handleActivateSession}
      onCloseSession={closeSession}
      onStartEdit={setEditingSessionId}
      onSubmitEdit={(sessionId, title) => {
        renameSession(sessionId, title);
        setEditingSessionId(null);
      }}
      onCancelEdit={() => setEditingSessionId(null)}
      onNewTab={() => void handleNewTab()}
      onOpenSplitPicker={handleOpenSplitPicker}
      onUnsplit={(sessionId) => void unsplitTerminal(sessionId)}
      onMoveToPane={moveSessionToPane}
      onHideBackground={hideBackgroundForSession}
      onShowBackground={showBackgroundForSession}
      toolbarActions={renderToolbarActions()}
      hideTabBar={false}
    />
  ), [
    activeSessionId,
    activeDropPreview,
    allPanes,
    closeSession,
    darkThemePalette,
    editingSessionId,
    effectiveTerminalThemeName,
    fontFamily,
    fontSize,
    handleActivateSession,
    handleNewTab,
    handleOpenSplitPicker,
    hiddenBackgroundSessionIds,
    hideBackgroundForSession,
    historyActive,
    lightThemePalette,
    moveSessionToPane,
    renameSession,
    renderToolbarActions,
    resolvedTheme,
    sessions,
    showBackgroundForSession,
    tabNotifications,
    tabStatusDetails,
    terminalBackgroundEnabled,
    terminalBackgroundImagePath,
    unsplitTerminal,
  ]);

  return (
    <div
      className="ui-terminal-tabs-shell flex h-full min-h-0 flex-col"
      data-fullscreen={fullscreen ? "true" : "false"}
      style={terminalWellStyle}
    >
      <SplitProjectPicker
        picker={splitPicker}
        projects={projects}
        onSelectEmpty={handleSplitEmpty}
        onSelectProject={handleSplitProject}
        onClose={handleCloseSplitPicker}
        shouldIgnoreOutsideInteraction={shouldIgnoreSplitPickerOutsideInteraction}
      />

      <div className="relative flex-1 min-h-0 overflow-hidden">
        {historyOpen && (
          <div
            className={`absolute min-h-0 overflow-hidden ${fullscreen ? "inset-x-0 bottom-0 top-0" : "inset-x-3 bottom-3 top-3"}`}
            style={{ display: historyActive ? "block" : "none" }}
          >
            <Suspense fallback={null}>
              <HistoryWorkspace active={historyActive} />
            </Suspense>
          </div>
        )}
        <div
          className="ui-terminal-well absolute inset-0 min-h-0"
          data-terminal-mode={terminalThemeMode}
          style={{ display: historyActive ? "none" : "block" }}
        >
          {paneTree && sessions.length > 0 ? (
            <DndContext
              sensors={sensors}
              collisionDetection={terminalTabCollisionDetection}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragCancel={clearDragState}
              onDragEnd={handleDragEnd}
            >
              <SplitTerminalView node={paneTree} renderLeaf={renderLeaf} />
              <DragOverlay dropAnimation={null}>
                {activeDragSession ? (
                  <DragOverlayTab
                    title={activeDragSession.title}
                    notification={tabNotifications[activeDragSession.id] ?? "none"}
                    statusUpdatedAt={tabStatusDetails[activeDragSession.id]?.updatedAt ?? null}
                  />
                ) : null}
              </DragOverlay>
            </DndContext>
          ) : null}
          {sessions.length === 0 && !useExternalTerminal && (
            <div className="flex h-full items-center justify-center">
              <EmptyState
                icon={<Terminal size={40} strokeWidth={1} />}
                title="无活跃终端"
                description="Ctrl+Shift+T 新建终端，或从左侧项目列表双击启动"
                tone="inverse"
                action={{ label: "打开终端", onClick: handleNewTab }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
