import { formatAbsoluteProjectFilePath, formatTerminalDragPath } from "./aiPathFormatter";
import type { Project, ProjectFileEntry } from "./types";

export const TERMINAL_FILE_DRAG_MIME = "application/x-cli-manager-file-drag";

export type TerminalFileDragProject = Pick<
  Project,
  "id" | "name" | "path" | "remote_path" | "environment_type" | "ssh_host_id" | "cli_tool"
>;

export interface TerminalFileDragPayload {
  text: string;
  absolutePath: string;
  source: Pick<Project, "id" | "path" | "remote_path" | "environment_type" | "ssh_host_id">;
}

interface TerminalDropZone {
  id: string;
  getRect: () => DOMRect | null;
  paste: (payload: TerminalFileDragPayload) => void;
  focus: () => void;
}

interface TerminalDragPointEvent {
  clientX: number;
  clientY: number;
  pageX: number;
  pageY: number;
  screenX: number;
  screenY: number;
}

let currentDrag: TerminalFileDragPayload | null = null;
let lastPoint: { x: number; y: number } | null = null;
let suppressNextFilePanelProjectSync = false;
const dropZones = new Map<string, TerminalDropZone>();

function isUsableCoordinate(x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0);
}

function getDropZoneAtPoint(x: number, y: number): TerminalDropZone | null {
  const zones = Array.from(dropZones.values()).reverse();
  for (const zone of zones) {
    const rect = zone.getRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;
    const inside = x >= rect.left
      && x <= rect.right
      && y >= rect.top
      && y <= rect.bottom;
    if (inside) return zone;
  }
  return null;
}

export function createTerminalFileDragPayload(
  project: TerminalFileDragProject,
  relativePath: string,
  kind: ProjectFileEntry["kind"] = "file",
): TerminalFileDragPayload {
  return {
    text: formatTerminalDragPath(project, relativePath, kind),
    absolutePath: formatAbsoluteProjectFilePath(project, relativePath, kind),
    source: {
      id: project.id,
      path: project.path,
      remote_path: project.remote_path,
      environment_type: project.environment_type,
      ssh_host_id: project.ssh_host_id,
    },
  };
}

export function beginTerminalFileDrag(payload: TerminalFileDragPayload) {
  currentDrag = payload.text ? payload : null;
  lastPoint = null;
  suppressNextFilePanelProjectSync = false;
}

export function endTerminalFileDrag() {
  currentDrag = null;
  lastPoint = null;
}

export function getTerminalFileDragText(): string {
  return currentDrag?.text ?? "";
}

export function getTerminalFileDragPayload(): TerminalFileDragPayload | null {
  return currentDrag;
}

export function appendTerminalFileDragSeparator(text: string): string {
  return /\s$/u.test(text) ? text : `${text} `;
}

export function markTerminalFileDragPanelSyncSuppression() {
  suppressNextFilePanelProjectSync = true;
}

export function consumeTerminalFileDragPanelSyncSuppression(): boolean {
  const shouldSuppress = suppressNextFilePanelProjectSync;
  suppressNextFilePanelProjectSync = false;
  return shouldSuppress;
}

export function parseTerminalFileDragPayload(value: string | null | undefined): TerminalFileDragPayload | null {
  if (!value) return null;
  try {
    const payload = JSON.parse(value) as Partial<TerminalFileDragPayload>;
    if (
      typeof payload.text !== "string"
      || typeof payload.absolutePath !== "string"
      || !payload.source
      || typeof payload.source.id !== "string"
      || typeof payload.source.path !== "string"
      || typeof payload.source.remote_path !== "string"
      || (payload.source.environment_type !== "local" && payload.source.environment_type !== "wsl" && payload.source.environment_type !== "ssh")
      || (payload.source.ssh_host_id !== null && typeof payload.source.ssh_host_id !== "string")
    ) {
      return null;
    }
    return payload as TerminalFileDragPayload;
  } catch {
    return null;
  }
}

export function updateTerminalFileDragPoint(x: number, y: number) {
  if (!currentDrag) return;
  if (!isUsableCoordinate(x, y)) return;
  lastPoint = { x, y };
}

export function updateTerminalFileDragPointFromEvent(event: TerminalDragPointEvent) {
  if (isUsableCoordinate(event.clientX, event.clientY)) {
    updateTerminalFileDragPoint(event.clientX, event.clientY);
    return;
  }

  if (isUsableCoordinate(event.pageX, event.pageY)) {
    updateTerminalFileDragPoint(event.pageX - window.scrollX, event.pageY - window.scrollY);
    return;
  }

  if (!isUsableCoordinate(event.screenX, event.screenY)) return;
  const screenLeft = window.screenX || window.screenLeft || 0;
  const screenTop = window.screenY || window.screenTop || 0;
  updateTerminalFileDragPoint(event.screenX - screenLeft, event.screenY - screenTop);
}

export function registerTerminalDropZone(zone: TerminalDropZone) {
  dropZones.set(zone.id, zone);
  return () => {
    dropZones.delete(zone.id);
  };
}

export function getTerminalFileDropZoneIdAtPoint(x: number, y: number): string | null {
  if (!isUsableCoordinate(x, y)) return null;
  return getDropZoneAtPoint(x, y)?.id ?? null;
}

export function commitTerminalFileDragDrop(): boolean {
  if (!currentDrag || !lastPoint) return false;

  const zone = getDropZoneAtPoint(lastPoint.x, lastPoint.y);
  if (zone) {
    markTerminalFileDragPanelSyncSuppression();
    zone.paste(currentDrag);
    zone.focus();
    endTerminalFileDrag();
    return true;
  }

  return false;
}
