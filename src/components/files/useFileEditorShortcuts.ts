import { useEffect } from "react";
import { eventToCombo } from "../../hooks/useKeyboardShortcuts";

interface UseFileEditorShortcutsOptions {
  active: boolean;
  copyAiShortcut: string;
  onCopyAiPath: () => void;
  onSave: () => void | Promise<void>;
}

export function useFileEditorShortcuts({
  active,
  copyAiShortcut,
  onCopyAiPath,
  onSave,
}: UseFileEditorShortcutsOptions): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!active || !copyAiShortcut.trim()) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".ui-file-editor-pane")) return;
      if (eventToCombo(event) !== copyAiShortcut) return;
      event.preventDefault();
      event.stopPropagation();
      onCopyAiPath();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [active, copyAiShortcut, onCopyAiPath]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!active || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void onSave();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, onSave]);
}
