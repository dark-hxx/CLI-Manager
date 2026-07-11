import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Terminal, type IBufferCell, type IBufferLine, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useShallow } from "zustand/shallow";
import {
  applyTransparency,
  getTerminalBackground,
  getTerminalBackgroundOverlayColor,
  getTerminalMinimumContrastRatio,
  getTerminalTheme,
  isLightTerminalTheme,
} from "../lib/terminalThemes";
import { getMaterialFileIcon } from "@baybreezy/file-extension-icon";
import { backgroundAssetUrl } from "../lib/assetUrl";
import { TERMINAL_FILE_PATH_MIME } from "../lib/aiPathFormatter";
import { resolveManualDirectCodexEnterData } from "../lib/codexManualInput";
import { debugConsoleWarn } from "../lib/debugConsole";
import { useI18n } from "../lib/i18n";
import { normalizeTerminalFontFamily } from "../lib/terminalFontFamily";
import {
  findTerminalRichAtomicAfterCursor,
  findTerminalRichAtomicBeforeCursor,
  parseTerminalRichInput,
  snapTerminalRichCursor,
  type TerminalRichInputSegment,
} from "../lib/terminalRichInput";
import {
  TERMINAL_INPUT_SUGGESTION_BUILTIN_PROMPT,
  TERMINAL_INPUT_SUGGESTION_AI_MODEL,
  getLocalTerminalInputSuggestions,
  getTerminalPathInputSuggestions,
  getTerminalInputSuggestionAiResult,
  mergeTerminalInputSuggestions,
  resolveSubmittedDirectoryChange,
  type TerminalInputSuggestion,
  type TerminalInputSuggestionContext,
} from "../lib/terminalInputSuggestions";
import type { CommandHistoryEntry, CommandTemplate, TerminalSession } from "../lib/types";
import {
  endTerminalFileDrag,
  getTerminalFileDropZoneIdAtPoint,
  getTerminalFileDragText,
  registerTerminalDropZone,
  updateTerminalFileDragPointFromEvent,
} from "../lib/terminalFileDrag";
import { planTerminalVisibilityRestore, refreshTerminalViewport } from "../lib/terminalVisibility";
import {
  defaultShellForOs,
  getOsPlatform,
  normalizeShellForOs,
  normalizeShellKey,
  type OsPlatform,
  type ShellKey,
} from "../lib/shell";
import { Portal } from "./ui/Portal";
import { useCommandHistoryStore } from "../stores/commandHistoryStore";
import { useProjectStore } from "../stores/projectStore";
import { useTemplateStore } from "../stores/templateStore";
import { formatStartupInputForPty, useTerminalStore, type ShellRuntimeEventName } from "../stores/terminalStore";
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN, useSettingsStore, type LightThemePalette, type DarkThemePalette } from "../stores/settingsStore";

const MIN_TERMINAL_COLS = 40;
const MIN_TERMINAL_ROWS = 8;
const ACTIVE_WRITE_FRAME_BUDGET = 64 * 1024;
const ACTIVE_WRITE_QUEUE_MAX_CHARS = 16 * 1024 * 1024;
const ACTIVE_WRITE_QUEUE_LOG_INTERVAL_MS = 2000;
const SEARCH_HIGHLIGHT_LIMIT = 1000;
const INACTIVE_BUFFER_MIN_CHARS = 256 * 1024;
const INACTIVE_BUFFER_MAX_CHARS = 8 * 1024 * 1024;
const INACTIVE_BUFFER_CHARS_PER_SCROLLBACK_ROW = 256;
const IMAGE_ADDON_PIXEL_LIMIT = 4 * 1024 * 1024;
const IMAGE_ADDON_SEQUENCE_LIMIT = 8 * 1024 * 1024;
const IMAGE_ADDON_STORAGE_LIMIT_MB = 32;
const SUGGESTION_CONTEXT_CACHE_TTL_MS = 2_000;
const SUGGESTION_LOCAL_DEBOUNCE_MS = 80;
const SUGGESTION_AI_DEBOUNCE_MS = 400;
const HIDDEN_WEBGL_DISPOSE_DELAY_MS = 10_000;
// Box-drawing glyphs used by TUI input boxes (Claude Code / Codex draw "│ > … │").
const TUI_BORDER_CHAR_PATTERN = /^[│┃║▏▎▍▌▋▊▉█┆┊╎╏]$/u;
const TUI_BORDER_PREFIX_PATTERN = /^[\s│┃║▏▎▍▌▋▊▉█┆┊╎╏]+/u;
import { toast } from "sonner";
import { logError, logInfo } from "../lib/logger";

// Shell integration OSC 序列在原始 PTY 流上解析（而非 xterm parser hook）：
// 后台 Tab 的输出会进入 inactive ring buffer 且可能被截断丢弃，状态事件必须
// 在丢弃之前提取，否则后台 Tab 不再上报状态。
// 777 为本应用私有协议（消费后剥离）；7/133/633 为 cwd / FinalTerm / VS Code 标准
// shell integration 序列（消费后原样放行，xterm 会忽略），借此兼容 oh-my-posh、
// VS Code shell integration 等用户自带集成。
const LEGACY_RUNTIME_OSC_PREFIX = "\x1b]777;cli-manager;";
const CWD_OSC_PREFIX = "\x1b]7;";
const INTEGRATION_OSC_PREFIXES = ["\x1b]133;", "\x1b]633;", CWD_OSC_PREFIX, LEGACY_RUNTIME_OSC_PREFIX];
const OSC_CARRY_BUFFER_MAX = 8192;
const OSC_PREFIX = "\x1b]";
const XTERM_BG_COLOR_MASK = 0x03ffffff;
const XTERM_COLOR_MODE_RGB = 0x03000000;
const XTERM_INVERSE_FLAG = 0x04000000;
const CLAUDE_LIGHT_SLASH_MENU_SELECTED_BG = 0xe7eefc;
const TUI_COMPOSER_PRELUDE_ROWS = 1;
const TUI_COMPOSER_CONTINUATION_ROWS = 4;
const TUI_COMPOSER_PROMPT_PATTERN = /^[\u203a\u276f\u00bb\u2023>]\s?/u;
const SLASH_COMMAND_MENU_LINE_PATTERN = /^\/[a-z0-9][a-z0-9:_-]*(?:\s|$)/i;
const AI_TUI_VIEWPORT_PATTERN = /(?:openai\s+codex|claude\s+code|yolo\s+mode|mcp\s+(?:client|startup)|\/model\s+to\s+change)/i;
const CODEX_COMMAND_PATTERN = /(?:^|\s)codex(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i;
const CLAUDE_COMMAND_PATTERN = /(?:^|\s)claude(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i;
const CODEX_IME_DEBUG_WINDOW_MS = 250;
const CODEX_IME_DUPLICATE_WINDOW_MS = 120;
const IME_PROCESS_KEY_CODE = 229;
const IME_PROCESS_KEY_RECOVERY_WINDOW_MS = 400;
const IME_COMPOSITION_END_SUPPRESS_WINDOW_MS = 80;
const IME_CROSS_SOURCE_DUPLICATE_WINDOW_MS = 80;
const NATIVE_TEXT_INPUT_DEDUP_WINDOW_MS = 16;
const CJK_NATIVE_PUNCTUATION_PATTERN = /^[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]+$/u;

type SpecialColorQueryId = 10 | 11;
type TerminalInputSource = "onData" | "nativeTextInput";

type OscPrefixMatch =
  | { kind: "match"; prefix: string }
  | { kind: "partial" }
  | { kind: "none" };

function decodeOscPathValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseOsc7Cwd(body: string): string | null {
  const value = body.trim();
  if (!value.toLocaleLowerCase().startsWith("file://")) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const path = decodeOscPathValue(url.pathname);
    if (/^\/[a-z]:[\\/]/iu.test(path)) return path.slice(1);
    if (url.hostname && url.hostname !== "localhost") return `//${url.hostname}${path}`;
    return path || null;
  } catch {
    return null;
  }
}

function parseStandardIntegrationCwd(command: string, rest: string): string | null {
  if (command !== "P") return null;
  const field = rest.split(";").find((part) => part.toLocaleLowerCase().startsWith("cwd="));
  if (!field) return null;
  const value = decodeOscPathValue(field.slice(field.indexOf("=") + 1)).trim();
  return value || null;
}

const matchIntegrationOscPrefix = (text: string, start: number): OscPrefixMatch => {
  let partial = false;
  for (const prefix of INTEGRATION_OSC_PREFIXES) {
    const available = Math.min(prefix.length, text.length - start);
    if (text.startsWith(prefix.slice(0, available), start)) {
      if (available === prefix.length) return { kind: "match", prefix };
      partial = true;
    }
  }
  return partial ? { kind: "partial" } : { kind: "none" };
};

// 终止符：BEL 或 ST（ESC \）。null 表示序列尚未完整（跨 chunk，需缓冲）。
type OscTerminator = { index: number; length: number } | { abortAt: number } | null;

const findOscTerminator = (text: string, from: number): OscTerminator => {
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x07) return { index: i, length: 1 };
    if (code === 0x1b) {
      if (i + 1 >= text.length) return null;
      if (text[i + 1] === "\\") return { index: i, length: 2 };
      // OSC body 内不应出现裸 ESC，按非法序列放行避免吞掉正常输出
      return { abortAt: i };
    }
  }
  return null;
};

type MutableXtermCell = IBufferCell & {
  fg: number;
  bg: number;
};

interface MutableXtermLine {
  length: number;
  loadCell(index: number, cell: MutableXtermCell): MutableXtermCell;
  setCell(index: number, cell: MutableXtermCell): void;
}

type XtermBufferLineApiView = IBufferLine & {
  // xterm's public buffer line is read-only; v6 keeps the mutable line here.
  _line?: MutableXtermLine;
};

interface SearchResultState {
  resultIndex: number;
  resultCount: number;
}

interface TerminalSuggestionGhostState {
  suffix: string;
  left: number;
  top: number;
  height: number;
  maxWidth: number;
}

// 终端可见区域内识别到的 @path 引用，渲染为内联文件 chip（覆盖在原字符上）。
interface AiPathChip {
  key: string;
  left: number;
  top: number;
  // 底下 @path 整段占用的像素宽度：外层遮罩槽用它盖住裸路径，
  // 内层 chip 自身保持紧凑（仅内容宽度），避免长路径把 chip 撑得过长。
  spanWidth: number;
  height: number;
  icon: string;
  label: string;
  // 跨行续行段：仅作遮罩（盖住裸路径余部），不再重复展示 icon+文件名。
  maskOnly?: boolean;
}

interface TerminalRichInputMask {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TerminalRichInputState {
  input: string;
  cursorIndex: number;
  segments: TerminalRichInputSegment[];
  inputStartCellIndex: number;
  maskedInputWidth: number;
  cols: number;
  left: number;
  top: number;
  width: number;
  cellWidth: number;
  cellHeight: number;
  leadingWidth: number;
  masks: TerminalRichInputMask[];
}

interface TerminalRichInputAnchor {
  inputStartCellIndex: number;
  maskedInputWidth: number;
  cols: number;
}

interface TerminalRichCursorTransition {
  input: string;
  inputStartCellIndex: number;
  inputRangeWidth: number;
  targetCursorIndex: number;
  cols: number;
  startedAt: number;
}

interface TerminalRichDeleteTransition {
  targetInput: string;
  inputStartCellIndex: number;
  targetCursorIndex: number;
  sourceInputWidth: number;
  cols: number;
  startedAt: number;
}

const TERMINAL_RICH_TRANSITION_TIMEOUT_MS = 2_000;

interface TextDiagnosticSummary {
  length: number;
  hasNonAscii: boolean;
  fingerprint: string;
}

interface CodexImeDebugState {
  compositionEndAt: number;
  compositionEndSummary: TextDiagnosticSummary | null;
  lastNearCompositionFingerprint: string | null;
  lastNearCompositionAt: number;
}

const EMPTY_SEARCH_RESULT: SearchResultState = { resultIndex: 0, resultCount: 0 };

const normalizeHexColor = (value: string | undefined, fallback: string) => (
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
);

const summarizeTextForDiagnostics = (value: string): TextDiagnosticSummary => {
  let hash = 0;
  let hasNonAscii = false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    hash = Math.imul(31, hash) + code;
    if (code > 0x7f) hasNonAscii = true;
  }
  return {
    length: value.length,
    hasNonAscii,
    fingerprint: (hash >>> 0).toString(36),
  };
};

const getInactiveBufferLimit = (scrollbackRows: number) => Math.min(
  INACTIVE_BUFFER_MAX_CHARS,
  Math.max(INACTIVE_BUFFER_MIN_CHARS, scrollbackRows * INACTIVE_BUFFER_CHARS_PER_SCROLLBACK_ROW)
);

const hexToRgba = (value: string | undefined, alpha: number, fallback: string) => {
  const normalized = normalizeHexColor(value, "");
  if (!normalized) return fallback;
  const hex = normalized.slice(1);
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const getTerminalRenderedCellSize = (terminal: Terminal, terminalContainer: HTMLElement, fallbackFontSize: number) => {
  const renderedCell = (
    terminal as typeof terminal & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    }
  )._core?._renderService?.dimensions?.css?.cell;
  const renderedWidth = renderedCell?.width;
  const renderedHeight = renderedCell?.height;
  if (
    typeof renderedWidth === "number" && Number.isFinite(renderedWidth) && renderedWidth > 0
    && typeof renderedHeight === "number" && Number.isFinite(renderedHeight) && renderedHeight > 0
  ) {
    return {
      width: renderedWidth,
      height: renderedHeight,
    };
  }
  const screen = terminalContainer.querySelector(".xterm-screen") as HTMLElement | null;
  const rect = (screen ?? terminalContainer).getBoundingClientRect();
  return {
    width: rect.width > 0 ? rect.width / Math.max(1, terminal.cols) : Math.max(1, fallbackFontSize * 0.6),
    height: rect.height > 0 ? rect.height / Math.max(1, terminal.rows) : Math.max(1, fallbackFontSize * 1.2),
  };
};

const parseSpecialColorQuery = (body: string): SpecialColorQueryId | null => {
  const separator = body.indexOf(";");
  if (separator < 0) return null;
  const oscId = body.slice(0, separator);
  const payload = body.slice(separator + 1).trim();
  if (payload !== "?") return null;
  if (oscId === "10") return 10;
  if (oscId === "11") return 11;
  return null;
};

const formatSpecialColorReply = (queryId: SpecialColorQueryId, hex: string) => {
  const normalized = normalizeHexColor(hex, queryId === 10 ? "#d8dee9" : "#0c0e10");
  const r = normalized.slice(1, 3);
  const g = normalized.slice(3, 5);
  const b = normalized.slice(5, 7);
  return `${OSC_PREFIX}${queryId};rgb:${r}${r}/${g}${g}/${b}${b}\x1b\\`;
};

const copyTextToClipboard = async (text: string) => {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  }
};

const readClipboardText = async () => navigator.clipboard.readText();

const trimTerminalPasteBoundaryLineBreaks = (text: string) => (
  text.replace(/^(?:\r\n?|\n)+|(?:\r\n?|\n)+$/gu, "")
);

const wrapTerminalPasteTextForCtrlShiftV = (text: string) => {
  const trimmed = trimTerminalPasteBoundaryLineBreaks(text);
  return /[\r\n]/u.test(trimmed) ? `'${trimmed}'` : trimmed;
};

const isCombiningCodePoint = (codePoint: number) => (
  (codePoint >= 0x0300 && codePoint <= 0x036f) ||
  (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
  (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
  (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
  (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
);

const isWideCodePoint = (codePoint: number) => (
  codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
);

const getTerminalCellWidth = (text: string) => {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0) continue;
    if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0) || isCombiningCodePoint(codePoint)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
};

const lineHasVisibleTextAfterColumn = (line: IBufferLine, column: number, cols: number) => {
  const width = Math.min(cols, line.length);
  for (let index = Math.max(0, column); index < width; index += 1) {
    if (line.getCell(index)?.getChars().trim()) return true;
  }
  return false;
};

const canShowSuggestionAtCurrentInputEnd = (terminal: Terminal, input: string) => {
  const inputCellWidth = getTerminalCellWidth(input);
  if (inputCellWidth <= 0) return false;

  const buffer = terminal.buffer.active;
  if (buffer.cursorX < inputCellWidth) return false;

  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  if (!line) return false;

  if (lineHasVisibleTextAfterColumn(line, buffer.cursorX, terminal.cols)) return false;

  const beforeCursor = line.translateToString(false, 0, Math.min(buffer.cursorX, line.length));
  return beforeCursor.endsWith(input);
};

const getTextCursorLength = (text: string) => Array.from(text).length;

const sliceTextByCursor = (text: string, start: number, end?: number) => (
  Array.from(text).slice(start, end).join("")
);

const clampTextCursorIndex = (text: string, index: number) => (
  Math.min(Math.max(0, index), getTextCursorLength(text))
);

const insertTextAtCursor = (text: string, cursorIndex: number, insertion: string) => {
  const chars = Array.from(text);
  const index = Math.min(Math.max(0, cursorIndex), chars.length);
  chars.splice(index, 0, ...Array.from(insertion));
  return chars.join("");
};

const removeTextBeforeCursor = (text: string, cursorIndex: number) => {
  const chars = Array.from(text);
  const index = Math.min(Math.max(0, cursorIndex), chars.length);
  if (index <= 0) return { text, cursorIndex: index };
  chars.splice(index - 1, 1);
  return { text: chars.join(""), cursorIndex: index - 1 };
};

const removeTextAtCursor = (text: string, cursorIndex: number) => {
  const chars = Array.from(text);
  const index = Math.min(Math.max(0, cursorIndex), chars.length);
  if (index >= chars.length) return { text, cursorIndex: index };
  chars.splice(index, 1);
  return { text: chars.join(""), cursorIndex: index };
};

const resolveCursorIndexFromCellOffset = (text: string, cellOffset: number) => {
  const chars = Array.from(text);
  if (cellOffset <= 0) return 0;
  let consumedCells = 0;
  for (let index = 0; index < chars.length; index += 1) {
    const charWidth = Math.max(1, getTerminalCellWidth(chars[index]));
    consumedCells += charWidth;
    if (cellOffset < consumedCells) return index + 1;
  }
  return chars.length;
};

const repeatControlSequence = (sequence: string, count: number) => (
  count > 0 ? sequence.repeat(count) : ""
);

const isLikelyMacPlatform = (os: OsPlatform) => (
  os === "macos" || (os === "unknown" && navigator.platform.toLowerCase().includes("mac"))
);

const withVisibleSelectionTheme = (theme: ITheme): ITheme => {
  const isLight = isLightTerminalTheme(theme);
  return {
    ...theme,
    selectionBackground: isLight ? "rgba(37, 99, 235, 0.28)" : "rgba(56, 189, 248, 0.52)",
    selectionInactiveBackground: isLight ? "rgba(37, 99, 235, 0.18)" : "rgba(56, 189, 248, 0.34)",
    selectionForeground: isLight ? "#0f172a" : "#f8fafc",
  };
};

const normalizeShellForKnownOs = (shell: string | null | undefined, os: OsPlatform): ShellKey | undefined => (
  os === "unknown" ? normalizeShellKey(shell) : normalizeShellForOs(shell, os)
);

const quoteShellPath = (path: string, shell: string | null | undefined) => {
  const normalized = normalizeShellKey(shell);
  if (normalized === "cmd") return `"${path.replace(/"/g, "\"\"")}"`;
  if (normalized === "powershell" || normalized === "pwsh") return `'${path.replace(/'/g, "''")}'`;
  return `'${path.replace(/'/g, "'\\''")}'`;
};

const formatShellPathList = (paths: string[], shell: string | null | undefined) => (
  paths.filter(Boolean).map((path) => quoteShellPath(path, shell)).join(" ")
);

const joinLocalPath = (rootPath: string, relativePath: string) => {
  const normalizedRelativePath = relativePath.replace(/^[/\\]+/u, "");
  if (/[\\/]/u.test(rootPath) && rootPath.includes("\\")) {
    return `${rootPath.replace(/[\\/]+$/u, "")}\\${normalizedRelativePath.replace(/\//g, "\\")}`;
  }
  return `${rootPath.replace(/\/+$/u, "")}/${normalizedRelativePath.replace(/\\/g, "/")}`;
};

const attachClipboardImageData = async (rootPath: string, fileName: string, dataBase64: string) => (
  invoke<string>("file_attach_data", { rootPath, fileName, dataBase64 })
);

const cleanupExpiredAttachments = async (rootPath: string) => (
  invoke<number>("file_cleanup_expired_attachments", { rootPath })
);

const getClipboardImageFile = (clipboardData: DataTransfer | null) => {
  const items = Array.from(clipboardData?.items ?? []);
  const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
  return imageItem?.getAsFile() ?? null;
};

const getImageFileExtension = (file: File) => {
  const typeExtension = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (typeExtension) return typeExtension;
  const nameExtension = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return nameExtension || "png";
};

const createClipboardImageFileName = (file: File) => {
  const trimmedName = file.name.trim();
  if (trimmedName && /\.[a-z0-9]+$/iu.test(trimmedName)) return trimmedName;
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "");
  return `screenshot-${timestamp}.${getImageFileExtension(file)}`;
};

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

const hasDataTransferType = (dataTransfer: DataTransfer | null, type: string): boolean => {
  if (!dataTransfer) return false;
  const types = dataTransfer.types as DataTransfer["types"] & {
    contains?: (value: string) => boolean;
  };
  if (typeof types.contains === "function") return types.contains(type);
  return Array.from(types).includes(type);
};

const openHttpUrl = (sessionId: string, uri: string) => {
  if (!/^https?:\/\//i.test(uri)) return;
  void openUrl(uri).catch((err) => logError("Failed to open terminal link", { sessionId, uri, err }));
};

const serializeBufferPlainText = (terminal: Terminal) => {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  return lines.join("\n").replace(/[\s\n]+$/u, "");
};

interface TerminalContextMenuPoint {
  x: number;
  y: number;
}

interface TerminalContextMenuActions {
  onNewTab?: () => void;
  onCloseSession?: () => void;
  onCloseOthers?: () => void;
  onCloseToLeft?: () => void;
  onCloseToRight?: () => void;
  onSplitRight?: (point?: TerminalContextMenuPoint) => void;
  onSplitDown?: (point?: TerminalContextMenuPoint) => void;
}

interface Props extends TerminalContextMenuActions {
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

interface ActiveWriteQueueItem {
  text: string;
  inactiveReplay: boolean;
}

export function XTermTerminal({ sessionId, isActive = true, isVisible = true, fontSize = 14, fontFamily = "Cascadia Code, Consolas, monospace", resolvedTheme = "dark", terminalThemeName = "auto", lightThemePalette = "warm-paper", darkThemePalette = "night-indigo", onNewTab, onCloseSession, onCloseOthers, onCloseToLeft, onCloseToRight, onSplitRight, onSplitDown }: Props) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const webglDisposeTimerRef = useRef<number | null>(null);
  const inputBuffer = useRef("");
  const inputCursorIndexRef = useRef(0);
  const richInputStateRef = useRef<TerminalRichInputState | null>(null);
  const trustedRichInputAnchorRef = useRef<TerminalRichInputAnchor | null>(null);
  const pendingRichCursorTransitionRef = useRef<TerminalRichCursorTransition | null>(null);
  const pendingRichDeleteTransitionRef = useRef<TerminalRichDeleteTransition | null>(null);
  const fitRafRef = useRef<number | null>(null);
  const isComposingRef = useRef(false);
  const isActiveRef = useRef(isActive);
  const isVisibleRef = useRef(isVisible);
  const lastObservedSizeRef = useRef<{ width: number; height: number } | null>(null);
  const inactiveBufferRef = useRef<string[]>([]);
  const inactiveBufferSizeRef = useRef(0);
  const activeWriteQueueRef = useRef<ActiveWriteQueueItem[]>([]);
  const activeWriteQueueSizeRef = useRef(0);
  const activeWriteQueueLastDropLogAtRef = useRef(0);
  const activeWriteRafRef = useRef<number | null>(null);
  const needsViewportRefreshRef = useRef(false);
  const inactiveReplayStickToBottomRef = useRef(false);
  const inactiveReplayPendingWritesRef = useRef(0);
  const inactiveReplayPendingRef = useRef(false);
  const cursorShowTimerRef = useRef<number | null>(null);
  const tuiComposerNormalizeRafRef = useRef<number | null>(null);
  const runtimeOscBufferRef = useRef("");
  const specialOscBufferRef = useRef("");
  const suggestionRef = useRef<TerminalInputSuggestion | null>(null);
  const acceptSuggestionRef = useRef<() => boolean>(() => false);
  const cleanedAttachmentRootsRef = useRef<Set<string>>(new Set());
  const terminalColorRepliesRef = useRef<{ foreground: string; background: string }>({
    foreground: formatSpecialColorReply(10, "#d8dee9"),
    background: formatSpecialColorReply(11, "#0c0e10"),
  });
  const terminalScrollbackRows = useSettingsStore((s) => s.terminalScrollbackRows);
  const lowMemoryMode = useSettingsStore((s) => s.lowMemoryMode);
  const disableHardwareAcceleration = useSettingsStore((s) => s.disableHardwareAcceleration);
  const terminalInputSuggestionsEnabled = useSettingsStore((s) => s.terminalInputSuggestionsEnabled);
  const terminalInputSuggestionProvider = useSettingsStore((s) => s.terminalInputSuggestionProvider);
  const inactiveBufferLimitRef = useRef(getInactiveBufferLimit(terminalScrollbackRows));
  inactiveBufferLimitRef.current = getInactiveBufferLimit(terminalScrollbackRows);

  const background = useSettingsStore(
    useShallow((s) => ({
      enabled: s.terminalBackground.enabled,
      imagePath: s.terminalBackground.imagePath,
      opacity: s.terminalBackground.opacity,
      fit: s.terminalBackground.fit,
      position: s.terminalBackground.position,
      blur: s.terminalBackground.blur,
      overlayDarken: s.terminalBackground.overlayDarken,
    }))
  );
  const hiddenForThisSession = useTerminalStore((s) => s.hiddenBackgroundSessionIds.has(sessionId));

  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchMatched, setSearchMatched] = useState<boolean | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResultState>(EMPTY_SEARCH_RESULT);
  const [menuState, setMenuState] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  const [inactiveReplayPending, setInactiveReplayPending] = useState(false);
  const [suggestionGhost, setSuggestionGhost] = useState<TerminalSuggestionGhostState | null>(null);
  const [aiPathChips, setAiPathChips] = useState<AiPathChip[]>([]);
  const [richInput, setRichInput] = useState<TerminalRichInputState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const osPlatformRef = useRef<OsPlatform>("unknown");
  const codexImeDebugRef = useRef<CodexImeDebugState>({
    compositionEndAt: -1,
    compositionEndSummary: null,
    lastNearCompositionFingerprint: null,
    lastNearCompositionAt: -1,
  });

  const getOsPlatformForPathQuoting = async () => {
    if (osPlatformRef.current !== "unknown") return osPlatformRef.current;
    const platform = await getOsPlatform();
    osPlatformRef.current = platform;
    return platform;
  };

  const cleanupExpiredAttachmentsOnce = (rootPath: string | null | undefined) => {
    if (!rootPath || cleanedAttachmentRootsRef.current.has(rootPath)) return;
    cleanedAttachmentRootsRef.current.add(rootPath);
    cleanupExpiredAttachments(rootPath).catch((err) => {
      cleanedAttachmentRootsRef.current.delete(rootPath);
      logError("Failed to cleanup expired terminal attachments", { sessionId, rootPath, err });
    });
  };

  useEffect(() => {
    let cancelled = false;
    void getOsPlatform().then((platform) => {
      if (!cancelled) {
        osPlatformRef.current = platform;
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!background.imagePath) {
      setAssetUrl(null);
      return;
    }
    backgroundAssetUrl(background.imagePath).then((url) => {
      if (!cancelled) setAssetUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [background.imagePath]);

  useEffect(() => {
    if (!searchOpen) return;
    const rafId = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [searchOpen]);

  useEffect(() => {
    if (terminalInputSuggestionsEnabled && !searchOpen) return;
    suggestionRef.current = null;
    setSuggestionGhost(null);
  }, [searchOpen, terminalInputSuggestionsEnabled]);

  useEffect(() => {
    suggestionRef.current = null;
    setSuggestionGhost(null);
  }, [terminalInputSuggestionProvider]);

  // 切换会话时清空上一会话残留的输入镜像与 @path chip。
  useEffect(() => {
    inputBuffer.current = "";
    inputCursorIndexRef.current = 0;
    richInputStateRef.current = null;
    trustedRichInputAnchorRef.current = null;
    pendingRichCursorTransitionRef.current = null;
    pendingRichDeleteTransitionRef.current = null;
    setAiPathChips([]);
    setRichInput(null);
  }, [sessionId]);

  const isTransparent = background.enabled && background.imagePath !== null && !hiddenForThisSession;
  const isTransparentRef = useRef(isTransparent);
  isTransparentRef.current = isTransparent;
  const terminalTheme = getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
  const isLightTerminalRef = useRef(isLightTerminalTheme(terminalTheme));
  isLightTerminalRef.current = isLightTerminalTheme(terminalTheme);
  const effectiveFontFamily = normalizeTerminalFontFamily(fontFamily);

  const clearHiddenWebglDisposeTimer = () => {
    if (webglDisposeTimerRef.current === null) return;
    window.clearTimeout(webglDisposeTimerRef.current);
    webglDisposeTimerRef.current = null;
  };

  const disposeWebglRenderer = () => {
    if (!webglAddonRef.current) return false;
    webglAddonRef.current.dispose();
    webglAddonRef.current = null;
    return true;
  };

  const canUseWebglRenderer = (theme: ReturnType<typeof getTerminalTheme>) => (
    !disableHardwareAcceleration && !isTransparentRef.current && !isLightTerminalTheme(theme)
  );

  const createWebglAddon = () => {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      if (webglAddonRef.current === addon) {
        webglAddonRef.current = null;
      }
    });
    return addon;
  };

  const syncWebglRenderer = (terminal: Terminal, theme: ReturnType<typeof getTerminalTheme>) => {
    if (!canUseWebglRenderer(theme)) {
      return disposeWebglRenderer();
    }
    if (lowMemoryMode && !isVisibleRef.current) return false;
    if (webglAddonRef.current) return false;
    try {
      const addon = createWebglAddon();
      terminal.loadAddon(addon);
      webglAddonRef.current = addon;
      return true;
    } catch {
      // WebGL not supported, fall back to xterm's default renderer.
      return false;
    }
  };

  const fitWhenStable = (force = false) => {
    const container = containerRef.current;
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (!container || !fitAddon || !terminal) return;
    if (!force && (!isVisibleRef.current || isComposingRef.current)) return;
    if (container.offsetWidth <= 0 || container.offsetHeight <= 0) return;

    const dims = fitAddon.proposeDimensions();
    if (!dims || dims.cols < MIN_TERMINAL_COLS || dims.rows < MIN_TERMINAL_ROWS) return;
    const beforeCols = terminal.cols;
    const beforeRows = terminal.rows;
    fitAddon.fit();
    const terminalSizeChanged = terminal.cols !== beforeCols || terminal.rows !== beforeRows;
    if (force || terminalSizeChanged || needsViewportRefreshRef.current) {
      refreshTerminalViewport(terminal);
      needsViewportRefreshRef.current = false;
    }
  };

  const scheduleFit = (force = false) => {
    if (fitRafRef.current !== null) {
      cancelAnimationFrame(fitRafRef.current);
    }
    fitRafRef.current = requestAnimationFrame(() => {
      fitRafRef.current = requestAnimationFrame(() => {
        fitRafRef.current = null;
        fitWhenStable(force);
      });
    });
  };

  const scheduleViewportRefresh = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;
        refreshTerminalViewport(terminal);
        scheduleFit(true);
      });
    });
  };

  useEffect(() => {
    const session = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
    const project = session?.projectId
      ? useProjectStore.getState().projects.find((item) => item.id === session.projectId)
      : null;
    cleanupExpiredAttachmentsOnce(project?.path || session?.cwd || null);
  }, [sessionId]);

  const reportPtyWriteError = (stage: string, err: unknown) => {
    toast.error("终端写入失败", { description: String(err) });
    logError("PTY write failed in XTermTerminal", { sessionId, stage, err });
  };

  const cancelPendingCursorShow = () => {
    if (cursorShowTimerRef.current !== null) {
      window.clearTimeout(cursorShowTimerRef.current);
      cursorShowTimerRef.current = null;
    }
  };

  const scheduleCursorShow = () => {
    cancelPendingCursorShow();
    cursorShowTimerRef.current = window.setTimeout(() => {
      cursorShowTimerRef.current = null;
      terminalRef.current?.write("\x1b[?25h");
    }, 80);
  };

  const emitShellRuntimeEvent = (event: ShellRuntimeEventName, exitCode: number | null) => {
    useTerminalStore.getState().handleShellRuntimeEvent({ sessionId, event, exitCode, origin: "osc" });
  };

  const updateSessionCwdIfChanged = (cwd: string | null) => {
    const value = cwd?.trim();
    if (!value) return;
    const store = useTerminalStore.getState();
    const session = store.sessions.find((item) => item.id === sessionId);
    if (!session || session.cwd === value) return;
    store.updateSessionCwd(sessionId, value);
  };

  const getSessionToolContext = () => {
    const session = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
    const project = session?.projectId
      ? useProjectStore.getState().projects.find((item) => item.id === session.projectId)
      : null;
    return {
      projectTool: project?.cli_tool.trim().toLowerCase() ?? "",
      startupCmd: session?.startupCmd ?? "",
      titleTool: session?.title.match(/\(([^()]*)\)\s*$/)?.[1]?.trim().toLowerCase() ?? "",
    };
  };

  const isCodexSession = (context = getSessionToolContext()) => {
    return (
      context.projectTool === "codex"
      || context.titleTool === "codex"
      || CODEX_COMMAND_PATTERN.test(context.startupCmd)
    );
  };

  const isClaudeSession = (context = getSessionToolContext()) => {
    return (
      context.projectTool.includes("claude")
      || context.titleTool.includes("claude")
      || CLAUDE_COMMAND_PATTERN.test(context.startupCmd)
    );
  };

  const isClaudeOrCodexSession = (context = getSessionToolContext()) => {
    return (
      context.projectTool === "codex"
      || context.projectTool.includes("claude")
      || context.titleTool === "codex"
      || context.titleTool.includes("claude")
      || CODEX_COMMAND_PATTERN.test(context.startupCmd)
      || CLAUDE_COMMAND_PATTERN.test(context.startupCmd)
    );
  };

  const shouldNormalizeTuiComposerBackground = (context = getSessionToolContext()) => (
    isTransparentRef.current || (isClaudeOrCodexSession(context) && isLightTerminalRef.current)
  );

  // 私有 OSC 777：session=<id>;event=<name>[;exit=<code>]
  const handleLegacyRuntimeOsc = (body: string) => {
    const fields = Object.fromEntries(body.split(";").map((part) => {
      const separator = part.indexOf("=");
      return separator < 0 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
    }));
    if (fields.session !== sessionId) return;
    const eventName = fields.event;
    if (eventName !== "command_started" && eventName !== "command_finished" && eventName !== "prompt_shown") return;
    const exitCode = fields.exit !== undefined && fields.exit !== "" ? Number(fields.exit) : null;
    emitShellRuntimeEvent(eventName as ShellRuntimeEventName, Number.isFinite(exitCode) ? exitCode : null);
  };

  // 标准 OSC 7/133/633：OSC 7 与 633;P;Cwd 同步 cwd；A=prompt 开始，C=命令开始执行，D[;exit]=命令结束。
  // D 不带 exit code 表示没跑命令（空回车 / prompt 处 Ctrl+C），不改变状态。
  const handleStandardIntegrationOsc = (body: string) => {
    const osc7Cwd = parseOsc7Cwd(body);
    if (osc7Cwd) {
      updateSessionCwdIfChanged(osc7Cwd);
      return;
    }

    const separator = body.indexOf(";");
    const command = separator < 0 ? body : body.slice(0, separator);
    const rest = separator < 0 ? "" : body.slice(separator + 1);
    const cwd = parseStandardIntegrationCwd(command, rest);
    if (cwd) {
      updateSessionCwdIfChanged(cwd);
      return;
    }

    if (command === "A") {
      emitShellRuntimeEvent("prompt_shown", null);
    } else if (command === "C") {
      emitShellRuntimeEvent("command_started", null);
    } else if (command === "D") {
      const exitField = rest.split(";")[0] ?? "";
      const exitCode = exitField === "" ? null : Number(exitField);
      emitShellRuntimeEvent("command_finished", Number.isFinite(exitCode) ? exitCode : null);
    }
  };

  const processShellIntegrationOsc = (text: string) => {
    const combined = runtimeOscBufferRef.current + text;
    runtimeOscBufferRef.current = "";
    let output = "";
    let cursor = 0;

    while (cursor < combined.length) {
      const start = combined.indexOf("\x1b]", cursor);
      if (start < 0) {
        // 尾部孤立 ESC 可能是下个 chunk 里 "\x1b]" 的前半，留待拼接；
        // 扣下的字符不会渲染出任何可见内容，显示安全。
        if (combined.charCodeAt(combined.length - 1) === 0x1b) {
          output += combined.slice(cursor, combined.length - 1);
          runtimeOscBufferRef.current = "\x1b";
        } else {
          output += combined.slice(cursor);
        }
        break;
      }

      const matched = matchIntegrationOscPrefix(combined, start);
      if (matched.kind === "none") {
        output += combined.slice(cursor, start + 2);
        cursor = start + 2;
        continue;
      }
      if (matched.kind === "partial") {
        output += combined.slice(cursor, start);
        runtimeOscBufferRef.current = combined.slice(start);
        break;
      }

      const terminator = findOscTerminator(combined, start + matched.prefix.length);
      if (terminator === null) {
        output += combined.slice(cursor, start);
        runtimeOscBufferRef.current = combined.slice(start);
        break;
      }
      if ("abortAt" in terminator) {
        output += combined.slice(cursor, terminator.abortAt);
        cursor = terminator.abortAt;
        continue;
      }

      const body = combined.slice(start + matched.prefix.length, terminator.index);
      const sequenceEnd = terminator.index + terminator.length;
      if (matched.prefix === LEGACY_RUNTIME_OSC_PREFIX) {
        handleLegacyRuntimeOsc(body);
      } else {
        handleStandardIntegrationOsc(body);
        output += combined.slice(start, sequenceEnd);
      }
      cursor = sequenceEnd;
    }

    if (runtimeOscBufferRef.current.length > OSC_CARRY_BUFFER_MAX) {
      runtimeOscBufferRef.current = "";
    }

    return output;
  };

  const processSpecialOscQueries = (text: string) => {
    const combined = specialOscBufferRef.current + text;
    specialOscBufferRef.current = "";
    let output = "";
    let cursor = 0;

    while (cursor < combined.length) {
      const start = combined.indexOf(OSC_PREFIX, cursor);
      if (start < 0) {
        if (combined.charCodeAt(combined.length - 1) === 0x1b) {
          output += combined.slice(cursor, combined.length - 1);
          specialOscBufferRef.current = "\x1b";
        } else {
          output += combined.slice(cursor);
        }
        break;
      }

      output += combined.slice(cursor, start);
      const terminator = findOscTerminator(combined, start + OSC_PREFIX.length);
      if (terminator === null) {
        specialOscBufferRef.current = combined.slice(start);
        break;
      }
      if ("abortAt" in terminator) {
        output += combined.slice(start, terminator.abortAt);
        cursor = terminator.abortAt;
        continue;
      }

      const body = combined.slice(start + OSC_PREFIX.length, terminator.index);
      const queryId = parseSpecialColorQuery(body);
      if (queryId === 10 || queryId === 11) {
        // Codex only waits briefly for OSC 10/11 terminal color replies during
        // startup. Reply directly from the raw PTY stream path so theme
        // detection is not delayed by xterm's render/write scheduling.
        const reply =
          queryId === 10
            ? terminalColorRepliesRef.current.foreground
            : terminalColorRepliesRef.current.background;
        invoke("pty_write", { sessionId, data: reply }).catch((err) => reportPtyWriteError("osc_color_reply", err));
      } else {
        output += combined.slice(start, terminator.index + terminator.length);
      }
      cursor = terminator.index + terminator.length;
    }

    if (specialOscBufferRef.current.length > OSC_CARRY_BUFFER_MAX) {
      specialOscBufferRef.current = "";
    }

    return output;
  };

  const normalizeTuiComposerBackground = (terminal: Terminal) => {
    const toolContext = getSessionToolContext();
    if (!shouldNormalizeTuiComposerBackground(toolContext)) return;
    const buffer = terminal.buffer.active;
    const probeCell = buffer.getNullCell() as MutableXtermCell;
    const minRow = 0;
    const codexSession = isCodexSession(toolContext);
    const claudeSession = isClaudeSession(toolContext);
    const knownAiSession = codexSession || claudeSession;
    const useBroadViewportNormalization = isTransparentRef.current || (codexSession && isLightTerminalRef.current);
    const useClaudeLightPatchNormalization = !useBroadViewportNormalization && claudeSession && isLightTerminalRef.current;

    const getViewportLine = (row: number) => buffer.getLine(buffer.viewportY + row);
    const normalizePromptText = (line: IBufferLine) => (
      line.translateToString(true).trimStart().replace(TUI_BORDER_PREFIX_PATTERN, "")
    );
    const isTuiPromptLine = (line: IBufferLine) => TUI_COMPOSER_PROMPT_PATTERN.test(normalizePromptText(line));
    const hasKnownAiTuiSignature = () => {
      for (let row = minRow; row < terminal.rows; row += 1) {
        const line = getViewportLine(row);
        if (line && AI_TUI_VIEWPORT_PATTERN.test(line.translateToString(true))) return true;
      }
      return false;
    };
    const getLineBackgroundState = (line: IBufferLine) => {
      const limit = Math.min(terminal.cols, line.length);
      let hasExplicitBackground = false;
      let inverseCells = 0;
      let hasInverse = false;
      for (let x = 0; x < limit; x += 1) {
        const cell = line.getCell(x, probeCell);
        if (!cell) continue;
        if (cell.getBgColorMode() !== 0) hasExplicitBackground = true;
        if (cell.isInverse() !== 0) {
          hasInverse = true;
          inverseCells += 1;
        }
      }
      return {
        hasExplicitBackground,
        hasInverse,
        hasWideInverse: inverseCells >= Math.max(4, Math.floor(terminal.cols * 0.25)),
      };
    };
    const isPatchLikeLine = (line: IBufferLine) => {
      const text = line.translateToString(true).trim();
      return /^(?:\d+\s+)?(?:[+-](?![+-]{2,})|@@|diff --git |index |--- |\+\+\+ |\*\*\* (?:Begin|End) Patch|\*\*\* (?:Update|Add|Delete) File:|```(?:diff|patch)?\s*$)/.test(text);
    };
    const clearLineBackground = (line: IBufferLine, clearInverse: boolean, clearForeground: boolean = false) => {
      const mutableLine = (line as XtermBufferLineApiView)._line;
      if (!mutableLine) return false;
      const limit = Math.min(terminal.cols, mutableLine.length);
      let changed = false;
      for (let x = 0; x < limit; x += 1) {
        mutableLine.loadCell(x, probeCell);
        // Drop only visual field styling; optionally reset low-contrast ANSI text on patch rows.
        const nextBg = probeCell.bg & ~XTERM_BG_COLOR_MASK;
        const fgWithoutColor = clearForeground ? probeCell.fg & ~XTERM_BG_COLOR_MASK : probeCell.fg;
        const nextFg = clearInverse ? fgWithoutColor & ~XTERM_INVERSE_FLAG : fgWithoutColor;
        if (nextBg === probeCell.bg && nextFg === probeCell.fg) continue;
        probeCell.bg = nextBg;
        probeCell.fg = nextFg;
        mutableLine.setCell(x, probeCell);
        changed = true;
      }
      return changed;
    };

    let firstChangedRow = terminal.rows;
    let lastChangedRow = -1;
    const markChangedRow = (row: number) => {
      firstChangedRow = Math.min(firstChangedRow, row);
      lastChangedRow = Math.max(lastChangedRow, row);
    };
    const isSlashCommandPromptLine = (line: IBufferLine) => {
      const text = normalizePromptText(line);
      return TUI_COMPOSER_PROMPT_PATTERN.test(text) && /^[\u203a\u276f\u00bb\u2023>]\s*\/\S*$/u.test(text);
    };
    const getSlashCommandMenuLineState = (line: IBufferLine) => {
      const text = line.translateToString(true);
      const trimmed = text.trimStart();
      const commandMatch = SLASH_COMMAND_MENU_LINE_PATTERN.exec(trimmed);
      if (!commandMatch) return null;

      const leadingSpaces = text.length - trimmed.length;
      const commandEnd = leadingSpaces + commandMatch[0].trimEnd().length;
      const limit = Math.min(terminal.cols, line.length, text.length);
      let visibleDescriptionCells = 0;
      let highlightedDescriptionCells = 0;
      for (let x = commandEnd; x < limit; x += 1) {
        const cell = line.getCell(x, probeCell);
        if (!cell || cell.getWidth() === 0 || cell.getChars().trim() === "") continue;
        visibleDescriptionCells += 1;
        if ((cell.getFgColorMode() !== 0 || cell.isBold() !== 0) && cell.isDim() === 0) {
          highlightedDescriptionCells += 1;
        }
      }

      return {
        selectedByForeground: highlightedDescriptionCells >= Math.max(
          6,
          Math.floor(visibleDescriptionCells * 0.35),
        ),
      };
    };
    const syncOwnedSlashMenuBackground = (line: IBufferLine, selected: boolean) => {
      const mutableLine = (line as XtermBufferLineApiView)._line;
      if (!mutableLine) return false;
      const limit = Math.min(terminal.cols, mutableLine.length);
      let changed = false;
      for (let x = 0; x < limit; x += 1) {
        mutableLine.loadCell(x, probeCell);
        const hasOwnedBackground = probeCell.isBgRGB()
          && probeCell.getBgColor() === CLAUDE_LIGHT_SLASH_MENU_SELECTED_BG;
        const nextBg = selected
          ? (probeCell.bg & ~XTERM_BG_COLOR_MASK) | XTERM_COLOR_MODE_RGB | CLAUDE_LIGHT_SLASH_MENU_SELECTED_BG
          : hasOwnedBackground
            ? probeCell.bg & ~XTERM_BG_COLOR_MASK
            : probeCell.bg;
        if (nextBg === probeCell.bg) continue;
        probeCell.bg = nextBg;
        mutableLine.setCell(x, probeCell);
        changed = true;
      }
      return changed;
    };
    const syncClaudeLightSlashMenuHighlights = () => {
      let promptRow = -1;
      const commandRows: Array<{ row: number; line: IBufferLine; selectedByForeground: boolean }> = [];
      for (let row = minRow; row < terminal.rows; row += 1) {
        const line = getViewportLine(row);
        if (line && isSlashCommandPromptLine(line)) promptRow = row;
      }
      if (promptRow >= 0) {
        for (let row = promptRow + 1; row < terminal.rows; row += 1) {
          const line = getViewportLine(row);
          if (!line) continue;
          const state = getSlashCommandMenuLineState(line);
          if (!state) continue;
          commandRows.push({ row, line, selectedByForeground: state.selectedByForeground });
        }
      }

      const foregroundSelectedRow = commandRows.find((item) => item.selectedByForeground)?.row;
      const selectedRow = foregroundSelectedRow ?? commandRows[0]?.row ?? -1;
      for (let row = minRow; row < terminal.rows; row += 1) {
        const line = getViewportLine(row);
        if (!line) continue;
        if (!syncOwnedSlashMenuBackground(line, row === selectedRow)) continue;
        markChangedRow(row);
      }
    };

    if (useBroadViewportNormalization && (knownAiSession || hasKnownAiTuiSignature())) {
      for (let row = minRow; row < terminal.rows; row += 1) {
        const line = getViewportLine(row);
        if (!line) continue;
        const backgroundState = getLineBackgroundState(line);
        if (!backgroundState.hasExplicitBackground && !backgroundState.hasInverse) continue;
        if (!clearLineBackground(line, backgroundState.hasInverse)) continue;
        markChangedRow(row);
      }
      if (lastChangedRow >= firstChangedRow) {
        terminal.refresh(firstChangedRow, lastChangedRow);
      }
      return;
    }

    if (useClaudeLightPatchNormalization) {
      for (let row = minRow; row < terminal.rows; row += 1) {
        const line = getViewportLine(row);
        if (!line || !isPatchLikeLine(line)) continue;
        const backgroundState = getLineBackgroundState(line);
        if (!backgroundState.hasExplicitBackground && !backgroundState.hasInverse) continue;
        if (!clearLineBackground(line, backgroundState.hasInverse, true)) continue;
        markChangedRow(row);
      }
      syncClaudeLightSlashMenuHighlights();
      if (lastChangedRow >= firstChangedRow) {
        terminal.refresh(firstChangedRow, lastChangedRow);
      }
      return;
    }

    for (let promptRow = terminal.rows - 1; promptRow >= minRow; promptRow -= 1) {
      const promptLine = getViewportLine(promptRow);
      if (!promptLine || !isTuiPromptLine(promptLine)) continue;

      const startRow = Math.max(minRow, promptRow - TUI_COMPOSER_PRELUDE_ROWS);
      const maxRow = Math.min(terminal.rows - 1, promptRow + TUI_COMPOSER_CONTINUATION_ROWS);
      for (let row = startRow; row <= maxRow; row += 1) {
        const line = getViewportLine(row);
        if (!line) break;
        const backgroundState = getLineBackgroundState(line);
        if (row < promptRow) {
          if (!backgroundState.hasExplicitBackground && !backgroundState.hasWideInverse) continue;
          if (!clearLineBackground(line, backgroundState.hasWideInverse)) continue;
          markChangedRow(row);
          continue;
        }
        if (
          row > promptRow
          && !line.isWrapped
          && !backgroundState.hasExplicitBackground
          && !backgroundState.hasWideInverse
        ) {
          break;
        }
        if (!backgroundState.hasExplicitBackground && !backgroundState.hasWideInverse) continue;
        if (!clearLineBackground(line, backgroundState.hasWideInverse)) continue;
        markChangedRow(row);
      }
    }

    if (lastChangedRow >= firstChangedRow) {
      terminal.refresh(firstChangedRow, lastChangedRow);
    }
  };

  const scheduleTuiComposerBackgroundNormalization = (terminal: Terminal | null = terminalRef.current) => {
    if (!terminal || tuiComposerNormalizeRafRef.current !== null) return;
    tuiComposerNormalizeRafRef.current = window.requestAnimationFrame(() => {
      tuiComposerNormalizeRafRef.current = null;
      if (terminalRef.current !== terminal) return;
      normalizeTuiComposerBackground(terminal);
    });
  };

  const processCursorVisibility = (text: string) => {
    const cursorPattern = /\x1b\[\?25[hl]/g;
    let processed = "";
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = cursorPattern.exec(text)) !== null) {
      processed += text.slice(lastIndex, match.index);
      const sequence = match[0];
      if (sequence.endsWith("l")) {
        cancelPendingCursorShow();
        processed += sequence;
      } else {
        scheduleCursorShow();
      }
      lastIndex = match.index + sequence.length;
    }

    return processed + text.slice(lastIndex);
  };

  const setInactiveReplayPendingVisible = (pending: boolean) => {
    if (inactiveReplayPendingRef.current === pending) return;
    inactiveReplayPendingRef.current = pending;
    setInactiveReplayPending(pending);
  };

  const hasQueuedInactiveReplay = () => activeWriteQueueRef.current.some((item) => item.inactiveReplay);

  const finishInactiveReplayIfReady = (terminal: Terminal) => {
    if (!inactiveReplayStickToBottomRef.current) return;
    if (
      hasQueuedInactiveReplay()
      || inactiveReplayPendingWritesRef.current > 0
    ) {
      return;
    }
    inactiveReplayStickToBottomRef.current = false;
    terminal.scrollToBottom();
    setInactiveReplayPendingVisible(false);
  };

  const flushActiveWriteQueue = () => {
    activeWriteRafRef.current = null;
    if (!isVisibleRef.current || activeWriteQueueRef.current.length === 0) {
      if (!isVisibleRef.current && activeWriteQueueRef.current.length > 0 && useSettingsStore.getState().debugMode) {
        logInfo("[terminal-visibility] active write flush deferred while hidden", {
          sessionId,
          queuedChars: activeWriteQueueSizeRef.current,
          queuedChunks: activeWriteQueueRef.current.length,
        });
      }
      return;
    }
    const terminal = terminalRef.current;
    if (!terminal) return;

    const writeTerminalChunk = (chunk: string, inactiveReplay: boolean) => {
      if (inactiveReplay) inactiveReplayPendingWritesRef.current += 1;
      terminal.write(chunk, () => {
        if (inactiveReplay) {
          inactiveReplayPendingWritesRef.current = Math.max(0, inactiveReplayPendingWritesRef.current - 1);
        }
        if (terminalRef.current !== terminal) return;
        if (inactiveReplay) terminal.scrollToBottom();
        normalizeTuiComposerBackground(terminal);
        scheduleTuiComposerBackgroundNormalization(terminal);
        if (inactiveReplay) finishInactiveReplayIfReady(terminal);
      });
    };

    let budget = ACTIVE_WRITE_FRAME_BUDGET;
    while (budget > 0 && activeWriteQueueRef.current.length > 0) {
      const item = activeWriteQueueRef.current[0];
      const chunk = item.text;
      if (chunk.length <= budget) {
        writeTerminalChunk(chunk, item.inactiveReplay);
        activeWriteQueueRef.current.shift();
        activeWriteQueueSizeRef.current = Math.max(0, activeWriteQueueSizeRef.current - chunk.length);
        budget -= chunk.length;
        continue;
      }
      writeTerminalChunk(chunk.slice(0, budget), item.inactiveReplay);
      activeWriteQueueRef.current[0] = { ...item, text: chunk.slice(budget) };
      activeWriteQueueSizeRef.current = Math.max(0, activeWriteQueueSizeRef.current - budget);
      budget = 0;
    }

    if (activeWriteQueueRef.current.length > 0) {
      activeWriteRafRef.current = requestAnimationFrame(flushActiveWriteQueue);
    } else {
      finishInactiveReplayIfReady(terminal);
    }
  };

  const enqueueActiveWrite = (text: string, inactiveReplay = false) => {
    if (!text) return;
    let nextText = processCursorVisibility(text);
    let droppedChars = 0;
    if (nextText.length >= ACTIVE_WRITE_QUEUE_MAX_CHARS) {
      droppedChars += activeWriteQueueSizeRef.current + nextText.length - ACTIVE_WRITE_QUEUE_MAX_CHARS;
      nextText = nextText.slice(-ACTIVE_WRITE_QUEUE_MAX_CHARS);
      activeWriteQueueRef.current = [];
      activeWriteQueueSizeRef.current = 0;
    }
    activeWriteQueueRef.current.push({ text: nextText, inactiveReplay });
    activeWriteQueueSizeRef.current += nextText.length;
    while (activeWriteQueueSizeRef.current > ACTIVE_WRITE_QUEUE_MAX_CHARS && activeWriteQueueRef.current.length > 0) {
      const overflow = activeWriteQueueSizeRef.current - ACTIVE_WRITE_QUEUE_MAX_CHARS;
      const head = activeWriteQueueRef.current[0];
      if (!head || head.text.length <= overflow) {
        const removed = activeWriteQueueRef.current.shift();
        const removedLength = removed?.text.length ?? 0;
        activeWriteQueueSizeRef.current -= removedLength;
        droppedChars += removedLength;
        continue;
      }
      activeWriteQueueRef.current[0] = { ...head, text: head.text.slice(overflow) };
      activeWriteQueueSizeRef.current -= overflow;
      droppedChars += overflow;
    }
    if (droppedChars > 0) {
      const now = Date.now();
      if (now - activeWriteQueueLastDropLogAtRef.current >= ACTIVE_WRITE_QUEUE_LOG_INTERVAL_MS) {
        activeWriteQueueLastDropLogAtRef.current = now;
        debugConsoleWarn("[oom-diagnostics:webview]", {
          area: "xterm",
          phase: "activeWriteQueueTrim",
          sessionId,
          droppedChars,
          queuedChars: activeWriteQueueSizeRef.current,
          maxQueuedChars: ACTIVE_WRITE_QUEUE_MAX_CHARS,
          thresholdExceeded: true,
        });
      }
    }
    if (activeWriteRafRef.current === null) {
      activeWriteRafRef.current = requestAnimationFrame(flushActiveWriteQueue);
    }
  };

  // Hot-update terminal options without recreating the terminal.
  // `isTransparent` is in the dep array so toggling the background image
  // immediately recomputes the theme (otherwise the WebGL clear color stays
  // opaque and the image-bearing pseudo-elements get painted over).
  // `background.overlayDarken` is also tracked so the per-cell alpha floor
  // (which stabilises subpixel text edges over high-frequency images) updates
  // live while the user drags the slider.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const baseTheme = getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
    const minimumContrastRatio = getTerminalMinimumContrastRatio(baseTheme);
    const nextTheme = isTransparent ? applyTransparency(baseTheme, background.overlayDarken) : baseTheme;
    terminal.options.theme = withVisibleSelectionTheme(nextTheme);
    if (terminal.options.minimumContrastRatio !== minimumContrastRatio) {
      terminal.options.minimumContrastRatio = minimumContrastRatio;
    }
    const weightChanged = terminal.options.fontWeight !== "normal" || terminal.options.fontWeightBold !== "bold";
    if (weightChanged) {
      terminal.options.fontWeight = "normal";
      terminal.options.fontWeightBold = "bold";
    }
    const rendererChanged = syncWebglRenderer(terminal, baseTheme);
    const sizeChanged = terminal.options.fontSize !== fontSize || terminal.options.fontFamily !== effectiveFontFamily;
    if (sizeChanged || weightChanged) {
      terminal.options.fontSize = fontSize;
      terminal.options.fontFamily = effectiveFontFamily;
    }
    if (sizeChanged || weightChanged || rendererChanged) {
      scheduleFit(true);
    }
    if (terminal.options.scrollback !== terminalScrollbackRows) {
      terminal.options.scrollback = terminalScrollbackRows;
    }
    normalizeTuiComposerBackground(terminal);
    scheduleTuiComposerBackgroundNormalization(terminal);
  }, [fontSize, effectiveFontFamily, terminalScrollbackRows, resolvedTheme, terminalThemeName, lightThemePalette, darkThemePalette, isTransparent, background.overlayDarken, lowMemoryMode, disableHardwareAcceleration]);

  // Visibility drives live rendering. A pane tab is "visible" when it is the
  // shown tab in its own pane — which, in a split, includes panes that are not
  // the globally focused one. When a tab becomes visible, flush any output
  // stashed while it was hidden and refit to its current size. This keeps a
  // split's unfocused half rendering live instead of freezing until clicked.
  useEffect(() => {
    const wasVisible = isVisibleRef.current;
    isVisibleRef.current = isVisible;

    if (!isVisible) {
      clearHiddenWebglDisposeTimer();
      if (lowMemoryMode && webglAddonRef.current) {
        webglDisposeTimerRef.current = window.setTimeout(() => {
          webglDisposeTimerRef.current = null;
          if (isVisibleRef.current) return;
          if (disposeWebglRenderer()) {
            needsViewportRefreshRef.current = true;
          }
        }, HIDDEN_WEBGL_DISPOSE_DELAY_MS);
      }
      return;
    }

    clearHiddenWebglDisposeTimer();
    const terminal = terminalRef.current;
    const baseTheme = getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
    if (terminal && syncWebglRenderer(terminal, baseTheme)) {
      needsViewportRefreshRef.current = true;
    }

    if (!fitAddonRef.current || !containerRef.current) return;
    const restorePlan = planTerminalVisibilityRestore({
      wasVisible,
      isVisible,
      inactiveBufferLength: inactiveBufferRef.current.length,
      activeWriteQueueLength: activeWriteQueueRef.current.length,
      activeWriteRafScheduled: activeWriteRafRef.current !== null,
    });
    // Flush data stashed while this tab was hidden
    if (restorePlan.shouldFlushInactiveBuffer && terminalRef.current) {
      const combined = inactiveBufferRef.current.join("");
      inactiveBufferRef.current = [];
      inactiveBufferSizeRef.current = 0;
      inactiveReplayStickToBottomRef.current = true;
      inactiveReplayPendingWritesRef.current = 0;
      setInactiveReplayPendingVisible(true);
      terminalRef.current.scrollToBottom();
      enqueueActiveWrite(combined, true);
    }
    if (restorePlan.shouldResumeActiveWriteQueue && activeWriteRafRef.current === null) {
      if (useSettingsStore.getState().debugMode) {
        logInfo("[terminal-visibility] resuming queued active writes after visibility restore", {
          sessionId,
          queuedChars: activeWriteQueueSizeRef.current,
          queuedChunks: activeWriteQueueRef.current.length,
        });
      }
      activeWriteRafRef.current = requestAnimationFrame(flushActiveWriteQueue);
    }
    if (restorePlan.shouldRefreshViewport) {
      needsViewportRefreshRef.current = true;
    }
    // Wait one frame to ensure display:block has taken effect and layout is stable.
    scheduleFit(true);
    scheduleViewportRefresh();
    if (terminalRef.current) {
      normalizeTuiComposerBackground(terminalRef.current);
      scheduleTuiComposerBackgroundNormalization(terminalRef.current);
    }
  }, [isVisible, lowMemoryMode, disableHardwareAcceleration, resolvedTheme, terminalThemeName, lightThemePalette, darkThemePalette]);

  // Focus follows the single globally active tab. Keyboard, cursor and IME stay
  // bound to this; a visible-but-unfocused split pane renders but never steals
  // focus.
  useEffect(() => {
    isActiveRef.current = isActive;
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (isActive) {
      terminal.focus();
    } else {
      terminal.blur();
    }
  }, [isActive]);

  useEffect(() => {
    if (!containerRef.current) return;

    const baseTheme = getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      cursorBlink: false,
      cursorStyle: "bar",
      cursorWidth: 1,
      fontSize,
      fontFamily: effectiveFontFamily,
      fontWeight: "normal",
      fontWeightBold: "bold",
      scrollback: terminalScrollbackRows,
      scrollOnEraseInDisplay: true,
      allowProposedApi: true,
      windowsPty: { backend: "conpty" },
      minimumContrastRatio: getTerminalMinimumContrastRatio(baseTheme),
      // xterm cannot toggle transparency after construction, so keep it enabled
      // even though WebGL is disabled while a background image is active.
      allowTransparency: true,
      theme: withVisibleSelectionTheme(isTransparentRef.current ? applyTransparency(baseTheme, background.overlayDarken) : baseTheme),
      // OSC 8 超链接（codex 等 CLI 输出）默认点击行为是 window.open，在 Tauri
      // webview 里会被拦成"是否导航"确认框。接管为系统默认浏览器打开，仅放行
      // http/https，避免恶意 scheme。
      linkHandler: {
        activate: (_event, uri) => openHttpUrl(sessionId, uri),
      },
    });
    // Keep Claude Code / other TUIs from overriding the app-wide thin cursor via DECSCUSR.
    const cursorStyleDisposable = terminal.parser.registerCsiHandler({ intermediates: " ", final: "q" }, () => true);

    const fitAddon = new FitAddon();
    const imageAddon = new ImageAddon({
      enableSizeReports: false,
      pixelLimit: IMAGE_ADDON_PIXEL_LIMIT,
      storageLimit: IMAGE_ADDON_STORAGE_LIMIT_MB,
      sixelSizeLimit: IMAGE_ADDON_SEQUENCE_LIMIT,
      iipSizeLimit: IMAGE_ADDON_SEQUENCE_LIMIT,
    });
    const searchAddon = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
    const serializeAddon = new SerializeAddon();
    const unicode11Addon = new Unicode11Addon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => openHttpUrl(sessionId, uri));
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(imageAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(serializeAddon);
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = "11";
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);
    const searchResultDisposable = searchAddon.onDidChangeResults((event) => {
      setSearchResult({ resultIndex: event.resultIndex, resultCount: event.resultCount });
    });

    let webglAddon: WebglAddon | null = null;
    if (!(lowMemoryMode && !isVisibleRef.current) && canUseWebglRenderer(baseTheme)) {
      try {
        webglAddon = createWebglAddon();
        terminal.loadAddon(webglAddon);
        webglAddonRef.current = webglAddon;
      } catch {
        // WebGL not supported, fall back to canvas
      }
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    scheduleFit(true);
    const sessionSnapshot = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
    const initialTerminalOutput = sessionSnapshot?.initialTerminalOutput;
    const writeDeferredStartup = () => {
      if (!sessionSnapshot?.deferStartupUntilInitialOutput || !sessionSnapshot.startupCmd) return;
      invoke("pty_write", {
        sessionId,
        data: formatStartupInputForPty(sessionSnapshot.startupCmd, normalizeShellKey(sessionSnapshot.shell) ?? null),
      }).catch((err) => reportPtyWriteError("deferredStartup", err));
    };
    if (initialTerminalOutput) {
      terminal.write(initialTerminalOutput, () => {
        terminal.scrollToBottom();
        refreshTerminalViewport(terminal);
        scheduleViewportRefresh();
        writeDeferredStartup();
      });
    } else {
      writeDeferredStartup();
    }
    if (isActive) {
      terminal.focus();
    }

    const copySelection = async () => {
      const selection = terminal.getSelection();
      if (!selection) return;
      await copyTextToClipboard(selection);
    };

    const markAttentionInputHandled = () => useTerminalStore.getState().markAttentionInputHandled(sessionId);

    const pasteIntoTerminal = (text: string) => {
      const normalizedText = trimTerminalPasteBoundaryLineBreaks(text);
      if (!normalizedText) return;
      markAttentionInputHandled();
      terminal.paste(normalizedText);
    };

    const pasteTarget = containerRef.current;
    const pasteListenerOptions = { capture: true } as const;
    const isPointInsidePasteTarget = (x: number, y: number) => {
      const rect = pasteTarget.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    const hasTerminalFileDragData = (dataTransfer: DataTransfer | null) => (
      Boolean(getTerminalFileDragText()) || hasDataTransferType(dataTransfer, TERMINAL_FILE_PATH_MIME)
    );
    const pasteTerminalFileText = (text: string) => {
      const normalizedText = `${text.replace(/[ \t]+$/u, "")} `;
      const previousInput = inputBuffer.current;
      const previousCursorIndex = clampTextCursorIndex(previousInput, inputCursorIndexRef.current);
      const expectedInput = insertTextAtCursor(previousInput, previousCursorIndex, normalizedText);
      const currentRichInput = richInputStateRef.current;
      if (
        currentRichInput?.input === previousInput &&
        currentRichInput.cols === terminal.cols
      ) {
        trustedRichInputAnchorRef.current = {
          inputStartCellIndex: currentRichInput.inputStartCellIndex,
          maskedInputWidth: currentRichInput.maskedInputWidth,
          cols: currentRichInput.cols,
        };
      }
      pasteIntoTerminal(normalizedText);
      if (inputBuffer.current !== expectedInput) {
        inputBuffer.current = expectedInput;
        inputCursorIndexRef.current = previousCursorIndex + getTextCursorLength(normalizedText);
      }
    };
    const unregisterTerminalDropZone = registerTerminalDropZone({
      id: sessionId,
      getRect: () => {
        if (!isVisibleRef.current) return null;
        return pasteTarget.getBoundingClientRect();
      },
      paste: pasteTerminalFileText,
      focus: () => terminal.focus(),
    });
    const getShellForPathQuoting = async () => {
      const os = await getOsPlatformForPathQuoting();
      const session = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
      const sessionShell = normalizeShellForKnownOs(session?.shell, os);
      if (sessionShell) return sessionShell;
      const defaultShell = normalizeShellForKnownOs(useSettingsStore.getState().defaultShell, os);
      return defaultShell ?? defaultShellForOs(os);
    };
    const getCurrentDropContext = () => {
      const session = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
      const project = session?.projectId
        ? useProjectStore.getState().projects.find((item) => item.id === session.projectId)
        : null;
      return { session, project };
    };
    const savePastedImageForTerminal = async (
      file: File,
      context: ReturnType<typeof getCurrentDropContext>
    ): Promise<string | null> => {
      const { session, project } = context;
      const attachRootPath = project?.path || session?.cwd || null;
      if (!attachRootPath) return null;

      try {
        const fileName = createClipboardImageFileName(file);
        const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
        const attachedRelativePath = await attachClipboardImageData(attachRootPath, fileName, dataBase64);
        cleanupExpiredAttachmentsOnce(attachRootPath);
        return joinLocalPath(attachRootPath, attachedRelativePath);
      } catch (err) {
        logError("Failed to attach pasted terminal image", { sessionId, err });
        toast.error("截图粘贴失败", { description: String(err) });
        return null;
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      const imageFile = getClipboardImageFile(e.clipboardData);
      const context = getCurrentDropContext();
      if (imageFile) {
        e.preventDefault();
        e.stopPropagation();
        void savePastedImageForTerminal(imageFile, context).then(async (path) => {
          if (!path) return;
          pasteIntoTerminal(formatShellPathList([path], await getShellForPathQuoting()));
          terminal.focus();
        });
        return;
      }

      const text = e.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      pasteIntoTerminal(text);
    };

    pasteTarget.addEventListener("paste", onPaste, pasteListenerOptions);

    const onDragOver = (e: DragEvent) => {
      const isActiveTerminalFileDrag = Boolean(getTerminalFileDragText());
      if (isActiveTerminalFileDrag) updateTerminalFileDragPointFromEvent(e);
      if (!isPointInsidePasteTarget(e.clientX, e.clientY) || !hasTerminalFileDragData(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      if (!isPointInsidePasteTarget(e.clientX, e.clientY) || !hasTerminalFileDragData(e.dataTransfer)) return;
      const text = getTerminalFileDragText()
        || e.dataTransfer?.getData(TERMINAL_FILE_PATH_MIME)
        || e.dataTransfer?.getData("text/plain")
        || "";
      e.preventDefault();
      e.stopPropagation();
      if (!text) return;
      pasteTerminalFileText(text);
      endTerminalFileDrag();
      terminal.focus();
    };
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", onDrop, true);

    let unlistenFileDrop: UnlistenFn | null = null;
    let fileDropCancelled = false;
    getCurrentWebview().onDragDropEvent(async (event) => {
      const payload = event.payload;
      if (payload.type !== "drop" || payload.paths.length === 0) return;
      const scaleFactor = await getCurrentWindow().scaleFactor().catch(() => window.devicePixelRatio || 1);
      if (fileDropCancelled) return;
      const position = payload.position.toLogical(scaleFactor);
      const dropZoneId = getTerminalFileDropZoneIdAtPoint(position.x, position.y);
      if (dropZoneId && dropZoneId !== sessionId) return;
      if (!dropZoneId && (!isActiveRef.current || !isVisibleRef.current)) return;

      pasteIntoTerminal(formatShellPathList(payload.paths, await getShellForPathQuoting()));
      terminal.focus();
    }).then((fn) => {
      if (fileDropCancelled) {
        fn();
      } else {
        unlistenFileDrop = fn;
      }
    }).catch((err) => {
      logError("Failed to listen terminal file drop", { sessionId, err });
    });

    const contextMenuTarget = containerRef.current;
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (terminal.hasSelection()) {
        void copySelection();
        terminal.clearSelection();
        terminal.focus();
        setMenuState(null);
        return;
      }
      setMenuState({ x: e.clientX, y: e.clientY, hasSelection: false });
    };
    contextMenuTarget.addEventListener("contextmenu", onContextMenu);

    const moveInputCursorToClick = (e: MouseEvent) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.detail !== 1 ||
        e.shiftKey ||
        e.ctrlKey ||
        e.altKey ||
        e.metaKey ||
        isComposingRef.current ||
        terminal.hasSelection()
      ) {
        return;
      }

      const currentInput = inputBuffer.current;
      if (!currentInput) return;

      const terminalContainer = containerRef.current;
      const screen = terminalContainer?.querySelector(".xterm-screen") as HTMLElement | null;
      if (!terminalContainer || !screen) return;

      const screenRect = screen.getBoundingClientRect();
      if (
        e.clientX < screenRect.left ||
        e.clientX > screenRect.right ||
        e.clientY < screenRect.top ||
        e.clientY > screenRect.bottom
      ) {
        return;
      }

      const cell = getTerminalRenderedCellSize(terminal, terminalContainer, fontSize);
      const clickColumn = Math.min(
        Math.max(0, Math.floor((e.clientX - screenRect.left) / Math.max(1, cell.width))),
        Math.max(0, terminal.cols)
      );
      const clickRow = Math.min(
        Math.max(0, Math.floor((e.clientY - screenRect.top) / Math.max(1, cell.height))),
        Math.max(0, terminal.rows - 1)
      );

      const buffer = terminal.buffer.active;
      const currentCursorIndex = clampTextCursorIndex(currentInput, inputCursorIndexRef.current);
      const cursorPrefixWidth = getTerminalCellWidth(sliceTextByCursor(currentInput, 0, currentCursorIndex));
      const cursorCellIndex = ((buffer.baseY + buffer.cursorY) * terminal.cols) + buffer.cursorX;
      const inputStartCellIndex = cursorCellIndex - cursorPrefixWidth;
      const inputEndCellIndex = inputStartCellIndex + getTerminalCellWidth(currentInput);
      const clickCellIndex = ((buffer.viewportY + clickRow) * terminal.cols) + clickColumn;
      const inputStartRow = Math.floor(inputStartCellIndex / terminal.cols);
      const inputEndRow = Math.floor(inputEndCellIndex / terminal.cols);
      const clickRowAbsolute = buffer.viewportY + clickRow;
      if (clickRowAbsolute < inputStartRow || clickRowAbsolute > inputEndRow) return;

      const targetCellOffset = Math.min(
        Math.max(0, clickCellIndex - inputStartCellIndex),
        Math.max(0, inputEndCellIndex - inputStartCellIndex)
      );
      const targetCursorIndex = resolveCursorIndexFromCellOffset(currentInput, targetCellOffset);
      const delta = targetCursorIndex - currentCursorIndex;
      if (delta === 0) {
        terminal.focus();
        return;
      }

      const data = delta > 0
        ? repeatControlSequence("\x1b[C", delta)
        : repeatControlSequence("\x1b[D", -delta);
      inputCursorIndexRef.current = targetCursorIndex;
      selectedInputSnapshot = null;
      clearSuggestionGhost();
      cancelAiSuggestionRefresh();
      markAttentionInputHandled();
      invoke("pty_write", { sessionId, data }).catch((err) => reportPtyWriteError("click_cursor", err));
      terminal.focus();
    };
    contextMenuTarget.addEventListener("click", moveInputCursorToClick);

    let selectedInputSnapshot: string | null = null;

    const rewriteCurrentInput = (nextInput: string, stage: string) => {
      inputBuffer.current = nextInput;
      inputCursorIndexRef.current = getTextCursorLength(nextInput);
      trustedRichInputAnchorRef.current = null;
      terminal.clearSelection();
      selectedInputSnapshot = null;
      markAttentionInputHandled();
      clearSuggestionGhost();
      cancelAiSuggestionRefresh();
      invoke("pty_write", { sessionId, data: `\x15${nextInput}` }).catch((err) => reportPtyWriteError(stage, err));
    };

    const isReplaceableInputData = (data: string) => {
      if (!data || data === "\r" || data === "\x7f" || data === "\b") return false;
      if (data.startsWith("\x1b") && !data.startsWith("\x1b[200~")) return false;
      return true;
    };

    const consumeSelectedInputForReplacement = (data: string) => {
      if (
        !selectedInputSnapshot ||
        selectedInputSnapshot !== inputBuffer.current ||
        !terminal.hasSelection() ||
        !isReplaceableInputData(data)
      ) {
        return false;
      }

      inputBuffer.current = "";
      inputCursorIndexRef.current = 0;
      trustedRichInputAnchorRef.current = null;
      selectedInputSnapshot = null;
      terminal.clearSelection();
      return true;
    };

    const resolveVisibleInputSelection = () => {
      const buffer = terminal.buffer.active;
      const rowText = (row: number) => {
        const line = buffer.getLine(buffer.viewportY + row);
        return line ? line.translateToString(true) : null;
      };
      const rowIsHorizontalRule = (row: number) => {
        const text = rowText(row);
        if (text === null) return false;
        const trimmed = text.trim();
        return trimmed.length > 0 && /^[─━═╌╍┄┅┈┉╴╶]+$/u.test(trimmed);
      };
      const findPromptContentStartColumn = (line: IBufferLine) => {
        const limit = Math.min(terminal.cols, line.length);
        for (let x = 0; x < limit; x += 1) {
          const cell = line.getCell(x);
          const chars = cell?.getChars() ?? "";
          if (!cell || !chars.trim() || TUI_BORDER_CHAR_PATTERN.test(chars)) continue;
          if (!TUI_COMPOSER_PROMPT_PATTERN.test(chars)) return null;
          let start = x + Math.max(1, cell.getWidth());
          while (start < limit) {
            const nextCell = line.getCell(start);
            const nextChars = nextCell?.getChars() ?? "";
            if (nextChars !== " ") break;
            start += Math.max(1, nextCell?.getWidth() ?? 1);
          }
          return start;
        }
        return null;
      };
      const getContentEndColumn = (line: IBufferLine, minColumn: number) => {
        const limit = Math.min(terminal.cols, line.length);
        for (let x = limit - 1; x >= minColumn; x -= 1) {
          const cell = line.getCell(x);
          const chars = cell?.getChars() ?? "";
          if (!cell || cell.getWidth() === 0 || !chars.trim() || TUI_BORDER_CHAR_PATTERN.test(chars)) continue;
          return Math.min(terminal.cols, x + Math.max(1, cell.getWidth()));
        }
        return minColumn;
      };

      for (let row = terminal.rows - 1; row >= 0; row -= 1) {
        const line = buffer.getLine(buffer.viewportY + row);
        if (!line) continue;
        const startColumn = findPromptContentStartColumn(line);
        if (startColumn === null) continue;

        let endRow = row;
        let endColumn = getContentEndColumn(line, startColumn);
        for (let nextRow = row + 1; nextRow < terminal.rows; nextRow += 1) {
          const nextLine = buffer.getLine(buffer.viewportY + nextRow);
          if (!nextLine || rowIsHorizontalRule(nextRow) || !nextLine.isWrapped) break;
          const nextEndColumn = getContentEndColumn(nextLine, 0);
          if (nextEndColumn <= 0) break;
          endRow = nextRow;
          endColumn = nextEndColumn;
        }

        const startCellIndex = ((buffer.viewportY + row) * terminal.cols) + startColumn;
        const endCellIndex = ((buffer.viewportY + endRow) * terminal.cols) + endColumn;
        const length = endCellIndex - startCellIndex;
        if (length <= 0) return null;
        return { startColumn, startRow: buffer.viewportY + row, length };
      }

      return null;
    };

    const selectCurrentInputText = () => {
      const currentInput = inputBuffer.current;
      selectedInputSnapshot = currentInput || null;
      terminal.clearSelection();
      if (!currentInput) {
        terminal.focus();
        return true;
      }

      const inputCellWidth = getTerminalCellWidth(currentInput);
      if (inputCellWidth <= 0) {
        terminal.focus();
        return true;
      }

      const visibleSelection = resolveVisibleInputSelection();
      if (visibleSelection) {
        terminal.select(visibleSelection.startColumn, visibleSelection.startRow, visibleSelection.length);
        terminal.focus();
        return true;
      }

      const buffer = terminal.buffer.active;
      const cursorCellIndex = ((buffer.baseY + buffer.cursorY) * terminal.cols) + buffer.cursorX;
      const cursorPrefixWidth = getTerminalCellWidth(sliceTextByCursor(currentInput, 0, inputCursorIndexRef.current));
      const startCellIndex = Math.max(0, cursorCellIndex - cursorPrefixWidth);
      const startRow = Math.floor(startCellIndex / terminal.cols);
      const startColumn = startCellIndex % terminal.cols;
      terminal.select(startColumn, startRow, inputCellWidth);
      terminal.focus();
      return true;
    };

    const removeSelectedInputText = () => {
      const selectedText = terminal.getSelection();
      const currentInput = inputBuffer.current;
      if (!selectedText && selectedInputSnapshot === currentInput && currentInput) {
        rewriteCurrentInput("", "selection_delete_all");
        return true;
      }

      if (!selectedText || !currentInput) {
        selectedInputSnapshot = null;
        return false;
      }

      if (selectedInputSnapshot === currentInput) {
        rewriteCurrentInput("", "selection_delete_all");
        return true;
      }

      const candidates = [
        selectedText,
        selectedText.replace(/\r\n?/g, "\n"),
        selectedText.replace(/\r\n?|\n/g, ""),
      ].filter(Boolean);
      const matchedText = candidates.find((text, index) => (
        candidates.indexOf(text) === index && currentInput.includes(text)
      ));
      if (!matchedText) return false;

      const index = currentInput.indexOf(matchedText);
      const nextInput = `${currentInput.slice(0, index)}${currentInput.slice(index + matchedText.length)}`;
      rewriteCurrentInput(nextInput, "selection_delete");
      return true;
    };

    // 退格删整段 @path：基于扫屏（不依赖 inputBuffer，故 TUI 下也可靠），
    // 读光标实际位置，构建“光标所在逻辑行、光标之前”的文本，若其正好以一个
    // @token 结尾，则返回该 token 的字符数，供 handler 发送等量退格整段删除。
    const getAiPathBackspaceCount = (): number => {
      const buffer = terminal.buffer.active;
      const cursorRow = buffer.cursorY; // 相对 viewport 顶部的屏幕行
      const cursorX = buffer.cursorX;
      if (cursorRow < 0 || cursorX <= 0) return 0;
      const reusableCell = buffer.getNullCell();

      // 找到光标所在逻辑行的起始屏幕行（向上回溯 isWrapped 续行）。
      let startRow = cursorRow;
      while (startRow > 0) {
        const line = buffer.getLine(buffer.viewportY + startRow);
        if (line?.isWrapped) startRow -= 1;
        else break;
      }

      // 逐格构建“逻辑行起点 → 光标位置”的文本（含宽字符处理）。
      let text = "";
      for (let r = startRow; r <= cursorRow; r += 1) {
        const line = buffer.getLine(buffer.viewportY + r);
        if (!line) break;
        const lastCol = r === cursorRow ? cursorX : terminal.cols;
        for (let col = 0; col < lastCol; col += 1) {
          const bufferCell = line.getCell(col, reusableCell);
          if (!bufferCell) continue;
          if (bufferCell.getWidth() === 0) continue;
          text += bufferCell.getChars() || " ";
        }
      }

      // 光标前文本是否恰好以一个 @token 结尾（含可选行号后缀）。
      const trailing = text.match(/@[^\s@]+(?:\s+L\d+(?:-L?\d+)?)?$/);
      if (!trailing) return 0;
      const tokenText = trailing[0];
      // 至少 2 字符（@ + 内容）才算引用，避免误删单个 @。
      if (tokenText.length < 2) return 0;
      return Array.from(tokenText).length;
    };

    const startRichCursorTransition = (targetCursorIndex: number) => {
      const current = richInputStateRef.current;
      const currentInput = inputBuffer.current;
      pendingRichDeleteTransitionRef.current = null;
      pendingRichCursorTransitionRef.current = current && current.input === currentInput && current.cols === terminal.cols
        ? {
            input: currentInput,
            inputStartCellIndex: current.inputStartCellIndex,
            inputRangeWidth: current.maskedInputWidth,
            targetCursorIndex,
            cols: current.cols,
            startedAt: Date.now(),
          }
        : null;
    };

    const tryHandleRichAtomicKey = (e: KeyboardEvent): boolean => {
      if (
        e.type !== "keydown" ||
        e.ctrlKey ||
        e.altKey ||
        e.metaKey ||
        e.shiftKey ||
        !richInputStateRef.current
      ) {
        return false;
      }
      if (!["ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(e.key)) return false;

      const currentInput = inputBuffer.current;
      const segments = parseTerminalRichInput(currentInput);
      if (!segments.some((segment) => segment.kind === "file")) return false;
      const currentCursor = clampTextCursorIndex(currentInput, inputCursorIndexRef.current);
      const containingAtomicSegment = segments.find((segment) => (
        segment.kind !== "text" && currentCursor > segment.rawStart && currentCursor < segment.rawEnd
      ));

      if (e.key === "ArrowLeft") {
        const segment = containingAtomicSegment ?? findTerminalRichAtomicBeforeCursor(segments, currentCursor);
        if (!segment) return false;
        const count = currentCursor - segment.rawStart;
        if (count <= 0) return false;
        e.preventDefault();
        startRichCursorTransition(segment.rawStart);
        inputCursorIndexRef.current = segment.rawStart;
        selectedInputSnapshot = null;
        markAttentionInputHandled();
        clearSuggestionGhost();
        cancelAiSuggestionRefresh();
        invoke("pty_write", { sessionId, data: repeatControlSequence("\x1b[D", count) })
          .catch((err) => reportPtyWriteError("rich_file_left", err));
        scheduleAiPathChips();
        return true;
      }

      if (e.key === "ArrowRight") {
        const segment = containingAtomicSegment ?? findTerminalRichAtomicAfterCursor(segments, currentCursor);
        if (!segment) return false;
        const count = segment.rawEnd - currentCursor;
        if (count <= 0) return false;
        e.preventDefault();
        startRichCursorTransition(segment.rawEnd);
        inputCursorIndexRef.current = segment.rawEnd;
        selectedInputSnapshot = null;
        markAttentionInputHandled();
        clearSuggestionGhost();
        cancelAiSuggestionRefresh();
        invoke("pty_write", { sessionId, data: repeatControlSequence("\x1b[C", count) })
          .catch((err) => reportPtyWriteError("rich_file_right", err));
        scheduleAiPathChips();
        return true;
      }

      const segment = e.key === "Backspace"
        ? (containingAtomicSegment ?? findTerminalRichAtomicBeforeCursor(segments, currentCursor))
        : (containingAtomicSegment ?? findTerminalRichAtomicAfterCursor(segments, currentCursor));
      if (!segment) return false;

      e.preventDefault();
      pendingRichCursorTransitionRef.current = null;
      const chars = Array.from(currentInput);
      chars.splice(segment.rawStart, segment.rawEnd - segment.rawStart);
      const nextInput = chars.join("");
      const currentRichInput = richInputStateRef.current;
      pendingRichDeleteTransitionRef.current = currentRichInput && currentRichInput.input === currentInput && currentRichInput.cols === terminal.cols
        ? {
            targetInput: nextInput,
            inputStartCellIndex: currentRichInput.inputStartCellIndex,
            targetCursorIndex: segment.rawStart,
            sourceInputWidth: currentRichInput.maskedInputWidth,
            cols: currentRichInput.cols,
            startedAt: Date.now(),
          }
        : null;
      inputBuffer.current = nextInput;
      inputCursorIndexRef.current = segment.rawStart;
      selectedInputSnapshot = null;
      markAttentionInputHandled();
      clearSuggestionGhost();
      cancelAiSuggestionRefresh();
      const moveToBoundary = e.key === "Backspace"
        ? repeatControlSequence("\x1b[C", segment.rawEnd - currentCursor)
        : repeatControlSequence("\x1b[D", currentCursor - segment.rawStart);
      const removeToken = e.key === "Backspace"
        ? "\x7f".repeat(segment.rawEnd - segment.rawStart)
        : repeatControlSequence("\x1b[3~", segment.rawEnd - segment.rawStart);
      invoke("pty_write", { sessionId, data: `${moveToBoundary}${removeToken}` })
        .catch((err) => reportPtyWriteError("rich_file_delete", err));
      scheduleAiPathChips();
      return true;
    };

    terminal.attachCustomKeyEventHandler((e) => {
      const isMacSelectAll = (
        osPlatformRef.current === "macos" ||
        (osPlatformRef.current === "unknown" && navigator.platform.toLowerCase().includes("mac"))
      );
      if (
        e.type === "keydown" &&
        e.key.toLowerCase() === "a" &&
        !e.shiftKey &&
        !e.altKey &&
        ((isMacSelectAll && e.metaKey && !e.ctrlKey) || (!isMacSelectAll && e.ctrlKey && !e.metaKey))
      ) {
        e.preventDefault();
        selectCurrentInputText();
        return false;
      }

      if (
        e.type === "keydown" &&
        (e.key === "Backspace" || e.key === "Delete") &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        if (removeSelectedInputText()) {
          e.preventDefault();
          return false;
        }
      }
      if (tryHandleRichAtomicKey(e)) return false;
      // 退格：光标紧邻 @path 末尾时，整段删除该引用（含行号后缀）。
      if (
        e.type === "keydown" &&
        e.key === "Backspace" &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.shiftKey
      ) {
        const count = getAiPathBackspaceCount();
        if (count > 1) {
          e.preventDefault();
          markAttentionInputHandled();
          // 逐个发送退格给 PTY，交给 shell/TUI 各自处理光标与重绘。
          const backspaces = "\x7f".repeat(count);
          invoke("pty_write", { sessionId, data: backspaces }).catch((err) => reportPtyWriteError("backspace-token", err));
          return false;
        }
      }
      if (e.type === "keydown" && e.key === "Enter") {
        const shortcut = useSettingsStore.getState().terminalNewlineShortcut;
        const managedCombo =
          (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) ||
          (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) ||
          (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey);
        const matched =
          (shortcut === "Shift+Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) ||
          (shortcut === "Ctrl+Enter" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) ||
          (shortcut === "Alt+Enter" && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey);
        if (managedCombo) {
          e.preventDefault();
          if (matched) {
            markAttentionInputHandled();
            const newlineData = isCodexSession() ? "\x1b\r" : "\n";
            invoke("pty_write", { sessionId, data: newlineData }).catch((err) => reportPtyWriteError("newline", err));
          }
          return false;
        }
      }
      if (
        e.type === "keydown" &&
        e.key === "Tab" &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        if (acceptSuggestionRef.current()) {
          e.preventDefault();
          return false;
        }
        return true;
      }
      if (
        e.type === "keydown" &&
        e.key === "ArrowRight" &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        if (acceptSuggestionRef.current()) {
          e.preventDefault();
          return false;
        }
        return true;
      }
      if (
        e.type === "keydown" &&
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        (e.code === "Space" || e.key === " ")
      ) {
        if (acceptSuggestionRef.current()) {
          e.preventDefault();
          return false;
        }
      }
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        readClipboardText().then((text) => {
          pasteIntoTerminal(wrapTerminalPasteTextForCtrlShiftV(text));
        }).catch((err) => {
          logError("Failed to read clipboard text", { sessionId, err });
        });
        return false;
      }
      if (
        e.type === "keydown" &&
        e.key.toLowerCase() === "c" &&
        !e.shiftKey &&
        !e.altKey &&
        ((isMacSelectAll && e.metaKey && !e.ctrlKey) || (!isMacSelectAll && e.ctrlKey && !e.metaKey)) &&
        terminal.hasSelection()
      ) {
        e.preventDefault();
        void copySelection();
        terminal.clearSelection();
        return false;
      }
      if (e.type !== "keydown" || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return true;
      const key = e.key.toLowerCase();
      if (key === "f") {
        e.preventDefault();
        setSearchOpen(true);
        window.requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
        return false;
      }
      if (key === "c" && terminal.hasSelection()) {
        e.preventDefault();
        void copySelection();
        terminal.clearSelection();
        return false;
      }
      if (key === "v") {
        e.preventDefault();
        readClipboardText().then((text) => {
          pasteIntoTerminal(text);
        }).catch((err) => {
          logError("Failed to read clipboard text", { sessionId, err });
        });
        return false;
      }
      return true;
    });

    // Forward keyboard input to PTY and record command history
    const addCommand = useCommandHistoryStore.getState().addCommand;
    const getProjectId = () => useTerminalStore.getState().sessions.find((s) => s.id === sessionId)?.projectId ?? null;
    let suggestionRequestId = 0;
    let suggestionRefreshTimerId: number | null = null;
    let aiSuggestionTimerId: number | null = null;
    let aiSuggestionInFlight = false;
    let aiSuggestionQueued = false;
    let pendingAiSuggestionContext: TerminalInputSuggestionContext | null = null;
    let pendingAiSuggestionRequestId = 0;
    let suggestionDisposed = false;
    // @path 内联 chip：rAF 合帧句柄 + 上一次结果（用于 diff 跳过无变化的 setState）
    let aiPathChipRafId: number | null = null;
    let lastAiPathChipsSignature = "";
    let lastRichInputSignature = "";
    let suggestionTemplatesLoaded = false;
    let lastSubmittedCommand: string | null = null;
    let suggestionContextCache: {
      loadedAt: number;
      projectId: string | null;
      history: CommandHistoryEntry[];
      templates: CommandTemplate[];
    } | null = null;

    const clearSuggestionGhost = () => {
      suggestionRef.current = null;
      setSuggestionGhost(null);
    };

    // 扫描终端可见行，把 @path 引用定位为内联 chip 覆盖层。
    // 纯视觉：字符仍在缓冲区，回车照常把 @path 发给 CLI。跨行的 token 不渲染。
    const scanAiPathChips = (): AiPathChip[] => {
      const wrapper = wrapperRef.current;
      const terminalContainer = containerRef.current;
      if (!wrapper || !terminalContainer) return [];
      const buffer = terminal.buffer.active;
      const rows = terminal.rows;
      const cols = terminal.cols;
      const screen = terminalContainer.querySelector(".xterm-screen") as HTMLElement | null;
      const wrapperRect = wrapper.getBoundingClientRect();
      const screenRect = (screen ?? terminalContainer).getBoundingClientRect();
      const fallbackFontSize = typeof terminal.options.fontSize === "number" ? terminal.options.fontSize : fontSize;
      const cell = getTerminalRenderedCellSize(terminal, terminalContainer, fallbackFontSize);
      const offsetLeft = screenRect.left - wrapperRect.left;
      const offsetTop = screenRect.top - wrapperRect.top;
      const chips: AiPathChip[] = [];
      const reusableCell = buffer.getNullCell();

      // 每个字符在屏幕上的位置：屏幕行（相对 viewport 的 0..rows-1）+ 起始列。
      interface CharPos { row: number; col: number; }

      // 把连续的自动换行（isWrapped）屏幕行拼成一条“逻辑行”，逐格构建文本，
      // 同时记录每个字符的屏幕行/列，以正确处理宽字符与跨行覆盖。
      const buildLogicalLine = (startRow: number): { text: string; pos: CharPos[]; nextRow: number } => {
        let text = "";
        const pos: CharPos[] = [];
        let row = startRow;
        while (row < rows) {
          if (row !== startRow) {
            const contLine = buffer.getLine(buffer.viewportY + row);
            if (!contLine || !contLine.isWrapped) break;
          }
          const line = buffer.getLine(buffer.viewportY + row);
          if (!line) break;
          for (let col = 0; col < cols; col += 1) {
            const bufferCell = line.getCell(col, reusableCell);
            if (!bufferCell) continue;
            const width = bufferCell.getWidth();
            if (width === 0) continue; // 宽字符占位尾格，跳过
            const chars = bufferCell.getChars() || " ";
            pos.push({ row, col });
            text += chars;
          }
          row += 1;
        }
        return { text, pos, nextRow: row };
      };

      let row = 0;
      while (row < rows) {
        const line = buffer.getLine(buffer.viewportY + row);
        // 若首个可见行本身是续行，仍从它开始独立成组（其真正行首在视口上方，忽略）。
        const { text, pos, nextRow } = buildLogicalLine(row);
        row = Math.max(nextRow, row + 1);
        if (!line || text.indexOf("@") < 0) continue;

        const fileSegments = parseTerminalRichInput(text).filter((segment) => segment.kind === "file");
        for (const fileSegment of fileSegments) {
          const token = fileSegment.raw;
          const startCharIdx = fileSegment.rawStart;
          const endCharIdx = fileSegment.rawEnd - 1;
          if (startCharIdx >= pos.length || endCharIdx >= pos.length) continue;

          // token 可能跨多个屏幕行（自动换行）——按屏幕行拆成连续段，逐段覆盖。
          let segStart = startCharIdx;
          let isFirstSegment = true;
          while (segStart <= endCharIdx) {
            const segRow = pos[segStart].row;
            // 找到本段（同一屏幕行）的最后一个字符索引
            let segEnd = segStart;
            while (segEnd + 1 <= endCharIdx && pos[segEnd + 1].row === segRow) segEnd += 1;

            const startCol = pos[segStart].col;
            const afterCol = segEnd + 1 < pos.length && pos[segEnd + 1].row === segRow
              ? pos[segEnd + 1].col
              : cols;
            const segCols = afterCol - startCol;
            if (segCols > 0) {
              chips.push({
                key: `${segRow}:${startCol}:${token}`,
                left: offsetLeft + startCol * cell.width,
                top: offsetTop + segRow * cell.height,
                spanWidth: segCols * cell.width,
                height: cell.height,
                icon: getMaterialFileIcon(fileSegment.fileName),
                label: fileSegment.label,
                // 只有第一段展示 icon+文件名，后续续行段仅作遮罩，盖住裸路径余部。
                maskOnly: !isFirstSegment,
              });
            }
            isFirstSegment = false;
            segStart = segEnd + 1;
          }
        }
      }
      return chips;
    };

    const buildRichInputState = (): TerminalRichInputState | null => {
      if (!isVisibleRef.current || isComposingRef.current) {
        pendingRichCursorTransitionRef.current = null;
        pendingRichDeleteTransitionRef.current = null;
        return null;
      }
      const input = inputBuffer.current;
      const pendingDeleteCandidate = pendingRichDeleteTransitionRef.current;
      const canContinueDeleteTransition = pendingDeleteCandidate?.targetInput === input;
      if ((!input && !canContinueDeleteTransition) || /[\r\n]/u.test(input)) {
        trustedRichInputAnchorRef.current = null;
        pendingRichCursorTransitionRef.current = null;
        pendingRichDeleteTransitionRef.current = null;
        return null;
      }
      const segments = parseTerminalRichInput(input);
      const hasFileSegment = segments.some((segment) => segment.kind === "file");

      const wrapper = wrapperRef.current;
      const terminalContainer = containerRef.current;
      if (!wrapper || !terminalContainer) return null;
      const screen = terminalContainer.querySelector(".xterm-screen") as HTMLElement | null;
      if (!screen) return null;

      const buffer = terminal.buffer.active;
      const cols = terminal.cols;
      if (cols <= 0) return null;
      const rawCursorIndex = clampTextCursorIndex(input, inputCursorIndexRef.current);
      const cursorIndex = snapTerminalRichCursor(segments, rawCursorIndex);
      const cursorPrefixWidth = getTerminalCellWidth(sliceTextByCursor(input, 0, rawCursorIndex));
      const cursorCellIndex = ((buffer.baseY + buffer.cursorY) * cols) + buffer.cursorX;
      const rawInputWidth = getTerminalCellWidth(input);
      const calculatedInputStartCellIndex = cursorCellIndex - cursorPrefixWidth;
      let inputStartCellIndex = calculatedInputStartCellIndex;
      let activeDeleteTransition: TerminalRichDeleteTransition | null = null;
      if (pendingDeleteCandidate) {
        // 视觉层立即采用删除后的输入，但继续遮住删除前的完整字符范围，
        // 避免 PTY 逐字符删除期间暴露中间状态并触发整行重排。
        const deleteTransitionIsValid = (
          pendingDeleteCandidate.targetInput === input &&
          pendingDeleteCandidate.cols === cols &&
          pendingDeleteCandidate.targetCursorIndex === rawCursorIndex &&
          Date.now() - pendingDeleteCandidate.startedAt <= TERMINAL_RICH_TRANSITION_TIMEOUT_MS &&
          cursorCellIndex >= pendingDeleteCandidate.inputStartCellIndex &&
          cursorCellIndex <= pendingDeleteCandidate.inputStartCellIndex + pendingDeleteCandidate.sourceInputWidth
        );
        if (deleteTransitionIsValid) {
          activeDeleteTransition = pendingDeleteCandidate;
          inputStartCellIndex = pendingDeleteCandidate.inputStartCellIndex;
        } else {
          pendingRichDeleteTransitionRef.current = null;
        }
      }
      const pendingTransition = pendingRichCursorTransitionRef.current;
      if (!activeDeleteTransition && pendingTransition) {
        // 原子跳转会一次写入多个方向键序列，xterm 原生光标会跨多个 render 才到达目标。
        // 期间固定活动输入起点，避免用“已到终点的逻辑光标”反推仍在移动的原生光标。
        const targetCursorCellIndex = pendingTransition.inputStartCellIndex + getTerminalCellWidth(
          sliceTextByCursor(input, 0, pendingTransition.targetCursorIndex),
        );
        const transitionIsValid = (
          pendingTransition.input === input &&
          pendingTransition.cols === cols &&
          pendingTransition.targetCursorIndex === rawCursorIndex &&
          Date.now() - pendingTransition.startedAt <= TERMINAL_RICH_TRANSITION_TIMEOUT_MS &&
          cursorCellIndex >= pendingTransition.inputStartCellIndex &&
          cursorCellIndex <= pendingTransition.inputStartCellIndex + pendingTransition.inputRangeWidth
        );
        if (transitionIsValid) {
          inputStartCellIndex = pendingTransition.inputStartCellIndex;
          if (cursorCellIndex === targetCursorCellIndex) {
            pendingRichCursorTransitionRef.current = null;
          }
        } else {
          pendingRichCursorTransitionRef.current = null;
        }
      }
      if (!hasFileSegment && !activeDeleteTransition) {
        trustedRichInputAnchorRef.current = null;
        pendingRichCursorTransitionRef.current = null;
        return null;
      }

      const bufferMatchesInputAt = (startCellIndex: number) => {
        if (startCellIndex < 0) return false;
        let inputCellIndex = startCellIndex;
        for (const char of input) {
          const charWidth = getTerminalCellWidth(char);
          if (charWidth <= 0) continue;
          const absoluteRow = Math.floor(inputCellIndex / cols);
          const column = inputCellIndex % cols;
          const renderedCell = buffer.getLine(absoluteRow)?.getCell(column);
          if (!renderedCell) return false;
          const renderedChars = renderedCell.getChars();
          if (char === " ") {
            if (renderedChars.trim()) return false;
          } else if (renderedChars !== char) {
            return false;
          }
          inputCellIndex += charWidth;
        }
        return true;
      };

      let resolvedInputMaskWidth = rawInputWidth;
      let bufferMatchesInput = bufferMatchesInputAt(inputStartCellIndex);
      if (bufferMatchesInput) {
        const previousAnchor = trustedRichInputAnchorRef.current;
        resolvedInputMaskWidth = Math.max(
          rawInputWidth,
          previousAnchor?.cols === cols && previousAnchor.inputStartCellIndex === inputStartCellIndex
            ? previousAnchor.maskedInputWidth
            : 0,
        );
      } else if (!activeDeleteTransition) {
        const trustedAnchor = trustedRichInputAnchorRef.current;
        if (trustedAnchor?.cols === cols) {
          const maxTrustedRange = rawInputWidth + cols * (TUI_COMPOSER_CONTINUATION_ROWS + 2);
          const trustedStartRow = Math.floor(trustedAnchor.inputStartCellIndex / cols);
          const visibleInput = resolveVisibleInputSelection();
          const visibleInputStartCellIndex = visibleInput
            ? visibleInput.startRow * cols + visibleInput.startColumn
            : null;
          const tryTrustedStart = (candidateStartCellIndex: number) => {
            const cursorOffset = cursorCellIndex - candidateStartCellIndex;
            if (cursorOffset < 0 || cursorOffset > maxTrustedRange) return false;
            inputStartCellIndex = candidateStartCellIndex;
            resolvedInputMaskWidth = Math.max(
              rawInputWidth,
              trustedAnchor.maskedInputWidth,
              cursorOffset + 1,
            );
            bufferMatchesInput = true;
            return true;
          };

          // TUI 显式换行会整体上移输入框首行；优先复用当前可见 prompt 起点，
          // 避免旧锚点失效后回退到按原始 @path 宽度占位的被动标签层。
          const canReanchorToVisibleInput = visibleInputStartCellIndex !== null
            && Math.abs(Math.floor(visibleInputStartCellIndex / cols) - trustedStartRow)
              <= TUI_COMPOSER_CONTINUATION_ROWS + 1;
          if (canReanchorToVisibleInput) {
            tryTrustedStart(visibleInputStartCellIndex);
          }
          if (!bufferMatchesInput && visibleInputStartCellIndex !== trustedAnchor.inputStartCellIndex) {
            tryTrustedStart(trustedAnchor.inputStartCellIndex);
          }
        }
      }

      if (bufferMatchesInput && activeDeleteTransition) {
        const sourceEndCellIndex = inputStartCellIndex + activeDeleteTransition.sourceInputWidth;
        let trailingCellIndex = inputStartCellIndex + rawInputWidth;
        while (trailingCellIndex < sourceEndCellIndex) {
          const absoluteRow = Math.floor(trailingCellIndex / cols);
          const column = trailingCellIndex % cols;
          const renderedCell = buffer.getLine(absoluteRow)?.getCell(column);
          if (!renderedCell || renderedCell.getChars().trim()) {
            bufferMatchesInput = false;
            break;
          }
          trailingCellIndex += 1;
        }
      }

      if (!bufferMatchesInput && !activeDeleteTransition) return null;
      if (bufferMatchesInput && activeDeleteTransition) {
        const targetCursorCellIndex = inputStartCellIndex + getTerminalCellWidth(
          sliceTextByCursor(input, 0, activeDeleteTransition.targetCursorIndex),
        );
        if (cursorCellIndex === targetCursorCellIndex) {
          pendingRichDeleteTransitionRef.current = null;
          if (!hasFileSegment) return null;
          activeDeleteTransition = null;
        }
      }

      const inputStartRow = Math.floor(inputStartCellIndex / cols);
      const visibleStartRow = buffer.viewportY;
      const visibleEndRow = buffer.viewportY + terminal.rows - 1;
      if (inputStartRow < visibleStartRow || inputStartRow > visibleEndRow) return null;

      const wrapperRect = wrapper.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      const fallbackFontSize = typeof terminal.options.fontSize === "number" ? terminal.options.fontSize : fontSize;
      const cell = getTerminalRenderedCellSize(terminal, terminalContainer, fallbackFontSize);
      const offsetLeft = screenRect.left - wrapperRect.left;
      const offsetTop = screenRect.top - wrapperRect.top;
      const inputStartColumn = inputStartCellIndex % cols;
      const maskedInputWidth = activeDeleteTransition
        ? Math.max(resolvedInputMaskWidth, activeDeleteTransition.sourceInputWidth)
        : resolvedInputMaskWidth;
      trustedRichInputAnchorRef.current = {
        inputStartCellIndex,
        maskedInputWidth,
        cols,
      };
      const maskEndCellIndex = Math.max(inputStartCellIndex + maskedInputWidth, cursorCellIndex + 1);
      const masks: TerminalRichInputMask[] = [];

      let maskCellIndex = inputStartCellIndex;
      while (maskCellIndex < maskEndCellIndex) {
        const absoluteRow = Math.floor(maskCellIndex / cols);
        if (absoluteRow > visibleEndRow) break;
        const startColumn = maskCellIndex % cols;
        const cellsInRow = Math.min(maskEndCellIndex - maskCellIndex, cols - startColumn);
        masks.push({
          left: offsetLeft + startColumn * cell.width,
          top: offsetTop + (absoluteRow - visibleStartRow) * cell.height,
          width: cellsInRow * cell.width,
          height: cell.height,
        });
        maskCellIndex += cellsInRow;
      }

      return {
        input,
        cursorIndex,
        segments,
        inputStartCellIndex,
        maskedInputWidth,
        cols,
        left: offsetLeft,
        top: offsetTop + (inputStartRow - visibleStartRow) * cell.height,
        width: cols * cell.width,
        cellWidth: cell.width,
        cellHeight: cell.height,
        leadingWidth: inputStartColumn * cell.width,
        masks,
      };
    };

    const applyRichInput = () => {
      const next = buildRichInputState();
      const signature = next
        ? `${next.input}|${next.cursorIndex}|${next.left}|${next.top}|${next.width}|${next.cellWidth}|${next.cellHeight}|${next.leadingWidth}|${next.masks.map((mask) => `${mask.left},${mask.top},${mask.width}`).join(";")}`
        : "";
      if (signature === lastRichInputSignature) return;
      lastRichInputSignature = signature;
      richInputStateRef.current = next;
      setRichInput(next);
    };

    const applyAiPathChips = () => {
      // 只要终端可见就渲染 chip：焦点切到别的终端（本终端 isActive=false）时，
      // 输入框里的 @path 仍应保持 chip 效果，不因失焦而消失。
      if (suggestionDisposed || !isVisibleRef.current) {
        if (lastAiPathChipsSignature !== "") {
          lastAiPathChipsSignature = "";
          setAiPathChips([]);
        }
        return;
      }
      const chips = scanAiPathChips();
      const signature = chips
        .map((chip) => `${chip.key}|${chip.left}|${chip.top}|${chip.spanWidth}|${chip.label}|${chip.maskOnly ? "m" : ""}`)
        .join("~");
      if (signature === lastAiPathChipsSignature) return;
      lastAiPathChipsSignature = signature;
      setAiPathChips(chips);
    };

    // rAF 合帧：高频事件（TUI 重绘/光标移动）只标脏，一帧最多扫一次。
    const scheduleAiPathChips = () => {
      if (aiPathChipRafId !== null) return;
      aiPathChipRafId = window.requestAnimationFrame(() => {
        aiPathChipRafId = null;
        applyRichInput();
        applyAiPathChips();
      });
    };

    const cancelAiSuggestionRefresh = () => {
      if (aiSuggestionTimerId !== null) {
        window.clearTimeout(aiSuggestionTimerId);
        aiSuggestionTimerId = null;
      }
      pendingAiSuggestionContext = null;
      aiSuggestionQueued = false;
    };

    const updateSuggestionGhostPosition = (suggestion: TerminalInputSuggestion | null) => {
      if (!suggestion || suggestionDisposed || !isActiveRef.current || !isVisibleRef.current || isComposingRef.current) {
        clearSuggestionGhost();
        return;
      }
      if (!canShowSuggestionAtCurrentInputEnd(terminal, inputBuffer.current)) {
        clearSuggestionGhost();
        return;
      }
      const wrapper = wrapperRef.current;
      const terminalContainer = containerRef.current;
      if (!wrapper || !terminalContainer) {
        clearSuggestionGhost();
        return;
      }

      const screen = terminalContainer.querySelector(".xterm-screen") as HTMLElement | null;
      const wrapperRect = wrapper.getBoundingClientRect();
      const screenRect = (screen ?? terminalContainer).getBoundingClientRect();
      const fallbackFontSize = typeof terminal.options.fontSize === "number" ? terminal.options.fontSize : fontSize;
      const cell = getTerminalRenderedCellSize(terminal, terminalContainer, fallbackFontSize);
      const buffer = terminal.buffer.active;
      const left = screenRect.left - wrapperRect.left + Math.max(0, buffer.cursorX) * cell.width;
      const top = screenRect.top - wrapperRect.top + Math.max(0, buffer.cursorY) * cell.height;
      const maxWidth = Math.max(0, wrapperRect.right - wrapperRect.left - left - 8);
      if (maxWidth < cell.width || top < 0 || top > wrapperRect.height) {
        clearSuggestionGhost();
        return;
      }

      const nextGhost = {
        suffix: suggestion.suffix,
        left,
        top,
        height: Math.max(1, cell.height),
        maxWidth,
      };
      setSuggestionGhost((current) => {
        if (
          current &&
          current.suffix === nextGhost.suffix &&
          current.left === nextGhost.left &&
          current.top === nextGhost.top &&
          current.height === nextGhost.height &&
          current.maxWidth === nextGhost.maxWidth
        ) {
          return current;
        }
        return nextGhost;
      });
    };

    const loadSuggestionContext = async (projectId: string | null) => {
      const now = Date.now();
      if (
        suggestionContextCache &&
        suggestionContextCache.projectId === projectId &&
        now - suggestionContextCache.loadedAt <= SUGGESTION_CONTEXT_CACHE_TTL_MS
      ) {
        return suggestionContextCache;
      }

      const templateStore = useTemplateStore.getState();
      if (!suggestionTemplatesLoaded && templateStore.templates.length === 0) {
        suggestionTemplatesLoaded = true;
        await templateStore.fetchTemplates().catch(() => {});
      }
      const [history, templates] = await Promise.all([
        useCommandHistoryStore.getState().getRecent(null, 120),
        Promise.resolve(useTemplateStore.getState().getForContext(projectId, sessionId)),
      ]);
      suggestionContextCache = {
        loadedAt: Date.now(),
        projectId,
        history,
        templates,
      };
      return suggestionContextCache;
    };

    const buildSuggestionContext = (
      input: string,
      session: TerminalSession | undefined,
      history: CommandHistoryEntry[],
      templates: CommandTemplate[]
    ): TerminalInputSuggestionContext => {
      const currentSettings = useSettingsStore.getState();
      const projectId = session?.projectId ?? null;
      return {
        input,
        projectId,
        cwd: session?.cwd ?? null,
        shell: session?.shell ?? null,
        sessionId,
        previousCommand: lastSubmittedCommand,
        history,
        templates,
        provider: currentSettings.terminalInputSuggestionProvider,
        model: TERMINAL_INPUT_SUGGESTION_AI_MODEL,
        debugLogging: currentSettings.debugMode,
        aiConfig: {
          enabled: currentSettings.terminalInputSuggestionLlmEnabled,
          baseUrl: currentSettings.terminalInputSuggestionBaseUrl,
          apiKey: currentSettings.terminalInputSuggestionApiKey,
          model: currentSettings.terminalInputSuggestionModel,
          prompt: currentSettings.terminalInputSuggestionUseBuiltinPrompt
            ? TERMINAL_INPUT_SUGGESTION_BUILTIN_PROMPT
            : currentSettings.terminalInputSuggestionCustomPrompt,
        },
      };
    };

    const suggestionContextHasUsableAiConfig = (context: TerminalInputSuggestionContext) => Boolean(
      context.aiConfig?.enabled &&
      context.aiConfig.baseUrl.trim() &&
      context.aiConfig.apiKey.trim() &&
      context.aiConfig.model.trim() &&
      context.aiConfig.prompt.trim()
    );

    const runPendingAiSuggestion = async () => {
      if (aiSuggestionInFlight) {
        aiSuggestionQueued = true;
        return;
      }
      const context = pendingAiSuggestionContext;
      const requestId = pendingAiSuggestionRequestId;
      if (!context) return;
      pendingAiSuggestionContext = null;
      aiSuggestionQueued = false;
      aiSuggestionInFlight = true;
      const suggestionResult = await getTerminalInputSuggestionAiResult(context);
      aiSuggestionInFlight = false;
      if (suggestionResult.aiAttempt) {
        useSettingsStore.getState().recordTerminalInputSuggestionUsage(suggestionResult.aiAttempt);
      }
      if (
        !suggestionDisposed &&
        requestId === suggestionRequestId &&
        useSettingsStore.getState().terminalInputSuggestionsEnabled &&
        context.input === inputBuffer.current &&
        suggestionResult.suggestions.length > 0
      ) {
        const suggestion = suggestionResult.suggestions[0];
        suggestionRef.current = suggestion;
        updateSuggestionGhostPosition(suggestion);
      }
      if (aiSuggestionQueued && pendingAiSuggestionContext) {
        void runPendingAiSuggestion();
      }
    };

    const scheduleAiSuggestionRefresh = (context: TerminalInputSuggestionContext, requestId: number) => {
      if (!suggestionContextHasUsableAiConfig(context)) {
        cancelAiSuggestionRefresh();
        return;
      }
      pendingAiSuggestionContext = context;
      pendingAiSuggestionRequestId = requestId;
      if (aiSuggestionTimerId !== null) {
        window.clearTimeout(aiSuggestionTimerId);
      }
      aiSuggestionTimerId = window.setTimeout(() => {
        aiSuggestionTimerId = null;
        void runPendingAiSuggestion();
      }, SUGGESTION_AI_DEBOUNCE_MS);
    };

    const refreshSuggestionGhost = async () => {
      const requestId = ++suggestionRequestId;
      const settings = useSettingsStore.getState();
      const input = inputBuffer.current;
      if (
        suggestionDisposed ||
        !settings.terminalInputSuggestionsEnabled ||
        !input ||
        input.includes("\n") ||
        input.includes("\r") ||
        isComposingRef.current
      ) {
        cancelAiSuggestionRefresh();
        clearSuggestionGhost();
        return;
      }

      const session = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
      const projectId = session?.projectId ?? null;
      const { history, templates } = await loadSuggestionContext(projectId);
      if (suggestionDisposed || requestId !== suggestionRequestId || input !== inputBuffer.current) return;
      if (!useSettingsStore.getState().terminalInputSuggestionsEnabled) {
        cancelAiSuggestionRefresh();
        clearSuggestionGhost();
        return;
      }

      const context = buildSuggestionContext(input, session, history, templates);
      const localSuggestions = getLocalTerminalInputSuggestions(context, { limit: 1 });
      const suggestion = localSuggestions[0] ?? null;
      suggestionRef.current = suggestion;
      updateSuggestionGhostPosition(suggestion);
      scheduleAiSuggestionRefresh(context, requestId);

      void getTerminalPathInputSuggestions(context, { limit: 1 })
        .then((pathSuggestions) => {
          if (
            suggestionDisposed ||
            requestId !== suggestionRequestId ||
            input !== inputBuffer.current ||
            !useSettingsStore.getState().terminalInputSuggestionsEnabled ||
            suggestionRef.current?.source === "ai"
          ) {
            return;
          }
          const mergedSuggestion = mergeTerminalInputSuggestions([...localSuggestions, ...pathSuggestions], { limit: 1 })[0] ?? null;
          suggestionRef.current = mergedSuggestion;
          updateSuggestionGhostPosition(mergedSuggestion);
        })
        .catch(() => {});
    };

    const scheduleSuggestionRefresh = () => {
      if (suggestionRefreshTimerId !== null) {
        window.clearTimeout(suggestionRefreshTimerId);
      }
      suggestionRefreshTimerId = window.setTimeout(() => {
        suggestionRefreshTimerId = null;
        void refreshSuggestionGhost();
      }, SUGGESTION_LOCAL_DEBOUNCE_MS);
    };

    acceptSuggestionRef.current = () => {
      const suggestion = suggestionRef.current;
      const settings = useSettingsStore.getState();
      if (!settings.terminalInputSuggestionsEnabled || !suggestion?.suffix) return false;
      clearSuggestionGhost();
      forwardTerminalInput(suggestion.suffix, "onData");
      settings.recordTerminalInputSuggestionUsage({ accepted: true });
      return true;
    };

    const maybeLogCodexImeDuplicate = (data: string) => {
      if (!isCodexSession()) return;
      const debugState = codexImeDebugRef.current;
      const now = Date.now();
      if (debugState.compositionEndAt < 0 || now - debugState.compositionEndAt > CODEX_IME_DEBUG_WINDOW_MS) return;
      if (!data || data === "\r" || data === "\x7f" || data === "\b" || data.startsWith("\x1b")) return;

      const normalized = data.replace(/\r\n?/g, "\n");
      if (!normalized.trim()) return;

      const summary = summarizeTextForDiagnostics(normalized);
      if (!summary.hasNonAscii) return;

      const duplicateDeltaMs = now - debugState.lastNearCompositionAt;
      const isSuspiciousDuplicate = (
        debugState.lastNearCompositionFingerprint === summary.fingerprint
        && duplicateDeltaMs >= 0
        && duplicateDeltaMs <= CODEX_IME_DUPLICATE_WINDOW_MS
      );

      if (isSuspiciousDuplicate) {
        logInfo("[codex-ime] duplicate-near-composition", {
          sessionId,
          data: summary,
          composition: debugState.compositionEndSummary,
          duplicateDeltaMs,
          compositionDeltaMs: now - debugState.compositionEndAt,
        });
      }

      debugState.lastNearCompositionFingerprint = summary.fingerprint;
      debugState.lastNearCompositionAt = now;
    };

    // 前置：data 是已经决定写入 PTY 的终端输入；后置：命令历史缓冲与运行状态跟随更新。
    // 副作用：回车时会按现有策略推断 cmd command_started，这个推断不能扩散到普通 shell。
    const updateInputBufferFromTerminalData = (data: string) => {
      if (data === "\r") {
        const cmd = inputBuffer.current;
        if (cmd.trim()) {
          lastSubmittedCommand = cmd.trim();
          suggestionContextCache = null;
          const submittedCwd = useTerminalStore.getState().sessions.find((item) => item.id === sessionId)?.cwd ?? null;
          void resolveSubmittedDirectoryChange(cmd, submittedCwd)
            .then((cwd) => updateSessionCwdIfChanged(cwd))
            .catch(() => {});
          addCommand(getProjectId(), cmd);
          // 回车猜测仅作为 cmd 的 command_started 信号（store 按 origin 过滤）；
          // 其余 shell 由 shell integration OSC 序列驱动，猜测会误判。
          useTerminalStore.getState().handleShellRuntimeEvent({ sessionId, event: "command_started", origin: "input" });
        }
        inputBuffer.current = "";
        inputCursorIndexRef.current = 0;
        trustedRichInputAnchorRef.current = null;
        cancelAiSuggestionRefresh();
        clearSuggestionGhost();
      } else if (data === "\x7f" || data === "\b") {
        const next = removeTextBeforeCursor(inputBuffer.current, inputCursorIndexRef.current);
        inputBuffer.current = next.text;
        inputCursorIndexRef.current = next.cursorIndex;
        scheduleSuggestionRefresh();
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        const cursorIndex = clampTextCursorIndex(inputBuffer.current, inputCursorIndexRef.current);
        inputBuffer.current = insertTextAtCursor(inputBuffer.current, cursorIndex, data);
        inputCursorIndexRef.current = cursorIndex + getTextCursorLength(data);
        scheduleSuggestionRefresh();
      } else if (data.length > 1) {
        const pastedText = data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
        if (!pastedText.startsWith("\x1b")) {
          const normalizedPaste = pastedText.replace(/\r\n?/g, "\n");
          const cursorIndex = clampTextCursorIndex(inputBuffer.current, inputCursorIndexRef.current);
          inputBuffer.current = insertTextAtCursor(inputBuffer.current, cursorIndex, normalizedPaste);
          inputCursorIndexRef.current = cursorIndex + getTextCursorLength(normalizedPaste);
          scheduleSuggestionRefresh();
        } else if (data === "\x1b[D" || data === "\x1bOD") {
          inputCursorIndexRef.current = clampTextCursorIndex(inputBuffer.current, inputCursorIndexRef.current - 1);
          cancelAiSuggestionRefresh();
          clearSuggestionGhost();
        } else if (data === "\x1b[C" || data === "\x1bOC") {
          inputCursorIndexRef.current = clampTextCursorIndex(inputBuffer.current, inputCursorIndexRef.current + 1);
          cancelAiSuggestionRefresh();
          clearSuggestionGhost();
        } else if (data === "\x1b[3~") {
          const next = removeTextAtCursor(inputBuffer.current, inputCursorIndexRef.current);
          inputBuffer.current = next.text;
          inputCursorIndexRef.current = next.cursorIndex;
          scheduleSuggestionRefresh();
        } else {
          trustedRichInputAnchorRef.current = null;
          cancelAiSuggestionRefresh();
          clearSuggestionGhost();
        }
      } else {
        trustedRichInputAnchorRef.current = null;
        cancelAiSuggestionRefresh();
        clearSuggestionGhost();
      }
    };

    // 前置：data 必须是 xterm 已解析出的用户输入，或浏览器 IME text input 兜底拿到的最终文本。
    // 后置：文本写入当前 PTY，并同步命令历史缓冲；副作用是触发 attention 标记、可能记录命令开始事件。
    // 这里统一入口是为了让 xterm onData 与 IME 兜底保持完全一致，避免中文标点只写 PTY 不进历史缓冲。
    let lastForwardedTerminalInput: { data: string; source: TerminalInputSource; at: number } | null = null;
    const isImeDuplicateCandidate = (data: string) => {
      if (!data || data === "\r" || data === "\x7f" || data === "\b" || data.startsWith("\x1b")) return false;
      const normalized = data.replace(/\r\n?/g, "\n");
      return Boolean(normalized.trim()) && /[^\x00-\x7f]/.test(normalized);
    };
    const shouldDropCrossSourceImeDuplicate = (data: string, source: TerminalInputSource, now: number) => {
      if (!isImeDuplicateCandidate(data) || !lastForwardedTerminalInput) return false;
      const deltaMs = now - lastForwardedTerminalInput.at;
      return (
        lastForwardedTerminalInput.source !== source &&
        lastForwardedTerminalInput.data === data &&
        deltaMs >= 0 &&
        deltaMs <= IME_CROSS_SOURCE_DUPLICATE_WINDOW_MS
      );
    };

    function forwardTerminalInput(data: string, source: TerminalInputSource) {
      const now = performance.now();
      if (shouldDropCrossSourceImeDuplicate(data, source, now)) {
        return;
      }
      markAttentionInputHandled();
      const replacingSelectedInput = consumeSelectedInputForReplacement(data);
      if (!replacingSelectedInput) {
        selectedInputSnapshot = null;
      }
      const inputBufferBefore = inputBuffer.current;
      const manualDirectCodexOverride = resolveManualDirectCodexEnterData({
        data,
        inputBuffer: inputBufferBefore,
        os: osPlatformRef.current,
      });
      const ptyData = manualDirectCodexOverride ?? data;
      lastForwardedTerminalInput = { data, source, at: now };
      invoke("pty_write", { sessionId, data: replacingSelectedInput ? `\x15${ptyData}` : ptyData }).catch((err) => reportPtyWriteError(source, err));
      maybeLogCodexImeDuplicate(data);
      updateInputBufferFromTerminalData(data);
    }

    terminal.onData((data) => {
      forwardTerminalInput(data, "onData");
    });

    // Sync resize to PTY
    terminal.onResize(({ cols, rows }) => {
      if (cols < MIN_TERMINAL_COLS || rows < MIN_TERMINAL_ROWS) return;
      invoke("pty_resize", { sessionId, cols, rows }).catch((err) => {
        logError("PTY resize failed in XTermTerminal", { sessionId, cols, rows, err });
      });
    });

    // Per-session TextDecoder with stream mode：
    // 跨 chunk 的多字节 UTF-8 必须使用 streaming decode，否则截断的 head/tail
    // 字节会被解码为 U+FFFD + 残字节，残字节进入 xterm 后会污染 SGR 解析状态
    // （表现为背景色串列、左侧异常红色竖条）。后端虽已保证字节边界对齐
    // （src-tauri/src/pty/boundary.rs），前端 stream 模式作为双重防御。
    // 不使用模块级共享 decoder：stream 模式会保留状态，跨会话共享会导致污染。
    const textDecoder = new TextDecoder("utf-8");

    // Listen for PTY output (Base64 encoded to preserve control characters)
    // Batch chunks per animation frame to keep main thread responsive on high-throughput output.
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    let pendingChunks: string[] = [];
    let writeRafId: number | null = null;
    const stashInactiveText = (text: string) => {
      if (!text) return;
      const maxBufferChars = inactiveBufferLimitRef.current;
      if (text.length >= maxBufferChars) {
        const suffix = text.slice(-maxBufferChars);
        inactiveBufferRef.current = [suffix];
        inactiveBufferSizeRef.current = suffix.length;
        return;
      }

      inactiveBufferRef.current.push(text);
      inactiveBufferSizeRef.current += text.length;
      while (inactiveBufferSizeRef.current > maxBufferChars && inactiveBufferRef.current.length > 0) {
        const overflow = inactiveBufferSizeRef.current - maxBufferChars;
        const head = inactiveBufferRef.current[0];
        if (!head || head.length <= overflow) {
          const removed = inactiveBufferRef.current.shift();
          if (removed) inactiveBufferSizeRef.current -= removed.length;
          continue;
        }
        inactiveBufferRef.current[0] = head.slice(overflow);
        inactiveBufferSizeRef.current -= overflow;
      }
    };
    const flushPendingWrites = () => {
      writeRafId = null;
      if (cancelled || pendingChunks.length === 0) return;
      const combined = pendingChunks.length === 1 ? pendingChunks[0] : pendingChunks.join("");
      pendingChunks = [];
      if (isVisibleRef.current) {
        enqueueActiveWrite(combined);
      } else {
        stashInactiveText(combined);
      }
    };
    listen<string>(`pty-output-${sessionId}`, (event) => {
      if (cancelled) return;
      const binaryString = atob(event.payload);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i += 1) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const text = processShellIntegrationOsc(processSpecialOscQueries(textDecoder.decode(bytes, { stream: true })));
      if (!text) return;
      if (isVisibleRef.current) {
        pendingChunks.push(text);
        if (writeRafId === null) {
          writeRafId = requestAnimationFrame(flushPendingWrites);
        }
      } else {
        // Tab hidden — stash to a bounded ring buffer; flush when reactivated
        stashInactiveText(text);
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    const terminalContainer = containerRef.current;
    const textarea = terminalContainer.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
    const viewport = terminalContainer.querySelector(".xterm-viewport") as HTMLElement | null;
    const nativeTextInputListenerOptions = { capture: true } as const;
    let lastImeProcessKeyAt = -1;
    let lastCompositionEndAt = -1;
    let lastNativeTextInputAt = -1;
    let lastNativeTextInputData = "";
    let compositionScrollRafId: number | null = null;
    let containerScrollResetRafId: number | null = null;
    let helperTextareaAnchorRafId: number | null = null;
    let compositionAnchorRafId: number | null = null;
    let compositionAnchorTimeoutId: number | null = null;
    let compositionScrollLock: { element: HTMLElement; scrollTop: number; scrollLeft: number }[] = [];
    // Frozen at compositionstart: the cell where the user actually began typing.
    // During composition the pinyin is NOT forwarded to the PTY, so the TUI does
    // not redraw and the real input position cannot move — even while a compact
    // progress bar thrashes the hardware cursor. We anchor once and reuse it,
    // instead of re-deriving the position from the (drifting) buffer cursor.
    let compositionAnchorCell: { x: number; y: number } | null = null;

    const captureCompositionScroll = () => {
      compositionScrollLock = [terminalContainer, viewport]
        .filter((element): element is HTMLElement => Boolean(element))
        .map((element) => ({
          element,
          scrollTop: element.scrollTop,
          scrollLeft: element.scrollLeft,
        }));
    };

    const restoreCompositionScroll = () => {
      for (const { element, scrollTop, scrollLeft } of compositionScrollLock) {
        if (element.scrollTop !== scrollTop) element.scrollTop = scrollTop;
        if (element.scrollLeft !== scrollLeft) element.scrollLeft = scrollLeft;
      }
    };

    const scheduleCompositionScrollRestore = () => {
      restoreCompositionScroll();
      if (compositionScrollRafId !== null) {
        cancelAnimationFrame(compositionScrollRafId);
      }
      compositionScrollRafId = requestAnimationFrame(() => {
        compositionScrollRafId = null;
        restoreCompositionScroll();
      });
    };

    const resetTerminalContainerScroll = () => {
      if (terminalContainer.scrollTop !== 0) terminalContainer.scrollTop = 0;
      if (terminalContainer.scrollLeft !== 0) terminalContainer.scrollLeft = 0;
    };

    const scheduleTerminalContainerScrollReset = () => {
      resetTerminalContainerScroll();
      if (containerScrollResetRafId !== null) {
        cancelAnimationFrame(containerScrollResetRafId);
      }
      containerScrollResetRafId = requestAnimationFrame(() => {
        containerScrollResetRafId = null;
        resetTerminalContainerScroll();
      });
    };

    const estimateCellSize = () => {
      const fallbackFontSize = typeof terminal.options.fontSize === "number" ? terminal.options.fontSize : fontSize;
      return getTerminalRenderedCellSize(terminal, terminalContainer, fallbackFontSize);
    };

    const resolveCompositionAnchorCell = () => {
      const buffer = terminal.buffer.active;
      const inputPromptPattern = /^(?:[>$#\u203a\u276f\u00bb\u2023]|PS(?:\s|>))/u;
      const clampX = (x: number) => Math.min(Math.max(0, x), Math.max(0, terminal.cols - 1));
      const clampY = (y: number) => Math.min(Math.max(0, y), Math.max(0, terminal.rows - 1));
      const cursor = {
        x: clampX(buffer.cursorX),
        y: clampY(buffer.cursorY),
      };

      const rowText = (row: number) => {
        const line = buffer.getLine(buffer.viewportY + row);
        return line ? line.translateToString(true) : null;
      };

      // Input box FIRST row: carries a "> " prompt after stripping any leading
      // box-drawing border (Claude Code / Codex draw "│ > … │").
      const rowIsPromptRow = (row: number) => {
        const text = rowText(row);
        if (text === null) return false;
        const trimmed = text.trimStart().replace(TUI_BORDER_PREFIX_PATTERN, "");
        return Boolean(trimmed) && inputPromptPattern.test(trimmed);
      };

      // The input box is delimited by horizontal rules ("─────"), NOT vertical
      // borders — Claude Code draws "───── / > line1 / ·  line2 / ─────". Detect
      // the bottom rule so the downward scan knows where the box ends.
      const rowIsHorizontalRule = (row: number) => {
        const text = rowText(row);
        if (text === null) return false;
        const trimmed = text.trim();
        return trimmed.length > 0 && /^[─━═╌╍┄┅┈┉╴╶]+$/u.test(trimmed);
      };

      // Anchor just past the last real (non-blank, non-border) glyph on a row.
      const anchorAtRowTextEnd = (row: number) => {
        const line = buffer.getLine(buffer.viewportY + row);
        if (!line) return { x: 0, y: clampY(row) };
        for (let x = Math.min(terminal.cols, line.length) - 1; x >= 0; x -= 1) {
          const cell = line.getCell(x);
          const chars = cell?.getChars().trim();
          // Skip blanks and any border glyph; anchor right after the typed text.
          if (!cell || !chars || TUI_BORDER_CHAR_PATTERN.test(chars)) continue;
          return { x: clampX(x + Math.max(1, cell.getWidth())), y: clampY(row) };
        }
        // Blank row (a freshly opened continuation line): sit at its indent so
        // the IME lands where the next glyph will appear.
        const text = line.translateToString(true);
        const indent = text.length - text.replace(/^\s+/u, "").length;
        return { x: clampX(indent > 0 ? indent : 1), y: clampY(row) };
      };

      // Locate the input box (always the bottom-most one — immune to the
      // hardware cursor the TUI flings around). Scan UP for its prompt row, then
      // find the bottom horizontal rule below it. The active input line is the
      // box's last row: in a multi-line box the user types on it while only the
      // first row keeps the "> " prompt and continuation rows are bare indents.
      // A single-line box (only the prompt row has content, with a blank pad row
      // before the rule) anchors on the prompt row itself. Purely structural.
      for (let row = terminal.rows - 1; row >= 0; row -= 1) {
        if (!rowIsPromptRow(row)) continue;

        let ruleRow = terminal.rows;
        for (let r = row + 1; r < terminal.rows; r += 1) {
          if (rowIsHorizontalRule(r)) { ruleRow = r; break; }
        }
        const boxBottom = Math.max(row, ruleRow - 1);

        // The TUI (Claude Code / Codex) paints its own text caret as a single
        // reverse-video cell (CSI 7m) inside the box — verified via buffer dump:
        // it tracks the real caret on the prompt row, on continuation rows, and
        // even mid-box, while the hardware cursor gets parked far-right or below
        // the box. Plain shells never set this attribute (xterm draws their
        // cursor as a render overlay, not a buffer cell attribute), so this scan
        // only ever fires for a TUI — and when it does, it IS the visual caret.
        for (let r = row; r <= boxBottom; r += 1) {
          const line = buffer.getLine(buffer.viewportY + r);
          if (!line) continue;
          const width = Math.min(terminal.cols, line.length);
          for (let x = 0; x < width; x += 1) {
            const cell = line.getCell(x);
            if (cell && cell.isInverse() !== 0) {
              return { x: clampX(x), y: clampY(r) };
            }
          }
        }

        // No inverse caret found. A borderless prompt — a plain shell, or a TUI
        // like Codex that draws no ─ rule — keeps the REAL terminal cursor on the
        // caret (verified via dump: no inverse cell, hardware cursor tracks the
        // caret on prompt / continuation / mid rows alike). Trust it directly.
        // (Claude Code flings its cursor away but always draws the rule + inverse,
        // handled above; only its rare dropped frame — rule present but inverse
        // momentarily gone — falls through to the structural anchor below.)
        if (ruleRow >= terminal.rows && cursor.y >= row) {
          return cursor;
        }

        // Bordered TUI whose inverse caret dropped this frame: fall back to
        // purely structural anchoring.
        // Last non-blank row inside the box.
        let lastContentRow = row;
        for (let r = row + 1; r <= boxBottom; r += 1) {
          if ((rowText(r) ?? "").trim().length > 0) lastContentRow = r;
        }

        // Only the prompt row carries content → single-line box, anchor there
        // (its trailing blank pad row is not an input line). Otherwise the box is
        // multi-line and the active line is its bottom row (possibly a blank,
        // freshly-opened continuation line the user just wrapped to).
        const anchorRow = lastContentRow === row ? row : boxBottom;

        // Plain shell, single line, cursor genuinely on it → exact in-line caret.
        const anchor = anchorRow === row && cursor.y === row
          ? cursor
          : anchorAtRowTextEnd(anchorRow);

        return anchor;
      }

      // No input box on screen (full-screen TUI without a prompt): the hardware
      // cursor is the only signal left.
      return cursor;
    };

    const applyCompositionAnchorFix = () => {
      if (!isComposingRef.current) return;
      const compositionView = terminalContainer.querySelector(".composition-view") as HTMLElement | null;
      if (!textarea && !compositionView) return;
      const anchor = compositionAnchorCell ?? resolveCompositionAnchorCell();
      const cell = estimateCellSize();
      const leftValue = Math.max(0, anchor.x * cell.width);
      const topValue = Math.max(0, anchor.y * cell.height);
      const heightValue = Math.max(1, cell.height);
      const left = `${leftValue}px`;
      const top = `${topValue}px`;
      const height = `${heightValue}px`;

      if (compositionView) {
        compositionView.style.left = left;
        compositionView.style.top = top;
        compositionView.style.height = height;
        compositionView.style.lineHeight = height;
      }
      if (textarea) {
        const compositionBounds = compositionView?.getBoundingClientRect();
        const widthValue = compositionBounds && compositionBounds.width > 0
          ? compositionBounds.width
          : Math.max(1, cell.width);
        textarea.style.left = left;
        textarea.style.top = top;
        textarea.style.width = `${widthValue}px`;
        textarea.style.height = height;
        textarea.style.lineHeight = height;
      }
    };

    const scheduleCompositionAnchorFix = () => {
      applyCompositionAnchorFix();
      if (compositionAnchorRafId !== null) {
        cancelAnimationFrame(compositionAnchorRafId);
      }
      compositionAnchorRafId = requestAnimationFrame(() => {
        compositionAnchorRafId = null;
        applyCompositionAnchorFix();
      });
      if (compositionAnchorTimeoutId !== null) {
        window.clearTimeout(compositionAnchorTimeoutId);
      }
      compositionAnchorTimeoutId = window.setTimeout(() => {
        compositionAnchorTimeoutId = null;
        applyCompositionAnchorFix();
      }, 0);
    };

    const pinHelperTextareaAnchor = () => {
      if (!textarea || isComposingRef.current) return;
      // Pre-position the hidden helper textarea ON the caret cell instead of
      // pushing it off-screen. Some IMEs — notably Sogou — anchor their
      // candidate popup to the textarea position at the instant composition
      // STARTS and never follow it afterwards. If the textarea sits at
      // "-9999em" at that moment, the popup is clamped to the window's top-left
      // corner for the entire composition (and our mid-composition re-anchoring
      // never gets a chance to move it). Keep it on the caret and hide it with
      // opacity:0 in place, so the popup opens at the cursor from the first key.
      const anchor = resolveCompositionAnchorCell();
      const cell = estimateCellSize();
      textarea.style.left = `${Math.max(0, anchor.x * cell.width)}px`;
      textarea.style.top = `${Math.max(0, anchor.y * cell.height)}px`;
      textarea.style.opacity = "0";
      // Keep the hidden input measurable: xterm's IME fallback for active IME
      // punctuation reads textarea diffs after keyCode 229, and some IMEs drop
      // the first character when the helper textarea is 0x0.
      textarea.style.width = "1px";
      textarea.style.height = `${Math.max(1, cell.height)}px`;
      textarea.style.lineHeight = `${Math.max(1, cell.height)}px`;
    };

    const scheduleHelperTextareaAnchorPin = () => {
      pinHelperTextareaAnchor();
      if (helperTextareaAnchorRafId !== null) {
        cancelAnimationFrame(helperTextareaAnchorRafId);
      }
      helperTextareaAnchorRafId = requestAnimationFrame(() => {
        helperTextareaAnchorRafId = null;
        pinHelperTextareaAnchor();
      });
    };

    const cancelHelperTextareaAnchorPin = () => {
      if (helperTextareaAnchorRafId !== null) {
        cancelAnimationFrame(helperTextareaAnchorRafId);
        helperTextareaAnchorRafId = null;
      }
    };

    scheduleHelperTextareaAnchorPin();
    terminalContainer.addEventListener("scroll", scheduleTerminalContainerScrollReset, { passive: true });
    const cursorMoveDisposable = terminal.onCursorMove(() => {
      if (!isActiveRef.current) return;
      if (isComposingRef.current) {
        clearSuggestionGhost();
        scheduleCompositionScrollRestore();
        scheduleCompositionAnchorFix();
        return;
      }
      updateSuggestionGhostPosition(suggestionRef.current);
      scheduleAiPathChips();
      if (!textarea || document.activeElement !== textarea) return;
      scheduleTerminalContainerScrollReset();
      scheduleHelperTextareaAnchorPin();
    });
    const renderDisposable = terminal.onRender(() => {
      scheduleTuiComposerBackgroundNormalization(terminal);
      scheduleAiPathChips();
      if (!isComposingRef.current) {
        updateSuggestionGhostPosition(suggestionRef.current);
        return;
      }
      clearSuggestionGhost();
      scheduleCompositionScrollRestore();
      scheduleCompositionAnchorFix();
    });

    // 中文 IME 的直出标点可能不会稳定进入 xterm 的 textarea diff：
    // Windows 常见信号是 keyCode 229；macOS 中文输入法的全角标点（如 "（"）
    // 可能只有 insertText。这里仅延迟补交这类小范围原生 text input，
    // 不阻断 xterm 自己的 composition / input 事件链，避免单字提交被吞或空格确认候选残留。
    const nowForImeInput = () => performance.now();
    const isHelperTextareaEvent = (event: Event) => Boolean(textarea) && event.target === textarea;
    const shouldRecoverNativeTextInput = (event: InputEvent) => {
      if (!isHelperTextareaEvent(event) || event.inputType !== "insertText" || !event.data) return false;
      if (/^[\t\n\v\f\r ]+$/.test(event.data)) return false;
      if (isComposingRef.current || event.isComposing) return false;
      const now = nowForImeInput();
      if (lastCompositionEndAt >= 0 && now - lastCompositionEndAt <= IME_COMPOSITION_END_SUPPRESS_WINDOW_MS) return false;
      if (isLikelyMacPlatform(osPlatformRef.current) && CJK_NATIVE_PUNCTUATION_PATTERN.test(event.data)) return true;
      const hasRecentImeProcessKey = lastImeProcessKeyAt >= 0 && now - lastImeProcessKeyAt <= IME_PROCESS_KEY_RECOVERY_WINDOW_MS;
      return hasRecentImeProcessKey;
    };
    const scheduleNativeTextInputRecovery = (data: string, eventAt: number) => {
      window.setTimeout(() => {
        if (cancelled || terminalRef.current !== terminal) return;
        const lastForwarded = lastForwardedTerminalInput;
        if (
          lastForwarded?.source === "onData"
          && lastForwarded.data === data
          && lastForwarded.at >= eventAt
          && lastForwarded.at - eventAt <= IME_CROSS_SOURCE_DUPLICATE_WINDOW_MS
        ) {
          return;
        }
        forwardTerminalInput(data, "nativeTextInput");
      }, 0);
    };
    const recoverNativeTextInput = (event: InputEvent) => {
      if (!shouldRecoverNativeTextInput(event)) return false;
      const data = event.data ?? "";
      const now = nowForImeInput();
      if (lastNativeTextInputData === data && now - lastNativeTextInputAt <= NATIVE_TEXT_INPUT_DEDUP_WINDOW_MS) return true;
      lastNativeTextInputAt = now;
      lastNativeTextInputData = data;
      scheduleNativeTextInputRecovery(data, now);
      return true;
    };
    const onNativeTextBeforeInput = (event: Event) => {
      recoverNativeTextInput(event as InputEvent);
    };
    const onNativeTextInput = (event: Event) => {
      recoverNativeTextInput(event as InputEvent);
    };
    const onImeProcessKeyDown = (event: KeyboardEvent) => {
      if (!isHelperTextareaEvent(event) || event.keyCode !== IME_PROCESS_KEY_CODE || event.ctrlKey || event.altKey || event.metaKey) return;
      lastImeProcessKeyAt = nowForImeInput();
    };

    terminalContainer.addEventListener("keydown", onImeProcessKeyDown, nativeTextInputListenerOptions);
    terminalContainer.addEventListener("beforeinput", onNativeTextBeforeInput, nativeTextInputListenerOptions);
    terminalContainer.addEventListener("input", onNativeTextInput, nativeTextInputListenerOptions);

    const onCompositionStart = () => {
      isComposingRef.current = true;
      clearSuggestionGhost();
      lastImeProcessKeyAt = -1;
      // Freeze the anchor at the cell where typing began. The buffer cursor is
      // trustworthy at this instant (the user just placed the caret here), and
      // it must not be re-read afterwards — TUI redraws can move the hardware
      // cursor mid-composition without the input position changing.
      compositionAnchorCell = resolveCompositionAnchorCell();
      cancelHelperTextareaAnchorPin();
      captureCompositionScroll();
      scheduleCompositionScrollRestore();
      scheduleCompositionAnchorFix();
    };
    const onCompositionUpdate = () => {
      scheduleCompositionScrollRestore();
      scheduleCompositionAnchorFix();
    };
    const onCompositionEnd = () => {
      isComposingRef.current = false;
      lastCompositionEndAt = nowForImeInput();
      compositionAnchorCell = null;
      if (isCodexSession()) {
        const textareaValue = textarea?.value ?? "";
        codexImeDebugRef.current.compositionEndAt = Date.now();
        codexImeDebugRef.current.compositionEndSummary = summarizeTextForDiagnostics(textareaValue);
        codexImeDebugRef.current.lastNearCompositionFingerprint = null;
        codexImeDebugRef.current.lastNearCompositionAt = -1;
      }
      scheduleCompositionScrollRestore();
      scheduleHelperTextareaAnchorPin();
      scheduleFit(true);
    };

    textarea?.addEventListener("compositionstart", onCompositionStart);
    textarea?.addEventListener("compositionupdate", onCompositionUpdate);
    textarea?.addEventListener("compositionend", onCompositionEnd);

    // Ctrl + wheel adjusts global font size (writes settings store, like Windows Terminal but persistent).
    const wheelTarget = containerRef.current;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const current = useSettingsStore.getState().fontSize;
      const next = Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, current + (e.deltaY > 0 ? -1 : 1)));
      if (next !== current) {
        void useSettingsStore.getState().update("fontSize", next);
      }
    };
    wheelTarget.addEventListener("wheel", onWheel, { passive: false, capture: true });

    // Resize observer — skip fit when container is hidden or IME composition is active.
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      const lastSize = lastObservedSizeRef.current;
      if (lastSize && Math.abs(lastSize.width - width) < 2 && Math.abs(lastSize.height - height) < 2) {
        return;
      }
      lastObservedSizeRef.current = { width, height };
      scheduleFit();
    });
    resizeObserver.observe(containerRef.current);


    return () => {
      cancelled = true;
      suggestionDisposed = true;
      if (suggestionRefreshTimerId !== null) {
        window.clearTimeout(suggestionRefreshTimerId);
        suggestionRefreshTimerId = null;
      }
      if (aiSuggestionTimerId !== null) {
        window.clearTimeout(aiSuggestionTimerId);
        aiSuggestionTimerId = null;
      }
      pendingAiSuggestionContext = null;
      aiSuggestionQueued = false;
      acceptSuggestionRef.current = () => false;
      clearSuggestionGhost();
      cancelPendingCursorShow();
      pasteTarget.removeEventListener("paste", onPaste, pasteListenerOptions);
      unregisterTerminalDropZone();
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
      fileDropCancelled = true;
      unlistenFileDrop?.();
      contextMenuTarget.removeEventListener("contextmenu", onContextMenu);
      contextMenuTarget.removeEventListener("click", moveInputCursorToClick);
      terminalContainer.removeEventListener("keydown", onImeProcessKeyDown, nativeTextInputListenerOptions);
      terminalContainer.removeEventListener("beforeinput", onNativeTextBeforeInput, nativeTextInputListenerOptions);
      terminalContainer.removeEventListener("input", onNativeTextInput, nativeTextInputListenerOptions);
      textarea?.removeEventListener("compositionstart", onCompositionStart);
      textarea?.removeEventListener("compositionupdate", onCompositionUpdate);
      textarea?.removeEventListener("compositionend", onCompositionEnd);
      terminalContainer.removeEventListener("scroll", scheduleTerminalContainerScrollReset);
      cursorMoveDisposable.dispose();
      renderDisposable.dispose();
      wheelTarget.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      resizeObserver.disconnect();
      if (fitRafRef.current !== null) {
        cancelAnimationFrame(fitRafRef.current);
        fitRafRef.current = null;
      }
      if (compositionScrollRafId !== null) {
        cancelAnimationFrame(compositionScrollRafId);
        compositionScrollRafId = null;
      }
      if (aiPathChipRafId !== null) {
        cancelAnimationFrame(aiPathChipRafId);
        aiPathChipRafId = null;
      }
      if (containerScrollResetRafId !== null) {
        cancelAnimationFrame(containerScrollResetRafId);
        containerScrollResetRafId = null;
      }
      if (helperTextareaAnchorRafId !== null) {
        cancelAnimationFrame(helperTextareaAnchorRafId);
        helperTextareaAnchorRafId = null;
      }
      if (compositionAnchorRafId !== null) {
        cancelAnimationFrame(compositionAnchorRafId);
        compositionAnchorRafId = null;
      }
      if (compositionAnchorTimeoutId !== null) {
        window.clearTimeout(compositionAnchorTimeoutId);
        compositionAnchorTimeoutId = null;
      }
      if (writeRafId !== null) {
        cancelAnimationFrame(writeRafId);
        writeRafId = null;
      }
      try {
        const serializedOutput = serializeAddon.serialize();
        const pendingOutput = [
          ...activeWriteQueueRef.current,
          ...pendingChunks,
          ...inactiveBufferRef.current,
        ].join("");
        useTerminalStore.getState().updateSessionTerminalSnapshot(sessionId, `${serializedOutput}${pendingOutput}`);
      } catch (err) {
        logError("Failed to snapshot terminal buffer before dispose", { sessionId, err });
      }
      if (activeWriteRafRef.current !== null) {
        cancelAnimationFrame(activeWriteRafRef.current);
        activeWriteRafRef.current = null;
      }
      if (tuiComposerNormalizeRafRef.current !== null) {
        cancelAnimationFrame(tuiComposerNormalizeRafRef.current);
        tuiComposerNormalizeRafRef.current = null;
      }
      pendingChunks = [];
      clearHiddenWebglDisposeTimer();
      activeWriteQueueRef.current = [];
      activeWriteQueueSizeRef.current = 0;
      inactiveReplayStickToBottomRef.current = false;
      inactiveReplayPendingWritesRef.current = 0;
      inactiveReplayPendingRef.current = false;
      inactiveBufferRef.current = [];
      inactiveBufferSizeRef.current = 0;
      needsViewportRefreshRef.current = false;
      unlisten?.();
      searchResultDisposable.dispose();
      cursorStyleDisposable.dispose();
      webglAddonRef.current?.dispose();
      webglAddonRef.current = null;
      webglAddon = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [sessionId]);

  const backgroundColor = getTerminalBackground(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
  const backgroundOverlayColor = getTerminalBackgroundOverlayColor(terminalTheme);
  const showBackgroundImage = isTransparent && assetUrl !== null;
  terminalColorRepliesRef.current = {
    foreground: formatSpecialColorReply(10, normalizeHexColor(terminalTheme.foreground, "#d8dee9")),
    background: formatSpecialColorReply(11, normalizeHexColor(terminalTheme.background, backgroundColor)),
  };
  const searchForeground = normalizeHexColor(terminalTheme.foreground, "#d8dee9");
  const searchBackground = normalizeHexColor(terminalTheme.background, backgroundColor);
  const searchAccent = normalizeHexColor(terminalTheme.cursor, searchForeground);
  const searchMatchBackground = normalizeHexColor(terminalTheme.yellow, "#e0af68");
  const searchActiveBackground = normalizeHexColor(terminalTheme.blue, "#7aa2f7");
  const searchResultLabel = !searchTerm
    ? ""
    : searchResult.resultCount > 0 && searchResult.resultIndex >= 0
      ? `${searchResult.resultIndex + 1}/${searchResult.resultCount}`
      : searchMatched === false
        ? "0/0"
        : "";

  const terminalSearchShellStyle: CSSProperties = {
    position: "absolute",
    right: 12,
    top: 12,
    zIndex: 20,
    backgroundColor: hexToRgba(searchBackground, showBackgroundImage ? 0.78 : 0.92, "rgba(0, 0, 0, 0.86)"),
    borderColor: hexToRgba(searchForeground, 0.24, "rgba(255, 255, 255, 0.22)"),
    boxShadow: `0 12px 30px ${hexToRgba(searchBackground, 0.55, "rgba(0, 0, 0, 0.45)")}`,
    color: searchForeground,
    fontFamily,
    maxWidth: "min(440px, calc(100% - 24px))",
  };
  const terminalSearchInputStyle: CSSProperties = {
    caretColor: searchAccent,
    color: searchForeground,
  };
  const terminalSearchButtonStyle: CSSProperties = {
    backgroundColor: hexToRgba(searchForeground, 0.08, "rgba(255, 255, 255, 0.08)"),
    borderColor: hexToRgba(searchForeground, 0.16, "rgba(255, 255, 255, 0.16)"),
    color: searchForeground,
  };

  const createSearchOptions = (incremental = false): ISearchOptions => ({
    incremental,
    decorations: {
      matchBackground: searchMatchBackground,
      matchBorder: searchMatchBackground,
      matchOverviewRuler: searchMatchBackground,
      activeMatchBackground: searchActiveBackground,
      activeMatchBorder: searchAccent,
      activeMatchColorOverviewRuler: searchAccent,
    },
  });

  const clearTerminalSearch = () => {
    searchAddonRef.current?.clearDecorations();
    setSearchMatched(null);
    setSearchResult(EMPTY_SEARCH_RESULT);
  };

  const runTerminalSearch = (term: string, direction: "next" | "previous", incremental = false) => {
    const searchAddon = searchAddonRef.current;
    if (!term || !searchAddon) {
      clearTerminalSearch();
      return;
    }
    const matched = direction === "previous"
      ? searchAddon.findPrevious(term, createSearchOptions(false))
      : searchAddon.findNext(term, createSearchOptions(incremental));
    setSearchMatched(matched);
  };

  const handleSearchTermChange = (value: string) => {
    setSearchTerm(value);
    runTerminalSearch(value, "next", true);
  };

  const closeTerminalSearch = () => {
    setSearchOpen(false);
    setSearchTerm("");
    clearTerminalSearch();
    window.requestAnimationFrame(() => terminalRef.current?.focus());
  };

  const closeContextMenu = () => setMenuState(null);

  const handleMenuCopy = () => {
    const terminal = terminalRef.current;
    closeContextMenu();
    if (!terminal) return;
    void copyTextToClipboard(terminal.getSelection());
    terminal.clearSelection();
    terminal.focus();
  };

  const handleMenuPaste = () => {
    const terminal = terminalRef.current;
    closeContextMenu();
    if (!terminal) return;
    readClipboardText().then((text) => {
      const normalizedText = trimTerminalPasteBoundaryLineBreaks(text);
      if (!normalizedText) return;
      useTerminalStore.getState().markAttentionInputHandled(sessionId);
      terminal.paste(normalizedText);
      terminal.focus();
    }).catch((err) => {
      logError("Failed to read clipboard text", { sessionId, err });
    });
  };

  const handleMenuSelectAll = () => {
    const terminal = terminalRef.current;
    closeContextMenu();
    if (!terminal) return;
    terminal.selectAll();
    terminal.focus();
  };

  const handleMenuCopyAll = () => {
    const terminal = terminalRef.current;
    closeContextMenu();
    if (!terminal) return;
    void copyTextToClipboard(serializeBufferPlainText(terminal));
    terminal.focus();
  };

  const handleMenuClear = () => {
    const terminal = terminalRef.current;
    closeContextMenu();
    if (!terminal) return;
    useTerminalStore.getState().markAttentionInputHandled(sessionId);
    invoke("pty_write", { sessionId, data: "\x0c" }).catch((err) => reportPtyWriteError("clear", err));
    terminal.focus();
  };

  const runMenuAction = (action?: () => void) => {
    closeContextMenu();
    action?.();
  };

  const runSplitMenuAction = (action?: (point?: TerminalContextMenuPoint) => void) => {
    const point = menuState ? { x: menuState.x, y: menuState.y } : undefined;
    closeContextMenu();
    action?.(point);
  };

  const hasManageActions = Boolean(
    onNewTab || onCloseSession || onCloseOthers || onCloseToLeft || onCloseToRight || onSplitRight || onSplitDown
  );

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

  // When the background image is active, an opaque wrapper background would
  // cover the pseudo-element image layer and break the transparency model.
  const wrapperStyle: CSSProperties = showBackgroundImage
    ? ({
        "--terminal-font-family": effectiveFontFamily,
        "--terminal-bg-image": `url("${assetUrl}")`,
        "--terminal-bg-opacity": (background.opacity / 100).toString(),
        "--terminal-bg-blur": `${background.blur}px`,
        "--terminal-bg-darken": (background.overlayDarken / 100).toString(),
        "--terminal-bg-overlay-color": backgroundOverlayColor,
      } as CSSProperties)
    : ({ "--terminal-font-family": effectiveFontFamily, backgroundColor } as CSSProperties);
  const terminalContainerStyle: CSSProperties | undefined = inactiveReplayPending
    ? { visibility: "hidden" }
    : undefined;

  const moveRichInputCursor = (targetIndex: number) => {
    const terminal = terminalRef.current;
    if (!terminal || !richInputStateRef.current) return;
    const currentInput = inputBuffer.current;
    const currentIndex = clampTextCursorIndex(currentInput, inputCursorIndexRef.current);
    const nextIndex = clampTextCursorIndex(currentInput, targetIndex);
    const delta = nextIndex - currentIndex;
    terminal.focus();
    if (delta === 0) return;
    const currentRichInput = richInputStateRef.current;
    pendingRichDeleteTransitionRef.current = null;
    pendingRichCursorTransitionRef.current = currentRichInput && currentRichInput.input === currentInput && currentRichInput.cols === terminal.cols
      ? {
          input: currentInput,
          inputStartCellIndex: currentRichInput.inputStartCellIndex,
          inputRangeWidth: currentRichInput.maskedInputWidth,
          targetCursorIndex: nextIndex,
          cols: currentRichInput.cols,
          startedAt: Date.now(),
        }
      : null;
    inputCursorIndexRef.current = nextIndex;
    suggestionRef.current = null;
    setSuggestionGhost(null);
    useTerminalStore.getState().markAttentionInputHandled(sessionId);
    const data = delta > 0
      ? repeatControlSequence("\x1b[C", delta)
      : repeatControlSequence("\x1b[D", -delta);
    invoke("pty_write", { sessionId, data }).catch((err) => reportPtyWriteError("rich_file_click", err));
  };

  const activeRichInput = isActive ? richInput : null;
  const passiveAiPathChips = activeRichInput
    ? aiPathChips.filter((chip) => !activeRichInput.masks.some((mask) => (
        chip.left < mask.left + mask.width &&
        chip.left + chip.spanWidth > mask.left &&
        chip.top < mask.top + mask.height &&
        chip.top + chip.height > mask.top
      )))
    : aiPathChips;

  const richInputItems: ReactNode[] = [];
  if (activeRichInput) {
    let caretRendered = false;
    const renderCaret = (cursorIndex: number, key: string) => {
      if (caretRendered || activeRichInput.cursorIndex !== cursorIndex) return;
      caretRendered = true;
      richInputItems.push(
        <span
          key={key}
          className="ui-terminal-rich-input-caret"
          style={{ height: activeRichInput.cellHeight, "--rich-input-caret-color": searchAccent } as CSSProperties}
        />
      );
    };

    for (const segment of activeRichInput.segments) {
      if (segment.kind === "file") {
        renderCaret(segment.rawStart, `caret:${segment.rawStart}`);
        richInputItems.push(
          <span
            key={`file:${segment.rawStart}:${segment.raw}`}
            className="ui-terminal-ai-path-chip ui-terminal-rich-file-chip"
            style={{ height: activeRichInput.cellHeight }}
            title={segment.label}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              moveRichInputCursor(event.clientX < rect.left + rect.width / 2 ? segment.rawStart : segment.rawEnd);
            }}
          >
            <img className="ui-terminal-ai-path-chip-icon" src={getMaterialFileIcon(segment.fileName)} alt="" draggable={false} />
            <span className="ui-terminal-ai-path-chip-label">{segment.label}</span>
          </span>
        );
        renderCaret(segment.rawEnd, `caret:${segment.rawEnd}`);
        continue;
      }

      if (segment.kind === "separator") {
        renderCaret(segment.rawStart, `caret:${segment.rawStart}`);
        richInputItems.push(
          <span
            key={`separator:${segment.rawStart}:${segment.rawEnd}`}
            className="ui-terminal-rich-input-char ui-terminal-rich-input-separator"
            style={{
              width: activeRichInput.cellWidth,
              height: activeRichInput.cellHeight,
              lineHeight: `${activeRichInput.cellHeight}px`,
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              moveRichInputCursor(event.clientX < rect.left + rect.width / 2 ? segment.rawStart : segment.rawEnd);
            }}
          >
            {"\u00a0"}
          </span>
        );
        renderCaret(segment.rawEnd, `caret:${segment.rawEnd}`);
        continue;
      }

      let cursorIndex = segment.rawStart;
      for (const char of segment.text) {
        const charCursorIndex = cursorIndex;
        renderCaret(charCursorIndex, `caret:${charCursorIndex}`);
        richInputItems.push(
          <span
            key={`text:${charCursorIndex}:${char.codePointAt(0) ?? 0}`}
            className="ui-terminal-rich-input-char"
            style={{
              width: Math.max(0, getTerminalCellWidth(char) * activeRichInput.cellWidth),
              height: activeRichInput.cellHeight,
              lineHeight: `${activeRichInput.cellHeight}px`,
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              moveRichInputCursor(event.clientX < rect.left + rect.width / 2 ? charCursorIndex : charCursorIndex + 1);
            }}
          >
            {char === " " ? "\u00a0" : char}
          </span>
        );
        cursorIndex += 1;
      }
    }
    renderCaret(getTextCursorLength(activeRichInput.input), `caret:${getTextCursorLength(activeRichInput.input)}`);
  }

  return (
    <div
      ref={wrapperRef}
      className="ui-terminal-bg-layer relative h-full w-full overflow-hidden"
      style={wrapperStyle}
      data-bg-enabled={showBackgroundImage ? "true" : undefined}
      data-bg-fit={showBackgroundImage ? background.fit : undefined}
      data-bg-position={showBackgroundImage ? background.position : undefined}
    >
      {searchOpen && (
        <div
          className="absolute right-3 top-3 z-20 flex h-8 items-center gap-1 rounded-md border px-2 text-[12px] backdrop-blur-md"
          style={terminalSearchShellStyle}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="select-none font-mono text-[13px] opacity-70" aria-hidden="true">/</span>
          <input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(e) => handleSearchTermChange(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                runTerminalSearch(searchTerm, e.shiftKey ? "previous" : "next");
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                runTerminalSearch(searchTerm, "next");
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                runTerminalSearch(searchTerm, "previous");
              }
              if (e.key === "Escape") {
                e.preventDefault();
                closeTerminalSearch();
              }
            }}
            className="h-6 w-44 min-w-0 bg-transparent px-1 font-mono text-[12px] outline-none placeholder:opacity-55"
            style={terminalSearchInputStyle}
            placeholder="search"
            aria-label="搜索终端输出"
          />
          <span className="w-12 select-none text-right font-mono text-[11px] opacity-70" aria-live="polite">
            {searchResultLabel}
          </span>
          <button
            type="button"
            disabled={!searchTerm}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runTerminalSearch(searchTerm, "previous")}
            className="flex h-5 w-5 items-center justify-center rounded-sm border font-mono text-[11px] outline-none disabled:opacity-35"
            style={terminalSearchButtonStyle}
            aria-label="上一个匹配"
            title="上一个匹配"
          >
            ↑
          </button>
          <button
            type="button"
            disabled={!searchTerm}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runTerminalSearch(searchTerm, "next")}
            className="flex h-5 w-5 items-center justify-center rounded-sm border font-mono text-[11px] outline-none disabled:opacity-35"
            style={terminalSearchButtonStyle}
            aria-label="下一个匹配"
            title="下一个匹配"
          >
            ↓
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={closeTerminalSearch}
            className="flex h-5 w-5 items-center justify-center rounded-sm border font-mono text-[11px] outline-none"
            style={terminalSearchButtonStyle}
            aria-label="关闭搜索"
            title="关闭搜索"
          >
            x
          </button>
        </div>
      )}
      <div ref={containerRef} className="h-full w-full overflow-hidden pl-2" style={terminalContainerStyle} />
      {terminalInputSuggestionsEnabled && isActive && isVisible && !searchOpen && !activeRichInput && suggestionGhost && (
        <div
          aria-hidden="true"
          className="terminal-input-suggestion-ghost"
          style={{
            left: suggestionGhost.left,
            top: suggestionGhost.top,
            height: suggestionGhost.height,
            maxWidth: suggestionGhost.maxWidth,
            lineHeight: `${suggestionGhost.height}px`,
            color: searchForeground,
            fontFamily: effectiveFontFamily,
            fontSize,
          }}
        >
          {suggestionGhost.suffix}
        </div>
      )}
      {isActive && isVisible && !searchOpen && activeRichInput && (
        <>
          <div className="ui-terminal-rich-input-mask-layer" aria-hidden="true">
            {activeRichInput.masks.map((mask, index) => (
              <span
                key={`${mask.left}:${mask.top}:${index}`}
                className="ui-terminal-rich-input-mask"
                style={{
                  left: mask.left,
                  top: mask.top,
                  width: mask.width,
                  height: mask.height,
                  "--rich-input-bg": backgroundColor,
                } as CSSProperties}
              />
            ))}
          </div>
          <div
            className="ui-terminal-rich-input-layer"
            aria-hidden="true"
            style={{
              left: activeRichInput.left,
              top: activeRichInput.top,
              width: activeRichInput.width,
              minHeight: activeRichInput.cellHeight,
              fontFamily: effectiveFontFamily,
              fontSize,
              color: searchForeground,
              "--ai-chip-slot-bg": backgroundColor,
              "--rich-input-bg": backgroundColor,
            } as CSSProperties}
          >
            {activeRichInput.leadingWidth > 0 && (
              <span
                className="ui-terminal-rich-input-leading"
                style={{ width: activeRichInput.leadingWidth, height: activeRichInput.cellHeight }}
              />
            )}
            {richInputItems}
          </div>
        </>
      )}
      {isVisible && !searchOpen && passiveAiPathChips.length > 0 && (
        <div className="ui-terminal-ai-path-chip-layer" aria-hidden="true">
          {passiveAiPathChips.map((chip) => (
            <span
              key={chip.key}
              className={chip.maskOnly ? "ui-terminal-ai-path-chip-slot ui-terminal-ai-path-chip-slot--mask" : "ui-terminal-ai-path-chip-slot"}
              style={{
                left: chip.left,
                top: chip.top,
                // 遮罩槽底色，先盖住底下的裸路径（含 TUI composer 背景），避免露出黑块
                "--ai-chip-slot-bg": backgroundColor,
                // 遮罩槽严格占用原始路径宽度，避免可见 chip 扩展后覆盖相邻引用
                width: chip.spanWidth,
                height: chip.height,
                fontFamily: effectiveFontFamily,
                fontSize,
              } as CSSProperties}
              title={chip.label}
            >
              {!chip.maskOnly && (
                <span className="ui-terminal-ai-path-chip">
                  <img className="ui-terminal-ai-path-chip-icon" src={chip.icon} alt="" draggable={false} />
                  <span className="ui-terminal-ai-path-chip-label">{chip.label}</span>
                </span>
              )}
            </span>
          ))}
        </div>
      )}
      {menuState && (
        <Portal>
          <div
            ref={menuRef}
            className="terminal-context-menu"
            role="menu"
            style={{
              left: Math.max(8, Math.min(menuState.x, window.innerWidth - 190)),
              top: Math.max(8, Math.min(menuState.y, window.innerHeight - 320)),
              "--menu-fg": searchForeground,
              "--menu-bg": searchBackground,
              "--menu-border": hexToRgba(searchForeground, 0.18, "rgba(255, 255, 255, 0.18)"),
              "--menu-hover": hexToRgba(searchForeground, 0.12, "rgba(255, 255, 255, 0.12)"),
              fontFamily,
            } as CSSProperties}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="terminal-context-menu-item"
              disabled={!menuState.hasSelection}
              onClick={handleMenuCopy}
            >
              <span>{t("terminal.contextMenu.copy")}</span>
              <span className="terminal-context-menu-hint">Ctrl+C</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="terminal-context-menu-item"
              onClick={handleMenuPaste}
            >
              <span>{t("terminal.contextMenu.paste")}</span>
              <span className="terminal-context-menu-hint">Ctrl+V</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="terminal-context-menu-item"
              onClick={handleMenuSelectAll}
            >
              <span>{t("terminal.contextMenu.selectAll")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="terminal-context-menu-item"
              onClick={handleMenuCopyAll}
            >
              <span>{t("terminal.contextMenu.copyAll")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="terminal-context-menu-item"
              onClick={handleMenuClear}
            >
              <span>{t("terminal.contextMenu.clear")}</span>
            </button>
            {hasManageActions && (
              <>
                <div className="terminal-context-menu-separator" role="separator" />
                {onNewTab && (
                  <button
                    type="button"
                    role="menuitem"
                    className="terminal-context-menu-item"
                    onClick={() => runMenuAction(onNewTab)}
                  >
                    <span>{t("terminal.toolbar.newTerminal")}</span>
                  </button>
                )}
                {onCloseSession && (
                  <button
                    type="button"
                    role="menuitem"
                    className="terminal-context-menu-item"
                    onClick={() => runMenuAction(onCloseSession)}
                  >
                    <span>{t("terminal.tab.closeCurrent")}</span>
                  </button>
                )}
                {onCloseOthers && (
                  <button
                    type="button"
                    role="menuitem"
                    className="terminal-context-menu-item"
                    onClick={() => runMenuAction(onCloseOthers)}
                  >
                    <span>{t("terminal.tab.closeOthers")}</span>
                  </button>
                )}
                {onCloseToLeft && (
                  <button
                    type="button"
                    role="menuitem"
                    className="terminal-context-menu-item"
                    onClick={() => runMenuAction(onCloseToLeft)}
                  >
                    <span>{t("terminal.tab.closeLeft")}</span>
                  </button>
                )}
                {onCloseToRight && (
                  <button
                    type="button"
                    role="menuitem"
                    className="terminal-context-menu-item"
                    onClick={() => runMenuAction(onCloseToRight)}
                  >
                    <span>{t("terminal.tab.closeRight")}</span>
                  </button>
                )}
                {(onSplitRight || onSplitDown) && <div className="terminal-context-menu-separator" role="separator" />}
                {onSplitRight && (
                  <button
                    type="button"
                    role="menuitem"
                    className="terminal-context-menu-item"
                    onClick={() => runSplitMenuAction(onSplitRight)}
                  >
                    <span>{t("terminal.tab.splitRight")}</span>
                  </button>
                )}
                {onSplitDown && (
                  <button
                    type="button"
                    role="menuitem"
                    className="terminal-context-menu-item"
                    onClick={() => runSplitMenuAction(onSplitDown)}
                  >
                    <span>{t("terminal.tab.splitDown")}</span>
                  </button>
                )}
              </>
            )}
          </div>
        </Portal>
      )}
    </div>
  );
}
