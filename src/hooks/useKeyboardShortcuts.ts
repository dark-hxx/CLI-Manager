import { useEffect } from "react";
import { useTerminalStore } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useCommandPaletteStore } from "../components/CommandPalette";
import { useHistoryStore } from "../stores/historyStore";

/** Convert a KeyboardEvent to a combo string like "Ctrl+Shift+T" */
export function eventToCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Meta");

  const key = e.key;
  // Ignore modifier-only presses
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return "";

  // Normalize key name
  const normalized = key.length === 1 ? key.toUpperCase() : key;
  parts.push(normalized);
  return parts.join("+");
}

export function useKeyboardShortcuts() {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const setActive = useTerminalStore((s) => s.setActive);
  const closeSession = useTerminalStore((s) => s.closeSession);
  const createSession = useTerminalStore((s) => s.createSession);
  const shortcuts = useSettingsStore((s) => s.keyboardShortcuts);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const combo = eventToCombo(e);
      if (!combo) return;

      // Command palette toggle works regardless of focus context
      if (combo === shortcuts.commandPalette) {
        e.preventDefault();
        useCommandPaletteStore.getState().toggle();
        return;
      }

      // Global history search
      if (combo === "Ctrl+K") {
        e.preventDefault();
        void useHistoryStore.getState().openHistory();
        useHistoryStore.getState().triggerGlobalSearchFocus();
        return;
      }

      // In-session history search
      if (combo === "Ctrl+F" && useHistoryStore.getState().isOpen) {
        e.preventDefault();
        useHistoryStore.getState().triggerSessionSearchFocus();
        return;
      }

      // Skip global shortcuts while user is typing/editing (including xterm textarea).
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        !!target?.closest(".xterm") ||
        !!target?.closest("[contenteditable='true']")
      ) {
        return;
      }

      if (combo === shortcuts.newTerminal) {
        e.preventDefault();
        createSession(undefined, undefined, "Terminal");
        return;
      }

      if (combo === shortcuts.closeTerminal) {
        e.preventDefault();
        if (activeSessionId) closeSession(activeSessionId);
        return;
      }

      if (combo === shortcuts.nextTab) {
        e.preventDefault();
        if (sessions.length < 2) return;
        const idx = sessions.findIndex((s) => s.id === activeSessionId);
        const next = (idx + 1) % sessions.length;
        setActive(sessions[next].id);
        return;
      }

      if (combo === shortcuts.prevTab) {
        e.preventDefault();
        if (sessions.length < 2) return;
        const idx = sessions.findIndex((s) => s.id === activeSessionId);
        const prev = (idx - 1 + sessions.length) % sessions.length;
        setActive(sessions[prev].id);
        return;
      }
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [sessions, activeSessionId, setActive, closeSession, createSession, shortcuts]);
}
