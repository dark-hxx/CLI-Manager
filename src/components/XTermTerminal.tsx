import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal, type IBufferCell, type IBufferLine, type IDisposable, type ILink, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
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
import { backgroundAssetUrl } from "../lib/assetUrl";
import { TERMINAL_FILE_PATH_MIME } from "../lib/aiPathFormatter";
import { resolveManualDirectCodexEnterData } from "../lib/codexManualInput";
import { translateCurrent, useI18n } from "../lib/i18n";
import { buildFastCursorMoveSequence } from "../lib/terminalCursorMovement";
import { normalizeTerminalFontFamily } from "../lib/terminalFontFamily";
import { findTerminalFileLinks, resolveTerminalFileSystemPath } from "../lib/terminalFileLinks";
import { findProjectByPath, findWorktreeByPath } from "../lib/terminalProject";
import { useTerminalSearch } from "../hooks/useTerminalSearch";
import { useTerminalContextMenu } from "../hooks/useTerminalContextMenu";
import { useTerminalOsc } from "../hooks/useTerminalOsc";
import { useTerminalDisplay } from "../hooks/useTerminalDisplay";
import { useTerminalInput, type TerminalSuggestionGhostState } from "../hooks/useTerminalInput";
import { getTerminalCellWidth, resolveCursorIndexFromCellOffset } from "../lib/terminalCellWidth";
import {
  clampTextCursorIndex,
  getTextCursorLength,
  insertTextAtCursor,
  removeTextAtCursor,
  removeTextBeforeCursor,
  repeatControlSequence,
  sliceTextByCursor,
} from "../lib/terminalTextEditing";
import { hexToRgba, normalizeHexColor } from "../lib/terminalColor";
import {
  arrayBufferToBase64,
  createClipboardImageFileName,
  getClipboardImageFile,
  hasDataTransferType,
} from "../lib/terminalClipboardImage";
import {
  terminalShortcutMatches,
  trimTerminalPasteBoundaryLineBreaks,
  wrapTerminalPasteTextForCtrlShiftV,
} from "../lib/terminalKeyboard";
import { formatShellPathList, joinLocalPath, normalizeShellForKnownOs } from "../lib/terminalShellPath";
import { resolveSubmittedDirectoryChange } from "../lib/terminalInputSuggestions";
import {
  endTerminalFileDrag,
  getTerminalFileDropZoneIdAtPoint,
  getTerminalFileDragText,
  registerTerminalDropZone,
  updateTerminalFileDragPointFromEvent,
} from "../lib/terminalFileDrag";
import {
  didRenderFullTerminalViewport,
  planTerminalVisibilityRestore,
  refreshTerminalViewport,
} from "../lib/terminalVisibility";
import {
  getLinuxGraphicsDiagnostics,
  isLinuxGraphicsConstrained,
  shouldDisableTerminalWebgl,
} from "../lib/linuxGraphics";
import {
  defaultShellForOs,
  getOsPlatform,
  normalizeShellKey,
  type OsPlatform,
} from "../lib/shell";
import { Portal } from "./ui/Portal";
import { useCommandHistoryStore } from "../stores/commandHistoryStore";
import { useProjectStore } from "../stores/projectStore";
import { formatStartupInputForPty, useTerminalStore } from "../stores/terminalStore";
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_SCROLLBACK_ROWS_DEFAULT,
  useSettingsStore,
  type LightThemePalette,
  type DarkThemePalette,
} from "../stores/settingsStore";

const MIN_TERMINAL_COLS = 40;
const MIN_TERMINAL_ROWS = 8;
const SEARCH_HIGHLIGHT_LIMIT = 1000;
const IMAGE_ADDON_PIXEL_LIMIT = 4 * 1024 * 1024;
const IMAGE_ADDON_SEQUENCE_LIMIT = 8 * 1024 * 1024;
const IMAGE_ADDON_STORAGE_LIMIT_MB = 32;
const ENABLE_CLICK_CURSOR_POSITIONING = false;
const VISIBILITY_RESTORE_REVEAL_TIMEOUT_MS = 500;
// Minimum time the app must stay in the background before a foreground return
// triggers a glyph-atlas rebuild. GPU sleep / lock screen (the corruption
// trigger) implies a long absence; quick alt-tabs skip the re-rasterization.
const WEBGL_ATLAS_REFRESH_MIN_HIDDEN_MS = 10_000;
// Box-drawing glyphs used by TUI input boxes (Claude Code / Codex draw "│ > … │").
const TUI_BORDER_CHAR_PATTERN = /^[│┃║▏▎▍▌▋▊▉█┆┊╎╏]$/u;
const TUI_BORDER_PREFIX_PATTERN = /^[\s│┃║▏▎▍▌▋▊▉█┆┊╎╏]+/u;
import { toast } from "sonner";
import { logError, logInfo, logWarn } from "../lib/logger";
import { registerTerminalSnapshotSource } from "../lib/sessionSnapshotPersistence";

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
const AI_TUI_FILE_PASTE_SHORTCUT_DATA = "\x1bv";
const CODEX_IME_DEBUG_WINDOW_MS = 250;
const CODEX_IME_DUPLICATE_WINDOW_MS = 120;
const IME_PROCESS_KEY_CODE = 229;
const IME_PROCESS_KEY_RECOVERY_WINDOW_MS = 400;
const IME_COMPOSITION_END_SUPPRESS_WINDOW_MS = 80;
const IME_CROSS_SOURCE_DUPLICATE_WINDOW_MS = 80;
const NATIVE_TEXT_INPUT_DEDUP_WINDOW_MS = 16;
const CJK_NATIVE_PUNCTUATION_PATTERN = /^[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]+$/u;

type TerminalInputSource = "onData" | "nativeTextInput";

type TerminalSubsystemDisposable = IDisposable;

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

const disposeTerminalSubsystem = (disposables: TerminalSubsystemDisposable[]) => {
  for (let index = disposables.length - 1; index >= 0; index -= 1) {
    disposables[index].dispose();
  }
  disposables.length = 0;
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

const isLikelyMacPlatform = (os: OsPlatform) => (
  os === "macos" || (os === "unknown" && navigator.platform.toLowerCase().includes("mac"))
);

// When search is active, SearchAddon calls terminal.select() on each match to
// position it. A visible selection color would then cover the yellow match
// decoration, so the current match looks "selected blue" until focus leaves.
// Make the selection transparent while searching so the decoration shows.
const withVisibleSelectionTheme = (theme: ITheme, searchActive = false): ITheme => {
  if (searchActive) {
    return {
      ...theme,
      selectionBackground: "rgba(0, 0, 0, 0)",
      selectionInactiveBackground: "rgba(0, 0, 0, 0)",
    };
  }
  const isLight = isLightTerminalTheme(theme);
  return {
    ...theme,
    selectionBackground: isLight ? "rgba(37, 99, 235, 0.28)" : "rgba(56, 189, 248, 0.52)",
    selectionInactiveBackground: isLight ? "rgba(37, 99, 235, 0.18)" : "rgba(56, 189, 248, 0.34)",
  };
};

const attachClipboardImageData = async (rootPath: string, fileName: string, dataBase64: string) => (
  invoke<string>("file_attach_data", { rootPath, fileName, dataBase64 })
);

const cleanupExpiredAttachments = async (rootPath: string) => (
  invoke<number>("file_cleanup_expired_attachments", { rootPath })
);

const openHttpUrl = (sessionId: string, uri: string) => {
  if (!/^https?:\/\//i.test(uri)) return;
  void openUrl(uri).catch((err) => logError("Failed to open terminal link", { sessionId, uri, err }));
};

const openTerminalFilePath = async (sessionId: string, rawPath: string) => {
  const terminalState = useTerminalStore.getState();
  const session = terminalState.sessions.find((item) => item.id === sessionId) ?? null;
  const projectState = useProjectStore.getState();
  const currentProject = session?.projectId
    ? projectState.projects.find((item) => item.id === session.projectId) ?? null
    : findProjectByPath(projectState.projects, session?.cwd);
  const currentWorktree = session?.worktreeId
    ? projectState.worktrees.find((item) => item.id === session.worktreeId) ?? null
    : findWorktreeByPath(projectState.worktrees, session?.cwd);
  const currentRootPath = currentWorktree?.path ?? currentProject?.path ?? session?.cwd ?? null;
  const systemPath = resolveTerminalFileSystemPath(rawPath, currentRootPath);
  if (!systemPath) return;

  void invoke("open_folder_in_explorer", { path: systemPath }).catch((err) => {
    logError("Failed to open terminal file", { sessionId, path: systemPath, err });
    toast.error(translateCurrent("files.toast.openFileFailed"), { description: String(err) });
  });
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

export function XTermTerminal({ sessionId, isActive = true, isVisible = true, fontSize = 14, fontFamily = "Cascadia Code, Consolas, monospace", resolvedTheme = "dark", terminalThemeName = "auto", lightThemePalette = "warm-paper", darkThemePalette = "night-indigo", onNewTab, onCloseSession, onCloseOthers, onCloseToLeft, onCloseToRight, onSplitRight, onSplitDown }: Props) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const inputBuffer = useRef("");
  const inputCursorIndexRef = useRef(0);
  // Input owns this ref. Display may only read it to suppress fit during IME composition.
  const isComposingRef = useRef(false);
  const isActiveRef = useRef(isActive);
  // The orchestrator mirrors the visibility prop; display/viewport code reads it only.
  const isVisibleRef = useRef(isVisible);
  const lastObservedSizeRef = useRef<{ width: number; height: number } | null>(null);
  const visibilityRestorePendingRef = useRef(false);
  const visibilityRestoreRevealTimerRef = useRef<number | null>(null);
  const visibilityRestoreRevealRafRef = useRef<number | null>(null);
  const cursorShowTimerRef = useRef<number | null>(null);
  const tuiComposerNormalizeRafRef = useRef<number | null>(null);
  const displayNormalizeOutputRef = useRef<(text: string) => string>((text) => text);
  const displayTransformOutputRef = useRef<(text: string) => string>((text) => text);
  const displayAfterWriteRef = useRef<((terminal: Terminal) => void) | null>(null);
  const cleanedAttachmentRootsRef = useRef<Set<string>>(new Set());
  const terminalScrollbackCustomEnabled = useSettingsStore((s) => s.terminalScrollbackCustomEnabled);
  const terminalScrollbackRows = useSettingsStore((s) => s.terminalScrollbackRows);
  const effectiveTerminalScrollbackRows = terminalScrollbackCustomEnabled
    ? terminalScrollbackRows
    : TERMINAL_SCROLLBACK_ROWS_DEFAULT;
  const lowMemoryMode = useSettingsStore((s) => s.lowMemoryMode);
  const disableHardwareAcceleration = useSettingsStore((s) => s.disableHardwareAcceleration);
  const terminalInputSuggestionsEnabled = useSettingsStore((s) => s.terminalInputSuggestionsEnabled);
  const terminalInputSuggestionProvider = useSettingsStore((s) => s.terminalInputSuggestionProvider);

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
  const [inactiveReplayPending, setInactiveReplayPending] = useState(false);
  const [visibilityRestorePending, setVisibilityRestorePending] = useState(false);
  const [suggestionGhost, setSuggestionGhost] = useState<TerminalSuggestionGhostState | null>(null);
  const [linuxGraphicsConstrained, setLinuxGraphicsConstrained] = useState(false);
  const [linuxGraphicsDisableWebgl, setLinuxGraphicsDisableWebgl] = useState(false);
  const { menuState, menuRef, openMenu, closeContextMenu } = useTerminalContextMenu();
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
    void getLinuxGraphicsDiagnostics()
      .then((diagnostics) => {
        if (cancelled) return;
        setLinuxGraphicsConstrained(isLinuxGraphicsConstrained(diagnostics));
        setLinuxGraphicsDisableWebgl(shouldDisableTerminalWebgl(diagnostics));
      })
      .catch((err) => {
        logWarn("Failed to load Linux graphics diagnostics for terminal renderer", { sessionId, err });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

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

  const isTransparent = background.enabled && background.imagePath !== null && !hiddenForThisSession;
  const isTransparentRef = useRef(isTransparent);
  isTransparentRef.current = isTransparent;
  const terminalTheme = getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
  const isLightTerminalRef = useRef(isLightTerminalTheme(terminalTheme));
  isLightTerminalRef.current = isLightTerminalTheme(terminalTheme);
  const effectiveFontFamily = normalizeTerminalFontFamily(fontFamily);

  // Derive search decoration colors before calling useTerminalSearch
  const backgroundColor = getTerminalBackground(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
  const searchDecorationColors = {
    matchBackground: normalizeHexColor(terminalTheme.yellow, "#e0af68"),
    activeMatchBackground: normalizeHexColor(terminalTheme.blue, "#7aa2f7"),
    accent: normalizeHexColor(terminalTheme.cursor, normalizeHexColor(terminalTheme.foreground, "#d8dee9")),
  };

  const {
    searchOpen,
    searchTerm,
    searchMatched,
    searchResult,
    searchInputRef,
    handleSearchResults,
    runTerminalSearch,
    handleSearchTermChange,
    openSearch,
    closeTerminalSearch,
  } = useTerminalSearch(terminalRef, searchAddonRef, searchDecorationColors);

  const {
    attachSuggestions,
    clearSuggestion: clearSuggestionGhost,
    cancelAiSuggestionRefresh,
    scheduleSuggestionRefresh,
    updateSuggestionGhostPosition,
    acceptSuggestion,
    onCommandSubmitted,
  } = useTerminalInput({
    sessionId,
    wrapperRef,
    containerRef,
    isActiveRef,
    isVisibleRef,
    isComposingRef,
    fontSize,
    getInput: () => inputBuffer.current,
    canShowSuggestionAtCurrentInputEnd,
    getTerminalRenderedCellSize,
    setSuggestionGhost,
  });

  // Clear suggestions when search opens (must come after hook call to read searchOpen)
  useEffect(() => {
    if (terminalInputSuggestionsEnabled && !searchOpen) return;
    clearSuggestionGhost();
  }, [searchOpen, terminalInputSuggestionsEnabled]);

  useEffect(() => {
    clearSuggestionGhost();
  }, [terminalInputSuggestionProvider]);

  const {
    syncWebglRenderer,
    scheduleHiddenWebglDispose,
    clearHiddenWebglDisposeTimer,
    clearWebglTextureAtlas,
    disposeWebglRenderer,
    scheduleFit,
    scheduleViewportRefresh,
    markViewportRefreshNeeded,
    getOutputRestorePlanState,
    flushInactiveBufferForReplay,
    resumeActiveWriteQueue,
    getPendingOutputSnapshot,
    attachPtyOutput,
    resetOutputState,
    cancelScheduledFit,
    resetViewportRefreshState,
  } = useTerminalDisplay({
    sessionId,
    containerRef,
    terminalRef,
    fitAddonRef,
    isVisibleRef,
    isComposingRef,
    lowMemoryMode,
    terminalScrollbackRows: effectiveTerminalScrollbackRows,
    disableHardwareAcceleration,
    linuxGraphicsDisableWebgl,
    isTransparentRef,
    normalizeOutputRef: displayNormalizeOutputRef,
    transformOutputRef: displayTransformOutputRef,
    afterTerminalWriteRef: displayAfterWriteRef,
    onInactiveReplayPendingChange: setInactiveReplayPending,
    onPtyOutputListenError: (err) => logError("Failed to listen PTY output", { sessionId, err }),
  });

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

  const {
    normalizeTerminalOutput,
    updateSessionCwdIfChanged,
    updateTerminalColorReplies,
  } = useTerminalOsc({
    sessionId,
    osPlatformRef,
    onPtyWriteError: reportPtyWriteError,
  });
  displayNormalizeOutputRef.current = normalizeTerminalOutput;

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
  displayAfterWriteRef.current = (terminal) => {
    normalizeTuiComposerBackground(terminal);
    scheduleTuiComposerBackgroundNormalization(terminal);
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
  displayTransformOutputRef.current = processCursorVisibility;

  const clearVisibilityRestoreRevealSchedule = () => {
    if (visibilityRestoreRevealTimerRef.current !== null) {
      window.clearTimeout(visibilityRestoreRevealTimerRef.current);
      visibilityRestoreRevealTimerRef.current = null;
    }
    if (visibilityRestoreRevealRafRef.current !== null) {
      window.cancelAnimationFrame(visibilityRestoreRevealRafRef.current);
      visibilityRestoreRevealRafRef.current = null;
    }
  };

  const finishVisibilityRestoreReveal = () => {
    clearVisibilityRestoreRevealSchedule();
    if (!visibilityRestorePendingRef.current) return;
    visibilityRestorePendingRef.current = false;
    setVisibilityRestorePending(false);
  };

  const beginVisibilityRestoreReveal = () => {
    clearVisibilityRestoreRevealSchedule();
    if (!visibilityRestorePendingRef.current) {
      visibilityRestorePendingRef.current = true;
      setVisibilityRestorePending(true);
    }
    visibilityRestoreRevealTimerRef.current = window.setTimeout(() => {
      visibilityRestoreRevealTimerRef.current = null;
      finishVisibilityRestoreReveal();
    }, VISIBILITY_RESTORE_REVEAL_TIMEOUT_MS);
  };

  const handleVisibilityRestoreRender = (terminal: Terminal, range: { start: number; end: number }) => {
    if (
      !visibilityRestorePendingRef.current
      || terminalRef.current !== terminal
      || !isVisibleRef.current
      || !didRenderFullTerminalViewport(range, terminal.rows)
      || visibilityRestoreRevealRafRef.current !== null
    ) {
      return;
    }
    if (visibilityRestoreRevealTimerRef.current !== null) {
      window.clearTimeout(visibilityRestoreRevealTimerRef.current);
      visibilityRestoreRevealTimerRef.current = null;
    }
    visibilityRestoreRevealRafRef.current = window.requestAnimationFrame(() => {
      visibilityRestoreRevealRafRef.current = null;
      finishVisibilityRestoreReveal();
    });
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
    const minimumContrastRatio = getTerminalMinimumContrastRatio(baseTheme, isTransparent);
    const nextTheme = isTransparent ? applyTransparency(baseTheme, background.overlayDarken) : baseTheme;
    terminal.options.theme = withVisibleSelectionTheme(nextTheme, searchOpen);
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
    if (terminal.options.scrollback !== effectiveTerminalScrollbackRows) {
      terminal.options.scrollback = effectiveTerminalScrollbackRows;
    }
    normalizeTuiComposerBackground(terminal);
    scheduleTuiComposerBackgroundNormalization(terminal);
  }, [fontSize, effectiveFontFamily, effectiveTerminalScrollbackRows, resolvedTheme, terminalThemeName, lightThemePalette, darkThemePalette, isTransparent, background.overlayDarken, lowMemoryMode, disableHardwareAcceleration, linuxGraphicsDisableWebgl, searchOpen]);

  // Visibility drives live rendering. A pane tab is "visible" when it is the
  // shown tab in its own pane — which, in a split, includes panes that are not
  // the globally focused one. When a tab becomes visible, flush any output
  // stashed while it was hidden and refit to its current size. This keeps a
  // split's unfocused half rendering live instead of freezing until clicked.
  useEffect(() => {
    const wasVisible = isVisibleRef.current;
    isVisibleRef.current = isVisible;

    if (!isVisible) {
      finishVisibilityRestoreReveal();
      scheduleHiddenWebglDispose(lowMemoryMode || linuxGraphicsConstrained);
      return;
    }

    clearHiddenWebglDisposeTimer();
    const terminal = terminalRef.current;
    const baseTheme = getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
    const rendererRestored = terminal ? syncWebglRenderer(terminal, baseTheme) : false;
    if (rendererRestored) {
      markViewportRefreshNeeded();
    }

    if (!fitAddonRef.current || !containerRef.current) return;
    const outputRestoreState = getOutputRestorePlanState();
    const restorePlan = planTerminalVisibilityRestore({
      wasVisible,
      isVisible,
      inactiveBufferLength: outputRestoreState.inactiveBufferLength,
      activeWriteQueueLength: outputRestoreState.activeWriteQueueLength,
      activeWriteRafScheduled: outputRestoreState.activeWriteRafScheduled,
    });
    // Flush data stashed while this tab was hidden
    if (restorePlan.shouldFlushInactiveBuffer) {
      flushInactiveBufferForReplay();
    }
    if (restorePlan.shouldResumeActiveWriteQueue) {
      if (useSettingsStore.getState().debugMode) {
        logInfo("[terminal-visibility] resuming queued active writes after visibility restore", {
          sessionId,
          queuedChunks: outputRestoreState.activeWriteQueueLength,
        });
      }
      resumeActiveWriteQueue();
    }
    if (restorePlan.shouldRefreshViewport || rendererRestored) {
      beginVisibilityRestoreReveal();
    }
    if (restorePlan.shouldRefreshViewport) {
      markViewportRefreshNeeded();
    }
    // Wait for display:block to take effect and the layout to stabilize.
    // Display refresh is gated by explicit viewport-refresh state, not by every fit.
    scheduleFit(true);
    if (terminalRef.current) {
      normalizeTuiComposerBackground(terminalRef.current);
      scheduleTuiComposerBackgroundNormalization(terminalRef.current);
    }
  }, [isVisible, lowMemoryMode, disableHardwareAcceleration, linuxGraphicsConstrained, linuxGraphicsDisableWebgl, resolvedTheme, terminalThemeName, lightThemePalette, darkThemePalette]);

  // The WebGL glyph atlas can be silently corrupted while the GPU sleeps
  // (display sleep, lock screen, driver reset) without ever firing
  // `webglcontextlost` — glyphs then render as wrong/missing characters until
  // something rebuilds the atlas (e.g. a window resize). Rebuild it proactively
  // when the app returns to the foreground after a long background stretch.
  useEffect(() => {
    let backgroundedAt: number | null = null;
    const markBackgrounded = () => {
      if (backgroundedAt === null) backgroundedAt = Date.now();
    };
    const maybeRefreshAtlas = () => {
      if (backgroundedAt === null) return;
      const hiddenFor = Date.now() - backgroundedAt;
      backgroundedAt = null;
      if (hiddenFor < WEBGL_ATLAS_REFRESH_MIN_HIDDEN_MS) return;
      try {
        clearWebglTextureAtlas();
      } catch {
        // Addon may be mid-disposal; the DOM renderer fallback needs no atlas.
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") markBackgrounded();
      else maybeRefreshAtlas();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", markBackgrounded);
    window.addEventListener("focus", maybeRefreshAtlas);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", markBackgrounded);
      window.removeEventListener("focus", maybeRefreshAtlas);
    };
  }, []);

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
      scrollback: effectiveTerminalScrollbackRows,
      scrollOnEraseInDisplay: true,
      allowProposedApi: true,
      windowsPty: { backend: "conpty" },
      minimumContrastRatio: getTerminalMinimumContrastRatio(baseTheme, isTransparentRef.current),
      // xterm cannot toggle transparency after construction, so keep it enabled
      // even though WebGL is disabled while a background image is active.
      allowTransparency: true,
      theme: withVisibleSelectionTheme(isTransparentRef.current ? applyTransparency(baseTheme, background.overlayDarken) : baseTheme, false),
      // OSC 8 超链接（codex 等 CLI 输出）默认点击行为是 window.open，在 Tauri
      // webview 里会被拦成"是否导航"确认框。接管为系统默认浏览器打开，仅放行
      // http/https，避免恶意 scheme。
      linkHandler: {
        activate: (_event, uri) => openHttpUrl(sessionId, uri),
      },
    });
    const baseDisposables: TerminalSubsystemDisposable[] = [];
    const displayDisposables: TerminalSubsystemDisposable[] = [];
    const inputDisposables: TerminalSubsystemDisposable[] = [];
    // Keep Claude Code / other TUIs from overriding the app-wide thin cursor via DECSCUSR.
    baseDisposables.push(terminal.parser.registerCsiHandler({ intermediates: " ", final: "q" }, () => true));

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
    baseDisposables.push(terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const line = terminal.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true) ?? "";
        const links: ILink[] = findTerminalFileLinks(line).map((match) => ({
          range: {
            start: { x: match.startIndex + 1, y: bufferLineNumber },
            end: { x: match.endIndex, y: bufferLineNumber },
          },
          text: match.text,
          activate: () => void openTerminalFilePath(sessionId, match.text),
          decorations: { pointerCursor: true, underline: true },
        }));
        callback(links.length > 0 ? links : undefined);
      },
    }));
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(imageAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(serializeAddon);
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = "11";
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);
    // 注册定时节流落盘的快照来源：让崩溃/强杀也能恢复到最近一次落盘的画面。
    const unregisterSnapshotSource = registerTerminalSnapshotSource(sessionId, () => serializeAddon.serialize());
    baseDisposables.push(searchAddon.onDidChangeResults(handleSearchResults));

    syncWebglRenderer(terminal, baseTheme);

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
    const unregisterTerminalDropZone = registerTerminalDropZone({
      id: sessionId,
      getRect: () => {
        if (!isVisibleRef.current) return null;
        return pasteTarget.getBoundingClientRect();
      },
      paste: pasteIntoTerminal,
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
      pasteIntoTerminal(text);
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
      if (!isVisibleRef.current) return;
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
        keyboardInputSelection = null;
        selectedInputSnapshot = null;
        terminal.focus();
        closeContextMenu();
        return;
      }
      openMenu(e.clientX, e.clientY, false);
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
      const data = buildFastCursorMoveSequence(
        currentCursorIndex,
        targetCursorIndex,
        getTextCursorLength(currentInput),
        !/[\r\n]/.test(currentInput),
        terminal.modes.applicationCursorKeysMode
      );
      if (!data) {
        terminal.focus();
        return;
      }

      inputCursorIndexRef.current = targetCursorIndex;
      keyboardInputSelection = null;
      selectedInputSnapshot = null;
      clearSuggestionGhost();
      cancelAiSuggestionRefresh();
      markAttentionInputHandled();
      invoke("pty_write", { sessionId, data }).catch((err) => reportPtyWriteError("click_cursor", err));
      terminal.focus();
    };
    if (ENABLE_CLICK_CURSOR_POSITIONING) {
      contextMenuTarget.addEventListener("click", moveInputCursorToClick);
    }

    let selectedInputSnapshot: string | null = null;
    let keyboardInputSelection: {
      anchorIndex: number;
      focusIndex: number;
      inputStartCellIndex: number;
    } | null = null;

    const clearKeyboardInputSelectionOnMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      keyboardInputSelection = null;
      selectedInputSnapshot = null;
    };
    contextMenuTarget.addEventListener("mousedown", clearKeyboardInputSelectionOnMouseDown);

    // \x15 (Ctrl+U) 在 bash/PSReadLine/Claude Code 等行编辑器中的语义是"删除光标之前"，
    // 并非整行清除；光标不在行尾时（点击移光标、Shift+方向键选择后右键/Ctrl+C 复制中断）
    // 后半段会残留，随后重打的文本与残留拼接，表现为"选区删除后又多出一份"。
    // 因此清行前先按跟踪的光标位置右移到输入末尾，使 \x15 等价于整行清除。
    const buildKillCurrentInputSequence = () => {
      const currentInput = inputBuffer.current;
      const currentCursorIndex = clampTextCursorIndex(currentInput, inputCursorIndexRef.current);
      const moveToEnd = repeatControlSequence(
        "\x1b[C",
        getTextCursorLength(currentInput) - currentCursorIndex
      );
      return `${moveToEnd}\x15`;
    };

    const rewriteCurrentInput = (
      nextInput: string,
      stage: string,
      cursorIndex: number = getTextCursorLength(nextInput)
    ) => {
      const killCurrentInput = buildKillCurrentInputSequence();
      const nextCursorIndex = clampTextCursorIndex(nextInput, cursorIndex);
      const cursorRestore = repeatControlSequence(
        "\x1b[D",
        getTextCursorLength(nextInput) - nextCursorIndex
      );
      inputBuffer.current = nextInput;
      inputCursorIndexRef.current = nextCursorIndex;
      terminal.clearSelection();
      keyboardInputSelection = null;
      selectedInputSnapshot = null;
      markAttentionInputHandled();
      clearSuggestionGhost();
      cancelAiSuggestionRefresh();
      invoke("pty_write", { sessionId, data: `${killCurrentInput}${nextInput}${cursorRestore}` })
        .catch((err) => reportPtyWriteError(stage, err));
    };

    const isReplaceableInputData = (data: string) => {
      if (!data || data === "\r" || data === "\x7f" || data === "\b") return false;
      if (data.startsWith("\x1b") && !data.startsWith("\x1b[200~")) return false;
      return true;
    };

    // 返回清空当前输入所需的控制序列；null 表示本次输入不做"替换选区"。
    const consumeSelectedInputForReplacement = (data: string) => {
      if (
        !selectedInputSnapshot ||
        selectedInputSnapshot !== inputBuffer.current ||
        !terminal.hasSelection() ||
        !isReplaceableInputData(data)
      ) {
        return null;
      }

      const killCurrentInput = buildKillCurrentInputSequence();
      inputBuffer.current = "";
      inputCursorIndexRef.current = 0;
      selectedInputSnapshot = null;
      terminal.clearSelection();
      return killCurrentInput;
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
      keyboardInputSelection = null;
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

    const renderKeyboardInputSelection = (
      currentInput: string,
      selection: NonNullable<typeof keyboardInputSelection>
    ) => {
      const startIndex = Math.min(selection.anchorIndex, selection.focusIndex);
      const endIndex = Math.max(selection.anchorIndex, selection.focusIndex);
      if (startIndex === endIndex) {
        terminal.clearSelection();
        return;
      }

      const startCellIndex = selection.inputStartCellIndex
        + getTerminalCellWidth(sliceTextByCursor(currentInput, 0, startIndex));
      const selectionCellWidth = getTerminalCellWidth(sliceTextByCursor(currentInput, startIndex, endIndex));
      terminal.select(startCellIndex % terminal.cols, Math.floor(startCellIndex / terminal.cols), selectionCellWidth);
    };

    const extendKeyboardInputSelection = (direction: -1 | 1) => {
      const currentInput = inputBuffer.current;
      const currentCursorIndex = clampTextCursorIndex(currentInput, inputCursorIndexRef.current);
      const targetCursorIndex = clampTextCursorIndex(currentInput, currentCursorIndex + direction);
      if (!currentInput || targetCursorIndex === currentCursorIndex) {
        terminal.focus();
        return;
      }

      const selection = keyboardInputSelection ?? (() => {
        const buffer = terminal.buffer.active;
        const cursorCellIndex = ((buffer.baseY + buffer.cursorY) * terminal.cols) + buffer.cursorX;
        const cursorPrefixWidth = getTerminalCellWidth(sliceTextByCursor(currentInput, 0, currentCursorIndex));
        return {
          anchorIndex: currentCursorIndex,
          focusIndex: currentCursorIndex,
          inputStartCellIndex: Math.max(0, cursorCellIndex - cursorPrefixWidth),
        };
      })();

      const nextSelection = { ...selection, focusIndex: targetCursorIndex };
      keyboardInputSelection = nextSelection;
      selectedInputSnapshot = null;
      inputCursorIndexRef.current = targetCursorIndex;
      renderKeyboardInputSelection(currentInput, nextSelection);
      clearSuggestionGhost();
      cancelAiSuggestionRefresh();
      markAttentionInputHandled();
      invoke("pty_write", { sessionId, data: direction < 0 ? "\x1b[D" : "\x1b[C" })
        .catch((err) => reportPtyWriteError("keyboard_selection", err));
      terminal.focus();
    };

    const collapseKeyboardInputSelection = (direction: -1 | 1) => {
      if (!keyboardInputSelection) return false;
      const startIndex = Math.min(keyboardInputSelection.anchorIndex, keyboardInputSelection.focusIndex);
      const endIndex = Math.max(keyboardInputSelection.anchorIndex, keyboardInputSelection.focusIndex);
      if (startIndex === endIndex) {
        keyboardInputSelection = null;
        return false;
      }

      const currentCursorIndex = clampTextCursorIndex(inputBuffer.current, inputCursorIndexRef.current);
      const targetCursorIndex = direction < 0 ? startIndex : endIndex;
      const delta = targetCursorIndex - currentCursorIndex;
      const data = delta > 0
        ? repeatControlSequence("\x1b[C", delta)
        : repeatControlSequence("\x1b[D", -delta);
      keyboardInputSelection = null;
      selectedInputSnapshot = null;
      inputCursorIndexRef.current = targetCursorIndex;
      terminal.clearSelection();
      clearSuggestionGhost();
      cancelAiSuggestionRefresh();
      markAttentionInputHandled();
      if (data) {
        invoke("pty_write", { sessionId, data }).catch((err) => reportPtyWriteError("keyboard_selection_collapse", err));
      }
      terminal.focus();
      return true;
    };

    const removeSelectedInputText = () => {
      const selectedText = terminal.getSelection();
      const currentInput = inputBuffer.current;
      const findSelectedTextRange = (preferredStartIndex?: number) => {
        if (!selectedText || !currentInput) return null;
        const candidates = [
          selectedText,
          selectedText.replace(/\r\n?/g, "\n"),
          selectedText.replace(/\r\n?|\n/g, ""),
        ].filter((text, index, list) => Boolean(text) && list.indexOf(text) === index);
        const inputChars = Array.from(currentInput);

        for (const candidate of candidates) {
          const candidateChars = Array.from(candidate);
          if (!candidateChars.length || candidateChars.length > inputChars.length) continue;

          const ranges: Array<{ startIndex: number; endIndex: number }> = [];
          for (let index = 0; index <= inputChars.length - candidateChars.length; index += 1) {
            const matched = candidateChars.every((char, offset) => inputChars[index + offset] === char);
            if (matched) {
              ranges.push({ startIndex: index, endIndex: index + candidateChars.length });
            }
          }

          if (ranges.length === 1 || (ranges.length && preferredStartIndex !== undefined)) {
            return ranges.reduce((best, range) => (
              Math.abs(range.startIndex - (preferredStartIndex ?? range.startIndex)) <
              Math.abs(best.startIndex - (preferredStartIndex ?? best.startIndex))
                ? range
                : best
            ));
          }
        }

        return null;
      };
      const deleteInputRange = (startIndex: number, endIndex: number, stage: string) => {
        if (startIndex >= endIndex) return false;
        const nextInput = `${sliceTextByCursor(currentInput, 0, startIndex)}${sliceTextByCursor(currentInput, endIndex)}`;
        rewriteCurrentInput(nextInput, stage, startIndex);
        return true;
      };

      if (keyboardInputSelection && terminal.hasSelection()) {
        const startIndex = Math.min(keyboardInputSelection.anchorIndex, keyboardInputSelection.focusIndex);
        const endIndex = Math.max(keyboardInputSelection.anchorIndex, keyboardInputSelection.focusIndex);
        if (deleteInputRange(startIndex, endIndex, "keyboard_selection_delete")) return true;
      }
      keyboardInputSelection = null;

      if (terminal.hasSelection() && currentInput) {
        const selectionPosition = terminal.getSelectionPosition();
        const visibleSelection = resolveVisibleInputSelection();
        if (selectionPosition && visibleSelection) {
          const inputStartCellIndex = (visibleSelection.startRow * terminal.cols) + visibleSelection.startColumn;
          const inputEndCellIndex = inputStartCellIndex + visibleSelection.length;
          const selectionStartCellIndex = (selectionPosition.start.y * terminal.cols) + selectionPosition.start.x;
          const selectionEndCellIndex = (selectionPosition.end.y * terminal.cols) + selectionPosition.end.x;
          const selectedStartCellIndex = Math.max(inputStartCellIndex, Math.min(selectionStartCellIndex, selectionEndCellIndex));
          const selectedEndCellIndex = Math.min(inputEndCellIndex, Math.max(selectionStartCellIndex, selectionEndCellIndex));

          if (selectedEndCellIndex > selectedStartCellIndex) {
            const startIndex = resolveCursorIndexFromCellOffset(currentInput, selectedStartCellIndex - inputStartCellIndex);
            const endIndex = resolveCursorIndexFromCellOffset(currentInput, selectedEndCellIndex - inputStartCellIndex);
            const textRange = findSelectedTextRange(startIndex);
            if (textRange && deleteInputRange(textRange.startIndex, textRange.endIndex, "selection_delete_text")) {
              return true;
            }
            if (deleteInputRange(startIndex, endIndex, "selection_delete")) return true;
          }
        }

        const textRange = findSelectedTextRange();
        if (textRange && deleteInputRange(textRange.startIndex, textRange.endIndex, "selection_delete_text")) {
          return true;
        }
      }

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

      const textRange = findSelectedTextRange();
      if (!textRange) return false;
      return deleteInputRange(textRange.startIndex, textRange.endIndex, "selection_delete_text");
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
        e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        e.preventDefault();
        extendKeyboardInputSelection(e.key === "ArrowLeft" ? -1 : 1);
        return false;
      }

      if (
        e.type === "keydown" &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        collapseKeyboardInputSelection(e.key === "ArrowLeft" ? -1 : 1)
      ) {
        e.preventDefault();
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
        if (acceptSuggestion()) {
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
        if (acceptSuggestion()) {
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
        if (acceptSuggestion()) {
          e.preventDefault();
          return false;
        }
      }
      if (e.type === "keydown" && isClaudeOrCodexSession()) {
        const shortcut = useSettingsStore.getState().keyboardShortcuts.pasteFileToAiTui;
        if (terminalShortcutMatches(e, shortcut)) {
          e.preventDefault();
          markAttentionInputHandled();
          invoke("pty_write", { sessionId, data: AI_TUI_FILE_PASTE_SHORTCUT_DATA })
            .catch((err) => reportPtyWriteError("ai_file_paste_shortcut", err));
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
      if (e.type === "keydown" && e.key.toLowerCase() === "c" && !e.shiftKey && !e.altKey) {
        const copyAndClearSelection = () => {
          void copySelection();
          terminal.clearSelection();
          keyboardInputSelection = null;
          selectedInputSnapshot = null;
        };
        const sendInterrupt = () => {
          markAttentionInputHandled();
          keyboardInputSelection = null;
          selectedInputSnapshot = null;
          invoke("pty_write", { sessionId, data: "\x03" }).catch((err) => reportPtyWriteError("interrupt", err));
        };
        const isMacCopy = isMacSelectAll && e.metaKey && !e.ctrlKey;
        const isPlainCtrlC = e.ctrlKey && !e.metaKey;

        if (isMacCopy && terminal.hasSelection()) {
          e.preventDefault();
          copyAndClearSelection();
          return false;
        }
        if (isPlainCtrlC) {
          e.preventDefault();
          if (!isMacSelectAll && terminal.hasSelection()) {
            copyAndClearSelection();
          } else {
            sendInterrupt();
          }
          return false;
        }
      }
      if (e.type !== "keydown" || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return true;
      const key = e.key.toLowerCase();
      if (key === "f") {
        e.preventDefault();
        openSearch();
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
          onCommandSubmitted(cmd.trim());
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
          cancelAiSuggestionRefresh();
          clearSuggestionGhost();
        }
      } else {
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
      keyboardInputSelection = null;
      const inputBufferBefore = inputBuffer.current;
      const manualDirectCodexOverride = resolveManualDirectCodexEnterData({
        data,
        inputBuffer: inputBufferBefore,
        os: osPlatformRef.current,
      });
      const ptyData = manualDirectCodexOverride ?? data;
      lastForwardedTerminalInput = { data, source, at: now };
      invoke("pty_write", { sessionId, data: replacingSelectedInput ? `${replacingSelectedInput}${ptyData}` : ptyData }).catch((err) => reportPtyWriteError(source, err));
      maybeLogCodexImeDuplicate(data);
      updateInputBufferFromTerminalData(data);
    }

    const detachInputSuggestions = attachSuggestions(terminal, (data) => {
      forwardTerminalInput(data, "onData");
    });

    // Contract: terminal.onData is input direction and belongs to the input subsystem.
    inputDisposables.push(terminal.onData((data) => {
      forwardTerminalInput(data, "onData");
    }));

    // Sync resize to PTY
    displayDisposables.push(terminal.onResize(({ cols, rows }) => {
      if (cols < MIN_TERMINAL_COLS || rows < MIN_TERMINAL_ROWS) return;
      invoke("pty_resize", { sessionId, cols, rows }).catch((err) => {
        logError("PTY resize failed in XTermTerminal", { sessionId, cols, rows, err });
      });
    }));

    const detachPtyOutput = attachPtyOutput();
    let cancelled = false;

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
    inputDisposables.push(terminal.onCursorMove(() => {
      if (!isActiveRef.current) return;
      if (isComposingRef.current) {
        clearSuggestionGhost();
        scheduleCompositionScrollRestore();
        scheduleCompositionAnchorFix();
        return;
      }
      updateSuggestionGhostPosition();
      if (!textarea || document.activeElement !== textarea) return;
      scheduleTerminalContainerScrollReset();
      scheduleHelperTextareaAnchorPin();
    }));
    displayDisposables.push(terminal.onRender((range) => {
      handleVisibilityRestoreRender(terminal, range);
      scheduleTuiComposerBackgroundNormalization(terminal);
      if (!isComposingRef.current) {
        updateSuggestionGhostPosition();
        return;
      }
      clearSuggestionGhost();
      scheduleCompositionScrollRestore();
      scheduleCompositionAnchorFix();
    }));

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
      detachInputSuggestions();
      cancelPendingCursorShow();
      pasteTarget.removeEventListener("paste", onPaste, pasteListenerOptions);
      unregisterTerminalDropZone();
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
      fileDropCancelled = true;
      unlistenFileDrop?.();
      contextMenuTarget.removeEventListener("contextmenu", onContextMenu);
      if (ENABLE_CLICK_CURSOR_POSITIONING) {
        contextMenuTarget.removeEventListener("click", moveInputCursorToClick);
      }
      contextMenuTarget.removeEventListener("mousedown", clearKeyboardInputSelectionOnMouseDown);
      terminalContainer.removeEventListener("keydown", onImeProcessKeyDown, nativeTextInputListenerOptions);
      terminalContainer.removeEventListener("beforeinput", onNativeTextBeforeInput, nativeTextInputListenerOptions);
      terminalContainer.removeEventListener("input", onNativeTextInput, nativeTextInputListenerOptions);
      textarea?.removeEventListener("compositionstart", onCompositionStart);
      textarea?.removeEventListener("compositionupdate", onCompositionUpdate);
      textarea?.removeEventListener("compositionend", onCompositionEnd);
      terminalContainer.removeEventListener("scroll", scheduleTerminalContainerScrollReset);
      disposeTerminalSubsystem(inputDisposables);
      disposeTerminalSubsystem(displayDisposables);
      wheelTarget.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      resizeObserver.disconnect();
      cancelScheduledFit();
      if (compositionScrollRafId !== null) {
        cancelAnimationFrame(compositionScrollRafId);
        compositionScrollRafId = null;
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
      try {
        const serializedOutput = serializeAddon.serialize();
        const pendingOutput = getPendingOutputSnapshot();
        useTerminalStore.getState().updateSessionTerminalSnapshot(sessionId, `${serializedOutput}${pendingOutput}`);
      } catch (err) {
        logError("Failed to snapshot terminal buffer before dispose", { sessionId, err });
      }
      if (tuiComposerNormalizeRafRef.current !== null) {
        cancelAnimationFrame(tuiComposerNormalizeRafRef.current);
        tuiComposerNormalizeRafRef.current = null;
      }
      detachPtyOutput();
      resetOutputState();
      clearHiddenWebglDisposeTimer();
      clearVisibilityRestoreRevealSchedule();
      visibilityRestorePendingRef.current = false;
      resetViewportRefreshState();
      unregisterSnapshotSource();
      disposeTerminalSubsystem(baseDisposables);
      disposeWebglRenderer();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [sessionId]);

  const backgroundOverlayColor = getTerminalBackgroundOverlayColor(terminalTheme);
  const showBackgroundImage = isTransparent && assetUrl !== null;
  updateTerminalColorReplies({
    foreground: normalizeHexColor(terminalTheme.foreground, "#d8dee9"),
    background: normalizeHexColor(terminalTheme.background, backgroundColor),
  });
  const searchForeground = normalizeHexColor(terminalTheme.foreground, "#d8dee9");
  const searchBackground = normalizeHexColor(terminalTheme.background, backgroundColor);
  const searchAccent = normalizeHexColor(terminalTheme.cursor, searchForeground);
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
  const visibilityRestoreStarting = isVisible && !isVisibleRef.current;
  const terminalContainerStyle: CSSProperties | undefined = inactiveReplayPending || visibilityRestorePending || visibilityRestoreStarting
    ? { visibility: "hidden" }
    : undefined;

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
      {terminalInputSuggestionsEnabled && isActive && isVisible && !searchOpen && suggestionGhost && (
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
