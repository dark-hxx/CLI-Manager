const AUTOHIDE_CLASS = "ui-autohide-scroll";
const HIDE_DELAY_MS = 800;

const hideTimers = new WeakMap<Element, number>();

/**
 * Show `.ui-autohide-scroll` scrollbars only while the element is scrolling.
 * scroll events do not bubble, so one capture listener on document covers
 * every container, including ones mounted later.
 */
export function installAutoHideScrollbars() {
  document.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.classList.contains(AUTOHIDE_CLASS)) return;
      target.setAttribute("data-scrolling", "true");
      const pending = hideTimers.get(target);
      if (pending !== undefined) window.clearTimeout(pending);
      hideTimers.set(
        target,
        window.setTimeout(() => {
          target.removeAttribute("data-scrolling");
          hideTimers.delete(target);
        }, HIDE_DELAY_MS),
      );
    },
    { capture: true, passive: true },
  );
}
