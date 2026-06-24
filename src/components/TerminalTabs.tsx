import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import { logError } from "../lib/logger";
import type { TerminalPaneDropEdge, TerminalPaneLeaf, TerminalPaneSplitDirection } from "../stores/terminalPaneTree";
import { collectPaneLeaves } from "../stores/terminalPaneTree";
import { SplitTerminalView } from "./SplitTerminalView";
import { XTermTerminal } from "./XTermTerminal";
import { CommandTemplatePanel } from "./CommandTemplatePanel";
import { CommandHistoryPanel } from "./CommandHistoryPanel";
import { TerminalStatsPanel } from "./terminal/TerminalStatsPanel";
import {
  ResizableTerminalPanelFrame,
  TerminalSidePanel,
  TERMINAL_GIT_PANEL_DEFAULT_WIDTH,
  TERMINAL_GIT_PANEL_WIDTH_STORAGE_KEY,
  TERMINAL_STATS_PANEL_DEFAULT_WIDTH,
  TERMINAL_STATS_PANEL_WIDTH_STORAGE_KEY,
  type TerminalSidePanelTab,
} from "./terminal/TerminalSidePanel";
import { SubagentTranscriptView } from "./terminal/SubagentTranscriptView";
import { openWindowsTerminal } from "../lib/externalTerminal";
import { resolveProjectStartupCommand } from "../lib/projectStartupCommand";
import { Terminal, Plus, ListClockIcon, X, Copy, Maximize2, Minimize2, ChevronDown, ChevronRight, BarChart3, GitBranch, Folder } from "./icons";
import { VendorIcon, inferVendor, type VendorKey } from "./VendorIcon";
import { EmptyState } from "./ui/EmptyState";
import { useHistoryStore } from "../stores/historyStore";
import { confirmTerminalTabClose } from "../lib/terminalCloseConfirm";
import type { HistorySourceFilter, Project, TerminalSession, TreeNode } from "../lib/types";
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
import { Portal } from "./ui/Portal";
import { getTerminalTheme } from "../lib/terminalThemes";

const HistoryWorkspace = lazy(() =>
  import("./HistoryWorkspace").then((module) => ({ default: module.HistoryWorkspace }))
);

const GitChangesPanel = lazy(() =>
  import("./git/GitChangesPanel").then((module) => ({ default: module.GitChangesPanel }))
);

const normalizeTabMenuHex = (value: string | undefined, fallback: string) => (
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
);

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
type SplitPickerAnchor = DOMRect | { x: number; y: number };
type SplitPickerAlign = "start" | "end";

type SplitPickerState = {
  sessionId: string;
  direction: TerminalPaneSplitDirection;
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
  if (!trimmed) return "PowerShell";

  const normalized = trimmed.toLowerCase();
  if (normalized === "powershell") return "PowerShell";
  if (normalized === "pwsh") return "PowerShell 7";
  if (normalized === "cmd") return "CMD";
  if (normalized === "wsl") return "WSL";
  if (normalized === "git-bash" || normalized === "git bash" || normalized === "gitbash") return "Git Bash";
  if (normalized === "bash") return "Bash";
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

  return {
    name: session.title.trim() || "Terminal",
    cli: formatCliToolLabel(project?.cli_tool),
    shell: formatShellLabel(session.shell ?? project?.shell ?? "powershell"),
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

// 终端 Tab 厂商图标：从启动命令 + 标题推断（未配自定义启动命令时 startupCmd 即为 cli_tool）
function inferSessionVendor(session: TerminalSession): VendorKey | null {
  return inferVendor(`${session.startupCmd ?? ""} ${session.title}`);
}

function parseProjectEnvVars(project?: Project): Record<string, string> | undefined {
  if (!project) return undefined;
  try {
    const parsed = JSON.parse(project.env_vars || "{}");
    if (typeof parsed === "object" && parsed !== null) {
      const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string");
      if (entries.length > 0) return Object.fromEntries(entries);
    }
  } catch {
    // ignore invalid env json
  }
  return undefined;
}

function buildProjectSplitOptions(project: Project): SplitTerminalOptions {
  const cmd = resolveProjectStartupCommand(project);
  const shell = project.shell && project.shell !== "powershell" ? project.shell : undefined;

  return {
    projectId: project.id,
    cwd: project.path,
    title: project.cli_tool ? `${project.name} (${project.cli_tool})` : project.name,
    startupCmd: cmd,
    envVars: parseProjectEnvVars(project),
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
  vendor?: VendorKey | null;
  hoverInfo: TerminalTabHoverInfo;
  onActivate: () => void;
  onClose: () => void;
  onStartEdit: () => void;
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
  isActive,
  isEditing,
  notification,
  vendor,
  hoverInfo,
  onActivate,
  onClose,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
  menuContent,
  menuClassName,
  menuStyle,
}: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, data: { paneId } });
  const tabElementRef = useRef<HTMLDivElement | null>(null);
  const contextMenuPointRef = useRef<SplitPickerAnchor | null>(null);
  const [editValue, setEditValue] = useState(title);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const skipNextBlurSubmitRef = useRef(false);
  const statusLabel = TAB_NOTIFICATION_LABELS[notification];
  const tabMinWidthClass = "min-w-[92px]";
  const [hoverCardPosition, setHoverCardPosition] = useState<{ left: number; top: number } | null>(null);
  const hoverOpenTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);

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
    if (isEditing || isDragging) return;
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
  }, [clearHoverCloseTimer, clearHoverOpenTimer, isDragging, isEditing]);

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

  return (
    <>
      <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setTabNodeRef}
          style={style}
          className={`ui-interactive ui-tab-trigger mx-1 flex h-7 ${tabMinWidthClass} max-w-[180px] shrink-0 cursor-pointer items-center gap-2 rounded-lg px-3 text-[12px] font-medium`}
          data-terminal-tab-id={id}
          data-selected={isActive ? "true" : "false"}
          onClick={onActivate}
          onPointerEnter={scheduleHoverCard}
          onPointerLeave={scheduleHideHoverCard}
          onDoubleClick={() => {
            hideHoverCard();
            onStartEdit();
          }}
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
            <span className="inline-flex shrink-0 items-center" aria-hidden="true">
              <VendorIcon vendor={vendor} size={14} />
            </span>
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
              aria-label={`重命名终端 ${title}`}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate tracking-[0.01em]">{title}</span>
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
      <ContextMenuContent className={menuClassName} style={menuStyle}>{menuContent(getTabAnchor)}</ContextMenuContent>
      </ContextMenu>
      {hoverCardPosition && !isEditing && !isDragging && (
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
  const rows = [
    { label: "CLI", value: info.cli },
    { label: "Shell", value: info.shell },
    { label: "\u9879\u76ee", value: info.project },
    { label: "\u8def\u5f84", value: info.path },
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
            aria-label="Copy Session ID"
            title="Copy Session ID"
          >
            <Copy size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>
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
      className={`ui-tab-trigger ui-terminal-drag-overlay-tab mx-1 flex h-7 ${tabMinWidthClass} max-w-[180px] items-center gap-2 rounded-lg px-3 text-[12px] font-medium`}
      data-selected="true"
    >
      <span
        className="ui-tab-runtime-dot w-2 h-2 rounded-full shrink-0"
        data-pulsing={PULSING_TAB_STATES.has(notification) ? "true" : "false"}
        style={{ backgroundColor: TAB_NOTIFICATION_COLORS[notification], color: TAB_NOTIFICATION_COLORS[notification] }}
        aria-hidden="true"
      />
      {vendor && (
        <span className="inline-flex shrink-0 items-center" aria-hidden="true">
          <VendorIcon vendor={vendor} size={14} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate tracking-[0.01em]">{title}</span>
    </div>
  );
}

interface PaneTabBarProps {
  pane: TerminalPaneLeaf;
  sessions: TerminalSession[];
  projects: Project[];
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
  onActivateSession: (sessionId: string) => void;
  onCloseSessions: (sessionIds: string[]) => void;
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
  variant?: "global" | "pane";
}

function PaneTabBar({
  pane,
  sessions,
  projects,
  allPanes,
  activeSessionId,
  editingSessionId,
  tabNotifications,
  terminalBackgroundEnabled,
  terminalBackgroundImagePath,
  hiddenBackgroundSessionIds,
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
  variant = "pane",
  resolvedTheme,
  terminalThemeName,
  lightThemePalette,
  darkThemePalette,
}: PaneTabBarProps) {
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
    const isLastTab = pane.sessionIds[pane.sessionIds.length - 1] === activeSessionId;
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
  }, [pane.activeSessionId, pane.sessionIds, updateTabScrollState]);

  const activatePaneSessionAt = useCallback((index: number) => {
    const session = paneSessions[index];
    if (!session) return;
    onActivateSession(session.id);
  }, [onActivateSession, paneSessions]);

  const closePaneSessions = useCallback((sessionIds: string[]) => {
    onCloseSessions(sessionIds);
  }, [onCloseSessions]);

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
              vendor={inferSessionVendor(session)}
              hoverInfo={buildTerminalTabHoverInfo(session, session.projectId ? projectById.get(session.projectId) : undefined)}
              onActivate={() => onActivateSession(session.id)}
              onClose={() => closePaneSessions([session.id])}
              onStartEdit={() => onStartEdit(session.id)}
              onSubmitEdit={(title) => onSubmitEdit(session.id, title)}
              onCancelEdit={onCancelEdit}
              menuClassName="terminal-skin"
              menuStyle={tabMenuStyle}
              menuContent={(getAnchor) => (
                <>
                  <ContextMenuItem onSelect={() => closePaneSessions([session.id])}>关闭终端</ContextMenuItem>
                  <ContextMenuItem onSelect={() => closeOtherPaneSessions(session.id)}>关闭其它终端</ContextMenuItem>
                  <ContextMenuItem onSelect={() => closePaneSessionsToLeft(session.id)}>关闭左侧终端</ContextMenuItem>
                  <ContextMenuItem onSelect={() => closePaneSessionsToRight(session.id)}>关闭右侧终端</ContextMenuItem>
                  <ContextMenuItem onSelect={onNewTab}>新建终端</ContextMenuItem>
                  <ContextMenuItem onSelect={() => onDuplicateSession(session)}>复制</ContextMenuItem>
                  {terminalBackgroundEnabled && terminalBackgroundImagePath && (
                    hiddenBackgroundSessionIds.has(session.id) ? (
                      <ContextMenuItem onSelect={() => onShowBackground(session.id)}>显示背景图</ContextMenuItem>
                    ) : (
                      <ContextMenuItem onSelect={() => onHideBackground(session.id)}>隐藏背景图</ContextMenuItem>
                    )
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => onOpenSplitPicker(session.id, "horizontal", getAnchor())}>
                    向右分屏
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onOpenSplitPicker(session.id, "vertical", getAnchor())}>
                    向下分屏
                  </ContextMenuItem>
                  {allPanes.length > 1 && <ContextMenuItem onSelect={() => onUnsplit(session.id)}>取消分屏</ContextMenuItem>}
                  {otherPanes.length > 0 && (
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>移动到其他分屏</ContextMenuSubTrigger>
                      <ContextMenuSubContent className="terminal-skin" style={tabMenuStyle}>
                        {otherPanes.map((targetPane, index) => (
                          <ContextMenuItem key={targetPane.id} onSelect={() => onMoveToPane(session.id, targetPane.id)}>
                            分屏 {index + 1}
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
    </div>
  );
}

interface PaneLeafViewProps {
  pane: TerminalPaneLeaf;
  sessions: TerminalSession[];
  projects: Project[];
  allPanes: TerminalPaneLeaf[];
  activeSessionId: string | null;
  historyActive: boolean;
  editingSessionId: string | null;
  tabNotifications: Record<string, TabNotificationState>;
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
  onCloseSessions: (sessionIds: string[]) => void;
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
  hideTabBar?: boolean;
}

function PaneLeafView({
  pane,
  sessions,
  projects,
  allPanes,
  activeSessionId,
  historyActive,
  editingSessionId,
  tabNotifications,
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
          projects={projects}
          allPanes={allPanes}
          activeSessionId={activeSessionId}
          editingSessionId={editingSessionId}
          tabNotifications={tabNotifications}
          terminalBackgroundEnabled={terminalBackgroundEnabled}
          terminalBackgroundImagePath={terminalBackgroundImagePath}
          hiddenBackgroundSessionIds={hiddenBackgroundSessionIds}
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
          resolvedTheme={resolvedTheme}
          terminalThemeName={terminalThemeName}
          lightThemePalette={lightThemePalette}
          darkThemePalette={darkThemePalette}
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
            {session.kind === "subagent-transcript" ? (
              <SubagentTranscriptView sessionId={session.id} title={session.title} />
            ) : (
              <XTermTerminal
                sessionId={session.id}
                isActive={!historyActive && session.id === activeSessionId}
                isVisible={!historyActive && session.id === pane.activeSessionId}
                fontSize={fontSize}
                fontFamily={fontFamily}
                resolvedTheme={resolvedTheme}
                terminalThemeName={terminalThemeName}
                lightThemePalette={lightThemePalette}
                darkThemePalette={darkThemePalette}
                onNewTab={onNewTab}
                onCloseSession={() => onCloseSessions([session.id])}
                onCloseOthers={
                  pane.sessionIds.length > 1
                    ? () => onCloseSessions(pane.sessionIds.filter((id) => id !== session.id))
                    : undefined
                }
                onCloseToLeft={
                  pane.sessionIds.indexOf(session.id) > 0
                    ? () => onCloseSessions(pane.sessionIds.slice(0, pane.sessionIds.indexOf(session.id)))
                    : undefined
                }
                onCloseToRight={
                  pane.sessionIds.indexOf(session.id) < pane.sessionIds.length - 1
                    ? () => onCloseSessions(pane.sessionIds.slice(pane.sessionIds.indexOf(session.id) + 1))
                    : undefined
                }
                onSplitRight={(point) => onOpenSplitPicker(session.id, "horizontal", point)}
                onSplitDown={(point) => onOpenSplitPicker(session.id, "vertical", point)}
              />
            )}
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
  tree: TreeNode[];
  menuStyle: CSSProperties;
  onSelectEmpty: () => void;
  onSelectProject: (project: Project) => void;
  onClose: () => void;
  shouldIgnoreOutsideInteraction: () => boolean;
}

function SplitProjectPicker({ picker, tree, menuStyle, onSelectEmpty, onSelectProject, onClose, shouldIgnoreOutsideInteraction }: SplitProjectPickerProps) {
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
        <div className="ui-split-project-picker-title px-2 py-1 text-xs font-semibold">选择分屏终端</div>
        <button
          type="button"
          onClick={onSelectEmpty}
          className="ui-tree-node ui-tree-project ui-split-project-picker-item ui-focus-ring mt-1 flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[13px]"
        >
          <span className="ui-tree-leading-icon"><Terminal size={14} strokeWidth={1.5} /></span>
          <span className="min-w-0 flex-1 truncate font-medium">空终端</span>
        </button>
        <div className="mt-1 max-h-72 space-y-0.5 overflow-y-auto">
          {tree.map((node) => renderTreeNode(node, 0))}
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
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    cursor: "grab",
  };

  return (
    <div ref={setNodeRef} style={style} className="ui-terminal-action-sort-item flex w-full justify-center" {...attributes} {...listeners}>
      {children}
    </div>
  );
}

interface TerminalTabsProps {
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export function TerminalTabs({ fullscreen = false, onToggleFullscreen }: TerminalTabsProps = {}) {
  const { sessions, activeSessionId, paneTree, tabNotifications } = useTerminalStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      paneTree: s.paneTree,
      tabNotifications: s.tabNotifications,
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
  const { projects, tree: projectTree } = useProjectStore(
    useShallow((s) => ({
      projects: s.projects,
      tree: s.tree,
    }))
  );
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
  const terminalToolbarOrder = useSettingsStore((s) => s.terminalToolbarOrder);
  const sidePanelMerged = useSettingsStore((s) => s.terminalSidePanelMerged);
  const updateSettings = useSettingsStore((s) => s.update);
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
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [sidePanelTab, setSidePanelTab] = useState<TerminalSidePanelTab>("stats");
  // 非合并模式：实时统计与 Git 变更各自独立开关，可并排显示
  const [statsOpen, setStatsOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [activeToolbarDragId, setActiveToolbarDragId] = useState<string | null>(null);
  const splitPickerOpenFrameRef = useRef<number | null>(null);
  const splitPickerOpenTimerRef = useRef<number | null>(null);
  const splitPickerOutsideGuardUntilRef = useRef(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const toolbarSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const allPanes = useMemo(() => collectPaneLeaves(paneTree), [paneTree]);
  const activeSession = useMemo(
    () => activeSessionId ? sessions.find((session) => session.id === activeSessionId) ?? null : null,
    [activeSessionId, sessions]
  );
  // 子 Agent 转录伪会话没有自己的 CLI 会话/项目：实时统计与 Git 面板落到其父终端，
  // 避免聚焦转录 Tab 时面板被清空/错位。
  const panelSession = useMemo(() => {
    if (activeSession?.kind === "subagent-transcript" && activeSession.subagent) {
      return sessions.find((session) => session.id === activeSession.subagent!.parentSessionId) ?? activeSession;
    }
    return activeSession;
  }, [activeSession, sessions]);
  const panelSessionId = panelSession?.id ?? null;
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
  } as CSSProperties;
  const historyActive = historyOpen && activeWorkspaceTab === "history";
  const statsPanelActive = sidePanelMerged ? sidePanelOpen && sidePanelTab === "stats" : statsOpen;
  const gitPanelActive = sidePanelMerged ? sidePanelOpen && sidePanelTab === "git" : gitOpen;

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
    const newTerminalContext = activeSession?.kind === "subagent-transcript"
      ? { cwd: undefined, title: "Terminal" }
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

  const handleDuplicateSession = useCallback((session: TerminalSession) => {
    void createSession(
      session.projectId,
      session.cwd,
      session.title,
      session.startupCmd,
      session.envVars ? { ...session.envVars } : undefined,
      session.shell ?? undefined,
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

  const handleCloseSessions = useCallback((sessionIds: string[]) => {
    const uniqueSessionIds = Array.from(new Set(sessionIds)).filter((sessionId) => sessions.some((session) => session.id === sessionId));
    if (!confirmTerminalTabClose(uniqueSessionIds.length)) return;
    uniqueSessionIds.forEach((sessionId) => void closeSession(sessionId));
  }, [closeSession, sessions]);

  const ensureStatsPanelAllowed = useCallback(async () => {
    try {
      const settings = useSettingsStore.getState();
      const status = await invoke<{ claude: { status: string }; codex: { status: string } }>(
        "hook_settings_get_status",
        {
          selectedDir: settings.claudeHookConfigDir?.trim() || null,
          codexSelectedDir: settings.codexHookConfigDir?.trim() || null,
        }
      );
      if (status.claude.status !== "installed" && status.codex.status !== "installed") {
        toast.warning("实时统计需要先安装 Hook", {
          description: "实时统计依赖 Claude/Codex Hook 上报 sessionId。请先到设置 → Hook 设置中安装对应工具的 Hook。",
        });
        return false;
      }
    } catch (err) {
      logError("Failed to check hook status before opening terminal stats panel", err);
    }
    return true;
  }, []);

  const handleToggleStatsPanel = useCallback(async () => {
    if (statsPanelActive) {
      if (sidePanelMerged) setSidePanelOpen(false);
      else setStatsOpen(false);
      return;
    }
    const allowed = await ensureStatsPanelAllowed();
    if (!allowed) return;
    if (sidePanelMerged) {
      setSidePanelTab("stats");
      setSidePanelOpen(true);
    } else {
      // 窄屏下退化为单面板：打开实时统计时收起 Git，避免挤压终端
      if (window.innerWidth < 1100) setGitOpen(false);
      setStatsOpen(true);
    }
  }, [ensureStatsPanelAllowed, sidePanelMerged, statsPanelActive]);

  const handleToggleGitChangesPanel = useCallback(() => {
    if (gitPanelActive) {
      if (sidePanelMerged) setSidePanelOpen(false);
      else setGitOpen(false);
      return;
    }
    if (sidePanelMerged) {
      setSidePanelTab("git");
      setSidePanelOpen(true);
    } else {
      // 窄屏下退化为单面板：打开 Git 时收起实时统计，避免挤压终端
      if (window.innerWidth < 1100) setStatsOpen(false);
      setGitOpen(true);
    }
  }, [gitPanelActive, sidePanelMerged]);

  const handleSidePanelTabChange = useCallback((tab: TerminalSidePanelTab) => {
    if (tab === "stats") {
      void ensureStatsPanelAllowed().then((allowed) => {
        if (allowed) setSidePanelTab("stats");
      });
      return;
    }
    setSidePanelTab(tab);
  }, [ensureStatsPanelAllowed]);

  // 响应式约束：非合并模式下两个面板各占固定宽度，窗口过窄时会挤压终端。
  // 同时打开且窗口 < 1100px 时自动收起 Git 面板（保留实时统计），并随窗口缩小持续生效。
  useEffect(() => {
    if (sidePanelMerged || !statsOpen || !gitOpen) return;
    const enforce = () => {
      if (window.innerWidth < 1100) setGitOpen(false);
    };
    enforce();
    window.addEventListener("resize", enforce);
    return () => window.removeEventListener("resize", enforce);
  }, [sidePanelMerged, statsOpen, gitOpen]);

  const handleOpenHistoryTab = useCallback(() => {
    if (historyOpen) {
      closeHistory();
      return;
    }

    const project = activeSession?.projectId ? projects.find((item) => item.id === activeSession.projectId) : undefined;
    setActiveWorkspaceTab("history");
    void openHistory({
      sourceFilter: resolveHistorySourceFilter(project?.cli_tool),
      projectPath: project?.path ?? null,
    });
  }, [activeSession, closeHistory, historyOpen, openHistory, projects]);

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

  const renderToolbarActions = useCallback(() => {
    const buttonMap: Record<string, ReactNode> = {
      new: (
        <button
          onClick={handleNewTab}
          className="ui-focus-ring ui-icon-action ui-primary-action ui-action-new"
          title="新建终端"
          aria-label="新建终端"
        >
          <Plus size={15} strokeWidth={2} />
        </button>
      ),
      templates: <CommandTemplatePanel popoverSide="left" toneClassName="ui-action-template" />,
      commandHistory: <CommandHistoryPanel compact popoverSide="left" toneClassName="ui-action-command-history" />,
      fullscreen: onToggleFullscreen ? (
        <button
          onClick={onToggleFullscreen}
          className="ui-focus-ring ui-icon-action ui-action-fullscreen"
          data-active={fullscreen ? "true" : "false"}
          title={fullscreen ? "退出沉浸式全屏" : "沉浸式全屏"}
          aria-label={fullscreen ? "退出沉浸式全屏" : "进入沉浸式全屏"}
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
          title={`会话历史（${sessionHistoryShortcutHint}）`}
          aria-label={historyOpen ? "关闭会话历史" : "打开会话历史"}
          aria-controls="history-workspace"
          aria-expanded={historyOpen}
        >
          <ListClockIcon size={16} />
          {terminalToolbarVisibility.showText && <span>会话历史</span>}
        </button>
      ),
      gitChanges: (
        <button
          onClick={handleToggleGitChangesPanel}
          className="ui-focus-ring ui-icon-action ui-action-git"
          data-active={gitPanelActive ? "true" : "false"}
          title={gitPanelActive ? "关闭 Git 变更" : "打开 Git 变更"}
          aria-label={gitPanelActive ? "关闭 Git 变更面板" : "打开 Git 变更面板"}
          aria-pressed={gitPanelActive}
        >
          <GitBranch size={13} strokeWidth={1.8} />
        </button>
      ),
      stats: (
        <button
          onClick={handleToggleStatsPanel}
          className="ui-focus-ring ui-icon-action ui-action-stats"
          data-active={statsPanelActive ? "true" : "false"}
          title={statsPanelActive ? "关闭统计面板" : "打开统计面板"}
          aria-label={statsPanelActive ? "关闭统计面板" : "打开统计面板"}
          aria-pressed={statsPanelActive}
        >
          <BarChart3 size={13} strokeWidth={1.8} />
        </button>
      ),
    };

    const visibleButtons = terminalToolbarOrder
      .filter((key) => {
        if (key === "new") return true;
        if (key === "fullscreen" && !onToggleFullscreen) return false;
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
          aria-label="终端操作侧边栏"
        >
          <SortableContext items={visibleButtons.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            {visibleButtons.map((btn) => (
              <SortableToolbarButton key={btn.id} id={btn.id} isDragging={activeToolbarDragId === btn.id}>
                {btn.element}
              </SortableToolbarButton>
            ))}
          </SortableContext>
        </nav>
        <DragOverlay dropAnimation={null}>
          {activeToolbarDragId && buttonMap[activeToolbarDragId] ? (
            <div className="ui-terminal-action-drag-overlay cursor-grabbing" style={{ opacity: 1 }}>
              {buttonMap[activeToolbarDragId]}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    );
  }, [
    activeToolbarDragId,
    fullscreen,
    gitPanelActive,
    handleNewTab,
    handleOpenHistoryTab,
    handleToggleGitChangesPanel,
    handleToggleStatsPanel,
    handleToolbarDragCancel,
    handleToolbarDragEnd,
    handleToolbarDragStart,
    historyOpen,
    onToggleFullscreen,
    sessionHistoryShortcutHint,
    statsPanelActive,
    terminalToolbarOrder,
    terminalToolbarVisibility,
    toolbarSensors,
  ]);

  const renderLeaf = useCallback((pane: TerminalPaneLeaf) => (
    <PaneLeafView
      key={pane.id}
      pane={pane}
      sessions={sessions}
      projects={projects}
      allPanes={allPanes}
      activeSessionId={activeSessionId}
      historyActive={historyActive}
      editingSessionId={editingSessionId}
      tabNotifications={tabNotifications}
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
      onCloseSessions={handleCloseSessions}
      onStartEdit={setEditingSessionId}
      onSubmitEdit={(sessionId, title) => {
        renameSession(sessionId, title);
        setEditingSessionId(null);
      }}
      onCancelEdit={() => setEditingSessionId(null)}
      onNewTab={() => void handleNewTab()}
      onDuplicateSession={handleDuplicateSession}
      onOpenSplitPicker={handleOpenSplitPicker}
      onUnsplit={(sessionId) => void unsplitTerminal(sessionId)}
      onMoveToPane={moveSessionToPane}
      onHideBackground={hideBackgroundForSession}
      onShowBackground={showBackgroundForSession}
      hideTabBar={false}
    />
  ), [
    activeSessionId,
    activeDropPreview,
    allPanes,
    darkThemePalette,
    editingSessionId,
    effectiveTerminalThemeName,
    fontFamily,
    fontSize,
    handleActivateSession,
    handleCloseSessions,
    handleNewTab,
    handleDuplicateSession,
    handleOpenSplitPicker,
    hiddenBackgroundSessionIds,
    hideBackgroundForSession,
    historyActive,
    lightThemePalette,
    moveSessionToPane,
    projects,
    renameSession,
    resolvedTheme,
    sessions,
    showBackgroundForSession,
    tabNotifications,
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
        tree={projectTree}
        menuStyle={splitPickerMenuStyle}
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
          className="ui-terminal-well absolute inset-0 min-h-0 flex"
          data-terminal-mode={terminalThemeMode}
          style={{ display: historyActive ? "none" : "flex" }}
        >
          <div className="flex-1 min-h-0 min-w-0">
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
                      vendor={inferSessionVendor(activeDragSession)}
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
          {sidePanelMerged ? (
            <TerminalSidePanel
              open={sidePanelOpen}
              activeTab={sidePanelTab}
              activeSessionId={panelSessionId}
              projectPath={panelSession?.cwd ?? null}
              onTabChange={handleSidePanelTabChange}
            />
          ) : (
            <>
              {statsOpen && (
                <ResizableTerminalPanelFrame
                  storageKey={TERMINAL_STATS_PANEL_WIDTH_STORAGE_KEY}
                  defaultWidth={TERMINAL_STATS_PANEL_DEFAULT_WIDTH}
                  resizeLabel="调整实时统计面板宽度"
                  resizeTitle="拖拽调整实时统计面板宽度"
                >
                  <TerminalStatsPanel activeSessionId={panelSessionId} open={statsOpen} embedded />
                </ResizableTerminalPanelFrame>
              )}
              {gitOpen && (
                <ResizableTerminalPanelFrame
                  storageKey={TERMINAL_GIT_PANEL_WIDTH_STORAGE_KEY}
                  defaultWidth={TERMINAL_GIT_PANEL_DEFAULT_WIDTH}
                  resizeLabel="调整 Git 变更面板宽度"
                  resizeTitle="拖拽调整 Git 变更面板宽度"
                >
                  <Suspense fallback={null}>
                    <GitChangesPanel open={gitOpen} projectPath={panelSession?.cwd ?? null} embedded />
                  </Suspense>
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
