import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useShallow } from "zustand/shallow";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
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
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTerminalStore, type SplitTerminalOptions, type TabNotificationState } from "../stores/terminalStore";
import { TERMINAL_PANEL_WIDTH_DEFAULTS, useSettingsStore } from "../stores/settingsStore";
import { useWorktreeStore } from "../stores/worktreeStore";
import { useProjectStore } from "../stores/projectStore";
import { isProjectFileDirty, useFileExplorerStore } from "../stores/fileExplorerStore";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { logError } from "../lib/logger";
import { DND_ACTIVATION_CONSTRAINT, DND_SORTABLE_TRANSITION } from "../lib/dragInteraction";
import type { TerminalPaneDropEdge, TerminalPaneLeaf, TerminalPaneSplitDirection } from "../stores/terminalPaneTree";
import {
  collectPaneLeaves,
  filterPaneTreeBySessionIds,
  findFirstSessionId,
  resolvePaneDropEdgeFromPoint,
} from "../stores/terminalPaneTree";
import { collectWorkspanSessionIds, type TerminalWorkspan } from "../stores/terminalWorkspan";
import { SplitTerminalView } from "./SplitTerminalView";
import { XTermTerminal } from "./XTermTerminal";
import { CommandTemplatePanel } from "./CommandTemplatePanel";
import { CommandHistoryPanel } from "./CommandHistoryPanel";
import { TerminalStatsPanel } from "./terminal/TerminalStatsPanel";
import { SystemResourcesPanel } from "./terminal/SystemResourcesPanel";
import {
  ResizableTerminalPanelFrame,
  TerminalSidePanel,
  type TerminalSidePanelTab,
} from "./terminal/TerminalSidePanel";
import { SubagentTranscriptView } from "./terminal/SubagentTranscriptView";
import { SessionReplayPanel } from "./terminal/SessionReplayPanel";
import { WorktreeFinishDialog } from "./worktree/WorktreeFinishDialog";
import { FileEditorPane } from "./files/FileEditorPane";
import { FileExplorerSidebar } from "./files/FileExplorerSidebar";
import { openWindowsTerminal } from "../lib/externalTerminal";
import { openPath } from "@tauri-apps/plugin-opener";
import { normalizeDirectCodexStartupCommand, resolveProjectStartupCommand } from "../lib/projectStartupCommand";
import { parseProjectEnvVars } from "../lib/providerSwitching";
import { Activity, Terminal, Plus, ListClockIcon, X, Copy, Maximize2, Minimize2, ChevronDown, ChevronRight, BarChart3, GitBranch, Folder, Check, Cpu } from "./icons";
import { WorktreeIcon } from "./WorktreeIcon";
import { VendorIcon, inferVendor, type VendorKey } from "./VendorIcon";
import { EmptyState } from "./ui/EmptyState";
import { useHistoryStore } from "../stores/historyStore";
import { useSystemResources } from "../hooks/useSystemResources";
import {
  shouldConfirmTerminalTabClose,
  TERMINAL_TAB_CLOSE_REQUEST_EVENT,
  type TerminalTabCloseRequestDetail,
} from "../lib/terminalCloseConfirm";
import type { HistorySourceFilter, Project, TerminalScope, TerminalSession, TreeNode, WorktreeRecord } from "../lib/types";
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
import { Button } from "./ui/button";
import { Portal } from "./ui/Portal";
import { ConfirmDialog } from "./ConfirmDialog";
import { getTerminalTheme, isLightTerminalTheme } from "../lib/terminalThemes";
import { getTerminalSidePanelSkinStyle } from "./stats/termStatsUi";
import {
  findWorktreeForSession,
  isSameProjectFileContext,
  projectWithWorktreeProviderOverrides,
  resolveProjectForSessionFileContext,
} from "../lib/terminalProject";
import { ALL_TERMINALS_SCOPE, collectProjectIdsForGroup, sessionMatchesTerminalScope } from "../lib/terminalScope";

const HistoryWorkspace = lazy(() =>
  import("./HistoryWorkspace").then((module) => ({ default: module.HistoryWorkspace }))
);

const GitChangesPanel = lazy(() =>
  import("./git/GitChangesPanel").then((module) => ({ default: module.GitChangesPanel }))
);

const normalizeTabMenuHex = (value: string | undefined, fallback: string) => (
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
);

const TERMINAL_PANEL_SEMANTIC_COLORS = {
  dark: {
    fg: "#ECECEC",
    dim: "#9CA0A6",
    green: "#3DD68C",
    yellow: "#E5C453",
    red: "#F25E5E",
    magenta: "#C77DBB",
    cyan: "#5AC8E0",
    blue: "#5B8DEF",
  },
  light: {
    fg: "#1F2937",
    dim: "#64748B",
    green: "#15803D",
    yellow: "#B45309",
    red: "#DC2626",
    magenta: "#9333EA",
    cyan: "#0891B2",
    blue: "#2563EB",
  },
} as const;

const tabMenuHexToRgba = (value: string | undefined, alpha: number, fallback: string) => {
  const normalized = normalizeTabMenuHex(value, "");
  if (!normalized) return fallback;
  const hex = normalized.slice(1);
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const TAB_NOTIFICATION_COLORS: Record<TabNotificationState, string> = {
  none: "#565f89",
  running: "#8b5cf6",
  attention: "#ff9e64",
  done: "#8fbf7f",
  failed: "#f7768e",
};

const TAB_NOTIFICATION_LABELS: Record<TabNotificationState, TranslationKey> = {
  none: "terminal.status.none",
  running: "terminal.status.running",
  attention: "terminal.status.attention",
  done: "terminal.status.done",
  failed: "terminal.status.failed",
};

const PULSING_TAB_STATES = new Set<TabNotificationState>(["running", "attention"]);
const PANE_DROP_PREFIX = "pane-drop:";
const PANE_CENTER_DROP_PREFIX = "pane-center:";
const PANE_EDGE_DROP_PREFIX = "pane-edge:";
const WORKSPAN_DRAG_PREFIX = "workspan:";
const WORKSPAN_SPLIT_ACTIVATION_RATIO = 0.18;
const PANE_DROP_EDGES: TerminalPaneDropEdge[] = ["left", "right", "top", "bottom"];
const WORKSPAN_NOTIFICATION_PRIORITY: Record<TabNotificationState, number> = {
  none: 0,
  done: 1,
  running: 2,
  failed: 3,
  attention: 4,
};
const SPLIT_PICKER_OUTSIDE_GUARD_MS = 250;
type SplitPickerAnchor = DOMRect | { x: number; y: number };
type SplitPickerAlign = "start" | "end";

type SplitPickerState = {
  sessionId: string;
  direction: TerminalPaneSplitDirection;
  x: number;
  y: number;
  align: SplitPickerAlign;
} | null;

type TerminalCloseConfirmState = {
  sessionIds: string[];
  x: number;
  y: number;
  align: SplitPickerAlign;
} | null;

type PaneDropTarget =
  | { type: "center"; paneId: string }
  | { type: "edge"; paneId: string; edge: TerminalPaneDropEdge };

type PaneDropPreview = { paneId: string; edge: TerminalPaneDropEdge } | null;

const TERMINAL_TAB_HOVER_DELAY_MS = 260;
const TERMINAL_TAB_HOVER_CLOSE_DELAY_MS = 320;
const TERMINAL_TAB_HOVER_CARD_WIDTH = 320;
const TERMINAL_TAB_HOVER_CARD_ESTIMATED_HEIGHT = 190;

interface TerminalTabHoverInfo {
  name: string;
  cli: string;
  shell: string;
  project: string;
  path: string;
  sessionId: string;
}

function isTerminalPaneDropEdge(value: string): value is TerminalPaneDropEdge {
  return PANE_DROP_EDGES.includes(value as TerminalPaneDropEdge);
}

function parseWorkspanDragId(value: string): string | null {
  return value.startsWith(WORKSPAN_DRAG_PREFIX) ? value.slice(WORKSPAN_DRAG_PREFIX.length) || null : null;
}

function getWorkspanNotification(
  sessionIds: string[],
  notifications: Record<string, TabNotificationState>
): TabNotificationState {
  let resolved: TabNotificationState = "none";
  for (const sessionId of sessionIds) {
    const next = notifications[sessionId] ?? "none";
    if (WORKSPAN_NOTIFICATION_PRIORITY[next] > WORKSPAN_NOTIFICATION_PRIORITY[resolved]) resolved = next;
  }
  return resolved;
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatCliToolLabel(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "Terminal";

  const normalized = trimmed.toLowerCase();
  if (normalized.includes("claude")) return "Claude";
  if (normalized.includes("codex") || normalized === "code") return "Codex";
  return trimmed;
}

function formatShellLabel(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "默认 Shell";

  const normalized = trimmed.toLowerCase();
  if (normalized === "powershell" || normalized === "powershell.exe") return "PowerShell";
  if (normalized === "pwsh" || normalized === "pwsh.exe") return "PowerShell 7";
  if (normalized === "cmd") return "CMD";
  if (normalized === "wsl") return "WSL";
  if (normalized === "git-bash" || normalized === "git bash" || normalized === "gitbash") return "Git Bash";
  if (normalized === "bash") return "Bash";
  if (normalized === "zsh") return "Zsh";
  if (normalized === "fish") return "Fish";
  if (normalized === "sh") return "sh";
  return trimmed;
}

function formatSessionIdPreview(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 18) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-6)}`;
}

function buildTerminalTabHoverInfo(session: TerminalSession, project?: Project): TerminalTabHoverInfo {
  if (session.kind === "subagent-transcript") {
    return {
      name: session.title.trim() || "Terminal",
      cli: "Subagent",
      shell: "Transcript",
      project: project?.name.trim() || "\u672a\u7ed1\u5b9a\u9879\u76ee",
      path: session.cwd?.trim() || project?.path.trim() || "-",
      sessionId: session.cliSessionId?.trim() || session.id,
    };
  }
  if (session.kind === "synced-history") {
    return {
      name: session.title.trim() || "同步记录",
      cli: "Synced History",
      shell: formatShellLabel(session.shell ?? project?.shell),
      project: project?.name.trim() || session.syncedHistory?.title || "\u672a\u7ed1\u5b9a\u9879\u76ee",
      path: session.syncedHistory?.cwd || session.cwd?.trim() || project?.path.trim() || "-",
      sessionId: session.syncedHistory?.key || session.id,
    };
  }
  return {
    name: session.title.trim() || "Terminal",
    cli: formatCliToolLabel(project?.cli_tool),
    shell: formatShellLabel(session.shell ?? project?.shell),
    project: project?.name.trim() || "\u672a\u7ed1\u5b9a\u9879\u76ee",
    path: session.cwd?.trim() || project?.path.trim() || "-",
    sessionId: session.cliSessionId?.trim() || session.id,
  };
}

const terminalTabCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  const edgeCollision = pointerCollisions.find((collision) => String(collision.id).startsWith(PANE_EDGE_DROP_PREFIX));
  if (edgeCollision) return [edgeCollision];

  const centerCollision = pointerCollisions.find((collision) => String(collision.id).startsWith(PANE_CENTER_DROP_PREFIX));
  if (centerCollision) return [centerCollision];

  if (String(args.active.id).startsWith(WORKSPAN_DRAG_PREFIX)) {
    const workspanTabCollision = pointerCollisions.find((collision) => String(collision.id).startsWith(WORKSPAN_DRAG_PREFIX));
    return workspanTabCollision ? [workspanTabCollision] : [];
  }

  const closestCollisions = closestCenter(args);
  const tabCollision = closestCollisions.find((collision) => !isPaneDropCollisionId(String(collision.id)));
  if (tabCollision) return [tabCollision];

  const paneBarCollision = pointerCollisions.find((collision) => String(collision.id).startsWith(PANE_DROP_PREFIX));
  return paneBarCollision ? [paneBarCollision] : closestCollisions;
};

function resolveWorkspanDropEdge(
  event: DragOverEvent | DragEndEvent,
  dropTarget: PaneDropTarget
): TerminalPaneDropEdge | null {
  if (dropTarget.type === "edge") return dropTarget.edge;
  if (!event.over) return null;

  const activatorEvent = event.activatorEvent;
  if (
    !("clientX" in activatorEvent)
    || !("clientY" in activatorEvent)
    || typeof activatorEvent.clientX !== "number"
    || typeof activatorEvent.clientY !== "number"
  ) {
    return null;
  }

  return resolvePaneDropEdgeFromPoint(
    activatorEvent.clientX + event.delta.x,
    activatorEvent.clientY + event.delta.y,
    event.over.rect,
    WORKSPAN_SPLIT_ACTIVATION_RATIO
  );
}

function resolveHistorySourceFilter(cliTool: string | null | undefined): HistorySourceFilter {
  const normalized = cliTool?.trim().toLowerCase();
  if (!normalized) return "all";
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex") || normalized === "code") return "codex";
  return "all";
}

// 终端 Tab 厂商图标：从启动命令 + 标题推断（未配自定义启动命令时 startupCmd 即为 cli_tool）
function inferSessionVendor(session: TerminalSession): VendorKey | null {
  return inferVendor(`${session.startupCmd ?? ""} ${session.title}`);
}

function buildProjectSplitOptions(project: Project): SplitTerminalOptions {
  const cmd = resolveProjectStartupCommand(project);
  const shell = project.shell && project.shell !== "powershell" ? project.shell : undefined;

  return {
    projectId: project.id,
    cwd: project.path,
    title: project.name,
    startupCmd: cmd,
    envVars: parseProjectEnvVars(project),
    shell,
  };
}

interface SortableTabProps {
  id: string;
  paneId: string;
  title: string;
  sessionKind: TerminalSession["kind"];
  isActive: boolean;
  isEditing: boolean;
  notification: TabNotificationState;
  vendor?: VendorKey | null;
  worktree?: WorktreeRecord | null;
  worktreeMenuContent?: (closeMenu: () => void) => ReactNode;
  hoverInfo: TerminalTabHoverInfo;
  onActivate: () => void;
  onClose: (anchor?: SplitPickerAnchor) => void;
  onSubmitEdit: (title: string) => void;
  onCancelEdit: () => void;
  menuContent: (getAnchor: () => SplitPickerAnchor | undefined) => ReactNode;
  menuClassName?: string;
  menuStyle?: CSSProperties;
}

function SortableTab({
  id,
  paneId,
  title,
  sessionKind,
  isActive,
  isEditing,
  notification,
  vendor,
  worktree,
  worktreeMenuContent,
  hoverInfo,
  onActivate,
  onClose,
  onSubmitEdit,
  onCancelEdit,
  menuContent,
  menuClassName,
  menuStyle,
}: SortableTabProps) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { paneId },
    transition: DND_SORTABLE_TRANSITION,
  });
  const tabElementRef = useRef<HTMLDivElement | null>(null);
  const contextMenuPointRef = useRef<SplitPickerAnchor | null>(null);
  const [editValue, setEditValue] = useState(title);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const skipNextBlurSubmitRef = useRef(false);
  const statusLabel = t(TAB_NOTIFICATION_LABELS[notification]);
  const tabMinWidthClass = "min-w-[92px]";
  const [hoverCardPosition, setHoverCardPosition] = useState<{ left: number; top: number } | null>(null);
  const [worktreePopoverOpen, setWorktreePopoverOpen] = useState(false);
  const hoverOpenTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const terminalTabHoverInfoEnabled = useSettingsStore((s) => s.terminalTabHoverInfoEnabled);

  const clearHoverOpenTimer = useCallback(() => {
    if (hoverOpenTimerRef.current === null) return;
    window.clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = null;
  }, []);

  const clearHoverCloseTimer = useCallback(() => {
    if (hoverCloseTimerRef.current === null) return;
    window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = null;
  }, []);

  const hideHoverCard = useCallback(() => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    setHoverCardPosition(null);
  }, [clearHoverCloseTimer, clearHoverOpenTimer]);

  const keepHoverCardOpen = useCallback(() => {
    clearHoverCloseTimer();
  }, [clearHoverCloseTimer]);

  const scheduleHideHoverCard = useCallback(() => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      setHoverCardPosition(null);
    }, TERMINAL_TAB_HOVER_CLOSE_DELAY_MS);
  }, [clearHoverCloseTimer, clearHoverOpenTimer]);

  const scheduleHoverCard = useCallback(() => {
    if (!terminalTabHoverInfoEnabled || isEditing || isDragging) return;
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    hoverOpenTimerRef.current = window.setTimeout(() => {
      hoverOpenTimerRef.current = null;
      const rect = tabElementRef.current?.getBoundingClientRect();
      if (!rect) return;

      const maxLeft = Math.max(8, window.innerWidth - TERMINAL_TAB_HOVER_CARD_WIDTH - 8);
      const maxTop = Math.max(8, window.innerHeight - TERMINAL_TAB_HOVER_CARD_ESTIMATED_HEIGHT - 8);
      setHoverCardPosition({
        left: clampNumber(rect.left, 8, maxLeft),
        top: clampNumber(rect.bottom + 6, 8, maxTop),
      });
    }, TERMINAL_TAB_HOVER_DELAY_MS);
  }, [clearHoverCloseTimer, clearHoverOpenTimer, isDragging, isEditing, terminalTabHoverInfoEnabled]);

  const copySessionId = useCallback(() => {
    void navigator.clipboard
      .writeText(hoverInfo.sessionId)
      .then(() => toast.success("Session ID \u5df2\u590d\u5236"))
      .catch((err) => toast.error("\u590d\u5236\u5931\u8d25", { description: String(err) }));
  }, [hoverInfo.sessionId]);

  useEffect(() => () => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
  }, [clearHoverCloseTimer, clearHoverOpenTimer]);

  useEffect(() => {
    if (isEditing || isDragging) hideHoverCard();
  }, [hideHoverCard, isDragging, isEditing]);

  useEffect(() => {
    if (!terminalTabHoverInfoEnabled) hideHoverCard();
  }, [hideHoverCard, terminalTabHoverInfoEnabled]);

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

  const getTabAnchor = useCallback(() => contextMenuPointRef.current ?? tabElementRef.current?.getBoundingClientRect(), []);
  const closeWorktreePopover = useCallback(() => setWorktreePopoverOpen(false), []);

  return (
    <>
      <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setTabNodeRef}
          style={style}
          className={`ui-interactive ui-tab-trigger ui-terminal-tab-item mx-1 flex h-7 ${tabMinWidthClass} max-w-[180px] shrink-0 cursor-pointer items-center gap-2 rounded-lg px-3 text-[12px] font-medium`}
          data-terminal-tab-id={id}
          data-session-kind={sessionKind}
          data-selected={isActive ? "true" : "false"}
          onClick={() => {
            hideHoverCard();
            onActivate();
          }}
          onPointerEnter={scheduleHoverCard}
          onPointerLeave={scheduleHideHoverCard}
          onContextMenu={(event) => {
            hideHoverCard();
            contextMenuPointRef.current = { x: event.clientX, y: event.clientY };
          }}
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
          />
          {vendor && (
            <span className="ui-terminal-tab-vendor inline-flex shrink-0 items-center" aria-hidden="true">
              <VendorIcon vendor={vendor} size={14} />
            </span>
          )}
          {worktree && (
            <Popover open={worktreePopoverOpen} onOpenChange={setWorktreePopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="ui-worktree-tab-badge inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none"
                  title={`${worktree.name}\n${worktree.branch}\n${worktree.path}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    hideHoverCard();
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <WorktreeIcon className="h-3 w-3" />
                  <span>WT</span>
                </button>
              </PopoverTrigger>
              {worktreeMenuContent && (
                <PopoverContent
                  className="terminal-skin context-menu min-w-[160px] p-1"
                  style={menuStyle}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onPointerMove={(event) => event.stopPropagation()}
                  onPointerUp={(event) => event.stopPropagation()}
                >
                  {worktreeMenuContent(closeWorktreePopover)}
                </PopoverContent>
              )}
            </Popover>
          )}
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
              aria-label={t("terminal.tab.rename")}
            />
          ) : (
            <span className="ui-terminal-tab-title min-w-0 flex-1 truncate tracking-[0.01em]">{title}</span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); hideHoverCard(); onClose(e.currentTarget.getBoundingClientRect()); }}
            onPointerEnter={hideHoverCard}
            onPointerDown={(e) => { e.stopPropagation(); hideHoverCard(); }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="ui-terminal-tab-close ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-[background-color,color,opacity,box-shadow] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
            aria-label={t("terminal.tab.close", { title })}
            title={t("terminal.tab.close", { title })}
          >
            <X size={13} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className={menuClassName} style={menuStyle}>{menuContent(getTabAnchor)}</ContextMenuContent>
      </ContextMenu>
      {terminalTabHoverInfoEnabled && hoverCardPosition && !isEditing && !isDragging && (
        <Portal>
          <TerminalTabHoverCard info={hoverInfo} position={hoverCardPosition} onPointerEnter={keepHoverCardOpen} onPointerLeave={scheduleHideHoverCard} onCopySessionId={copySessionId} />
        </Portal>
      )}
    </>
  );
}

function TerminalTabHoverCard({
  info,
  position,
  onPointerEnter,
  onPointerLeave,
  onCopySessionId,
}: {
  info: TerminalTabHoverInfo;
  position: { left: number; top: number };
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onCopySessionId: () => void;
}) {
  const { t } = useI18n();
  const rows = [
    { label: "CLI", value: info.cli },
    { label: "Shell", value: info.shell },
    { label: t("termStats.project"), value: info.project },
    { label: t("termStats.path"), value: info.path },
  ];
  const sessionIdPreview = formatSessionIdPreview(info.sessionId);

  return (
    <div
      className="ui-terminal-tab-hover-card"
      style={{ left: position.left, top: position.top }}
      role="tooltip"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="ui-terminal-tab-hover-title">{info.name}</div>
      <div className="ui-terminal-tab-hover-rows">
        {rows.map((row) => (
          <div key={row.label} className="ui-terminal-tab-hover-row">
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
        <div className="ui-terminal-tab-hover-row ui-terminal-tab-hover-row-action">
          <span>Session ID</span>
          <strong>{sessionIdPreview}</strong>
          <button
            type="button"
            className="ui-terminal-tab-hover-copy"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onCopySessionId();
            }}
            aria-label={t("terminal.tab.copySessionId")}
            title={t("terminal.tab.copySessionId")}
          >
            <Copy size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
function SortableWorkspanTab({
  workspan,
  title,
  notification,
  vendor,
  isActive,
  dragDisabled,
  renameDisabled,
  onActivate,
  onClose,
  onRename,
}: {
  workspan: TerminalWorkspan;
  title: string;
  notification: TabNotificationState;
  vendor?: VendorKey | null;
  isActive: boolean;
  dragDisabled: boolean;
  renameDisabled: boolean;
  onActivate: () => void;
  onClose: (anchor: DOMRect) => void;
  onRename: (title: string) => void;
}) {
  const { t } = useI18n();
  const sortableId = `${WORKSPAN_DRAG_PREFIX}${workspan.id}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    disabled: dragDisabled,
    data: { type: "workspan", workspanId: workspan.id },
    transition: DND_SORTABLE_TRANSITION,
  });
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const horizontalTransform = transform ? { ...transform, y: 0 } : transform;
  const style: CSSProperties = {
    transform: isDragging ? undefined : CSS.Transform.toString(horizontalTransform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0.45 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  const sortableAttributes = { ...attributes, role: "tab" as const, "aria-selected": isActive };

  useEffect(() => {
    if (!editing) return;
    setEditValue(title);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [editing, title]);

  const submitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== title) onRename(trimmed);
    setEditing(false);
  }, [editValue, onRename, title]);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="ui-interactive ui-tab-trigger ui-terminal-tab-item ui-workspan-tab mx-1 flex h-7 min-w-[104px] max-w-[200px] shrink-0 cursor-pointer items-center gap-2 rounded-lg px-3 text-[12px] font-medium"
      data-workspan-id={workspan.id}
      data-selected={isActive ? "true" : "false"}
      onClick={onActivate}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!renameDisabled) setEditing(true);
      }}
      {...sortableAttributes}
      {...listeners}
    >
      <span
        className="ui-tab-runtime-dot h-2 w-2 shrink-0 rounded-full"
        data-pulsing={PULSING_TAB_STATES.has(notification) ? "true" : "false"}
        style={{ backgroundColor: TAB_NOTIFICATION_COLORS[notification], color: TAB_NOTIFICATION_COLORS[notification] }}
        aria-label={t(TAB_NOTIFICATION_LABELS[notification])}
        role="status"
      />
      {vendor ? (
        <span className="ui-terminal-tab-vendor inline-flex shrink-0 items-center" aria-hidden="true">
          <VendorIcon vendor={vendor} size={14} />
        </span>
      ) : (
        <Terminal size={14} strokeWidth={1.8} aria-hidden="true" />
      )}
      {editing ? (
        <input
          ref={inputRef}
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") submitRename();
            if (event.key === "Escape") setEditing(false);
          }}
          onBlur={submitRename}
          className="ui-input h-5 min-w-0 flex-1 rounded-md px-1.5 py-0 text-[12px] text-on-surface outline-none"
          aria-label={t("terminal.tab.rename")}
        />
      ) : (
        <span className="ui-terminal-tab-title min-w-0 flex-1 truncate tracking-[0.01em]">{title}</span>
      )}
      <button
        type="button"
        className="ui-terminal-tab-close ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-[background-color,color,opacity,box-shadow] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onClose(event.currentTarget.getBoundingClientRect());
        }}
        aria-label={t("terminal.workspan.close", { title })}
        title={t("terminal.workspan.close", { title })}
      >
        <X size={13} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>
  );
}

function DragOverlayTab({
  title,
  notification,
  vendor,
}: {
  title: string;
  notification: TabNotificationState;
  vendor?: VendorKey | null;
}) {
  const tabMinWidthClass = "min-w-[92px]";

  return (
    <div
      className={`ui-tab-trigger ui-terminal-tab-item ui-terminal-drag-overlay-tab mx-1 flex h-7 ${tabMinWidthClass} max-w-[180px] items-center gap-2 rounded-lg px-3 text-[12px] font-medium`}
      data-selected="true"
    >
      <span
        className="ui-tab-runtime-dot w-2 h-2 rounded-full shrink-0"
        data-pulsing={PULSING_TAB_STATES.has(notification) ? "true" : "false"}
        style={{ backgroundColor: TAB_NOTIFICATION_COLORS[notification], color: TAB_NOTIFICATION_COLORS[notification] }}
        aria-hidden="true"
      />
      {vendor && (
        <span className="ui-terminal-tab-vendor inline-flex shrink-0 items-center" aria-hidden="true">
          <VendorIcon vendor={vendor} size={14} />
        </span>
      )}
      <span className="ui-terminal-tab-title min-w-0 flex-1 truncate tracking-[0.01em]">{title}</span>
    </div>
  );
}

interface PaneTabBarProps {
  pane: TerminalPaneLeaf;
  sessions: TerminalSession[];
  visibleSessionIds?: Set<string> | null;
  projects: Project[];
  worktrees: WorktreeRecord[];
  allPanes: TerminalPaneLeaf[];
  activeSessionId: string | null;
  editingSessionId: string | null;
  tabNotifications: Record<string, TabNotificationState>;
  resolvedTheme: "dark" | "light";
  terminalThemeName: string;
  lightThemePalette: ReturnType<typeof useSettingsStore.getState>["lightThemePalette"];
  darkThemePalette: ReturnType<typeof useSettingsStore.getState>["darkThemePalette"];
  terminalBackgroundEnabled: boolean;
  terminalBackgroundImagePath: string | null;
  hiddenBackgroundSessionIds: Set<string>;
  isPaneFullscreen: boolean;
  onActivateSession: (sessionId: string) => void;
  onCloseSessions: (sessionIds: string[], anchor?: SplitPickerAnchor) => void;
  onStartEdit: (sessionId: string) => void;
  onSubmitEdit: (sessionId: string, title: string) => void;
  onCancelEdit: () => void;
  onNewTab: () => void;
  onDuplicateSession: (session: TerminalSession) => void;
  onOpenSplitPicker: (sessionId: string, direction: TerminalPaneSplitDirection, anchor?: SplitPickerAnchor) => void;
  onUnsplit: (sessionId: string) => void;
  onMoveToPane: (sessionId: string, paneId: string) => void;
  onHideBackground: (sessionId: string) => void;
  onShowBackground: (sessionId: string) => void;
  onTogglePaneFullscreen: (paneId: string) => void;
  onOpenWorktreeChanges: (sessionId: string) => void;
  onOpenWorktreeHistory: (project: Project, worktree: WorktreeRecord) => void;
  onFinishWorktree: (project: Project, worktree: WorktreeRecord) => void;
  onInstallWorktreeDeps: (project: Project, worktree: WorktreeRecord) => void;
  onDiscardWorktree: (project: Project, worktree: WorktreeRecord) => void;
  onOpenWorktreeDirectory: (worktree: WorktreeRecord) => void;
  variant?: "global" | "pane";
}

function PaneTabBar({
  pane,
  sessions,
  visibleSessionIds,
  projects,
  worktrees,
  allPanes,
  activeSessionId,
  editingSessionId,
  tabNotifications,
  terminalBackgroundEnabled,
  terminalBackgroundImagePath,
  hiddenBackgroundSessionIds,
  isPaneFullscreen,
  onActivateSession,
  onCloseSessions,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
  onNewTab,
  onDuplicateSession,
  onOpenSplitPicker,
  onUnsplit,
  onMoveToPane,
  onHideBackground,
  onShowBackground,
  onTogglePaneFullscreen,
  onOpenWorktreeChanges,
  onOpenWorktreeHistory,
  onFinishWorktree,
  onInstallWorktreeDeps,
  onDiscardWorktree,
  onOpenWorktreeDirectory,
  variant = "pane",
  resolvedTheme,
  terminalThemeName,
  lightThemePalette,
  darkThemePalette,
}: PaneTabBarProps) {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: `${PANE_DROP_PREFIX}${pane.id}` });
  const tabMenuTheme = getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
  const tabMenuForeground = normalizeTabMenuHex(tabMenuTheme.foreground, resolvedTheme === "dark" ? "#d8dee9" : "#1e293b");
  const tabMenuBackground = normalizeTabMenuHex(tabMenuTheme.background, resolvedTheme === "dark" ? "#0c0e10" : "#ffffff");
  const tabMenuStyle: CSSProperties = {
    "--menu-fg": tabMenuForeground,
    "--menu-bg": tabMenuBackground,
    "--menu-border": tabMenuHexToRgba(tabMenuForeground, 0.18, "rgba(255, 255, 255, 0.18)"),
    "--menu-hover": tabMenuHexToRgba(tabMenuForeground, 0.12, "rgba(255, 255, 255, 0.12)"),
  } as CSSProperties;
  const tabScrollRef = useRef<HTMLDivElement | null>(null);
  const tabScrollUpdateTimeoutRef = useRef<number | null>(null);
  const [tabListOpen, setTabListOpen] = useState(false);
  const [tabScrollState, setTabScrollState] = useState({
    isOverflowing: false,
    canScrollLeft: false,
    canScrollRight: false,
  });
  const projectById = useMemo(() => {
    const next = new Map<string, Project>();
    for (const project of projects) next.set(project.id, project);
    return next;
  }, [projects]);
  const worktreeById = useMemo(() => {
    const next = new Map<string, WorktreeRecord>();
    for (const worktree of worktrees) next.set(worktree.id, worktree);
    return next;
  }, [worktrees]);
  const paneSessions = pane.sessionIds
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session) => !visibleSessionIds || (session && visibleSessionIds.has(session.id)))
    .filter((session): session is TerminalSession => Boolean(session));
  const paneSessionIds = paneSessions.map((session) => session.id);
  const activePaneTabId =
    activeSessionId && paneSessionIds.includes(activeSessionId)
      ? activeSessionId
      : paneSessionIds[0] ?? null;
  const otherPanes = allPanes.filter((item) => item.id !== pane.id && item.sessionIds.length > 0);
  const paneFullscreenLabel = isPaneFullscreen
    ? t("terminal.toolbar.exitImmersiveFullscreen")
    : t("terminal.toolbar.enterImmersiveFullscreen");
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
    if (!element || !activePaneTabId) {
      updateTabScrollState();
      return;
    }

    const activeTab = Array.from(element.querySelectorAll<HTMLElement>("[data-terminal-tab-id]"))
      .find((node) => node.dataset.terminalTabId === activePaneTabId);
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
    const isLastTab = paneSessionIds[paneSessionIds.length - 1] === activePaneTabId;
    // 末尾标签吸附到最右，避免容器 padding / 标签 margin 残留导致右滚按钮仍可点
    const clampedScrollLeft = isLastTab
      ? maxScrollLeft
      : Math.min(maxScrollLeft, Math.max(0, nextScrollLeft));
    if (Math.abs(clampedScrollLeft - element.scrollLeft) > 0.5) {
      element.scrollTo({ left: clampedScrollLeft, behavior: "smooth" });
    }

    window.requestAnimationFrame(updateTabScrollState);
    if (tabScrollUpdateTimeoutRef.current !== null) window.clearTimeout(tabScrollUpdateTimeoutRef.current);
    tabScrollUpdateTimeoutRef.current = window.setTimeout(() => {
      tabScrollUpdateTimeoutRef.current = null;
      updateTabScrollState();
    }, 220);
  }, [activePaneTabId, pane.id, paneSessionIds, updateTabScrollState]);

  const activatePaneSessionAt = useCallback((index: number) => {
    const session = paneSessions[index];
    if (!session) return;
    onActivateSession(session.id);
  }, [onActivateSession, paneSessions]);

  const closePaneSessions = useCallback((sessionIds: string[], anchor?: SplitPickerAnchor) => {
    onCloseSessions(sessionIds, anchor);
  }, [onCloseSessions]);

  const closeOtherPaneSessions = useCallback((sessionId: string, anchor?: SplitPickerAnchor) => {
    const index = paneSessionIds.indexOf(sessionId);
    if (index < 0) return;
    closePaneSessions(paneSessionIds.filter((id) => id !== sessionId), anchor);
  }, [closePaneSessions, paneSessionIds]);

  const closePaneSessionsToLeft = useCallback((sessionId: string, anchor?: SplitPickerAnchor) => {
    const index = paneSessionIds.indexOf(sessionId);
    if (index <= 0) return;
    closePaneSessions(paneSessionIds.slice(0, index), anchor);
  }, [closePaneSessions, paneSessionIds]);

  const closePaneSessionsToRight = useCallback((sessionId: string, anchor?: SplitPickerAnchor) => {
    const index = paneSessionIds.indexOf(sessionId);
    if (index < 0) return;
    closePaneSessions(paneSessionIds.slice(index + 1), anchor);
  }, [closePaneSessions, paneSessionIds]);

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

    const handleWheel = (wheelEvent: WheelEvent) => {
      const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
      if (maxScrollLeft <= 0) return;
      // 取绝对值较大的轴：触控板横向滚动用 deltaX，鼠标滚轮用 deltaY
      const delta = Math.abs(wheelEvent.deltaX) >= Math.abs(wheelEvent.deltaY)
        ? wheelEvent.deltaX
        : wheelEvent.deltaY;
      if (delta === 0) return;
      wheelEvent.preventDefault();
      element.scrollLeft += delta;
      scheduleUpdate();
    };

    element.addEventListener("scroll", scheduleUpdate, { passive: true });
    element.addEventListener("wheel", handleWheel, { passive: false });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    observer?.observe(element);

    return () => {
      element.removeEventListener("scroll", scheduleUpdate);
      element.removeEventListener("wheel", handleWheel);
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
  }, [activePaneTabId, paneSessionIds.length, scrollActivePaneTabIntoView]);

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
          aria-label={t("terminal.tab.scrollLeft")}
          title={t("terminal.tab.scrollLeft")}
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
        <SortableContext items={paneSessionIds} strategy={horizontalListSortingStrategy}>
          {paneSessions.map((session) => (
            <SortableTab
              key={session.id}
              id={session.id}
              paneId={pane.id}
              title={session.title}
              sessionKind={session.kind}
              isActive={session.id === activeSessionId}
              isEditing={editingSessionId === session.id}
              notification={tabNotifications[session.id] ?? "none"}
              vendor={inferSessionVendor(session)}
              worktree={session.worktreeId ? worktreeById.get(session.worktreeId) ?? null : null}
              worktreeMenuContent={session.worktreeId && worktreeById.get(session.worktreeId) && session.projectId && projectById.get(session.projectId) ? (closeMenu) => {
                const project = projectById.get(session.projectId!);
                const activeWorktree = worktreeById.get(session.worktreeId!);
                if (!project || !activeWorktree) return null;
                const runAndClose = (action: () => void) => {
                  closeMenu();
                  action();
                };
                return (
                  <>
                    <button type="button" className="context-menu-item w-full" onClick={() => runAndClose(() => onOpenWorktreeChanges(session.id))}>{t("worktree.menu.viewChanges")}</button>
                    <button type="button" className="context-menu-item w-full" onClick={() => runAndClose(() => onOpenWorktreeHistory(project, activeWorktree))}>{t("worktree.menu.viewHistory")}</button>
                    <button type="button" className="context-menu-item w-full" onClick={() => runAndClose(() => onFinishWorktree(project, activeWorktree))}>{t("worktree.menu.finish")}</button>
                    <button type="button" className="context-menu-item w-full" onClick={() => runAndClose(() => onInstallWorktreeDeps(project, activeWorktree))}>{t("worktree.menu.installDeps")}</button>
                    <button type="button" className="context-menu-item w-full" onClick={() => runAndClose(() => onOpenWorktreeDirectory(activeWorktree))}>{t("worktree.menu.openDirectory")}</button>
                    <button type="button" className="context-menu-item danger w-full" onClick={() => runAndClose(() => onDiscardWorktree(project, activeWorktree))}>{t("worktree.menu.discard")}</button>
                  </>
                );
              } : undefined}
              hoverInfo={buildTerminalTabHoverInfo(session, session.projectId ? projectById.get(session.projectId) : undefined)}
              onActivate={() => onActivateSession(session.id)}
              onClose={(anchor) => closePaneSessions([session.id], anchor)}
              onSubmitEdit={(title) => onSubmitEdit(session.id, title)}
              onCancelEdit={onCancelEdit}
              menuClassName="terminal-skin"
              menuStyle={tabMenuStyle}
              menuContent={(getAnchor) => (
                <>
                  <ContextMenuItem onSelect={() => closePaneSessions([session.id], getAnchor())}>{t("terminal.tab.closeCurrent")}</ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => {
                      // Radix 会在菜单关闭后恢复焦点；延后一拍进入编辑态，避免输入框刚挂载就被 blur 提交掉。
                      window.setTimeout(() => onStartEdit(session.id), 0);
                    }}
                  >
                    {t("terminal.tab.rename")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => closeOtherPaneSessions(session.id, getAnchor())}>{t("terminal.tab.closeOthers")}</ContextMenuItem>
                  <ContextMenuItem onSelect={() => closePaneSessionsToLeft(session.id, getAnchor())}>{t("terminal.tab.closeLeft")}</ContextMenuItem>
                  <ContextMenuItem onSelect={() => closePaneSessionsToRight(session.id, getAnchor())}>{t("terminal.tab.closeRight")}</ContextMenuItem>
                  <ContextMenuItem onSelect={onNewTab}>{t("terminal.toolbar.newTerminal")}</ContextMenuItem>
                  <ContextMenuItem onSelect={() => onDuplicateSession(session)}>{t("terminal.tab.duplicate")}</ContextMenuItem>
                  {terminalBackgroundEnabled && terminalBackgroundImagePath && (
                    hiddenBackgroundSessionIds.has(session.id) ? (
                      <ContextMenuItem onSelect={() => onShowBackground(session.id)}>{t("terminal.tab.showBackground")}</ContextMenuItem>
                    ) : (
                      <ContextMenuItem onSelect={() => onHideBackground(session.id)}>{t("terminal.tab.hideBackground")}</ContextMenuItem>
                    )
                  )}
                  {session.worktreeId && worktreeById.get(session.worktreeId) && session.projectId && projectById.get(session.projectId) && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => onOpenWorktreeChanges(session.id)}>{t("worktree.menu.viewChanges")}</ContextMenuItem>
                      <ContextMenuItem onSelect={() => onOpenWorktreeHistory(projectById.get(session.projectId!)!, worktreeById.get(session.worktreeId!)!)}>{t("worktree.menu.viewHistory")}</ContextMenuItem>
                      <ContextMenuItem onSelect={() => onFinishWorktree(projectById.get(session.projectId!)!, worktreeById.get(session.worktreeId!)!)}>{t("worktree.menu.finish")}</ContextMenuItem>
                      <ContextMenuItem onSelect={() => onInstallWorktreeDeps(projectById.get(session.projectId!)!, worktreeById.get(session.worktreeId!)!)}>{t("worktree.menu.installDeps")}</ContextMenuItem>
                      <ContextMenuItem onSelect={() => onOpenWorktreeDirectory(worktreeById.get(session.worktreeId!)!)}>{t("worktree.menu.openDirectory")}</ContextMenuItem>
                      <ContextMenuItem onSelect={() => onDiscardWorktree(projectById.get(session.projectId!)!, worktreeById.get(session.worktreeId!)!)}>{t("worktree.menu.discard")}</ContextMenuItem>
                    </>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => onOpenSplitPicker(session.id, "horizontal", getAnchor())}>
                    {t("terminal.tab.splitRight")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onOpenSplitPicker(session.id, "vertical", getAnchor())}>
                    {t("terminal.tab.splitDown")}
                  </ContextMenuItem>
                  {allPanes.length > 1 && <ContextMenuItem onSelect={() => onUnsplit(session.id)}>{t("terminal.tab.unsplit")}</ContextMenuItem>}
                  {otherPanes.length > 0 && (
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>{t("terminal.tab.moveToPane")}</ContextMenuSubTrigger>
                      <ContextMenuSubContent className="terminal-skin" style={tabMenuStyle}>
                        {otherPanes.map((targetPane, index) => (
                          <ContextMenuItem key={targetPane.id} onSelect={() => onMoveToPane(session.id, targetPane.id)}>
                            {t("terminal.tab.paneName", { index: index + 1 })}
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
            aria-label={t("terminal.tab.scrollRight")}
            title={t("terminal.tab.scrollRight")}
          >
            <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <Popover open={tabListOpen && tabScrollState.isOverflowing} onOpenChange={setTabListOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="ui-terminal-tab-list-button"
                aria-label={t("terminal.tab.openList")}
                aria-expanded={tabListOpen && tabScrollState.isOverflowing}
                title={t("terminal.tab.list")}
              >
                <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="terminal-skin ui-terminal-tab-list-popover w-64 p-1.5"
              style={tabMenuStyle}
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <div className="ui-terminal-tab-list-title px-2 py-1 text-[11px] font-semibold">{t("terminal.tab.tabs")}</div>
              <div className="max-h-72 overflow-y-auto">
                {paneSessions.map((session, index) => {
                  const notification = tabNotifications[session.id] ?? "none";
                  return (
                    <button
                      key={session.id}
                      type="button"
                      className="ui-interactive ui-terminal-tab-list-item flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-on-surface-variant"
                      data-selected={session.id === pane.activeSessionId ? "true" : "false"}
                      onClick={() => {
                        activatePaneSessionAt(index);
                        setTabListOpen(false);
                      }}
                      title={session.title}
                    >
                      <span
                        className="ui-tab-runtime-dot h-2 w-2 shrink-0 rounded-full"
                        data-pulsing={PULSING_TAB_STATES.has(notification) ? "true" : "false"}
                        style={{ backgroundColor: TAB_NOTIFICATION_COLORS[notification], color: TAB_NOTIFICATION_COLORS[notification] }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{session.title}</span>
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        </>
      )}
      {variant === "pane" && allPanes.length > 1 && (
        <div className="ui-terminal-actions flex shrink-0 items-center">
          <button
            type="button"
            className="ui-focus-ring ui-icon-action ui-action-fullscreen"
            data-active={isPaneFullscreen ? "true" : "false"}
            onClick={() => onTogglePaneFullscreen(pane.id)}
            title={paneFullscreenLabel}
            aria-label={paneFullscreenLabel}
            aria-pressed={isPaneFullscreen}
          >
            {isPaneFullscreen ? <Minimize2 size={14} strokeWidth={1.8} /> : <Maximize2 size={14} strokeWidth={1.8} />}
          </button>
        </div>
      )}
    </div>
  );
}

interface PaneLeafViewProps {
  pane: TerminalPaneLeaf;
  sessions: TerminalSession[];
  visibleSessionIds?: Set<string> | null;
  projects: Project[];
  worktrees: WorktreeRecord[];
  allPanes: TerminalPaneLeaf[];
  activeSessionId: string | null;
  historyActive: boolean;
  editingSessionId: string | null;
  tabNotifications: Record<string, TabNotificationState>;
  fontSize: number;
  fontFamily: string;
  resolvedTheme: "dark" | "light";
  terminalThemeName: string;
  terminalThemeBackground: string;
  lightThemePalette: ReturnType<typeof useSettingsStore.getState>["lightThemePalette"];
  darkThemePalette: ReturnType<typeof useSettingsStore.getState>["darkThemePalette"];
  terminalBackgroundEnabled: boolean;
  terminalBackgroundImagePath: string | null;
  hiddenBackgroundSessionIds: Set<string>;
  isPaneFullscreen: boolean;
  isLayoutVisible: boolean;
  activeDropPreview?: PaneDropPreview;
  onActivateSession: (sessionId: string) => void;
  onCloseSessions: (sessionIds: string[], anchor?: SplitPickerAnchor) => void;
  onStartEdit: (sessionId: string) => void;
  onSubmitEdit: (sessionId: string, title: string) => void;
  onCancelEdit: () => void;
  onNewTab: () => void;
  onDuplicateSession: (session: TerminalSession) => void;
  onOpenSplitPicker: (sessionId: string, direction: TerminalPaneSplitDirection, anchor?: SplitPickerAnchor) => void;
  onUnsplit: (sessionId: string) => void;
  onMoveToPane: (sessionId: string, paneId: string) => void;
  onHideBackground: (sessionId: string) => void;
  onShowBackground: (sessionId: string) => void;
  onTogglePaneFullscreen: (paneId: string) => void;
  onOpenWorktreeChanges: (sessionId: string) => void;
  onOpenWorktreeHistory: (project: Project, worktree: WorktreeRecord) => void;
  onFinishWorktree: (project: Project, worktree: WorktreeRecord) => void;
  onInstallWorktreeDeps: (project: Project, worktree: WorktreeRecord) => void;
  onDiscardWorktree: (project: Project, worktree: WorktreeRecord) => void;
  onOpenWorktreeDirectory: (worktree: WorktreeRecord) => void;
  hideTabBar?: boolean;
}

function PaneLeafView({
  pane,
  sessions,
  visibleSessionIds,
  projects,
  worktrees,
  allPanes,
  activeSessionId,
  historyActive,
  editingSessionId,
  tabNotifications,
  fontSize,
  fontFamily,
  resolvedTheme,
  terminalThemeName,
  terminalThemeBackground,
  lightThemePalette,
  darkThemePalette,
  terminalBackgroundEnabled,
  terminalBackgroundImagePath,
  hiddenBackgroundSessionIds,
  isPaneFullscreen,
  isLayoutVisible,
  activeDropPreview,
  onActivateSession,
  onCloseSessions,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
  onNewTab,
  onDuplicateSession,
  onOpenSplitPicker,
  onUnsplit,
  onMoveToPane,
  onHideBackground,
  onShowBackground,
  onTogglePaneFullscreen,
  onOpenWorktreeChanges,
  onOpenWorktreeHistory,
  onFinishWorktree,
  onInstallWorktreeDeps,
  onDiscardWorktree,
  onOpenWorktreeDirectory,
  hideTabBar = false,
}: PaneLeafViewProps) {
  const paneSessions = pane.sessionIds
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is TerminalSession => Boolean(session));
  const visiblePaneSessionIds = visibleSessionIds
    ? pane.sessionIds.filter((id) => visibleSessionIds.has(id))
    : pane.sessionIds;
  const effectivePaneActiveSessionId =
    pane.activeSessionId && visiblePaneSessionIds.includes(pane.activeSessionId)
      ? pane.activeSessionId
      : visiblePaneSessionIds[0] ?? null;

  return (
    <div className="ui-terminal-pane flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {!hideTabBar && (
        <PaneTabBar
          pane={pane}
          sessions={sessions}
          visibleSessionIds={visibleSessionIds}
          projects={projects}
          worktrees={worktrees}
          allPanes={allPanes}
          activeSessionId={activeSessionId}
          editingSessionId={editingSessionId}
          tabNotifications={tabNotifications}
          terminalBackgroundEnabled={terminalBackgroundEnabled}
          terminalBackgroundImagePath={terminalBackgroundImagePath}
          hiddenBackgroundSessionIds={hiddenBackgroundSessionIds}
          isPaneFullscreen={isPaneFullscreen}
          onActivateSession={onActivateSession}
          onCloseSessions={onCloseSessions}
          onStartEdit={onStartEdit}
          onSubmitEdit={onSubmitEdit}
          onCancelEdit={onCancelEdit}
          onNewTab={onNewTab}
          onDuplicateSession={onDuplicateSession}
          onOpenSplitPicker={onOpenSplitPicker}
          onUnsplit={onUnsplit}
          onMoveToPane={onMoveToPane}
          onHideBackground={onHideBackground}
          onShowBackground={onShowBackground}
          onTogglePaneFullscreen={onTogglePaneFullscreen}
          onOpenWorktreeChanges={onOpenWorktreeChanges}
          onOpenWorktreeHistory={onOpenWorktreeHistory}
          onFinishWorktree={onFinishWorktree}
          onInstallWorktreeDeps={onInstallWorktreeDeps}
          onDiscardWorktree={onDiscardWorktree}
          onOpenWorktreeDirectory={onOpenWorktreeDirectory}
          resolvedTheme={resolvedTheme}
          terminalThemeName={terminalThemeName}
          lightThemePalette={lightThemePalette}
          darkThemePalette={darkThemePalette}
        />
      )}
      <div
        className="ui-terminal-pane-content relative min-h-0 flex-1 overflow-hidden"
        onMouseDownCapture={() => {
          if (effectivePaneActiveSessionId && effectivePaneActiveSessionId !== activeSessionId) {
            onActivateSession(effectivePaneActiveSessionId);
          }
        }}
      >
        {paneSessions.map((session) => (
          <div
            key={session.id}
            className="absolute inset-0"
            style={{ display: session.id === effectivePaneActiveSessionId ? "block" : "none" }}
          >
            {session.kind === "file-editor" ? (
              <FileEditorPane
                session={session}
                isActive={session.id === activeSessionId}
                terminalThemeBackground={terminalThemeBackground}
                onClose={() => onCloseSessions([session.id])}
              />
            ) : session.kind === "subagent-transcript" ? (
              <SubagentTranscriptView
                sessionId={session.id}
                title={session.title}
                isVisible={!historyActive && isLayoutVisible && session.id === effectivePaneActiveSessionId}
              />
            ) : (
              <XTermTerminal
                sessionId={session.id}
                isActive={!historyActive && session.id === activeSessionId}
                isVisible={!historyActive && isLayoutVisible && session.id === effectivePaneActiveSessionId}
                fontSize={fontSize}
                fontFamily={fontFamily}
                resolvedTheme={resolvedTheme}
                terminalThemeName={terminalThemeName}
                lightThemePalette={lightThemePalette}
                darkThemePalette={darkThemePalette}
                onNewTab={onNewTab}
                onCloseSession={() => onCloseSessions([session.id])}
                onCloseOthers={
                  visiblePaneSessionIds.length > 1
                    ? () => onCloseSessions(visiblePaneSessionIds.filter((id) => id !== session.id))
                    : undefined
                }
                onCloseToLeft={
                  visiblePaneSessionIds.indexOf(session.id) > 0
                    ? () => onCloseSessions(visiblePaneSessionIds.slice(0, visiblePaneSessionIds.indexOf(session.id)))
                    : undefined
                }
                onCloseToRight={
                  visiblePaneSessionIds.indexOf(session.id) < visiblePaneSessionIds.length - 1
                    ? () => onCloseSessions(visiblePaneSessionIds.slice(visiblePaneSessionIds.indexOf(session.id) + 1))
                    : undefined
                }
                onSplitRight={(point) => onOpenSplitPicker(session.id, "horizontal", point)}
                onSplitDown={(point) => onOpenSplitPicker(session.id, "vertical", point)}
              />
            )}
          </div>
        ))}
        <PaneContentDropZones
          paneId={pane.id}
          enabled={isLayoutVisible}
          activeDropPreview={activeDropPreview}
        />
      </div>
    </div>
  );
}

function areSessionIdListsEqual(prevIds: string[], nextIds: string[]): boolean {
  if (prevIds.length !== nextIds.length) return false;
  for (let index = 0; index < prevIds.length; index += 1) {
    if (prevIds[index] !== nextIds[index]) return false;
  }
  return true;
}

function findSessionById(sessions: TerminalSession[], sessionId: string): TerminalSession | undefined {
  return sessions.find((session) => session.id === sessionId);
}

function findProjectById(projects: Project[], projectId: string | null | undefined): Project | undefined {
  if (!projectId) return undefined;
  return projects.find((project) => project.id === projectId);
}

function paneContainsSessionId(pane: TerminalPaneLeaf, sessionId: string | null): boolean {
  return sessionId ? pane.sessionIds.includes(sessionId) : false;
}

function didPaneSessionsChange(prevProps: PaneLeafViewProps, nextProps: PaneLeafViewProps): boolean {
  for (const sessionId of nextProps.pane.sessionIds) {
    if (findSessionById(prevProps.sessions, sessionId) !== findSessionById(nextProps.sessions, sessionId)) {
      return true;
    }
  }
  return false;
}

function didPaneProjectsChange(prevProps: PaneLeafViewProps, nextProps: PaneLeafViewProps): boolean {
  for (const sessionId of nextProps.pane.sessionIds) {
    const nextSession = findSessionById(nextProps.sessions, sessionId);
    const projectId = nextSession?.projectId;
    if (findProjectById(prevProps.projects, projectId) !== findProjectById(nextProps.projects, projectId)) {
      return true;
    }
  }
  return false;
}

function didPaneNotificationsChange(
  prevNotifications: Record<string, TabNotificationState>,
  nextNotifications: Record<string, TabNotificationState>,
  sessionIds: string[]
): boolean {
  for (const sessionId of sessionIds) {
    if ((prevNotifications[sessionId] ?? "none") !== (nextNotifications[sessionId] ?? "none")) {
      return true;
    }
  }
  return false;
}

function didPaneHiddenBackgroundChange(prevHidden: Set<string>, nextHidden: Set<string>, sessionIds: string[]): boolean {
  for (const sessionId of sessionIds) {
    if (prevHidden.has(sessionId) !== nextHidden.has(sessionId)) {
      return true;
    }
  }
  return false;
}

function areSessionIdSetsEqual(prev?: Set<string> | null, next?: Set<string> | null): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.size !== next.size) return false;
  for (const id of prev) {
    if (!next.has(id)) return false;
  }
  return true;
}

function getPaneSiblingsSignature(panes: TerminalPaneLeaf[]): string {
  return panes.map((pane) => `${pane.id}:${pane.sessionIds.length}`).join("|");
}

function arePaneLeafViewPropsEqual(prevProps: PaneLeafViewProps, nextProps: PaneLeafViewProps): boolean {
  if (prevProps.pane.id !== nextProps.pane.id) return false;
  if (!areSessionIdListsEqual(prevProps.pane.sessionIds, nextProps.pane.sessionIds)) return false;
  if (prevProps.pane.activeSessionId !== nextProps.pane.activeSessionId) return false;
  if (prevProps.historyActive !== nextProps.historyActive) return false;
  if (prevProps.isPaneFullscreen !== nextProps.isPaneFullscreen) return false;
  if (prevProps.isLayoutVisible !== nextProps.isLayoutVisible) return false;
  if (prevProps.fontSize !== nextProps.fontSize || prevProps.fontFamily !== nextProps.fontFamily) return false;
  if (prevProps.resolvedTheme !== nextProps.resolvedTheme) return false;
  if (prevProps.terminalThemeName !== nextProps.terminalThemeName) return false;
  if (prevProps.terminalThemeBackground !== nextProps.terminalThemeBackground) return false;
  if (prevProps.lightThemePalette !== nextProps.lightThemePalette) return false;
  if (prevProps.darkThemePalette !== nextProps.darkThemePalette) return false;
  if (prevProps.terminalBackgroundEnabled !== nextProps.terminalBackgroundEnabled) return false;
  if (prevProps.terminalBackgroundImagePath !== nextProps.terminalBackgroundImagePath) return false;
  if (prevProps.hideTabBar !== nextProps.hideTabBar) return false;
  if (!areSessionIdSetsEqual(prevProps.visibleSessionIds, nextProps.visibleSessionIds)) return false;
  if (getPaneSiblingsSignature(prevProps.allPanes) !== getPaneSiblingsSignature(nextProps.allPanes)) return false;
  if ((prevProps.activeDropPreview?.paneId ?? null) !== (nextProps.activeDropPreview?.paneId ?? null)) return false;
  if ((prevProps.activeDropPreview?.edge ?? null) !== (nextProps.activeDropPreview?.edge ?? null)) return false;

  const wasEditingThisPane = paneContainsSessionId(prevProps.pane, prevProps.editingSessionId);
  const isEditingThisPane = paneContainsSessionId(nextProps.pane, nextProps.editingSessionId);
  if (wasEditingThisPane !== isEditingThisPane) return false;
  if (wasEditingThisPane && prevProps.editingSessionId !== nextProps.editingSessionId) return false;

  const wasActiveInThisPane = paneContainsSessionId(prevProps.pane, prevProps.activeSessionId);
  const isActiveInThisPane = paneContainsSessionId(nextProps.pane, nextProps.activeSessionId);
  if (wasActiveInThisPane !== isActiveInThisPane) return false;
  if (wasActiveInThisPane && prevProps.activeSessionId !== nextProps.activeSessionId) return false;

  if (didPaneSessionsChange(prevProps, nextProps)) return false;
  if (didPaneProjectsChange(prevProps, nextProps)) return false;
  if (prevProps.worktrees !== nextProps.worktrees) return false;
  if (didPaneNotificationsChange(prevProps.tabNotifications, nextProps.tabNotifications, nextProps.pane.sessionIds)) return false;
  if (didPaneHiddenBackgroundChange(prevProps.hiddenBackgroundSessionIds, nextProps.hiddenBackgroundSessionIds, nextProps.pane.sessionIds)) return false;

  return (
    prevProps.onActivateSession === nextProps.onActivateSession &&
    prevProps.onCloseSessions === nextProps.onCloseSessions &&
    prevProps.onStartEdit === nextProps.onStartEdit &&
    prevProps.onSubmitEdit === nextProps.onSubmitEdit &&
    prevProps.onCancelEdit === nextProps.onCancelEdit &&
    prevProps.onNewTab === nextProps.onNewTab &&
    prevProps.onDuplicateSession === nextProps.onDuplicateSession &&
    prevProps.onOpenSplitPicker === nextProps.onOpenSplitPicker &&
    prevProps.onUnsplit === nextProps.onUnsplit &&
    prevProps.onMoveToPane === nextProps.onMoveToPane &&
    prevProps.onHideBackground === nextProps.onHideBackground &&
    prevProps.onShowBackground === nextProps.onShowBackground &&
    prevProps.onTogglePaneFullscreen === nextProps.onTogglePaneFullscreen &&
    prevProps.onOpenWorktreeChanges === nextProps.onOpenWorktreeChanges &&
    prevProps.onOpenWorktreeHistory === nextProps.onOpenWorktreeHistory &&
    prevProps.onFinishWorktree === nextProps.onFinishWorktree &&
    prevProps.onInstallWorktreeDeps === nextProps.onInstallWorktreeDeps &&
    prevProps.onDiscardWorktree === nextProps.onDiscardWorktree &&
    prevProps.onOpenWorktreeDirectory === nextProps.onOpenWorktreeDirectory
  );
}

const MemoPaneLeafView = memo(PaneLeafView, arePaneLeafViewPropsEqual);

function PaneContentDropZones({
  paneId,
  enabled,
  activeDropPreview,
}: {
  paneId: string;
  enabled: boolean;
  activeDropPreview?: PaneDropPreview;
}) {
  const centerDrop = useDroppable({ id: `${PANE_CENTER_DROP_PREFIX}${paneId}`, disabled: !enabled });
  const leftDrop = useDroppable({ id: `${PANE_EDGE_DROP_PREFIX}${paneId}:left`, disabled: !enabled });
  const rightDrop = useDroppable({ id: `${PANE_EDGE_DROP_PREFIX}${paneId}:right`, disabled: !enabled });
  const topDrop = useDroppable({ id: `${PANE_EDGE_DROP_PREFIX}${paneId}:top`, disabled: !enabled });
  const bottomDrop = useDroppable({ id: `${PANE_EDGE_DROP_PREFIX}${paneId}:bottom`, disabled: !enabled });
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
  tree: TreeNode[];
  menuStyle: CSSProperties;
  onSelectEmpty: () => void;
  onSelectProject: (project: Project) => void;
  onClose: () => void;
  shouldIgnoreOutsideInteraction: () => boolean;
}

function SplitProjectPicker({ picker, tree, menuStyle, onSelectEmpty, onSelectProject, onClose, shouldIgnoreOutsideInteraction }: SplitProjectPickerProps) {
  const { t } = useI18n();
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const renderTreeNode = useCallback((node: TreeNode, depth: number): ReactNode => {
    if (node.type === "project") {
      const project = node.project;
      const cliVendor = project.cli_tool ? inferVendor(project.cli_tool) : null;
      return (
        <button
          key={`p:${project.id}`}
          type="button"
          onClick={() => onSelectProject(project)}
          className="ui-tree-node ui-tree-project ui-split-project-picker-item ui-focus-ring flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[13px]"
          style={{ paddingLeft: 10 + depth * 16 }}
          title={project.path}
        >
          <span className="ui-tree-leading-icon">
            {cliVendor ? (
              <VendorIcon vendor={cliVendor} size={14} />
            ) : (
              <Terminal size={14} strokeWidth={1.5} />
            )}
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="block min-w-0 truncate font-medium">{project.name}</span>
            {project.cli_tool && (
              <span className="ui-tree-meta-chip ui-split-project-picker-chip inline-flex max-w-24 shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-tight">
                <span className="min-w-0 truncate">{project.cli_tool}</span>
              </span>
            )}
          </span>
        </button>
      );
    }

    if (node.type === "worktree") {
      return null;
    }

    const group = node.group;
    const isOpen = !collapsedGroupIds.has(group.id);
    return (
      <div key={`g:${group.id}`}>
        <button
          type="button"
          onClick={() => toggleGroup(group.id)}
          className="ui-tree-node ui-tree-group ui-split-project-picker-item ui-focus-ring flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[13px] font-semibold"
          style={{ paddingLeft: 10 + depth * 16 }}
        >
          <span className="ui-tree-chevron inline-flex items-center justify-center">
            <ChevronRight size={12} strokeWidth={2} style={{ transition: "transform 150ms", transform: isOpen ? "rotate(90deg)" : "rotate(0)" }} />
          </span>
          <span className="ui-tree-leading-icon"><Folder size={16} strokeWidth={1.5} /></span>
          <span className="flex-1 truncate">{group.name}</span>
        </button>
        {isOpen && node.children.length > 0 && (
          <div className="space-y-0.5">
            {node.children.map((child) => renderTreeNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }, [collapsedGroupIds, onSelectProject, toggleGroup]);

  const anchorStyle: CSSProperties = picker
    ? { position: "fixed", left: picker.x, top: picker.y, width: 1, height: 1 }
    : { position: "fixed", left: 0, top: 0, width: 1, height: 1 };

  return (
    <Popover open={picker !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <PopoverAnchor asChild>
        <span className="pointer-events-none" style={anchorStyle} aria-hidden="true" />
      </PopoverAnchor>
      <PopoverContent
        align={picker?.align ?? "start"}
        className="ui-split-project-picker w-80 p-2"
        style={menuStyle}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (shouldIgnoreOutsideInteraction()) event.preventDefault();
        }}
      >
        <div className="ui-split-project-picker-title px-2 py-1 text-xs font-semibold">{t("terminal.split.selectTerminal")}</div>
        <button
          type="button"
          onClick={onSelectEmpty}
          className="ui-tree-node ui-tree-project ui-split-project-picker-item ui-focus-ring mt-1 flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[13px]"
        >
          <span className="ui-tree-leading-icon"><Terminal size={14} strokeWidth={1.5} /></span>
          <span className="min-w-0 flex-1 truncate font-medium">{t("terminal.tab.emptyTerminal")}</span>
        </button>
        <div className="mt-1 max-h-72 space-y-0.5 overflow-y-auto">
          {tree.map((node) => renderTreeNode(node, 0))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TerminalCloseConfirmBubble({
  confirm,
  menuStyle,
  onConfirm,
  onClose,
  shouldIgnoreOutsideInteraction,
}: {
  confirm: TerminalCloseConfirmState;
  menuStyle: CSSProperties;
  onConfirm: () => void;
  onClose: () => void;
  shouldIgnoreOutsideInteraction: () => boolean;
}) {
  const { t } = useI18n();
  const anchorStyle: CSSProperties = confirm
    ? { position: "fixed", left: confirm.x, top: confirm.y, width: 1, height: 1 }
    : { position: "fixed", left: 0, top: 0, width: 1, height: 1 };

  return (
    <Popover open={confirm !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <PopoverAnchor asChild>
        <span className="pointer-events-none" style={anchorStyle} aria-hidden="true" />
      </PopoverAnchor>
      <PopoverContent
        align={confirm?.align ?? "end"}
        className="terminal-skin w-auto p-1.5"
        style={menuStyle}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (shouldIgnoreOutsideInteraction()) event.preventDefault();
        }}
      >
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onClose} aria-label={t("terminal.close.cancel")} title={t("terminal.close.cancel")}>
            <X size={13} strokeWidth={2.2} aria-hidden="true" />
          </Button>
          <Button
            size="sm"
            variant="destructive"
            className="h-6 px-1.5 text-[11px]"
            onClick={onConfirm}
            aria-label={t("terminal.close.confirm")}
            title={t("terminal.close.confirm")}
          >
            <Check size={12} strokeWidth={2.2} aria-hidden="true" />
            <span>{t("common.close")}</span>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SortableToolbarButton({
  id,
  isDragging,
  children,
}: {
  id: string;
  isDragging: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id,
    transition: DND_SORTABLE_TRANSITION,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0.4 : 1,
    cursor: "grab",
  };

  return (
    <div ref={setNodeRef} style={style} className="ui-terminal-action-sort-item flex w-full justify-center" {...attributes} {...listeners}>
      {children}
    </div>
  );
}

function CpuCatIndicator({
  enabled,
  active,
  onClick,
}: {
  enabled: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const cpuOnlyOptions = useMemo(() => ({ fullDetail: false, system: false, cpu: true, memory: false }), []);
  const { snapshot } = useSystemResources(enabled, cpuOnlyOptions, 3000);
  if (!enabled) return null;

  const usage = snapshot ? Math.max(0, Math.min(100, snapshot.cpu.usagePercent)) : 0;
  // 速度按跑动频率线性映射（0%≈1.67s/圈 → 100%≈0.31s/圈），日常低占用区间的变速才肉眼可辨
  const speed = `${(1 / (0.6 + 2.6 * (usage / 100))).toFixed(2)}s`;
  const color =
    usage >= 75
      ? "var(--term-panel-red, #f25e5e)"
      : usage >= 45
        ? "var(--term-panel-yellow, #e5c453)"
        : "var(--term-panel-green, #3dd68c)";
  const label = t("systemResources.cpuCatTitle", { usage: `${usage.toFixed(0)}%` });

  return (
    <button
      type="button"
      className="ui-focus-ring ui-cpu-cat"
      data-active={active ? "true" : "false"}
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{ "--cpu-cat-speed": speed, "--cpu-cat-color": color } as CSSProperties}
    >
      <svg viewBox="0 0 48 34" aria-hidden="true">
        <g className="ui-cpu-cat-run">
          <path className="ui-cpu-cat-tail" d="M37 18c6-1 7-8 2-10" />
          <path className="ui-cpu-cat-body" d="M13 14h19c4 0 7 3 7 7v1c0 3-3 5-6 5H14c-4 0-7-3-7-7s3-6 6-6Z" />
          <path className="ui-cpu-cat-head" d="M10 9 14 3l4 6h7l4-6 4 6v11H10V9Z" />
          <circle className="ui-cpu-cat-eye" cx="17" cy="13" r="1.3" />
          <circle className="ui-cpu-cat-eye" cx="26" cy="13" r="1.3" />
          <path className="ui-cpu-cat-leg ui-cpu-cat-leg-a" d="M16 27v5" />
          <path className="ui-cpu-cat-leg ui-cpu-cat-leg-b" d="M29 27v5" />
        </g>
      </svg>
    </button>
  );
}

interface TerminalTabsProps {
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  projectScopedTerminalViewEnabled?: boolean;
  terminalScope?: TerminalScope;
}

export function TerminalTabs({
  fullscreen = false,
  onToggleFullscreen,
  projectScopedTerminalViewEnabled = false,
  terminalScope = ALL_TERMINALS_SCOPE,
}: TerminalTabsProps = {}) {
  const { t } = useI18n();
  const { sessions, activeSessionId, workspans, activeWorkspanId, tabNotifications } = useTerminalStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      workspans: s.workspans,
      activeWorkspanId: s.activeWorkspanId,
      tabNotifications: s.tabNotifications,
    }))
  );
  const setActive = useTerminalStore((s) => s.setActive);
  const setActiveWorkspan = useTerminalStore((s) => s.setActiveWorkspan);
  const reorderWorkspans = useTerminalStore((s) => s.reorderWorkspans);
  const mergeWorkspanAtPaneEdge = useTerminalStore((s) => s.mergeWorkspanAtPaneEdge);
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
  const { groups, projects, tree: projectTree } = useProjectStore(
    useShallow((s) => ({
      groups: s.groups,
      projects: s.projects,
      tree: s.tree,
    }))
  );
  const updateProject = useProjectStore((s) => s.updateProject);
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const checkWorktreeDeps = useWorktreeStore((s) => s.checkDeps);
  const dismissWorktreeDepsPrompt = useWorktreeStore((s) => s.dismissDepsPrompt);
  const removeWorktree = useWorktreeStore((s) => s.removeWorktree);
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const terminalBackgroundEnabled = useSettingsStore((s) => s.terminalBackground.enabled);
  const terminalBackgroundImagePath = useSettingsStore((s) => s.terminalBackground.imagePath);
  const terminalToolbarVisibility = useSettingsStore((s) => s.terminalToolbarVisibility);
  const terminalToolbarOrder = useSettingsStore((s) => s.terminalToolbarOrder);
  const systemResourceMonitoringEnabled = useSettingsStore((s) => s.systemResourceMonitoringEnabled);
  const cpuResourceCardVisible = useSettingsStore((s) => s.systemResourceCardVisibility.cpu);
  const sidePanelMerged = useSettingsStore((s) => s.terminalSidePanelMerged);
  const terminalSidePanelSingleOpen = useSettingsStore((s) => s.terminalSidePanelSingleOpen);
  const terminalSidePanelSkin = useSettingsStore((s) => s.terminalSidePanelSkin);
  const updateSettings = useSettingsStore((s) => s.update);
  const openFileProject = useFileExplorerStore((s) => s.openProject);
  const fileProject = useFileExplorerStore((s) => s.project);
  const sessionHistoryShortcut = useSettingsStore((s) => s.keyboardShortcuts.sessionHistory);
  const sessionHistoryShortcutHint = sessionHistoryShortcut.trim() || t("common.none");
  const historyOpen = useHistoryStore((s) => s.isOpen);
  const openHistory = useHistoryStore((s) => s.openHistory);
  const closeHistory = useHistoryStore((s) => s.closeHistory);
  const focusGlobalSearchSeq = useHistoryStore((s) => s.focusGlobalSearchSeq);
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<"terminal" | "history">("terminal");
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [splitPicker, setSplitPicker] = useState<SplitPickerState>(null);
  const [closeConfirm, setCloseConfirm] = useState<TerminalCloseConfirmState>(null);
  const [activeDragSessionId, setActiveDragSessionId] = useState<string | null>(null);
  const [activeDragWorkspanId, setActiveDragWorkspanId] = useState<string | null>(null);
  const [activeDropPreview, setActiveDropPreview] = useState<PaneDropPreview>(null);
  const [fullscreenPaneId, setFullscreenPaneId] = useState<string | null>(null);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [sidePanelTab, setSidePanelTab] = useState<TerminalSidePanelTab>("stats");
  // 非合并模式：实时统计与 Git 变更各自独立开关，可并排显示
  const [statsOpen, setStatsOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [systemResourcesOpen, setSystemResourcesOpen] = useState(false);
  const [finishTarget, setFinishTarget] = useState<{ project: Project; worktree: WorktreeRecord } | null>(null);
  const [discardTarget, setDiscardTarget] = useState<{ project: Project; worktree: WorktreeRecord } | null>(null);
  const [activeToolbarDragId, setActiveToolbarDragId] = useState<string | null>(null);
  const paneFullscreenStartedFromGlobalRef = useRef(false);
  const previousFullscreenRef = useRef(fullscreen);
  const splitPickerOpenFrameRef = useRef<number | null>(null);
  const splitPickerOpenTimerRef = useRef<number | null>(null);
  const splitPickerOutsideGuardUntilRef = useRef(0);
  const closeConfirmOutsideGuardUntilRef = useRef(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: DND_ACTIVATION_CONSTRAINT }));
  const toolbarSensors = useSensors(useSensor(PointerSensor, { activationConstraint: DND_ACTIVATION_CONSTRAINT }));

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const worktreeById = useMemo(() => new Map(worktrees.map((worktree) => [worktree.id, worktree])), [worktrees]);
  const terminalScopeValue = projectScopedTerminalViewEnabled ? terminalScope : ALL_TERMINALS_SCOPE;
  const scopedProjectId =
    terminalScopeValue.kind === "project" || terminalScopeValue.kind === "worktree"
      ? terminalScopeValue.projectId
      : null;
  const scopedProject = useMemo(
    () => (scopedProjectId ? projectById.get(scopedProjectId) ?? null : null),
    [projectById, scopedProjectId]
  );
  const scopedWorktree = useMemo(
    () => (terminalScopeValue.kind === "worktree" ? worktreeById.get(terminalScopeValue.worktreeId) ?? null : null),
    [terminalScopeValue, worktreeById]
  );
  const scopedGroup = useMemo(
    () => (terminalScopeValue.kind === "group" ? groups.find((group) => group.id === terminalScopeValue.groupId) ?? null : null),
    [groups, terminalScopeValue]
  );
  const scopedGroupProjectIds = useMemo(
    () => (terminalScopeValue.kind === "group" ? collectProjectIdsForGroup(groups, projects, terminalScopeValue.groupId) : null),
    [groups, projects, terminalScopeValue]
  );
  const scopedSessionIds = useMemo(() => {
    if (!projectScopedTerminalViewEnabled || terminalScopeValue.kind === "all") return null;
    const next = new Set<string>();
    for (const session of sessions) {
      if (sessionMatchesTerminalScope(session, terminalScopeValue, sessions, projects, projectById, worktrees, scopedGroupProjectIds)) {
        next.add(session.id);
      }
    }
    return next;
  }, [projectById, projectScopedTerminalViewEnabled, projects, scopedGroupProjectIds, sessions, terminalScopeValue, worktrees]);
  const visibleWorkspanLayouts = useMemo(() => workspans.flatMap((workspan) => {
    const paneTree = scopedSessionIds
      ? filterPaneTreeBySessionIds(workspan.paneTree, scopedSessionIds)
      : workspan.paneTree;
    if (!paneTree) return [];
    const visibleSessionIds = collectPaneLeaves(paneTree).flatMap((pane) => pane.sessionIds);
    return [{
      workspan,
      paneTree,
      panes: collectPaneLeaves(paneTree),
      sessionIds: collectWorkspanSessionIds(workspan),
      closeSessionIds: visibleSessionIds,
    }];
  }), [scopedSessionIds, workspans]);
  const effectiveActiveWorkspanId = visibleWorkspanLayouts.some(({ workspan }) => workspan.id === activeWorkspanId)
    ? activeWorkspanId
    : visibleWorkspanLayouts[0]?.workspan.id ?? null;
  const activeWorkspanLayout = visibleWorkspanLayouts.find(({ workspan }) => workspan.id === effectiveActiveWorkspanId) ?? null;
  const renderPaneTree = activeWorkspanLayout?.paneTree ?? null;
  const visibleSessions = useMemo(
    () => (scopedSessionIds ? sessions.filter((session) => scopedSessionIds.has(session.id)) : sessions),
    [scopedSessionIds, sessions]
  );
  const preservedHiddenPtySessions = useMemo(
    () => scopedSessionIds
      ? sessions.filter((session) => (session.kind ?? "pty") === "pty" && !scopedSessionIds.has(session.id))
      : [],
    [scopedSessionIds, sessions]
  );
  const allPanes = activeWorkspanLayout?.panes ?? [];
  const activeFullscreenPaneId = useMemo(() => {
    if (!fullscreenPaneId) return null;
    const pane = allPanes.find((item) => item.id === fullscreenPaneId);
    if (!pane) return null;
    if (scopedSessionIds && !pane.sessionIds.some((sessionId) => scopedSessionIds.has(sessionId))) return null;
    return fullscreenPaneId;
  }, [allPanes, fullscreenPaneId, scopedSessionIds]);
  const preferredScopedSessionId = useMemo(() => {
    if (!scopedSessionIds) return null;
    if (activeSessionId && scopedSessionIds.has(activeSessionId)) return activeSessionId;
    return findFirstSessionId(renderPaneTree);
  }, [activeSessionId, renderPaneTree, scopedSessionIds]);
  const effectiveActiveSessionId = preferredScopedSessionId ?? activeSessionId;
  const activeSession = useMemo(
    () => {
      if (scopedSessionIds && !preferredScopedSessionId) return null;
      return effectiveActiveSessionId ? sessions.find((session) => session.id === effectiveActiveSessionId) ?? null : null;
    },
    [effectiveActiveSessionId, preferredScopedSessionId, scopedSessionIds, sessions]
  );
  // 子 Agent 转录伪会话没有自己的 CLI 会话/项目：实时统计与 Git 面板落到其父终端，
  // 避免聚焦转录 Tab 时面板被清空/错位。
  useEffect(() => {
    if (!projectScopedTerminalViewEnabled || terminalScopeValue.kind === "all") return;
    const currentActiveSessionId = useTerminalStore.getState().activeSessionId;
    if (currentActiveSessionId && scopedSessionIds?.has(currentActiveSessionId)) return;
    if (!preferredScopedSessionId || preferredScopedSessionId === currentActiveSessionId) return;
    setActive(preferredScopedSessionId);
  }, [preferredScopedSessionId, projectScopedTerminalViewEnabled, scopedSessionIds, setActive, terminalScopeValue]);

  const panelSession = useMemo(() => {
    if (activeSession?.kind === "subagent-transcript" && activeSession.subagent) {
      return sessions.find((session) => session.id === activeSession.subagent!.parentSessionId) ?? activeSession;
    }
    if (activeSession?.kind === "file-editor") {
      return null;
    }
    return activeSession;
  }, [activeSession, sessions]);
  const panelSessionId = panelSession?.id ?? null;
  const activeWorktree = useMemo(
    () => findWorktreeForSession(activeSession, sessions, worktrees),
    [activeSession, sessions, worktrees]
  );
  const filePanelProject = useMemo(
    () => resolveProjectForSessionFileContext(activeSession, sessions, projects, projectById, worktrees),
    [activeSession, projectById, projects, sessions, worktrees]
  );
  const sidePanelProjectPath = panelSession?.cwd ?? filePanelProject?.path ?? null;
  const activeDragSession = useMemo(
    () => activeDragSessionId ? sessions.find((session) => session.id === activeDragSessionId) ?? null : null,
    [activeDragSessionId, sessions]
  );
  const activeDragWorkspan = useMemo(
    () => activeDragWorkspanId ? workspans.find((workspan) => workspan.id === activeDragWorkspanId) ?? null : null,
    [activeDragWorkspanId, workspans]
  );
  const workspanTabModels = useMemo(() => visibleWorkspanLayouts.map(({ workspan, sessionIds, closeSessionIds }) => {
    const memberSessions = sessionIds
      .map((sessionId) => sessions.find((session) => session.id === sessionId))
      .filter((session): session is TerminalSession => Boolean(session));
    const singleSession = memberSessions.length === 1 ? memberSessions[0] : null;
    return {
      workspan,
      sessionIds,
      closeSessionIds,
      singleSession,
      title: singleSession?.title ?? t("terminal.workspan.title", { count: memberSessions.length }),
      notification: getWorkspanNotification(sessionIds, tabNotifications),
      vendor: singleSession ? inferSessionVendor(singleSession) : null,
    };
  }), [sessions, t, tabNotifications, visibleWorkspanLayouts]);
  const activeDragWorkspanModel = activeDragWorkspan
    ? workspanTabModels.find(({ workspan }) => workspan.id === activeDragWorkspan.id) ?? null
    : null;
  const terminalTheme = useMemo(
    () => getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette),
    [darkThemePalette, lightThemePalette, resolvedTheme, terminalThemeName]
  );
  const terminalThemeTone = isLightTerminalTheme(terminalTheme) ? "light" : "dark";
  const terminalThemeBackground = terminalTheme.background ?? (resolvedTheme === "dark" ? "#0c0e10" : "#ffffff");
  const terminalThemeForeground = terminalTheme.foreground ?? (resolvedTheme === "dark" ? "#f8fafc" : "#1e293b");
  const terminalThemeAccent = terminalTheme.blue ?? terminalTheme.cursor ?? terminalThemeForeground;
  const terminalThemeMuted = terminalTheme.brightBlack ?? terminalTheme.white ?? terminalThemeForeground;
  const terminalThemeSelection = terminalTheme.selectionBackground ?? terminalThemeAccent;
  const terminalPanelSemanticColors = TERMINAL_PANEL_SEMANTIC_COLORS[terminalThemeTone];
  const splitPickerMenuForeground = normalizeTabMenuHex(terminalTheme.foreground, resolvedTheme === "dark" ? "#d8dee9" : "#1e293b");
  const splitPickerMenuBackground = normalizeTabMenuHex(terminalTheme.background, terminalThemeBackground);
  const splitPickerMenuStyle = {
    "--menu-fg": splitPickerMenuForeground,
    "--menu-bg": splitPickerMenuBackground,
    "--menu-border": tabMenuHexToRgba(splitPickerMenuForeground, 0.18, "rgba(255, 255, 255, 0.18)"),
    "--menu-hover": tabMenuHexToRgba(splitPickerMenuForeground, 0.12, "rgba(255, 255, 255, 0.12)"),
  } as CSSProperties;
  const terminalWellStyle = {
    "--terminal-bridge-color": terminalThemeBackground,
    "--terminal-theme-background": terminalThemeBackground,
    "--terminal-theme-foreground": terminalThemeForeground,
    "--terminal-theme-muted": terminalThemeMuted,
    "--terminal-theme-accent": terminalThemeAccent,
    "--terminal-theme-selection": terminalThemeSelection,
    "--term-panel-bg": "var(--terminal-theme-background, #0c0e10)",
    "--term-panel-card": "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 91%, var(--term-panel-fg, #ececec) 9%)",
    "--term-panel-card-inner": "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 87%, var(--term-panel-fg, #ececec) 13%)",
    "--term-panel-border": "color-mix(in srgb, var(--term-panel-fg, #ececec) 14%, transparent)",
    "--term-panel-fg": terminalPanelSemanticColors.fg,
    "--term-panel-dim": terminalPanelSemanticColors.dim,
    "--term-panel-green": terminalPanelSemanticColors.green,
    "--term-panel-yellow": terminalPanelSemanticColors.yellow,
    "--term-panel-red": terminalPanelSemanticColors.red,
    "--term-panel-magenta": terminalPanelSemanticColors.magenta,
    "--term-panel-cyan": terminalPanelSemanticColors.cyan,
    "--term-panel-blue": terminalPanelSemanticColors.blue,
    "--term-panel-track": "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 94%, var(--term-panel-fg, #ececec) 6%)",
  } as CSSProperties;
  const terminalActionSidebarStyle = useMemo(
    () => getTerminalSidePanelSkinStyle(terminalSidePanelSkin),
    [terminalSidePanelSkin]
  );
  const historyActive = historyOpen && activeWorkspaceTab === "history";
  const statsPanelActive = sidePanelMerged ? sidePanelOpen && sidePanelTab === "stats" : statsOpen;
  const replayPanelActive = sidePanelMerged ? sidePanelOpen && sidePanelTab === "replay" : replayOpen;
  const gitPanelActive = sidePanelMerged ? sidePanelOpen && sidePanelTab === "git" : gitOpen;
  const filesPanelActive = sidePanelMerged ? sidePanelOpen && sidePanelTab === "files" : filesOpen;
  const systemResourcesPanelActive = sidePanelMerged
    ? sidePanelOpen && sidePanelTab === "systemResources"
    : systemResourcesOpen;

  useEffect(() => {
    if (!historyOpen && activeWorkspaceTab === "history") setActiveWorkspaceTab("terminal");
  }, [activeWorkspaceTab, historyOpen]);

  useEffect(() => {
    if (!terminalSidePanelSingleOpen || !historyOpen) return;
    setSidePanelOpen(false);
    setStatsOpen(false);
    setGitOpen(false);
    setReplayOpen(false);
    setFilesOpen(false);
    setSystemResourcesOpen(false);
  }, [historyOpen, terminalSidePanelSingleOpen]);

  useEffect(() => {
    if (!historyOpen) return;
    setActiveWorkspaceTab("history");
  }, [focusGlobalSearchSeq, historyOpen]);

  useEffect(() => {
    if (!fullscreenPaneId || activeFullscreenPaneId) return;

    setFullscreenPaneId(null);
    const shouldExitFullscreen = !paneFullscreenStartedFromGlobalRef.current && fullscreen;
    paneFullscreenStartedFromGlobalRef.current = false;
    if (shouldExitFullscreen) onToggleFullscreen?.();
  }, [activeFullscreenPaneId, fullscreen, fullscreenPaneId, onToggleFullscreen]);

  useEffect(() => {
    const wasFullscreen = previousFullscreenRef.current;
    previousFullscreenRef.current = fullscreen;
    if (!wasFullscreen || fullscreen || !activeFullscreenPaneId) return;

    setFullscreenPaneId(null);
    paneFullscreenStartedFromGlobalRef.current = false;
  }, [activeFullscreenPaneId, fullscreen]);

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

  const armCloseConfirmOutsideGuard = useCallback(() => {
    closeConfirmOutsideGuardUntilRef.current = Date.now() + 180;
  }, []);

  const shouldIgnoreCloseConfirmOutsideInteraction = useCallback(() => {
    return Date.now() < closeConfirmOutsideGuardUntilRef.current;
  }, []);

  const handleNewTab = useCallback(async () => {
    const newTerminalContext =
      activeSession?.kind === "subagent-transcript"
        ? { cwd: undefined, title: "Terminal" }
        : activeSession?.kind === "file-editor"
          ? { cwd: activeSession.fileEditor?.projectPath, title: "Terminal" }
          : { cwd: activeSession?.cwd, title: activeSession?.title ?? "Terminal" };
    if (useExternalTerminal) {
      await openWindowsTerminal([{ title: newTerminalContext.title, cwd: newTerminalContext.cwd ?? undefined }]);
      closeHistory();
      setActiveWorkspaceTab("terminal");
      return;
    }
    await createSession(undefined, newTerminalContext.cwd ?? undefined, newTerminalContext.title);
    closeHistory();
    setActiveWorkspaceTab("terminal");
  }, [activeSession, closeHistory, createSession, useExternalTerminal]);

  const handleOpenScopedTerminal = useCallback(async () => {
    if (!scopedProject || useExternalTerminal) return;

    if (terminalScopeValue.kind === "worktree") {
      if (!scopedWorktree) return;
      const options = buildProjectSplitOptions(projectWithWorktreeProviderOverrides(scopedProject, scopedWorktree));
      await createSession(
        options.projectId,
        scopedWorktree.path,
        `${scopedProject.name} · ${scopedWorktree.name}`,
        options.startupCmd,
        options.envVars,
        options.shell,
        undefined,
        scopedWorktree.id
      );
      closeHistory();
      setActiveWorkspaceTab("terminal");
      return;
    }

    if (terminalScopeValue.kind !== "project") return;
    const options = buildProjectSplitOptions(scopedProject);
    await createSession(options.projectId, options.cwd, options.title, options.startupCmd, options.envVars, options.shell);
    closeHistory();
    setActiveWorkspaceTab("terminal");
  }, [closeHistory, createSession, scopedProject, scopedWorktree, terminalScopeValue, useExternalTerminal]);

  const handleInstallWorktreeDeps = useCallback((project: Project, worktree: WorktreeRecord) => {
    void checkWorktreeDeps(worktree).then((deps) => {
      if (!deps.needsInstall || !deps.command) {
        toast.info(t("worktree.deps.notNeeded"));
        return;
      }
      const options = buildProjectSplitOptions(project);
      void dismissWorktreeDepsPrompt(worktree.id);
      void createSession(
        options.projectId,
        worktree.path,
        t("worktree.deps.installTitle", { name: worktree.name }),
        deps.command,
        options.envVars,
        options.shell,
        undefined,
        worktree.id,
      );
    }).catch((err) => toast.error(t("worktree.deps.checkFailed"), { description: String(err) }));
  }, [checkWorktreeDeps, createSession, dismissWorktreeDepsPrompt, t]);

  const handleOpenWorktreeDirectory = useCallback((worktree: WorktreeRecord) => {
    void openPath(worktree.path).catch((err) => toast.error(t("sidebar.toast.openDirectoryFailed"), { description: String(err) }));
  }, [t]);

  const handleOpenWorktreeChanges = useCallback((sessionId: string) => {
    closeHistory();
    setActiveWorkspaceTab("terminal");
    setActive(sessionId);
    if (sidePanelMerged) {
      setSidePanelTab("git");
      setSidePanelOpen(true);
      return;
    }
    setGitOpen(true);
  }, [closeHistory, setActive, sidePanelMerged]);

  const handleOpenWorktreeHistory = useCallback((project: Project, worktree: WorktreeRecord) => {
    if (terminalSidePanelSingleOpen) {
      setSidePanelOpen(false);
      setStatsOpen(false);
      setGitOpen(false);
      setReplayOpen(false);
      setFilesOpen(false);
      setSystemResourcesOpen(false);
    }
    setActiveWorkspaceTab("history");
    void openHistory({
      sourceFilter: resolveHistorySourceFilter(project.cli_tool),
      projectPath: project.path,
      scopedProjectPath: worktree.path,
    });
  }, [openHistory, terminalSidePanelSingleOpen]);

  const handleDuplicateSession = useCallback((session: TerminalSession) => {
    void createSession(
      session.projectId,
      session.cwd,
      session.title,
      normalizeDirectCodexStartupCommand(session.startupCmd),
      session.envVars ? { ...session.envVars } : undefined,
      session.shell ?? undefined,
      undefined,
      session.worktreeId,
    ).then(() => {
      closeHistory();
      setActiveWorkspaceTab("terminal");
    }).catch(() => {});
  }, [closeHistory, createSession]);

  const handleActivateSession = useCallback((sessionId: string) => {
    closeHistory();
    setActiveWorkspaceTab("terminal");
    setActive(sessionId);
  }, [closeHistory, setActive]);

  const handleTogglePaneFullscreen = useCallback((paneId: string) => {
    if (activeFullscreenPaneId === paneId) {
      setFullscreenPaneId(null);
      const shouldExitFullscreen = !paneFullscreenStartedFromGlobalRef.current && fullscreen;
      paneFullscreenStartedFromGlobalRef.current = false;
      if (shouldExitFullscreen) onToggleFullscreen?.();
      return;
    }

    const targetPane = allPanes.find((pane) => pane.id === paneId);
    if (!targetPane) return;

    if (targetPane.activeSessionId && targetPane.activeSessionId !== activeSessionId) {
      handleActivateSession(targetPane.activeSessionId);
    } else {
      closeHistory();
      setActiveWorkspaceTab("terminal");
    }

    paneFullscreenStartedFromGlobalRef.current = fullscreen;
    setFullscreenPaneId(paneId);
    if (!fullscreen) onToggleFullscreen?.();
  }, [activeFullscreenPaneId, activeSessionId, allPanes, closeHistory, fullscreen, handleActivateSession, onToggleFullscreen]);

  const resolveCloseConfirmAnchor = useCallback((anchor?: SplitPickerAnchor) => {
    const rawX = anchor ? ("right" in anchor ? anchor.right : anchor.x) : window.innerWidth - 72;
    const rawY = anchor ? ("bottom" in anchor ? anchor.bottom : anchor.y) : 56;
    const align: SplitPickerAlign = anchor && "right" in anchor ? "end" : "start";

    return {
      x: Math.min(Math.max(rawX, 16), window.innerWidth - 16),
      y: Math.min(Math.max(rawY, 44), window.innerHeight - 16),
      align,
    };
  }, []);

  const findCloseConfirmAnchor = useCallback((sessionIds: string[]): SplitPickerAnchor | undefined => {
    const targetIds = new Set(sessionIds);
    const tab = Array.from(document.querySelectorAll<HTMLElement>("[data-terminal-tab-id]"))
      .find((node) => targetIds.has(node.dataset.terminalTabId ?? ""));
    return tab?.getBoundingClientRect();
  }, []);

  const closeSessionIds = useCallback((sessionIds: string[]) => {
    void (async () => {
      for (const sessionId of sessionIds) {
        try {
          await closeSession(sessionId);
        } catch (err) {
          logError("Failed to close terminal session", { sessionId, err });
        }
      }
    })();
  }, [closeSession]);

  const handleCloseSessions = useCallback((sessionIds: string[], anchor?: SplitPickerAnchor) => {
    const uniqueSessionIds = Array.from(new Set(sessionIds)).filter((sessionId) => sessions.some((session) => session.id === sessionId));
    if (uniqueSessionIds.length === 0) return;

    const terminalSessionCount = uniqueSessionIds.filter((sessionId) => {
      const session = sessions.find((item) => item.id === sessionId);
      return session?.kind !== "file-editor";
    }).length;

    if (!shouldConfirmTerminalTabClose(terminalSessionCount)) {
      closeSessionIds(uniqueSessionIds);
      return;
    }

    const position = resolveCloseConfirmAnchor(anchor ?? findCloseConfirmAnchor(uniqueSessionIds));
    armCloseConfirmOutsideGuard();
    setCloseConfirm({
      sessionIds: uniqueSessionIds,
      ...position,
    });
  }, [armCloseConfirmOutsideGuard, closeSessionIds, findCloseConfirmAnchor, resolveCloseConfirmAnchor, sessions]);

  const confirmCloseSessions = useCallback(() => {
    if (!closeConfirm) return;
    const sessionIds = closeConfirm.sessionIds;
    setCloseConfirm(null);
    closeSessionIds(sessionIds);
  }, [closeConfirm, closeSessionIds]);

  const cancelCloseSessions = useCallback(() => {
    setCloseConfirm(null);
  }, []);

  useEffect(() => {
    const handleCloseRequest = (event: Event) => {
      const detail = (event as CustomEvent<TerminalTabCloseRequestDetail>).detail;
      const requestedSessionIds = detail?.sessionIds?.length
        ? detail.sessionIds
        : activeSessionId
          ? [activeSessionId]
          : [];
      if (requestedSessionIds.length === 0) return;
      handleCloseSessions(requestedSessionIds, findCloseConfirmAnchor(requestedSessionIds));
    };

    window.addEventListener(TERMINAL_TAB_CLOSE_REQUEST_EVENT, handleCloseRequest);
    return () => window.removeEventListener(TERMINAL_TAB_CLOSE_REQUEST_EVENT, handleCloseRequest);
  }, [activeSessionId, findCloseConfirmAnchor, handleCloseSessions]);

  const ensureStatsPanelAllowed = useCallback(async () => {
    try {
      const settings = useSettingsStore.getState();
      const status = await invoke<{ claude: { status: string }; codex: { status: string } }>(
        "hook_settings_get_status",
        {
          selectedDir: settings.claudeHookConfigDir?.trim() || null,
          codexSelectedDir: settings.codexHookConfigDir?.trim() || null,
          ccSwitchDbPath: settings.ccSwitchDbPath ?? undefined,
          autoRepair: settings.claudeHookAutoRepairKnownInstalled,
        }
      );
      if (status.claude.status !== "installed" && status.codex.status !== "installed") {
        toast.warning(t("notifications.stats.needHook"), {
          description: t("notifications.stats.needHookDescription"),
        });
        return false;
      }
    } catch (err) {
      logError("Failed to check hook status before opening terminal stats panel", err);
    }
    return true;
  }, [t]);

  const handleToggleStatsPanel = useCallback(async () => {
    if (statsPanelActive) {
      if (sidePanelMerged) setSidePanelOpen(false);
      else setStatsOpen(false);
      return;
    }
    const allowed = await ensureStatsPanelAllowed();
    if (!allowed) return;
    if (terminalSidePanelSingleOpen) {
      closeHistory();
      setActiveWorkspaceTab("terminal");
    }
    if (sidePanelMerged) {
      setSidePanelTab("stats");
      setSidePanelOpen(true);
    } else {
      if (terminalSidePanelSingleOpen || window.innerWidth < 1100) {
        setGitOpen(false);
        setReplayOpen(false);
        setFilesOpen(false);
        setSystemResourcesOpen(false);
      }
      setStatsOpen(true);
    }
  }, [closeHistory, ensureStatsPanelAllowed, sidePanelMerged, statsPanelActive, terminalSidePanelSingleOpen]);

  const handleToggleSystemResourcesPanel = useCallback(() => {
    if (systemResourcesPanelActive) {
      if (sidePanelMerged) setSidePanelOpen(false);
      else setSystemResourcesOpen(false);
      return;
    }
    if (terminalSidePanelSingleOpen) {
      closeHistory();
      setActiveWorkspaceTab("terminal");
    }
    if (sidePanelMerged) {
      setSidePanelTab("systemResources");
      setSidePanelOpen(true);
    } else {
      if (terminalSidePanelSingleOpen || window.innerWidth < 1100) {
        setStatsOpen(false);
        setGitOpen(false);
        setReplayOpen(false);
        setFilesOpen(false);
      }
      setSystemResourcesOpen(true);
    }
  }, [closeHistory, sidePanelMerged, systemResourcesPanelActive, terminalSidePanelSingleOpen]);

  const handleToggleGitChangesPanel = useCallback(() => {
    if (gitPanelActive) {
      if (sidePanelMerged) setSidePanelOpen(false);
      else setGitOpen(false);
      return;
    }
    if (sidePanelMerged) {
      if (terminalSidePanelSingleOpen) {
        closeHistory();
        setActiveWorkspaceTab("terminal");
      }
      setSidePanelTab("git");
      setSidePanelOpen(true);
    } else {
      if (terminalSidePanelSingleOpen) {
        closeHistory();
        setActiveWorkspaceTab("terminal");
      }
      if (terminalSidePanelSingleOpen || window.innerWidth < 1100) {
        setStatsOpen(false);
        setReplayOpen(false);
        setFilesOpen(false);
        setSystemResourcesOpen(false);
      }
      setGitOpen(true);
    }
  }, [closeHistory, gitPanelActive, sidePanelMerged, terminalSidePanelSingleOpen]);

  const handleToggleReplayPanel = useCallback(() => {
    if (replayPanelActive) {
      if (sidePanelMerged) setSidePanelOpen(false);
      else setReplayOpen(false);
      return;
    }
    if (sidePanelMerged) {
      if (terminalSidePanelSingleOpen) {
        closeHistory();
        setActiveWorkspaceTab("terminal");
      }
      setSidePanelTab("replay");
      setSidePanelOpen(true);
    } else {
      if (terminalSidePanelSingleOpen) {
        closeHistory();
        setActiveWorkspaceTab("terminal");
      }
      if (terminalSidePanelSingleOpen || window.innerWidth < 1100) {
        setStatsOpen(false);
        setGitOpen(false);
        setFilesOpen(false);
        setSystemResourcesOpen(false);
      }
      setReplayOpen(true);
    }
  }, [closeHistory, replayPanelActive, sidePanelMerged, terminalSidePanelSingleOpen]);

  const syncFilePanelProject = useCallback(async (project: Project) => {
    try {
      const sameFileContext = isSameProjectFileContext(fileProject, project);
      if (!sameFileContext && isProjectFileDirty()) {
        const confirmed = window.confirm(t("sidebar.toast.unsavedFileConfirm"));
        if (!confirmed) return false;
      }
      if (sameFileContext) return true;
      await openFileProject(project);
      return true;
    } catch (err) {
      logError("Failed to open terminal file panel project", err);
      toast.error(t("sidebar.toast.openProjectFilesFailed"), { description: String(err) });
      return false;
    }
  }, [fileProject, openFileProject, t]);

  const closeFilesPanel = useCallback(() => {
    if (sidePanelMerged) {
      if (sidePanelTab === "files") setSidePanelOpen(false);
      return;
    }
    setFilesOpen(false);
  }, [sidePanelMerged, sidePanelTab]);

  const handleToggleFilesPanel = useCallback(async () => {
    if (filesPanelActive) {
      closeFilesPanel();
      return;
    }
    if (!filePanelProject) return;
    const allowed = await syncFilePanelProject(filePanelProject);
    if (!allowed) return;
    if (terminalSidePanelSingleOpen) {
      closeHistory();
      setActiveWorkspaceTab("terminal");
    }
    if (sidePanelMerged) {
      setSidePanelTab("files");
      setSidePanelOpen(true);
    } else {
      if (terminalSidePanelSingleOpen || window.innerWidth < 1100) {
        setStatsOpen(false);
        setGitOpen(false);
        setReplayOpen(false);
        setSystemResourcesOpen(false);
      }
      setFilesOpen(true);
    }
  }, [closeFilesPanel, closeHistory, filePanelProject, filesPanelActive, sidePanelMerged, syncFilePanelProject, terminalSidePanelSingleOpen]);

  const handleSidePanelTabChange = useCallback((tab: TerminalSidePanelTab) => {
    if (tab === "stats") {
      void ensureStatsPanelAllowed().then((allowed) => {
        if (allowed) setSidePanelTab("stats");
      });
      return;
    }
    if (tab === "files") {
      if (!filePanelProject) return;
      void syncFilePanelProject(filePanelProject).then((allowed) => {
        if (allowed) setSidePanelTab("files");
      });
      return;
    }
    setSidePanelTab(tab);
  }, [ensureStatsPanelAllowed, filePanelProject, syncFilePanelProject]);

  // 响应式约束：非合并模式下两个面板各占固定宽度，窗口过窄时会挤压终端。
  // 窗口 < 1100px 时退化为单面板，并随窗口缩小持续生效。
  useEffect(() => {
    if (sidePanelMerged) return;
    const enforce = () => {
      if (!terminalSidePanelSingleOpen && window.innerWidth >= 1100) return;
      const openPanels = [statsOpen, gitOpen, replayOpen, filesOpen, systemResourcesOpen].filter(Boolean).length;
      if (openPanels <= 1) return;
      if (statsOpen) {
        setGitOpen(false);
        setReplayOpen(false);
        setFilesOpen(false);
        setSystemResourcesOpen(false);
        return;
      }
      if (systemResourcesOpen) {
        setGitOpen(false);
        setReplayOpen(false);
        setFilesOpen(false);
        return;
      }
      if (gitOpen) {
        setReplayOpen(false);
        setFilesOpen(false);
        setSystemResourcesOpen(false);
        return;
      }
      if (replayOpen) {
        setFilesOpen(false);
        setSystemResourcesOpen(false);
      }
    };
    enforce();
    window.addEventListener("resize", enforce);
    return () => window.removeEventListener("resize", enforce);
  }, [filesOpen, gitOpen, replayOpen, sidePanelMerged, statsOpen, systemResourcesOpen, terminalSidePanelSingleOpen]);

  useEffect(() => {
    if (!filesPanelActive) return;
    if (!filePanelProject) {
      closeFilesPanel();
      return;
    }
    void syncFilePanelProject(filePanelProject);
  }, [closeFilesPanel, filePanelProject?.id, filePanelProject?.path, filesPanelActive, syncFilePanelProject]);

  const handleOpenHistoryTab = useCallback(() => {
    if (historyOpen) {
      closeHistory();
      return;
    }

    if (terminalSidePanelSingleOpen) {
      setSidePanelOpen(false);
      setStatsOpen(false);
      setGitOpen(false);
      setReplayOpen(false);
      setFilesOpen(false);
      setSystemResourcesOpen(false);
    }
    const project = activeSession?.projectId ? projects.find((item) => item.id === activeSession.projectId) : undefined;
    setActiveWorkspaceTab("history");
    void openHistory({
      sourceFilter: resolveHistorySourceFilter(project?.cli_tool),
      projectPath: project?.path ?? activeSession?.cwd ?? null,
      scopedProjectPath: activeWorktree?.path ?? null,
    });
  }, [activeSession, activeWorktree?.path, closeHistory, historyOpen, openHistory, projects, terminalSidePanelSingleOpen]);

  const handleOpenSplitPicker = useCallback((sessionId: string, direction: TerminalPaneSplitDirection, anchor?: SplitPickerAnchor) => {
    clearSplitPickerOpenSchedule();
    const rawX = anchor ? ("right" in anchor ? anchor.right : anchor.x) : window.innerWidth - 24;
    const rawY = anchor ? ("bottom" in anchor ? anchor.bottom : anchor.y) : 56;
    const x = Math.min(Math.max(rawX, 16), window.innerWidth - 16);
    const y = Math.min(Math.max(rawY, 44), window.innerHeight - 16);
    const align: SplitPickerAlign = anchor && "right" in anchor ? "end" : "start";
    splitPickerOpenFrameRef.current = window.requestAnimationFrame(() => {
      splitPickerOpenFrameRef.current = null;
      splitPickerOpenTimerRef.current = window.setTimeout(() => {
        splitPickerOpenTimerRef.current = null;
        splitPickerOutsideGuardUntilRef.current = Date.now() + SPLIT_PICKER_OUTSIDE_GUARD_MS;
        setSplitPicker({ sessionId, direction, x, y, align });
      }, 0);
    });
  }, [clearSplitPickerOpenSchedule]);

  const handleSplitEmpty = useCallback(() => {
    if (!splitPicker) return;
    void splitTerminal(splitPicker.sessionId, splitPicker.direction, { title: "Terminal" });
    handleCloseSplitPicker();
    closeHistory();
    setActiveWorkspaceTab("terminal");
  }, [closeHistory, handleCloseSplitPicker, splitPicker, splitTerminal]);

  const handleSplitProject = useCallback((project: Project) => {
    if (!splitPicker) return;
    void splitTerminal(splitPicker.sessionId, splitPicker.direction, buildProjectSplitOptions(project));
    handleCloseSplitPicker();
    closeHistory();
    setActiveWorkspaceTab("terminal");
  }, [closeHistory, handleCloseSplitPicker, splitPicker, splitTerminal]);

  const findPaneForSession = useCallback((sessionId: string) => {
    return allPanes.find((pane) => pane.sessionIds.includes(sessionId)) ?? null;
  }, [allPanes]);

  const canSplitSessionToPaneEdge = useCallback((sessionId: string, targetPaneId: string) => {
    const sourcePane = findPaneForSession(sessionId);
    const targetPane = allPanes.find((pane) => pane.id === targetPaneId) ?? null;
    if (!sourcePane || !targetPane) return false;
    return sourcePane.id !== targetPane.id || sourcePane.sessionIds.length > 1;
  }, [allPanes, findPaneForSession]);

  const updateActiveDropPreview = useCallback((next: PaneDropPreview) => {
    setActiveDropPreview((current) => {
      if (!current || !next) return current === next ? current : next;
      return current.paneId === next.paneId && current.edge === next.edge ? current : next;
    });
  }, []);

  const clearDragState = useCallback(() => {
    setActiveDragSessionId(null);
    setActiveDragWorkspanId(null);
    updateActiveDropPreview(null);
  }, [updateActiveDropPreview]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const dragId = String(event.active.id);
    const workspanId = parseWorkspanDragId(dragId);
    if (workspanId) {
      if (scopedSessionIds || !workspans.some((workspan) => workspan.id === workspanId)) return;
      setActiveDragWorkspanId(workspanId);
      setActiveWorkspaceTab("terminal");
      return;
    }
    const sessionId = dragId;
    if (!sessions.some((session) => session.id === sessionId)) return;
    setActiveDragSessionId(sessionId);
    setActiveWorkspaceTab("terminal");
  }, [scopedSessionIds, sessions, workspans]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (!event.over) {
      updateActiveDropPreview(null);
      return;
    }

    const dropTarget = parsePaneDropTarget(String(event.over.id));
    if (activeDragWorkspanId) {
      const targetWorkspanId = activeWorkspanLayout?.workspan.id ?? null;
      const targetPaneExists = dropTarget
        && activeWorkspanLayout?.panes.some((pane) => pane.id === dropTarget.paneId);
      const edge = dropTarget ? resolveWorkspanDropEdge(event, dropTarget) : null;
      if (targetPaneExists && edge && targetWorkspanId && targetWorkspanId !== activeDragWorkspanId) {
        updateActiveDropPreview({ paneId: dropTarget.paneId, edge });
        return;
      }
      updateActiveDropPreview(null);
      return;
    }

    if (!activeDragSessionId) {
      updateActiveDropPreview(null);
      return;
    }
    if (dropTarget?.type === "edge" && canSplitSessionToPaneEdge(activeDragSessionId, dropTarget.paneId)) {
      updateActiveDropPreview({ paneId: dropTarget.paneId, edge: dropTarget.edge });
      return;
    }

    updateActiveDropPreview(null);
  }, [activeDragSessionId, activeDragWorkspanId, activeWorkspanLayout, canSplitSessionToPaneEdge, updateActiveDropPreview]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    clearDragState();
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    const sourceWorkspanId = parseWorkspanDragId(activeId);
    if (sourceWorkspanId) {
      const targetWorkspanId = parseWorkspanDragId(overId);
      if (targetWorkspanId) {
        if (sourceWorkspanId !== targetWorkspanId) reorderWorkspans(sourceWorkspanId, targetWorkspanId);
        return;
      }
      const dropTarget = parsePaneDropTarget(overId);
      const activeTargetWorkspanId = activeWorkspanLayout?.workspan.id ?? null;
      const edge = dropTarget ? resolveWorkspanDropEdge(event, dropTarget) : null;
      if (
        dropTarget
        && edge
        && activeTargetWorkspanId
        && activeTargetWorkspanId !== sourceWorkspanId
      ) {
        mergeWorkspanAtPaneEdge(
          sourceWorkspanId,
          activeTargetWorkspanId,
          dropTarget.paneId,
          edge
        );
        setActiveWorkspaceTab("terminal");
      }
      return;
    }
    if (active.id === over.id) return;
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
  }, [activeWorkspanLayout, canSplitSessionToPaneEdge, clearDragState, findPaneForSession, mergeWorkspanAtPaneEdge, moveSessionToPane, reorderSessions, reorderWorkspans, splitSessionToPaneEdge]);

  const handleToolbarDragStart = useCallback((event: DragStartEvent) => {
    setActiveToolbarDragId(String(event.active.id));
  }, []);

  const handleToolbarDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveToolbarDragId(null);

    if (!over || active.id === over.id) return;

    const oldIndex = terminalToolbarOrder.indexOf(String(active.id));
    const newIndex = terminalToolbarOrder.indexOf(String(over.id));

    if (oldIndex !== -1 && newIndex !== -1) {
      const newOrder = arrayMove(terminalToolbarOrder, oldIndex, newIndex);
      void updateSettings("terminalToolbarOrder", newOrder);
    }
  }, [terminalToolbarOrder, updateSettings]);

  const handleToolbarDragCancel = useCallback(() => {
    setActiveToolbarDragId(null);
  }, []);

  const handleToggleGlobalFullscreen = useCallback(() => {
    if (activeFullscreenPaneId) {
      setFullscreenPaneId(null);
      paneFullscreenStartedFromGlobalRef.current = false;
    }
    onToggleFullscreen?.();
  }, [activeFullscreenPaneId, onToggleFullscreen]);

  const renderToolbarActions = useCallback(() => {
    const buttonMap: Record<string, ReactNode> = {
      new: (
        <button
          onClick={handleNewTab}
          className="ui-focus-ring ui-icon-action ui-primary-action ui-action-new"
          title={t("terminal.toolbar.newTerminal")}
          aria-label={t("terminal.toolbar.newTerminal")}
        >
          <Plus size={15} strokeWidth={2} />
        </button>
      ),
      templates: (
        <CommandTemplatePanel
          popoverSide="left"
          toneClassName="ui-action-template"
          popoverStyle={terminalActionSidebarStyle}
        />
      ),
      commandHistory: (
        <CommandHistoryPanel
          compact
          popoverSide="left"
          toneClassName="ui-action-command-history"
          popoverStyle={terminalActionSidebarStyle}
        />
      ),
      fullscreen: onToggleFullscreen ? (
        <button
          onClick={handleToggleGlobalFullscreen}
          className="ui-focus-ring ui-icon-action ui-action-fullscreen"
          data-active={fullscreen ? "true" : "false"}
          title={fullscreen ? t("terminal.toolbar.exitImmersiveFullscreen") : t("terminal.toolbar.immersiveFullscreen")}
          aria-label={fullscreen ? t("terminal.toolbar.exitImmersiveFullscreen") : t("terminal.toolbar.enterImmersiveFullscreen")}
          aria-pressed={fullscreen}
        >
          {fullscreen ? <Minimize2 size={14} strokeWidth={1.8} /> : <Maximize2 size={14} strokeWidth={1.8} />}
        </button>
      ) : null,
      sessionHistory: (
        <button
          onClick={handleOpenHistoryTab}
          className="ui-focus-ring ui-icon-action ui-action-session-history"
          data-active={historyOpen ? "true" : "false"}
          title={`${t("terminal.toolbar.sessionHistory")} (${sessionHistoryShortcutHint})`}
          aria-label={historyOpen ? t("terminal.toolbar.closeSessionHistory") : t("terminal.toolbar.openSessionHistory")}
          aria-controls="history-workspace"
          aria-expanded={historyOpen}
        >
          <ListClockIcon size={16} />
          {terminalToolbarVisibility.showText && <span>{t("terminal.toolbar.sessionHistory")}</span>}
        </button>
      ),
      replay: (
        <button
          onClick={handleToggleReplayPanel}
          className="ui-focus-ring ui-icon-action ui-action-replay"
          data-active={replayPanelActive ? "true" : "false"}
          title={replayPanelActive ? t("terminal.toolbar.closeReplayPanel") : t("terminal.toolbar.openReplayPanel")}
          aria-label={replayPanelActive ? t("terminal.toolbar.closeReplayPanel") : t("terminal.toolbar.openReplayPanel")}
          aria-pressed={replayPanelActive}
        >
          <Activity size={13} strokeWidth={1.8} />
          {terminalToolbarVisibility.showText && <span>{t("terminal.toolbar.replay")}</span>}
        </button>
      ),
      gitChanges: (
        <button
          onClick={handleToggleGitChangesPanel}
          className="ui-focus-ring ui-icon-action ui-action-git"
          data-active={gitPanelActive ? "true" : "false"}
          title={gitPanelActive ? t("terminal.toolbar.closeGit") : t("terminal.toolbar.openGit")}
          aria-label={gitPanelActive ? t("terminal.toolbar.closeGitPanel") : t("terminal.toolbar.openGitPanel")}
          aria-pressed={gitPanelActive}
        >
          <GitBranch size={13} strokeWidth={1.8} />
        </button>
      ),
      files: (
        <button
          onClick={handleToggleFilesPanel}
          disabled={!filesPanelActive && !filePanelProject}
          className="ui-focus-ring ui-icon-action ui-action-files"
          data-active={filesPanelActive ? "true" : "false"}
          title={
            !filesPanelActive && !filePanelProject
              ? t("termStats.noProject")
              : filesPanelActive
                ? t("terminal.toolbar.closeFilesPanel")
                : t("terminal.toolbar.openFilesPanel")
          }
          aria-label={
            !filesPanelActive && !filePanelProject
              ? t("termStats.noProject")
              : filesPanelActive
                ? t("terminal.toolbar.closeFilesPanel")
                : t("terminal.toolbar.openFilesPanel")
          }
          aria-pressed={filesPanelActive}
        >
          <Folder size={13} strokeWidth={1.8} />
        </button>
      ),
      stats: (
        <button
          onClick={handleToggleStatsPanel}
          className="ui-focus-ring ui-icon-action ui-action-stats"
          data-active={statsPanelActive ? "true" : "false"}
          title={statsPanelActive ? t("terminal.toolbar.closeStatsPanel") : t("terminal.toolbar.openStatsPanel")}
          aria-label={statsPanelActive ? t("terminal.toolbar.closeStatsPanel") : t("terminal.toolbar.openStatsPanel")}
          aria-pressed={statsPanelActive}
        >
          <BarChart3 size={13} strokeWidth={1.8} />
        </button>
      ),
      systemResources: (
        <button
          onClick={handleToggleSystemResourcesPanel}
          className="ui-focus-ring ui-icon-action ui-action-system-resources"
          data-active={systemResourcesPanelActive ? "true" : "false"}
          title={systemResourcesPanelActive ? t("terminal.toolbar.closeSystemResourcesPanel") : t("terminal.toolbar.openSystemResourcesPanel")}
          aria-label={systemResourcesPanelActive ? t("terminal.toolbar.closeSystemResourcesPanel") : t("terminal.toolbar.openSystemResourcesPanel")}
          aria-pressed={systemResourcesPanelActive}
        >
          <Cpu size={13} strokeWidth={1.8} />
        </button>
      ),
    };

    const visibleButtons = terminalToolbarOrder
      .filter((key) => {
        if (key === "new") return true;
        if (key === "fullscreen" && !onToggleFullscreen) return false;
        if (key === "systemResources") {
          return terminalToolbarVisibility.systemResources === true;
        }
        return terminalToolbarVisibility[key as keyof typeof terminalToolbarVisibility] === true;
      })
      .map((key) => ({ id: key, element: buttonMap[key] }))
      .filter((btn): btn is { id: string; element: ReactNode } => btn.element != null);

    return (
      <DndContext
        sensors={toolbarSensors}
        collisionDetection={closestCenter}
        onDragStart={handleToolbarDragStart}
        onDragEnd={handleToolbarDragEnd}
        onDragCancel={handleToolbarDragCancel}
      >
        <nav
          className="ui-terminal-actions ui-terminal-action-sidebar flex shrink-0 flex-col items-center gap-2"
          aria-label={t("terminal.toolbar.actions")}
          data-show-text={terminalToolbarVisibility.showText ? "true" : undefined}
          style={terminalActionSidebarStyle}
        >
          <SortableContext items={visibleButtons.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            {visibleButtons.map((btn) => (
              <SortableToolbarButton key={btn.id} id={btn.id} isDragging={activeToolbarDragId === btn.id}>
                {btn.element}
              </SortableToolbarButton>
            ))}
          </SortableContext>
          <div className="ui-terminal-action-cat-slot">
            <CpuCatIndicator
              enabled={systemResourceMonitoringEnabled && cpuResourceCardVisible}
              active={systemResourcesPanelActive}
              onClick={handleToggleSystemResourcesPanel}
            />
          </div>
        </nav>
        <DragOverlay dropAnimation={null}>
          {activeToolbarDragId && buttonMap[activeToolbarDragId] ? (
            <div className="ui-terminal-action-drag-overlay cursor-grabbing" style={{ ...terminalActionSidebarStyle, opacity: 1 }}>
              {buttonMap[activeToolbarDragId]}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    );
  }, [
    activeToolbarDragId,
    cpuResourceCardVisible,
    fullscreen,
    filePanelProject,
    filesPanelActive,
    gitPanelActive,
    handleNewTab,
    handleOpenHistoryTab,
    handleToggleFilesPanel,
    handleToggleGitChangesPanel,
    handleToggleGlobalFullscreen,
    handleToggleReplayPanel,
    handleToggleStatsPanel,
    handleToggleSystemResourcesPanel,
    handleToolbarDragCancel,
    handleToolbarDragEnd,
    handleToolbarDragStart,
    historyOpen,
    onToggleFullscreen,
    replayPanelActive,
    sessionHistoryShortcutHint,
    sidePanelMerged,
    statsPanelActive,
    systemResourceMonitoringEnabled,
    systemResourcesPanelActive,
    t,
    terminalToolbarOrder,
    terminalToolbarVisibility,
    terminalActionSidebarStyle,
    toolbarSensors,
  ]);

  const renameOpenProjectTabs = useCallback(
    (projectId: string, title: string) => {
      sessions
        .filter((session) => session.projectId === projectId && !session.worktreeId && (session.kind ?? "pty") === "pty")
        .forEach((session) => renameSession(session.id, title));
    },
    [renameSession, sessions]
  );

  const handleSubmitTabEdit = useCallback(
    async (sessionId: string, title: string) => {
      const trimmed = title.trim();
      const session = sessions.find((item) => item.id === sessionId);
      if (!session || !trimmed) {
        setEditingSessionId(null);
        return;
      }

      if (session.projectId && !session.worktreeId && (session.kind ?? "pty") === "pty") {
        try {
          await updateProject(session.projectId, { name: trimmed });
          renameOpenProjectTabs(session.projectId, trimmed);
        } catch (err) {
          toast.error(t("terminal.tab.renameFailed"), { description: String(err) });
        } finally {
          setEditingSessionId(null);
        }
        return;
      }

      renameSession(sessionId, trimmed);
      setEditingSessionId(null);
    },
    [renameOpenProjectTabs, renameSession, sessions, t, updateProject]
  );

  const renderWorkspanLeaf = useCallback((
    pane: TerminalPaneLeaf,
    layoutPanes: TerminalPaneLeaf[],
    layoutActiveSessionId: string | null,
    layoutVisible: boolean
  ) => (
    <MemoPaneLeafView
      key={pane.id}
      pane={pane}
      sessions={sessions}
      visibleSessionIds={scopedSessionIds}
      projects={projects}
      worktrees={worktrees}
      allPanes={layoutPanes}
      activeSessionId={layoutActiveSessionId}
      historyActive={historyActive}
      editingSessionId={editingSessionId}
      tabNotifications={tabNotifications}
      fontSize={fontSize}
      fontFamily={fontFamily}
      resolvedTheme={resolvedTheme}
      terminalThemeName={terminalThemeName}
      terminalThemeBackground={terminalThemeBackground}
      lightThemePalette={lightThemePalette}
      darkThemePalette={darkThemePalette}
      terminalBackgroundEnabled={terminalBackgroundEnabled}
      terminalBackgroundImagePath={terminalBackgroundImagePath}
      hiddenBackgroundSessionIds={hiddenBackgroundSessionIds}
      isPaneFullscreen={layoutVisible && activeFullscreenPaneId === pane.id}
      isLayoutVisible={layoutVisible && (!activeFullscreenPaneId || activeFullscreenPaneId === pane.id)}
      activeDropPreview={layoutVisible ? activeDropPreview : null}
      onActivateSession={handleActivateSession}
      onCloseSessions={handleCloseSessions}
      onStartEdit={setEditingSessionId}
      onSubmitEdit={(sessionId, title) => {
        void handleSubmitTabEdit(sessionId, title);
      }}
      onCancelEdit={() => setEditingSessionId(null)}
      onNewTab={() => void handleNewTab()}
      onDuplicateSession={handleDuplicateSession}
      onOpenSplitPicker={handleOpenSplitPicker}
      onUnsplit={(sessionId) => void unsplitTerminal(sessionId)}
      onMoveToPane={moveSessionToPane}
      onHideBackground={hideBackgroundForSession}
      onShowBackground={showBackgroundForSession}
      onTogglePaneFullscreen={handleTogglePaneFullscreen}
      onOpenWorktreeChanges={handleOpenWorktreeChanges}
      onOpenWorktreeHistory={handleOpenWorktreeHistory}
      onFinishWorktree={(project, worktree) => setFinishTarget({ project, worktree })}
      onInstallWorktreeDeps={handleInstallWorktreeDeps}
      onDiscardWorktree={(project, worktree) => setDiscardTarget({ project, worktree })}
      onOpenWorktreeDirectory={handleOpenWorktreeDirectory}
      hideTabBar={pane.sessionIds.length <= 1}
    />
  ), [
    activeFullscreenPaneId,
    activeDropPreview,
    darkThemePalette,
    editingSessionId,
    fontFamily,
    fontSize,
    handleActivateSession,
    handleCloseSessions,
    handleNewTab,
    handleDuplicateSession,
    handleOpenSplitPicker,
    handleOpenWorktreeChanges,
    handleOpenWorktreeHistory,
    handleOpenWorktreeDirectory,
    handleInstallWorktreeDeps,
    handleTogglePaneFullscreen,
    hiddenBackgroundSessionIds,
    hideBackgroundForSession,
    historyActive,
    lightThemePalette,
    moveSessionToPane,
    projects,
    handleSubmitTabEdit,
    resolvedTheme,
    scopedSessionIds,
    sessions,
    worktrees,
    showBackgroundForSession,
    tabNotifications,
    terminalThemeBackground,
    terminalBackgroundEnabled,
    terminalBackgroundImagePath,
    terminalThemeName,
    unsplitTerminal,
  ]);

  const hasScopedTerminalFilter = projectScopedTerminalViewEnabled && terminalScopeValue.kind !== "all";
  const scopedEmptyState = useMemo(() => {
    if (!hasScopedTerminalFilter) return null;

    if (terminalScopeValue.kind === "worktree") {
      const name = scopedWorktree?.name ?? scopedProject?.name ?? "";
      return {
        title: t("terminal.empty.worktreeTitle", { name }),
        description: t("terminal.empty.worktreeDescription", { name }),
        action:
          scopedProject && scopedWorktree
            ? { label: t("terminal.empty.worktreeAction", { name: scopedWorktree.name }), onClick: handleOpenScopedTerminal }
            : undefined,
      };
    }

    if (terminalScopeValue.kind === "group") {
      const name = scopedGroup?.name ?? "";
      return {
        title: t("terminal.empty.groupTitle", { name }),
        description: t("terminal.empty.groupDescription", { name }),
      };
    }

    const name = scopedProject?.name ?? "";
    return {
      title: t("terminal.empty.projectTitle", { name }),
      description: t("terminal.empty.projectDescription", { name }),
      action: scopedProject
        ? { label: t("terminal.empty.projectAction", { name: scopedProject.name }), onClick: handleOpenScopedTerminal }
        : undefined,
    };
  }, [
    handleOpenScopedTerminal,
    hasScopedTerminalFilter,
    scopedGroup?.name,
    scopedProject,
    scopedWorktree,
    t,
    terminalScopeValue,
  ]);

  return (
    <div
      className="ui-terminal-tabs-shell flex h-full min-h-0 flex-col"
      data-fullscreen={fullscreen ? "true" : "false"}
      style={terminalWellStyle}
    >
      <SplitProjectPicker
        picker={splitPicker}
        tree={projectTree}
        menuStyle={splitPickerMenuStyle}
        onSelectEmpty={handleSplitEmpty}
        onSelectProject={handleSplitProject}
        onClose={handleCloseSplitPicker}
        shouldIgnoreOutsideInteraction={shouldIgnoreSplitPickerOutsideInteraction}
      />
      <TerminalCloseConfirmBubble
        confirm={closeConfirm}
        menuStyle={splitPickerMenuStyle}
        onConfirm={confirmCloseSessions}
        onClose={cancelCloseSessions}
        shouldIgnoreOutsideInteraction={shouldIgnoreCloseConfirmOutsideInteraction}
      />
      <WorktreeFinishDialog
        open={!!finishTarget}
        project={finishTarget?.project ?? null}
        worktree={finishTarget?.worktree ?? null}
        onClose={() => setFinishTarget(null)}
      />
      <ConfirmDialog
        open={!!discardTarget}
        title={t("worktree.discard.title", { name: discardTarget?.worktree.name ?? "" })}
        message={t("worktree.discard.message", { branch: discardTarget?.worktree.branch ?? "" })}
        confirmText={t("worktree.discard.confirm")}
        cancelText={t("common.cancel")}
        danger
        onConfirm={() => {
          if (discardTarget) {
            void removeWorktree(discardTarget.worktree, true).catch((err) => {
              toast.error(t("worktree.toast.discardFailed"), { description: String(err) });
            });
          }
          setDiscardTarget(null);
        }}
        onClose={() => setDiscardTarget(null)}
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
          className="ui-terminal-well absolute inset-0 min-h-0 flex"
          data-terminal-mode="independent"
          data-terminal-theme-tone={terminalThemeTone}
          style={{ display: historyActive ? "none" : "flex" }}
        >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {visibleWorkspanLayouts.length > 0 ? (
              <DndContext
                sensors={sensors}
                collisionDetection={terminalTabCollisionDetection}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragCancel={clearDragState}
                onDragEnd={handleDragEnd}
              >
                <div
                  className="ui-terminal-pane-chrome ui-workspan-tabbar flex h-9 shrink-0 items-center overflow-x-auto px-1"
                  role="tablist"
                  aria-label={t("terminal.workspan.tabList")}
                >
                  <SortableContext
                    items={workspanTabModels.map(({ workspan }) => `${WORKSPAN_DRAG_PREFIX}${workspan.id}`)}
                    strategy={horizontalListSortingStrategy}
                  >
                    {workspanTabModels.map((model) => (
                      <SortableWorkspanTab
                        key={model.workspan.id}
                        workspan={model.workspan}
                        title={model.title}
                        notification={model.notification}
                        vendor={model.vendor}
                        isActive={model.workspan.id === effectiveActiveWorkspanId}
                        dragDisabled={hasScopedTerminalFilter}
                        renameDisabled={!model.singleSession}
                        onActivate={() => {
                          setActiveWorkspaceTab("terminal");
                          setActiveWorkspan(model.workspan.id);
                        }}
                        onClose={(anchor) => handleCloseSessions(model.closeSessionIds, anchor)}
                        onRename={(title) => {
                          if (model.singleSession) void handleSubmitTabEdit(model.singleSession.id, title);
                        }}
                      />
                    ))}
                  </SortableContext>
                </div>
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  {visibleWorkspanLayouts.map((layout) => {
                    const layoutVisible = layout.workspan.id === effectiveActiveWorkspanId;
                    const layoutActiveSessionId = layoutVisible
                      ? effectiveActiveSessionId
                      : layout.workspan.activeSessionId;
                    return (
                      <div
                        key={layout.workspan.id}
                        className="absolute inset-0 min-h-0 min-w-0 overflow-hidden"
                        style={{ display: layoutVisible ? "block" : "none" }}
                        aria-hidden={layoutVisible ? undefined : "true"}
                      >
                        <SplitTerminalView
                          node={layout.paneTree}
                          renderLeaf={(pane) => renderWorkspanLeaf(
                            pane,
                            layout.panes,
                            layoutActiveSessionId,
                            layoutVisible
                          )}
                          fullscreenLeafId={layoutVisible ? activeFullscreenPaneId : null}
                        />
                      </div>
                    );
                  })}
                  {preservedHiddenPtySessions.length > 0 && (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none fixed left-0 top-0 h-px w-px overflow-hidden opacity-0"
                      tabIndex={-1}
                    >
                      {preservedHiddenPtySessions.map((session) => (
                        <XTermTerminal
                          key={`preserve:${session.id}`}
                          sessionId={session.id}
                          isActive={false}
                          isVisible={false}
                          fontSize={fontSize}
                          fontFamily={fontFamily}
                          resolvedTheme={resolvedTheme}
                          terminalThemeName={terminalThemeName}
                          lightThemePalette={lightThemePalette}
                          darkThemePalette={darkThemePalette}
                        />
                      ))}
                    </div>
                  )}
                </div>
                <DragOverlay dropAnimation={null}>
                  {activeDragWorkspanModel ? (
                    <DragOverlayTab
                      title={activeDragWorkspanModel.title}
                      notification={activeDragWorkspanModel.notification}
                      vendor={activeDragWorkspanModel.vendor}
                    />
                  ) : activeDragSession ? (
                    <DragOverlayTab
                      title={activeDragSession.title}
                      notification={tabNotifications[activeDragSession.id] ?? "none"}
                      vendor={inferSessionVendor(activeDragSession)}
                    />
                  ) : null}
                </DragOverlay>
              </DndContext>
            ) : null}
            {hasScopedTerminalFilter && visibleSessions.length === 0 && !useExternalTerminal && scopedEmptyState && (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  icon={<Terminal size={40} strokeWidth={1} />}
                  title={scopedEmptyState.title}
                  description={scopedEmptyState.description}
                  tone="inverse"
                  action={scopedEmptyState.action}
                />
              </div>
            )}
            {sessions.length === 0 && !useExternalTerminal && !hasScopedTerminalFilter && (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  icon={<Terminal size={40} strokeWidth={1} />}
                  title={t("terminal.empty.title")}
                  description={t("terminal.empty.description")}
                  tone="inverse"
                  action={{ label: t("terminal.empty.action"), onClick: handleNewTab }}
                />
              </div>
            )}
          </div>
          {sidePanelMerged ? (
            <TerminalSidePanel
              open={sidePanelOpen}
              activeTab={sidePanelTab}
              activeSessionId={panelSessionId}
              projectPath={sidePanelProjectPath}
              filesTabDisabled={!filePanelProject}
              systemResourcesEnabled
              filesPanelContent={<FileExplorerSidebar mode="panel" onClosePanel={closeFilesPanel} />}
              onTabChange={handleSidePanelTabChange}
            />
          ) : (
            <>
              {statsOpen && (
                <ResizableTerminalPanelFrame
                  widthKey="stats"
                  defaultWidth={TERMINAL_PANEL_WIDTH_DEFAULTS.stats}
                  resizeLabel={t("terminal.panel.resizeStatsLabel")}
                  resizeTitle={t("terminal.panel.resizeStatsTitle")}
                >
                  <TerminalStatsPanel activeSessionId={panelSessionId} open={statsOpen} embedded />
                </ResizableTerminalPanelFrame>
              )}
              {gitOpen && (
                <ResizableTerminalPanelFrame
                  widthKey="git"
                  defaultWidth={TERMINAL_PANEL_WIDTH_DEFAULTS.git}
                  resizeLabel={t("terminal.panel.resizeGitLabel")}
                  resizeTitle={t("terminal.panel.resizeGitTitle")}
                >
                  <Suspense fallback={null}>
                    <GitChangesPanel open={gitOpen} projectPath={sidePanelProjectPath} embedded />
                  </Suspense>
                </ResizableTerminalPanelFrame>
              )}
              {replayOpen && (
                <ResizableTerminalPanelFrame
                  widthKey="replay"
                  defaultWidth={TERMINAL_PANEL_WIDTH_DEFAULTS.replay}
                  resizeLabel={t("terminal.panel.resizeReplayLabel")}
                  resizeTitle={t("terminal.panel.resizeReplayTitle")}
                >
                  <SessionReplayPanel activeSessionId={panelSessionId} open={replayOpen} />
                </ResizableTerminalPanelFrame>
              )}
              {filesOpen && (
                <ResizableTerminalPanelFrame
                  widthKey="files"
                  defaultWidth={TERMINAL_PANEL_WIDTH_DEFAULTS.files}
                  resizeLabel={t("terminal.panel.resizeFilesLabel")}
                  resizeTitle={t("terminal.panel.resizeFilesTitle")}
                >
                  <FileExplorerSidebar mode="panel" onClosePanel={closeFilesPanel} />
                </ResizableTerminalPanelFrame>
              )}
              {systemResourcesOpen && (
                <ResizableTerminalPanelFrame
                  widthKey="systemResources"
                  defaultWidth={TERMINAL_PANEL_WIDTH_DEFAULTS.systemResources}
                  resizeLabel={t("terminal.panel.resizeSystemResourcesLabel")}
                  resizeTitle={t("terminal.panel.resizeSystemResourcesTitle")}
                >
                  <SystemResourcesPanel open={systemResourcesOpen} embedded />
                </ResizableTerminalPanelFrame>
              )}
            </>
          )}
          {renderToolbarActions()}
        </div>
      </div>
    </div>
  );
}
