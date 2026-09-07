import type { LucideIcon } from "lucide-react";
import {
  closestCenter, pointerWithin, type CollisionDetection, type DragEndEvent, type DragOverEvent,
} from "@dnd-kit/core";
import { type SplitTerminalOptions, type TabNotificationState } from "../state";
import { useSshHostStore } from "../../remote/api/sshHostStore";
import { type TranslationKey } from "../../../shared/i18n/index";
import { WORKSPAN_DRAG_PREFIX } from "../../workspace/api/dragInteraction";
import type { TerminalPaneDropEdge, TerminalPaneSplitDirection } from "../api/terminalPaneTree";
import { resolvePaneDropEdgeFromPoint } from "../api/terminalPaneTree";
import { resolveProjectPath } from "../../projects/api/groupPath";
import { resolveProjectStartupCommand } from "../../projects/api/projectStartupCommand";
import { resolveCliToolHistorySourceId, resolveCliToolIconKey, type CliToolIconKey } from "../../../shared/lib/cliTools";
import { parseProjectEnvVars } from "../../providers/api/providerSwitching";
import { inferVendor, type VendorKey } from "../../../shared/ui/VendorIcon";
import type { Group, HistorySourceFilter, Project, TerminalScope, TerminalSession } from "../../../shared/types/index";
import { WORKSPAN_TABBAR_END_DROP_ID } from "../../workspace/api/WorkspanTabBar";

export const normalizeTabMenuHex = (value: string | undefined, fallback: string) => (
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
);

export const TERMINAL_PANEL_SEMANTIC_COLORS = {
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

export const tabMenuHexToRgba = (value: string | undefined, alpha: number, fallback: string) => {
  const normalized = normalizeTabMenuHex(value, "");
  if (!normalized) return fallback;
  const hex = normalized.slice(1);
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export const TAB_NOTIFICATION_LABELS: Record<TabNotificationState, TranslationKey> = {
  none: "terminal.status.none",
  running: "terminal.status.running",
  attention: "terminal.status.attention",
  done: "terminal.status.done",
  failed: "terminal.status.failed",
};

export const PANE_DROP_PREFIX = "pane-drop:";

export const PANE_CENTER_DROP_PREFIX = "pane-center:";

export const PANE_EDGE_DROP_PREFIX = "pane-edge:";

export const WORKSPAN_SPLIT_ACTIVATION_RATIO = 0.08;

export const PANE_DROP_EDGES: TerminalPaneDropEdge[] = ["left", "right", "top", "bottom"];

export const WORKSPAN_NOTIFICATION_PRIORITY: Record<TabNotificationState, number> = {
  none: 0,
  done: 1,
  running: 2,
  failed: 3,
  attention: 4,
};

export const SPLIT_PICKER_OUTSIDE_GUARD_MS = 250;

export type SplitPickerAnchor = DOMRect | { x: number; y: number };

export type SplitPickerAlign = "start" | "end";

export type SplitPickerState = {
  sessionId: string;
  direction: TerminalPaneSplitDirection;
  x: number;
  y: number;
  align: SplitPickerAlign;
} | null;

export type TerminalCloseConfirmState = {
  sessionIds: string[];
  x: number;
  y: number;
  align: SplitPickerAlign;
} | null;

export type PaneDropTarget =
  | { type: "center"; paneId: string }
  | { type: "edge"; paneId: string; edge: TerminalPaneDropEdge };

export type PaneDropPreview = { paneId: string; edge: TerminalPaneDropEdge } | null;

export const TERMINAL_TAB_HOVER_DELAY_MS = 260;

export const TERMINAL_TAB_HOVER_CLOSE_DELAY_MS = 320;

export const TERMINAL_TAB_HOVER_CARD_WIDTH = 320;

export const TERMINAL_TAB_HOVER_CARD_ESTIMATED_HEIGHT = 190;

export const SSH_CONNECTION_STATE_COLORS: Record<NonNullable<TerminalSession["connectionState"]>, string> = {
  connecting: "#60a5fa",
  authenticating: "#f59e0b",
  connected: "#22c55e",
  disconnected: "#94a3b8",
  failed: "#ef4444",
};

export interface TerminalTabHoverInfo {
  name: string;
  cli: string;
  cliVendor: VendorKey | null;
  shell: string;
  project: string;
  path: string;
  sessionId: string;
  sshHost?: string;
  connectionState?: TerminalSession["connectionState"];
  disconnectReason?: TerminalSession["disconnectReason"];
}

export interface TerminalTabHoverRow {
  key: string;
  label: string;
  value: string;
  icon: LucideIcon;
  vendor?: VendorKey | null;
  copyValue?: string;
  copyLabel?: string;
}

export function isTerminalPaneDropEdge(value: string): value is TerminalPaneDropEdge {
  return PANE_DROP_EDGES.includes(value as TerminalPaneDropEdge);
}

export function getWorkspanNotification(
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

export function parsePaneDropTarget(id: string): PaneDropTarget | null {
  if (id.startsWith(PANE_CENTER_DROP_PREFIX)) return { type: "center", paneId: id.slice(PANE_CENTER_DROP_PREFIX.length) };
  if (id.startsWith(PANE_DROP_PREFIX)) return { type: "center", paneId: id.slice(PANE_DROP_PREFIX.length) };
  if (!id.startsWith(PANE_EDGE_DROP_PREFIX)) return null;

  const payload = id.slice(PANE_EDGE_DROP_PREFIX.length);
  const [paneId, edge] = payload.split(":");
  if (!paneId || !edge || !isTerminalPaneDropEdge(edge)) return null;
  return { type: "edge", paneId, edge };
}

export function isPaneDropCollisionId(id: string): boolean {
  return id.startsWith(PANE_EDGE_DROP_PREFIX) || id.startsWith(PANE_CENTER_DROP_PREFIX) || id.startsWith(PANE_DROP_PREFIX);
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function formatCliToolLabel(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "Terminal";

  const normalized = trimmed.toLowerCase();
  if (normalized.includes("claude")) return "Claude";
  if (normalized.includes("codex") || normalized === "code") return "Codex";
  return trimmed;
}

export function formatShellLabel(value: string | null | undefined): string {
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

export function formatSessionIdPreview(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 18) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-6)}`;
}

export function buildTerminalTabHoverInfo(session: TerminalSession, project?: Project): TerminalTabHoverInfo {
  if (session.kind === "subagent-transcript") {
    return {
      name: session.title.trim() || "Terminal",
      cli: "Subagent",
      cliVendor: null,
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
      cliVendor: null,
      shell: formatShellLabel(session.shell ?? project?.shell),
      project: project?.name.trim() || session.syncedHistory?.title || "\u672a\u7ed1\u5b9a\u9879\u76ee",
      path: session.syncedHistory?.cwd || session.cwd?.trim() || project?.path.trim() || "-",
      sessionId: session.syncedHistory?.key || session.id,
    };
  }
  const sshHost = session.environmentType === "ssh"
    ? useSshHostStore.getState().hosts.find((host) => host.id === session.sshHostId)
    : undefined;
  return {
    name: session.title.trim() || "Terminal",
    cli: formatCliToolLabel(project?.cli_tool),
    cliVendor: inferVendor(project?.cli_tool) ?? inferSessionVendor(session),
    shell: session.environmentType === "ssh" ? "SSH" : formatShellLabel(session.shell ?? project?.shell),
    project: project?.name.trim() || "\u672a\u7ed1\u5b9a\u9879\u76ee",
    path: session.remotePath?.trim() || session.cwd?.trim() || project?.remote_path.trim() || project?.path.trim() || "-",
    sessionId: session.cliSessionId?.trim() || session.id,
    sshHost: sshHost?.name || sshHost?.config_alias || sshHost?.host || session.sshHostId,
    connectionState: session.connectionState,
    disconnectReason: session.disconnectReason,
  };
}

export const terminalTabCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  const edgeCollision = pointerCollisions.find((collision) => String(collision.id).startsWith(PANE_EDGE_DROP_PREFIX));
  if (edgeCollision) return [edgeCollision];

  const centerCollision = pointerCollisions.find((collision) => String(collision.id).startsWith(PANE_CENTER_DROP_PREFIX));
  if (centerCollision) return [centerCollision];

  if (String(args.active.id).startsWith(WORKSPAN_DRAG_PREFIX)) {
    const workspanTabCollision = pointerCollisions.find((collision) => String(collision.id).startsWith(WORKSPAN_DRAG_PREFIX));
    return workspanTabCollision ? [workspanTabCollision] : [];
  }

  const workspanTabCollision = pointerCollisions.find((collision) => String(collision.id).startsWith(WORKSPAN_DRAG_PREFIX));
  if (workspanTabCollision) return [workspanTabCollision];

  const workspanTabbarEndCollision = pointerCollisions.find((collision) => collision.id === WORKSPAN_TABBAR_END_DROP_ID);
  if (workspanTabbarEndCollision) return [workspanTabbarEndCollision];

  const closestCollisions = closestCenter(args);
  const tabCollision = closestCollisions.find((collision) => {
    const id = String(collision.id);
    return !isPaneDropCollisionId(id)
      && !id.startsWith(WORKSPAN_DRAG_PREFIX)
      && id !== WORKSPAN_TABBAR_END_DROP_ID;
  });
  if (tabCollision) return [tabCollision];

  const paneBarCollision = pointerCollisions.find((collision) => String(collision.id).startsWith(PANE_DROP_PREFIX));
  return paneBarCollision ? [paneBarCollision] : closestCollisions;
};

export function resolveWorkspanDropEdge(
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

export function resolveHistorySourceFilter(cliTool: string | null | undefined): HistorySourceFilter {
  return resolveCliToolHistorySourceId(cliTool) ?? "all";
}

export function inferSessionVendor(session: TerminalSession): VendorKey | null {
  return inferVendor(`${session.startupCmd ?? ""} ${session.title}`);
}

export function inferSessionCliToolIcon(session: TerminalSession, project?: Project): CliToolIconKey | null {
  return (
    resolveCliToolIconKey(project?.cli_tool)
    ?? resolveCliToolIconKey(session.startupCmd)
    ?? resolveCliToolIconKey(session.title)
  );
}

export function buildProjectSplitOptions(project: Project, groups: Group[]): SplitTerminalOptions {
  const cmd = resolveProjectStartupCommand(project);
  const shell = project.shell && project.shell !== "powershell" ? project.shell : undefined;

  return {
    projectId: project.id,
    cwd: resolveProjectPath(project, groups),
    title: project.name,
    startupCmd: cmd,
    envVars: parseProjectEnvVars(project),
    shell,
  };
}

export interface TerminalTabsProps {
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  projectScopedTerminalViewEnabled?: boolean;
  terminalScope?: TerminalScope;
  onOpenProviderSettings?: () => void;
  onOpenHistorySettings?: () => void;
}
