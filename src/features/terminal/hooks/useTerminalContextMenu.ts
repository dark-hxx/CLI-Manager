import { useEffect, useRef, useState, type RefObject } from "react";

export interface TerminalContextMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

export interface UseTerminalContextMenuResult {
  menuState: TerminalContextMenuState | null;
  menuRef: RefObject<HTMLDivElement | null>;
  openMenu: (x: number, y: number, hasSelection: boolean) => void;
  closeContextMenu: () => void;
}

// Terminal right-click context menu display state machine. Owns only the
// menu's open/closed state and the dismiss listeners (outside click, Escape,
// scroll, window blur). The menu actions themselves (copy/paste/clear/…) stay
// in the component because they orchestrate terminal operations and would turn
// this hook's interface into a wide bag of injected callbacks otherwise.
export function useTerminalContextMenu(): UseTerminalContextMenuResult {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuState, setMenuState] = useState<TerminalContextMenuState | null>(null);

  const openMenu = (x: number, y: number, hasSelection: boolean) => {
    setMenuState({ x, y, hasSelection });
  };

  const closeContextMenu = () => setMenuState(null);

  useEffect(() => {
    if (!menuState) return;
    const close = () => setMenuState(null);
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenuState(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuState(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuState]);

  return { menuState, menuRef, openMenu, closeContextMenu };
}
