// Theme resolution for the terminal-side preview panels (Markdown preview, subagent
// transcript, session replay, in-terminal Git diff). These panels follow the terminal
// theme by default, but the user can pin an independent preset from the same library.
//
// Brightness is decided here and only here: panels must not call isLightTerminalTheme()
// on their own, or the preview family drifts apart one panel at a time.
import type { CSSProperties } from "react";
import type { ITheme } from "@xterm/xterm";
import {
  getTerminalTheme,
  isKnownTerminalThemePreset,
  isLightTerminalTheme,
  withTerminalTextColor,
  type DarkTerminalPalette,
  type LightTerminalPalette,
} from "./terminalThemes";

export const FOLLOW_TERMINAL_PREVIEW_THEME = "follow-terminal";

export interface TerminalPreviewThemeInput {
  previewThemeName: string;
  terminalThemeName: string;
  resolvedTheme: "dark" | "light";
  lightThemePalette: LightTerminalPalette;
  darkThemePalette: DarkTerminalPalette;
  /**
   * The terminal's custom text-color override. Applied only while following the terminal,
   * so today's preview appearance is preserved; an independently chosen preset keeps its
   * own foreground instead of inheriting a terminal-only override.
   */
  terminalTextColor?: string;
}

export interface TerminalPreviewThemeResolution {
  theme: ITheme;
  tone: "light" | "dark";
  isIndependent: boolean;
  panelStyle: CSSProperties;
}

function previewThemeColor(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

/**
 * Local CSS variable scope for one preview panel. Mirrors the global `--term-panel-*`
 * contract App.tsx writes for terminal-side chrome, so a panel root carrying this style
 * re-themes its whole subtree without any descendant reading the theme itself.
 */
export function buildTerminalPreviewPanelStyle(theme: ITheme): CSSProperties {
  const background = previewThemeColor(theme.background, "#0c0e10");
  const foreground = previewThemeColor(theme.foreground, "#f8fafc");
  const muted = previewThemeColor(theme.brightBlack ?? theme.white, "#9ca0a6");
  const accent = previewThemeColor(theme.cyan ?? theme.blue ?? theme.cursor, foreground);
  const green = previewThemeColor(theme.green ?? theme.cyan, accent);
  const yellow = previewThemeColor(theme.yellow, accent);
  const red = previewThemeColor(theme.red, accent);
  const magenta = previewThemeColor(theme.magenta, accent);
  const blue = previewThemeColor(theme.blue, accent);

  return {
    "--terminal-theme-background": background,
    "--terminal-theme-foreground": foreground,
    "--terminal-theme-muted": muted,
    "--terminal-theme-accent": accent,
    "--terminal-theme-selection": previewThemeColor(theme.selectionBackground, accent),
    "--term-panel-bg": background,
    "--term-panel-fg": foreground,
    "--term-panel-dim": muted,
    "--term-panel-green": green,
    "--term-panel-yellow": yellow,
    "--term-panel-red": red,
    "--term-panel-magenta": magenta,
    "--term-panel-cyan": previewThemeColor(theme.cyan, accent),
    "--term-panel-blue": blue,
    "--term-panel-card": "color-mix(in srgb, var(--term-panel-bg) 91%, var(--term-panel-fg) 9%)",
    "--term-panel-card-inner": "color-mix(in srgb, var(--term-panel-bg) 87%, var(--term-panel-fg) 13%)",
    "--term-panel-border": "color-mix(in srgb, var(--term-panel-fg) 14%, transparent)",
    "--term-panel-track": "color-mix(in srgb, var(--term-panel-bg) 94%, var(--term-panel-fg) 6%)",
    "--ui-scrollbar-thumb": "color-mix(in srgb, var(--term-panel-fg) 28%, transparent)",
    "--ui-scrollbar-track": "color-mix(in srgb, var(--term-panel-bg) 94%, var(--term-panel-fg) 6%)",
  } as CSSProperties;
}

// Anything that is not a known preset id — including a stale id from settings sync or a
// renamed preset — means "follow the terminal", never a broken panel.
export function isIndependentTerminalPreviewTheme(previewThemeName: string): boolean {
  return previewThemeName !== FOLLOW_TERMINAL_PREVIEW_THEME
    && isKnownTerminalThemePreset(previewThemeName);
}

export function resolveTerminalPreviewTheme({
  previewThemeName,
  terminalThemeName,
  resolvedTheme,
  lightThemePalette,
  darkThemePalette,
  terminalTextColor = "",
}: TerminalPreviewThemeInput): TerminalPreviewThemeResolution {
  const isIndependent = isIndependentTerminalPreviewTheme(previewThemeName);
  const presetTheme = getTerminalTheme(
    isIndependent ? previewThemeName : terminalThemeName,
    resolvedTheme,
    lightThemePalette,
    darkThemePalette,
  );
  const theme = isIndependent ? presetTheme : withTerminalTextColor(presetTheme, terminalTextColor);
  return {
    theme,
    tone: isLightTerminalTheme(theme) ? "light" : "dark",
    isIndependent,
    panelStyle: buildTerminalPreviewPanelStyle(theme),
  };
}
