export type TerminalDisplay = { mode: "manual" | "width" | "contain"; fontSize: number; width: number; height: number };
export const DISPLAY_KEY = "cli-manager.web-terminal-display.v1";
export const DEFAULT_DISPLAY: TerminalDisplay = { mode: "contain", fontSize: 14, width: 100, height: 100 };

export function normalizeDisplay(value: unknown): TerminalDisplay {
  const input = value && typeof value === "object" ? value as Partial<TerminalDisplay> : {};
  const clamp = (n: unknown, fallback: number, min: number, max: number) =>
    typeof n === "number" && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
  return {
    mode: input.mode === "manual" || input.mode === "width" ? input.mode : "contain",
    fontSize: clamp(input.fontSize, 14, 8, 36),
    width: clamp(input.width, 100, 30, 100),
    height: clamp(input.height, 100, 30, 100),
  };
}

export function readDisplay(): TerminalDisplay {
  try { return normalizeDisplay(JSON.parse(localStorage.getItem(DISPLAY_KEY) ?? "null")); }
  catch { return { ...DEFAULT_DISPLAY }; }
}
