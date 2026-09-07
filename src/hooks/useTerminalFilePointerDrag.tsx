import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Portal } from "../components/ui/Portal";
import { POINTER_DRAG_START_PX } from "../lib/dragInteraction";
import {
  beginTerminalFileDrag,
  commitTerminalFileDragDrop,
  createTerminalFileDragPayload,
  endTerminalFileDrag,
  getTerminalFileDropZoneIdAtPoint,
  updateTerminalFileDragPointFromEvent,
  type TerminalFileDragProject,
} from "../lib/terminalFileDrag";
import type { ProjectFileEntry } from "../lib/types";

export interface TerminalFileDragSource {
  path: string;
  kind: ProjectFileEntry["kind"];
}

interface PointerDragState<TSource extends TerminalFileDragSource> {
  pointerId: number;
  startX: number;
  startY: number;
  source: TSource;
  preview: TerminalFileDragPreviewSource;
  dragging: boolean;
}

interface TerminalFileDragPreviewSource {
  className: string;
  html: string;
  offsetX: number;
  offsetY: number;
  paddingLeft: string;
  width: number;
}

interface TerminalFileDragPreviewState {
  x: number;
  y: number;
  source: TerminalFileDragPreviewSource;
}

interface UseTerminalFilePointerDragOptions<TSource extends TerminalFileDragSource> {
  project: TerminalFileDragProject | null;
  onDropOutsideTerminal?: (source: TSource, point: { x: number; y: number }) => void;
}

interface TerminalFilePointerDrag<TSource extends TerminalFileDragSource> {
  handlePointerDown: (event: ReactPointerEvent<HTMLElement>, source: TSource) => void;
  handlePointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  handlePointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  handlePointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  preview: ReactNode;
}

function markTerminalFilePointerDragHandled(element: HTMLElement) {
  element.dataset.pointerDragHandled = "true";
  window.setTimeout(() => {
    delete element.dataset.pointerDragHandled;
  }, 0);
}

export function isTerminalFilePointerDragClickHandled(element: HTMLElement): boolean {
  return element.dataset.pointerDragHandled === "true";
}

export function useTerminalFilePointerDrag<TSource extends TerminalFileDragSource = TerminalFileDragSource>({
  project,
  onDropOutsideTerminal,
}: UseTerminalFilePointerDragOptions<TSource>): TerminalFilePointerDrag<TSource> {
  const [dragPreview, setDragPreview] = useState<TerminalFileDragPreviewState | null>(null);
  const pointerDragRef = useRef<PointerDragState<TSource> | null>(null);
  const dragPreviewElementRef = useRef<HTMLDivElement | null>(null);
  const dragPreviewFrameRef = useRef<number | null>(null);
  const pendingDragPreviewRef = useRef<{ source: TerminalFileDragPreviewSource; x: number; y: number } | null>(null);

  const resetPointerDrag = useCallback(() => {
    pointerDragRef.current = null;
    pendingDragPreviewRef.current = null;
    if (dragPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current);
      dragPreviewFrameRef.current = null;
    }
    setDragPreview(null);
    document.body.style.removeProperty("user-select");
  }, []);

  const updateDragPreview = useCallback((source: TerminalFileDragPreviewSource, x: number, y: number) => {
    pendingDragPreviewRef.current = { source, x, y };
    if (dragPreviewFrameRef.current !== null) return;

    dragPreviewFrameRef.current = window.requestAnimationFrame(() => {
      dragPreviewFrameRef.current = null;
      const pending = pendingDragPreviewRef.current;
      const element = dragPreviewElementRef.current;
      if (!pending || !element) return;

      const { source: pendingSource, x: nextX, y: nextY } = pending;
      element.style.transform = `translate3d(${nextX - pendingSource.offsetX}px, ${nextY - pendingSource.offsetY}px, 0)`;
      if (getTerminalFileDropZoneIdAtPoint(nextX, nextY)) {
        element.dataset.overTerminal = "true";
      } else {
        delete element.dataset.overTerminal;
      }
    });
  }, []);

  useEffect(() => () => {
    if (dragPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current);
    }
    if (pointerDragRef.current?.dragging) endTerminalFileDrag();
    document.body.style.removeProperty("user-select");
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, source: TSource) => {
    if (!project || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.pointerType === "mouse" && event.buttons !== 1) return;

    const rect = event.currentTarget.getBoundingClientRect();
    pointerDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      source,
      preview: {
        className: event.currentTarget.className,
        html: event.currentTarget.innerHTML,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        paddingLeft: event.currentTarget.style.paddingLeft,
        width: rect.width,
      },
      dragging: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [project]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = pointerDragRef.current;
    if (!state || state.pointerId !== event.pointerId) return;

    if (!state.dragging) {
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (Math.hypot(dx, dy) < POINTER_DRAG_START_PX) return;
      if (!project) {
        resetPointerDrag();
        return;
      }

      state.dragging = true;
      beginTerminalFileDrag(createTerminalFileDragPayload(project, state.source.path, state.source.kind));
      setDragPreview({
        x: event.clientX - state.preview.offsetX,
        y: event.clientY - state.preview.offsetY,
        source: state.preview,
      });
      document.body.style.userSelect = "none";
    }

    updateTerminalFileDragPointFromEvent(event);
    updateDragPreview(state.preview, event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
  }, [project, resetPointerDrag, updateDragPreview]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = pointerDragRef.current;
    if (!state || state.pointerId !== event.pointerId) return;

    if (!state.dragging) {
      resetPointerDrag();
      return;
    }

    markTerminalFilePointerDragHandled(event.currentTarget);
    updateTerminalFileDragPointFromEvent(event);
    if (!commitTerminalFileDragDrop()) {
      onDropOutsideTerminal?.(state.source, { x: event.clientX, y: event.clientY });
      endTerminalFileDrag();
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
    resetPointerDrag();
  }, [onDropOutsideTerminal, resetPointerDrag]);

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = pointerDragRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    endTerminalFileDrag();
    resetPointerDrag();
  }, [resetPointerDrag]);

  const preview = dragPreview ? (
    <Portal>
      <div
        ref={dragPreviewElementRef}
        className="ui-file-drag-preview"
        style={{
          width: dragPreview.source.width,
          transform: `translate3d(${dragPreview.x}px, ${dragPreview.y}px, 0)`,
        }}
        aria-hidden="true"
      >
        <div
          className={dragPreview.source.className}
          style={dragPreview.source.paddingLeft ? { paddingLeft: dragPreview.source.paddingLeft } : undefined}
          dangerouslySetInnerHTML={{ __html: dragPreview.source.html }}
        />
      </div>
    </Portal>
  ) : null;

  return {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    preview,
  };
}
