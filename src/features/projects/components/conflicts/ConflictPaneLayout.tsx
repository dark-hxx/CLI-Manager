import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import {
  CONFLICT_DIVIDER_WIDTH, DEFAULT_CONFLICT_COLUMNS, conflictColumnMinimum, fitConflictColumns, resizeConflictColumns,
  type ConflictColumnSizes, type ConflictDivider,
} from "../../lib/conflictColumnLayout";

interface Props {
  sizes: ConflictColumnSizes;
  onSizesChange: (sizes: ConflictColumnSizes) => void;
  labels: [string, string];
  resizeHint: string;
  chosen: boolean;
  children: [ReactNode, ReactNode, ReactNode];
}

interface Drag {
  pointerId: number;
  divider: ConflictDivider;
  startX: number;
  width: number;
  scale: number;
  sizes: ConflictColumnSizes;
  handle: HTMLDivElement;
}

/** Only this layout previews a drag; committing sizes never changes editor keys or models. */
export function ConflictPaneLayout({ sizes, onSizesChange, labels, resizeHint, chosen, children }: Props) {
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<ConflictColumnSizes | null>(null);
  const widthRef = useRef(0);
  const [width, setWidth] = useState(0);
  const [preview, setPreview] = useState<ConflictColumnSizes | null>(null);
  const id = useId();
  const current = fitConflictColumns(preview ?? sizes, width);
  const minimum = conflictColumnMinimum(width);

  // Cancel queued geometry before releasing capture: lostpointercapture may fire synchronously.
  const releaseDrag = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    pending.current = null;
    const active = drag.current;
    drag.current = null;
    if (active?.handle.hasPointerCapture(active.pointerId)) active.handle.releasePointerCapture(active.pointerId);
  }, []);

  const cancelDrag = useCallback(() => {
    releaseDrag();
    setPreview(null);
  }, [releaseDrag]);

  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    const measure = () => {
      const available = Math.max(0, element.clientWidth - CONFLICT_DIVIDER_WIDTH * 2);
      if (available === widthRef.current) return;
      // A hidden tab or resized host invalidates the pointer's original coordinate system.
      cancelDrag();
      widthRef.current = available;
      setWidth(available);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [cancelDrag]);

  useEffect(() => {
    window.addEventListener("blur", cancelDrag);
    return () => {
      window.removeEventListener("blur", cancelDrag);
      releaseDrag();
    };
  }, [cancelDrag, releaseDrag]);

  const start = (event: PointerEvent<HTMLDivElement>, divider: ConflictDivider) => {
    if (event.button !== 0 || !event.isPrimary || width <= 0 || drag.current || !grid.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const scale = grid.current.getBoundingClientRect().width / grid.current.clientWidth;
    drag.current = { pointerId: event.pointerId, divider, startX: event.clientX, width, scale, sizes: current, handle: event.currentTarget };
    setPreview(current);
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    pending.current = resizeConflictColumns(active.sizes, active.divider, (event.clientX - active.startX) / active.scale / active.width, active.width);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pending.current) setPreview(pending.current);
    });
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    // Include the release coordinate even when the last pointermove has not been painted yet.
    const next = resizeConflictColumns(active.sizes, active.divider, (event.clientX - active.startX) / active.scale / active.width, active.width);
    releaseDrag();
    setPreview(null);
    onSizesChange(next);
  };

  const reset = () => {
    cancelDrag();
    onSizesChange([...DEFAULT_CONFLICT_COLUMNS]);
  };

  // Keyboard bounds describe the leading pane of each adjacent pair, as required by separator ARIA.
  const keyDown = (event: KeyboardEvent<HTMLDivElement>, divider: ConflictDivider) => {
    if (event.key === "Escape") { event.preventDefault(); cancelDrag(); return; }
    if (event.key === "Enter") { event.preventDefault(); reset(); return; }
    if (width <= 0) return;
    const step = (event.shiftKey ? 50 : 10) / width;
    const delta = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step
      : event.key === "Home" ? -1 : event.key === "End" ? 1 : null;
    if (delta === null) return;
    event.preventDefault();
    cancelDrag();
    onSizesChange(resizeConflictColumns(current, divider, delta, width));
  };

  const separator = (divider: ConflictDivider) => <div
    className="conflict-column-divider" role="separator" tabIndex={0} aria-orientation="vertical"
    aria-label={labels[divider]} title={resizeHint} aria-controls={`${id}-pane-${divider}`}
    aria-valuemin={Math.round(minimum * 100)} aria-valuemax={Math.round((current[divider] + current[divider + 1] - minimum) * 100)}
    aria-valuenow={Math.round(current[divider] * 100)}
    onPointerDown={(event) => start(event, divider)} onPointerMove={move} onPointerUp={finish}
    onPointerCancel={(event) => { if (drag.current?.pointerId === event.pointerId) cancelDrag(); }}
    onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) cancelDrag(); }} onDoubleClick={reset}
    onKeyDown={(event) => keyDown(event, divider)} />;

  return <div ref={grid} className="conflict-merge-grid" data-conflict-chosen={chosen} data-resizing={preview !== null}
    style={{ gridTemplateColumns: `minmax(0, ${current[0]}fr) ${CONFLICT_DIVIDER_WIDTH}px minmax(0, ${current[1]}fr) ${CONFLICT_DIVIDER_WIDTH}px minmax(0, ${current[2]}fr)` }}>
    <div className="conflict-pane-slot" id={`${id}-pane-0`}>{children[0]}</div>
    {separator(0)}
    <div className="conflict-pane-slot" id={`${id}-pane-1`}>{children[1]}</div>
    {separator(1)}
    <div className="conflict-pane-slot" id={`${id}-pane-2`}>{children[2]}</div>
  </div>;
}
