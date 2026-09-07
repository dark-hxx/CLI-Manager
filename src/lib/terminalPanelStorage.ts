import type { TerminalPanelWidthKey } from "../stores/settingsStore";

const MERGED_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-side-panel-width";
const TERMINAL_STATS_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-stats-panel-width";
const TERMINAL_GIT_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-git-panel-width";
const TERMINAL_FILES_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-files-panel-width";
const TERMINAL_REPLAY_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-replay-panel-width";
const TERMINAL_PROVIDER_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-provider-panel-width";
const LEGACY_WIDTH_STORAGE_KEYS: Partial<Record<TerminalPanelWidthKey, string>> = {
  merged: MERGED_PANEL_WIDTH_STORAGE_KEY,
  stats: TERMINAL_STATS_PANEL_WIDTH_STORAGE_KEY,
  git: TERMINAL_GIT_PANEL_WIDTH_STORAGE_KEY,
  replay: TERMINAL_REPLAY_PANEL_WIDTH_STORAGE_KEY,
  files: TERMINAL_FILES_PANEL_WIDTH_STORAGE_KEY,
  providers: TERMINAL_PROVIDER_PANEL_WIDTH_STORAGE_KEY,
};

function clampStoredWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
}

export function readLegacyTerminalPanelWidth(
  widthKey: TerminalPanelWidthKey,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
): number | null {
  if (typeof window === "undefined") return null;
  const storageKey = LEGACY_WIDTH_STORAGE_KEYS[widthKey];
  if (!storageKey) return null;
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  if (storageKey === MERGED_PANEL_WIDTH_STORAGE_KEY && parsed === 243) return defaultWidth;
  return clampStoredWidth(parsed, minWidth, maxWidth);
}
