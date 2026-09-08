export type TerminalPaneMarkerStyle = "full" | "tab-top";

export interface TerminalPaneMarkerSettings {
  enabled: boolean;
  style: TerminalPaneMarkerStyle;
  doneColor: string;
  failedColor: string;
  attentionColor: string;
}

export type TerminalPaneMarkerHookStatus = "none" | "running" | "attention" | "done" | "failed";
export type TerminalPaneMarkerStatus = "focus" | "attention" | "done" | "failed";

export interface TerminalPaneMarkerPresentation {
  status: TerminalPaneMarkerStatus;
  color: string;
  width: 1 | 2;
  opacity: 0.5 | 1;
}

export const DEFAULT_TERMINAL_PANE_MARKER_FOCUS_COLOR =
  "color-mix(in srgb, var(--terminal-theme-muted, #64748b) 60%, var(--terminal-theme-background, #0c0e10) 40%)";

export const DEFAULT_TERMINAL_PANE_MARKER_SETTINGS: TerminalPaneMarkerSettings = {
  enabled: false,
  style: "tab-top",
  doneColor: "#8FBF7F",
  failedColor: "#F7768E",
  attentionColor: "#FF9E64",
};

const HEX_COLOR_PATTERN = /^#[0-9A-F]{6}$/i;

function sanitizeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value) ? value.toUpperCase() : fallback;
}

export function sanitizeTerminalPaneMarkerSettings(value: unknown): TerminalPaneMarkerSettings {
  const raw = typeof value === "object" && value !== null
    ? value as Partial<Record<keyof TerminalPaneMarkerSettings, unknown>>
    : {};
  const style = raw.style === "full" || raw.style === "tab-top"
    ? raw.style
    : DEFAULT_TERMINAL_PANE_MARKER_SETTINGS.style;

  return {
    enabled: typeof raw.enabled === "boolean"
      ? raw.enabled
      : DEFAULT_TERMINAL_PANE_MARKER_SETTINGS.enabled,
    style,
    doneColor: sanitizeColor(raw.doneColor, DEFAULT_TERMINAL_PANE_MARKER_SETTINGS.doneColor),
    failedColor: sanitizeColor(raw.failedColor, DEFAULT_TERMINAL_PANE_MARKER_SETTINGS.failedColor),
    attentionColor: sanitizeColor(raw.attentionColor, DEFAULT_TERMINAL_PANE_MARKER_SETTINGS.attentionColor),
  };
}

export function resolveTerminalPaneMarker(input: {
  isLayoutVisible: boolean;
  isSplitLayout: boolean;
  isAppFocused: boolean;
  isPaneFocused: boolean;
  isMainSession: boolean;
  hookStatus: TerminalPaneMarkerHookStatus;
  settings: TerminalPaneMarkerSettings;
  accentColor?: string;
}): TerminalPaneMarkerPresentation | null {
  if (!input.settings.enabled || !input.isLayoutVisible || !input.isSplitLayout) return null;

  const status = input.isMainSession
    && (input.hookStatus === "done" || input.hookStatus === "failed" || input.hookStatus === "attention")
    ? input.hookStatus
    : null;
  const focused = input.isAppFocused && input.isPaneFocused;
  if (!status && !focused) return null;

  const color = status === "done"
    ? input.settings.doneColor
    : status === "failed"
      ? input.settings.failedColor
      : status === "attention"
        ? input.settings.attentionColor
        : input.accentColor ?? DEFAULT_TERMINAL_PANE_MARKER_FOCUS_COLOR;

  return {
    status: status ?? "focus",
    color,
    width: focused ? 2 : 1,
    opacity: focused ? 1 : 0.5,
  };
}
