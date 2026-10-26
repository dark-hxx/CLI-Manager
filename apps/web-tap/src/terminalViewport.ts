import type { Terminal } from "@xterm/xterm";

/** Scroll the mirrored grid without changing its size or taking over xterm's scrollback. */
export function installTerminalViewport(term: Terminal, container: HTMLElement, menu: boolean) {
  let following = true;
  let expectedTop = container.scrollTop, expectedLeft = container.scrollLeft;
  let observedTop = container.scrollTop, observedLeft = container.scrollLeft;
  let frame = 0;
  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  const atBottom = () => container.scrollHeight - container.scrollTop - container.clientHeight < 32;
  const scrolled = () => {
    const horizontal = Math.abs(container.scrollLeft - observedLeft) >= 1;
    const vertical = Math.abs(container.scrollTop - observedTop) >= 1;
    observedTop = container.scrollTop; observedLeft = container.scrollLeft;
    const programmatic = Math.abs(container.scrollTop - expectedTop) < 1 && Math.abs(container.scrollLeft - expectedLeft) < 1;
    expectedTop = -1; expectedLeft = -1;
    if (programmatic) return;
    if (horizontal) following = false;
    else if (vertical) following = atBottom();
  };
  const reveal = () => {
    frame = 0;
    const buffer = term.buffer.active;
    if (!following || !screen || !container.clientHeight || buffer.viewportY < buffer.baseY) return;
    const row = screen.clientHeight / term.rows, col = screen.clientWidth / term.cols;
    const top = buffer.cursorY * row, left = buffer.cursorX * col;
    const below = menu ? Math.min(row * 8, container.clientHeight / 2) : row + 1;
    if (top < container.scrollTop) container.scrollTop = Math.max(0, top - row * 2);
    else if (top + below > container.scrollTop + container.clientHeight)
      container.scrollTop = top + below - container.clientHeight;
    if (left < container.scrollLeft) container.scrollLeft = Math.max(0, left - col * 2);
    else if (left + col * 2 > container.scrollLeft + container.clientWidth)
      container.scrollLeft = left + col * 2 - container.clientWidth;
    expectedTop = container.scrollTop; expectedLeft = container.scrollLeft;
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(reveal); };
  // xterm handles wheel/touch itself. Consume only motion within the oversized outer grid;
  // at its edges the existing scrollback and CLI mouse protocol keep receiving events.
  const pan = (dx: number, dy: number) => {
    const top = container.scrollTop, left = container.scrollLeft;
    const maxTop = container.scrollHeight - container.clientHeight;
    const maxLeft = container.scrollWidth - container.clientWidth;
    const nextTop = Math.max(0, Math.min(maxTop, top + dy));
    const nextLeft = Math.max(0, Math.min(maxLeft, left + dx));
    if (Math.abs(nextTop - top) < 1 && Math.abs(nextLeft - left) < 1) return false;
    container.scrollTop = nextTop; container.scrollLeft = nextLeft;
    following = Math.abs(nextLeft - left) < 1 && atBottom();
    expectedTop = container.scrollTop; expectedLeft = container.scrollLeft;
    return true;
  };
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) return;
    const unit = event.deltaMode === 1 ? (screen?.clientHeight ?? term.rows * 16) / term.rows
      : event.deltaMode === 2 ? container.clientHeight : 1;
    const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
    const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
    if (pan(dx * unit, dy * unit)) { event.preventDefault(); event.stopPropagation(); }
  };
  let touch: { x: number; y: number } | undefined;
  const startTouch = (event: TouchEvent) => {
    const point = event.touches.length === 1 ? event.touches[0] : undefined;
    touch = point ? { x: point.clientX, y: point.clientY } : undefined;
  };
  const moveTouch = (event: TouchEvent) => {
    const previous = touch;
    startTouch(event);
    if (previous && touch && pan(previous.x - touch.x, previous.y - touch.y)) {
      event.preventDefault(); event.stopPropagation();
    }
  };
  const rendered = term.onRender(schedule);
  const resized = new ResizeObserver(schedule);
  resized.observe(container);
  if (screen) resized.observe(screen);
  container.addEventListener("scroll", scrolled, { passive: true });
  container.addEventListener("wheel", wheel, { capture: true, passive: false });
  container.addEventListener("touchstart", startTouch, { capture: true, passive: true });
  container.addEventListener("touchmove", moveTouch, { capture: true, passive: false });
  schedule();
  return () => {
    rendered.dispose(); resized.disconnect(); cancelAnimationFrame(frame);
    container.removeEventListener("scroll", scrolled);
    container.removeEventListener("wheel", wheel, true);
    container.removeEventListener("touchstart", startTouch, true);
    container.removeEventListener("touchmove", moveTouch, true);
  };
}
