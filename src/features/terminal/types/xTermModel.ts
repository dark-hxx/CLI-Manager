import { type LightThemePalette, type DarkThemePalette } from "../../../stores/settingsStore";

export const SEARCH_HIGHLIGHT_LIMIT = 1000;

export const IMAGE_ADDON_PIXEL_LIMIT = 4 * 1024 * 1024;

export const IMAGE_ADDON_SEQUENCE_LIMIT = 8 * 1024 * 1024;

export const IMAGE_ADDON_STORAGE_LIMIT_MB = 32;

export const VISIBILITY_RESTORE_REVEAL_TIMEOUT_MS = 500;

export const OSC52_MAX_PENDING_CLIPBOARD_ACTIONS = 32;

export const CODEX_OUTPUT_SIGNATURE_PATTERN = /(?:openai\s+codex|\/model\s+to\s+change)/i;

export const ANSI_CSI_SEQUENCE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export const WEBGL_ATLAS_REFRESH_MIN_HIDDEN_MS = 10_000;

export const CODEX_IME_DEBUG_WINDOW_MS = 250;

export const CODEX_IME_DUPLICATE_WINDOW_MS = 120;

export interface TerminalContextMenuPoint {
  x: number;
  y: number;
}

export interface TerminalContextMenuActions {
  onNewTab?: () => void;
  onCloseSession?: () => void;
  onCloseOthers?: () => void;
  onCloseToLeft?: () => void;
  onCloseToRight?: () => void;
  onSplitRight?: (point?: TerminalContextMenuPoint) => void;
  onSplitDown?: (point?: TerminalContextMenuPoint) => void;
}

export interface Props extends TerminalContextMenuActions {
  sessionId: string;
  isActive?: boolean;
  isVisible?: boolean;
  fontSize?: number;
  fontFamily?: string;
  resolvedTheme?: "dark" | "light";
  terminalThemeName?: string;
  lightThemePalette?: LightThemePalette;
  darkThemePalette?: DarkThemePalette;
}
