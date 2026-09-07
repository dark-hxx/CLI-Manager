import { useMemo } from "react";
import {
  resolveTerminalPreviewTheme,
  type TerminalPreviewThemeResolution,
} from "../lib/terminalPreviewTheme";
import { useSettingsStore } from "../stores/settingsStore";

/**
 * Single source of truth for terminal-side preview panels: Markdown preview, subagent
 * transcript, session replay, and the in-terminal Git diff viewer. Panels must consume
 * this instead of resolving the terminal theme (or its brightness) on their own.
 */
export function useTerminalPreviewTheme(): TerminalPreviewThemeResolution {
  const previewThemeName = useSettingsStore((state) => state.terminalPreviewThemeName);
  const terminalThemeName = useSettingsStore((state) => state.terminalThemeName);
  const resolvedTheme = useSettingsStore((state) => state.resolvedTheme);
  const lightThemePalette = useSettingsStore((state) => state.lightThemePalette);
  const darkThemePalette = useSettingsStore((state) => state.darkThemePalette);
  const terminalTextColor = useSettingsStore((state) => state.terminalTextColor);

  return useMemo(
    () => resolveTerminalPreviewTheme({
      previewThemeName,
      terminalThemeName,
      resolvedTheme,
      lightThemePalette,
      darkThemePalette,
      terminalTextColor,
    }),
    [
      darkThemePalette,
      lightThemePalette,
      previewThemeName,
      resolvedTheme,
      terminalTextColor,
      terminalThemeName,
    ],
  );
}
