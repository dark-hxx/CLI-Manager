interface TerminalFileDragPayload {
  text: string;
}

interface TerminalDropZone {
  id: string;
  getRect: () => DOMRect | null;
  paste: (text: string) => void;
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
const dropZones = new Map<string, TerminalDropZone>();
// 最近激活的真实终端 sessionId，供“发送到当前终端”在无明确目标时兜底。
let lastActiveTerminalId: string | null = null;

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

export function beginTerminalFileDrag(text: string) {
  currentDrag = text ? { text } : null;
  lastPoint = null;
}

export function endTerminalFileDrag() {
  currentDrag = null;
  lastPoint = null;
}

export function getTerminalFileDragText(): string {
  return currentDrag?.text ?? "";
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
    zone.paste(currentDrag.text);
    zone.focus();
    endTerminalFileDrag();
    return true;
  }

  return false;
}

export function setLastActiveTerminalId(id: string | null) {
  lastActiveTerminalId = id;
}

function isDropZoneVisible(zone: TerminalDropZone): boolean {
  const rect = zone.getRect();
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

// 把文本发送到目标终端：优先 preferredId，其次最近激活的终端，
// 最后回退到唯一可见的终端。返回是否成功送达。
export function sendTextToTerminal(text: string, preferredId?: string | null): boolean {
  if (!text) return false;

  const tryZone = (id: string | null | undefined): boolean => {
    if (!id) return false;
    const zone = dropZones.get(id);
    if (!zone || !isDropZoneVisible(zone)) return false;
    zone.paste(text);
    zone.focus();
    return true;
  };

  if (tryZone(preferredId)) return true;
  if (tryZone(lastActiveTerminalId)) return true;

  const visibleZones = Array.from(dropZones.values()).filter(isDropZoneVisible);
  if (visibleZones.length === 1) {
    visibleZones[0].paste(text);
    visibleZones[0].focus();
    return true;
  }

  return false;
}
