import { useEffect, type RefObject } from "react";

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(", ");

  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter((el) => {
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const focusables = getFocusableElements(container);
    const first = focusables[0];
    const fallbackTarget = container;

    if (!container.hasAttribute("tabindex")) {
      container.setAttribute("tabindex", "-1");
    }

    (first ?? fallbackTarget).focus();

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;

      const currentFocusables = getFocusableElements(container);
      if (currentFocusables.length === 0) {
        event.preventDefault();
        fallbackTarget.focus();
        return;
      }

      const firstEl = currentFocusables[0];
      const lastEl = currentFocusables[currentFocusables.length - 1];
      const activeElement = document.activeElement as HTMLElement | null;

      if (!event.shiftKey && activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      } else if (event.shiftKey && activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      }
    };

    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("keydown", handleKeydown);
    };
  }, [active, containerRef]);
}
