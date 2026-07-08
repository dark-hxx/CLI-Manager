import { useEffect, useRef } from "react";
import { useTerminalStore } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useFileExplorerStore } from "../stores/fileExplorerStore";
import { useCommandPaletteStore } from "../components/CommandPalette";
import { useHistoryStore } from "../stores/historyStore";
import { copyAiText } from "../lib/aiClipboard";
import { formatAiPathBlock } from "../lib/aiPathFormatter";
import { TERMINAL_TAB_CLOSE_REQUEST_EVENT, type TerminalTabCloseRequestDetail } from "../lib/terminalCloseConfirm";

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

function isShortcutMatch(combo: string, shortcut: string): boolean {
  return shortcut.trim() !== "" && combo === shortcut;
}

function getMouseTabSwitchDelta(button: number): 1 | -1 | null {
  if (button === 3) return -1;
  if (button === 4) return 1;
  return null;
}

interface KeyboardShortcutOptions {
  onToggleTerminalFullscreen?: () => void;
}

export function useKeyboardShortcuts(options: KeyboardShortcutOptions = {}) {
  const shortcuts = useSettingsStore((s) => s.keyboardShortcuts);
  const viewMode = useSettingsStore((s) => s.viewMode);

  // Refs hold the latest values; the actual handler is bound once.
  const shortcutsRef = useRef(shortcuts);
  const viewModeRef = useRef(viewMode);
  const onToggleTerminalFullscreenRef = useRef(options.onToggleTerminalFullscreen);
  shortcutsRef.current = shortcuts;
  viewModeRef.current = viewMode;
  onToggleTerminalFullscreenRef.current = options.onToggleTerminalFullscreen;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const combo = eventToCombo(e);
      if (!combo) return;
      const shortcuts = shortcutsRef.current;
      const viewMode = viewModeRef.current;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isFileEditorTarget = !!target?.closest(".ui-file-editor-pane");

      // Command palette toggle works regardless of focus context
      if (isShortcutMatch(combo, shortcuts.commandPalette)) {
        e.preventDefault();
        useCommandPaletteStore.getState().toggle();
        return;
      }

      if (isShortcutMatch(combo, shortcuts.toggleTerminalFullscreen)) {
        e.preventDefault();
        onToggleTerminalFullscreenRef.current?.();
        return;
      }

      if (isShortcutMatch(combo, shortcuts.sessionHistory)) {
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

      const isXtermTarget = !!target?.closest(".xterm");
      const isEditingTarget =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        !!target?.closest("[contenteditable='true']");

      if (combo === "Ctrl+F" && !isXtermTarget) {
        e.preventDefault();
      }

      if (isShortcutMatch(combo, shortcuts.copyAi)) {
        if (isEditingTarget || isXtermTarget || isFileEditorTarget) return;
        const { project, activeFile } = useFileExplorerStore.getState();
        if (!project) return;
        e.preventDefault();
        void copyAiText(
          formatAiPathBlock(project, activeFile?.path ?? "", activeFile ? "file" : "directory"),
          "AI 路径已复制"
        );
        return;
      }

      const terminalState = useTerminalStore.getState();
      const { sessions, activeSessionId, setActive, createSession } = terminalState;
      const activeSession = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : null;
      const newTerminalCwd = activeSession?.kind === "subagent-transcript" ? undefined : activeSession?.cwd;
      const newTerminalTitle = activeSession?.kind === "subagent-transcript" ? "Terminal" : activeSession?.title ?? "Terminal";

      if (isShortcutMatch(combo, shortcuts.nextTab) || isShortcutMatch(combo, shortcuts.prevTab)) {
        if (viewMode === "compact" || (isEditingTarget && !isXtermTarget)) return;
        e.preventDefault();
        if (sessions.length < 2) return;
        const delta = isShortcutMatch(combo, shortcuts.nextTab) ? 1 : -1;
        const nextSessionId = terminalState.getNextSessionIdForShortcut(delta);
        if (nextSessionId) setActive(nextSessionId);
        return;
      }

      // 关闭当前会话必须优先于编辑区跳过逻辑，否则终端输入焦点下 Ctrl+W 会被 PTY 吃掉。
      if (isShortcutMatch(combo, shortcuts.closeTerminal)) {
        if (viewMode === "compact") return;
        e.preventDefault();
        if (activeSessionId) {
          window.dispatchEvent(new CustomEvent<TerminalTabCloseRequestDetail>(TERMINAL_TAB_CLOSE_REQUEST_EVENT, {
            detail: { sessionIds: [activeSessionId] },
          }));
        }
        return;
      }

      // Skip global shortcuts while user is typing/editing.
      if (isEditingTarget || isXtermTarget) {
        return;
      }

      if (isShortcutMatch(combo, shortcuts.newTerminal)) {
        if (viewMode === "compact") return;
        e.preventDefault();
        createSession(undefined, newTerminalCwd ?? undefined, newTerminalTitle);
        return;
      }
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  useEffect(() => {
    const preventMouseNavigation = (e: MouseEvent) => {
      if (getMouseTabSwitchDelta(e.button) === null) return;
      e.preventDefault();
      e.stopPropagation();
    };

    const handleMouseUp = (e: MouseEvent) => {
      const delta = getMouseTabSwitchDelta(e.button);
      if (delta === null) return;
      e.preventDefault();
      e.stopPropagation();

      if (viewModeRef.current === "compact") return;
      const terminalState = useTerminalStore.getState();
      if (terminalState.sessions.length < 2) return;
      const nextSessionId = terminalState.getNextSessionIdForShortcut(delta);
      if (nextSessionId) terminalState.setActive(nextSessionId);
    };

    window.addEventListener("mousedown", preventMouseNavigation, true);
    window.addEventListener("mouseup", handleMouseUp, true);
    window.addEventListener("auxclick", preventMouseNavigation, true);
    return () => {
      window.removeEventListener("mousedown", preventMouseNavigation, true);
      window.removeEventListener("mouseup", handleMouseUp, true);
      window.removeEventListener("auxclick", preventMouseNavigation, true);
    };
  }, []);
}
