import { useEffect } from "react";

type ViewportInput = {
  innerHeight: number;
  baselineHeight: number;
  focused: boolean;
  visual?: { height: number; offsetTop: number; scale: number };
  keyboardTop?: number;
};

// Keyboard state is a hint, not device detection. Pinch zoom must not resize the app.
export function calculateMobileViewport(input: ViewportInput) {
  const zoomed = input.visual && Math.abs(input.visual.scale - 1) > 0.05;
  const top = zoomed ? 0 : Math.max(0, input.visual?.offsetTop ?? 0);
  let height = zoomed ? input.innerHeight : Math.min(input.innerHeight, input.visual?.height ?? input.innerHeight);
  if (!zoomed && input.keyboardTop !== undefined && input.keyboardTop > top) {
    height = Math.min(height, input.keyboardTop - top);
  }
  height = Math.max(1, height);
  const keyboardOpen = !zoomed && input.focused && input.baselineHeight - height > 120;
  return { height, top, keyboardOpen, inset: zoomed ? 0 : Math.max(0, input.innerHeight - height - top) };
}

export function useMobileViewport() {
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(max-width: 900px), (pointer: coarse)");
    const viewport = window.visualViewport;
    const keyboard = (navigator as Navigator & {
      virtualKeyboard?: EventTarget & { boundingRect?: { top: number; height: number } };
    }).virtualKeyboard;
    const keys = ["--mobile-viewport-height", "--mobile-viewport-top", "--keyboard-height"];
    const previous = keys.map((key) => root.style.getPropertyValue(key));
    const previousMobile = root.dataset.mobileViewport;
    const previousKeyboard = root.dataset.mobileKeyboard;
    let baselineHeight = window.innerHeight;
    let baselineWidth = window.innerWidth;
    let frame = 0;
    const restore = () => {
      keys.forEach((key, i) => previous[i] ? root.style.setProperty(key, previous[i]) : root.style.removeProperty(key));
      if (previousMobile === undefined) delete root.dataset.mobileViewport;
      else root.dataset.mobileViewport = previousMobile;
      if (previousKeyboard === undefined) delete root.dataset.mobileKeyboard;
      else root.dataset.mobileKeyboard = previousKeyboard;
    };
    const update = () => {
      frame = 0;
      if (!media.matches) { restore(); return; }
      const active = document.activeElement;
      const focused = active instanceof HTMLElement && (
        active.isContentEditable || active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLInputElement && !["button", "checkbox", "radio", "submit", "range", "color"].includes(active.type))
      );
      // A large width change indicates rotation or a genuinely new window size.
      if (Math.abs(window.innerWidth - baselineWidth) > 80) baselineHeight = window.innerHeight;
      baselineWidth = window.innerWidth;
      baselineHeight = Math.max(baselineHeight, window.innerHeight);
      const rect = keyboard?.boundingRect;
      const result = calculateMobileViewport({
        innerHeight: window.innerHeight, baselineHeight, focused,
        visual: viewport ? { height: viewport.height, offsetTop: viewport.offsetTop, scale: viewport.scale } : undefined,
        keyboardTop: rect && rect.height > 0 ? rect.top : undefined,
      });
      root.dataset.mobileViewport = "true";
      root.dataset.mobileKeyboard = String(result.keyboardOpen);
      root.style.setProperty(keys[0], `${result.height}px`);
      root.style.setProperty(keys[1], `${result.top}px`);
      root.style.setProperty(keys[2], `${result.inset}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    keyboard?.addEventListener("geometrychange", schedule);
    media.addEventListener("change", schedule);
    update();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      keyboard?.removeEventListener("geometrychange", schedule);
      media.removeEventListener("change", schedule);
      restore();
    };
  }, []);
}
