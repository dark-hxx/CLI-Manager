import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type WheelEvent as ReactWheelEvent } from "react";
import {
  Terminal,
  type IBufferLine,
  type IBufferRange,
  type IDisposable,
  type ILink,
  type ITheme,
  type IViewportRange,
} from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useShallow } from "zustand/shallow";
import {
  applyTransparency,
  getTerminalBackground,
  getTerminalBackgroundOverlayColor,
  getTerminalMinimumContrastRatio,
  getTerminalTheme,
  isLightTerminalTheme,
  withTerminalTextColor,
} from "../lib/terminalThemes";
import { backgroundAssetUrl } from "../lib/assetUrl";
import { translateCurrent, useI18n } from "../lib/i18n";
import { normalizeTerminalFontFamily } from "../lib/terminalFontFamily";
import { canUseTerminalImageAddonWasm } from "../lib/terminalImageAddonSupport";
import {
  findTerminalFileLinks,
  findTerminalRelativeFileLinks,
  normalizeTerminalRelativePath,
  resolveTerminalFileSystemPath,
  terminalStringRangeToBufferColumns,
  type TerminalFileLinkMatch,
} from "../lib/terminalFileLinks";
import { requestTerminalFileNavigation } from "../lib/terminalFileNavigation";
import { findProjectByPath, findWorktreeByPath } from "../lib/terminalProject";
import { projectSupportsCapability } from "../lib/projectCapabilities";
import { useTerminalSearch } from "../hooks/useTerminalSearch";
import { useTerminalContextMenu } from "../hooks/useTerminalContextMenu";
import { useTerminalOsc } from "../hooks/useTerminalOsc";
import { useTerminalDisplay } from "../hooks/useTerminalDisplay";
import { useTerminalInput, type TerminalSuggestionGhostState } from "../hooks/useTerminalInput";
import { getTerminalCellWidth } from "../lib/terminalCellWidth";
import { resolveClaudeImeCompositionAnchor } from "../lib/terminalImeAnchor";
import { copyTextToClipboard, readTextFromClipboard } from "../lib/systemClipboard";
import { formatOsc52Reply } from "../lib/terminalOscParse";
import { eventToCombo } from "../hooks/useKeyboardShortcuts";
import { hasCodexTuiViewport, hasTuiComposerPromptViewport } from "../lib/terminalTuiDisplay";
import { createTerminalTuiColorSyncController } from "../lib/terminalTuiColorSync";
import { hexToRgba, normalizeHexColor } from "../lib/terminalColor";
import { wrapTerminalPasteTextForCtrlShiftV } from "../lib/terminalKeyboard";
import {
  didRenderFullTerminalViewport,
  refreshTerminalViewport,
} from "../lib/terminalVisibility";
import {
  getLinuxGraphicsDiagnostics,
  isLinuxGraphicsConstrained,
  shouldDisableTerminalWebgl,
} from "../lib/linuxGraphics";
import { getOsPlatform, normalizeShellKey, type OsPlatform } from "../lib/shell";
import { Portal } from "./ui/Portal";
import { FontSizeControl, useFontSizeControlVisibility } from "./ui/FontSizeControl";
import { useProjectStore } from "../stores/projectStore";
import { formatStartupInputForPty, useTerminalStore } from "../stores/terminalStore";
import {
  ArrowDown,
  Eye,
  EyeOff,
} from "./icons";
import {
  isTerminalMarkdownPreviewSupported,
  TerminalMarkdownPreview,
} from "./terminal/TerminalMarkdownPreview";
import {
  createTerminalCliContext,
  isClaudeTerminalContext,
  isCodexTerminalContext,
  isGrokLaunchCommand,
  isGrokRuntimeContext,
  isGrokTerminalContext,
  isOpenCodeTerminalContext,
} from "../terminal/browser/TerminalCliContext";
import { createTerminalMouseInteractionOptions } from "../terminal/browser/TerminalMouseInteraction";
import { resolveTerminalNewlineKeyEvent } from "../terminal/browser/TerminalNewlineShortcut";
import { attachOpenCodeTuiClipboard } from "../terminal/browser/OpenCodeTuiClipboard";
import {
  createPiTerminalCompatibility,
  type PiTerminalCompatibility,
} from "../terminal/browser/TerminalPiCompatibility";
import { shouldReflowTerminalCursorLine } from "../terminal/browser/TerminalReflowPolicy";
import { terminalProcessManager } from "../terminal/core/TerminalProcessManager";
import type { TerminalProcessTraits } from "../terminal/transport/PtyHostSocket";
import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_SCROLLBACK_ROWS_DEFAULT,
  useSettingsStore,
  type LightThemePalette,
  type DarkThemePalette,
} from "../stores/settingsStore";

const SEARCH_HIGHLIGHT_LIMIT = 1000;
const IMAGE_ADDON_PIXEL_LIMIT = 4 * 1024 * 1024;
const IMAGE_ADDON_SEQUENCE_LIMIT = 8 * 1024 * 1024;
const IMAGE_ADDON_STORAGE_LIMIT_MB = 32;
const VISIBILITY_RESTORE_REVEAL_TIMEOUT_MS = 500;
// ponytail: fixed ceiling bounds untrusted OSC 52 bursts; add per-session rate limiting only if legitimate bursts need it.
const OSC52_MAX_PENDING_CLIPBOARD_ACTIONS = 32;
const CODEX_OUTPUT_SIGNATURE_PATTERN = /(?:openai\s+codex|\/model\s+to\s+change)/i;
const ANSI_CSI_SEQUENCE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
let terminalImageAddonFallbackLogged = false;
// Minimum time the app must stay in the background before a foreground return
// triggers a glyph-atlas rebuild. GPU sleep / lock screen (the corruption
// trigger) implies a long absence; quick alt-tabs skip the re-rasterization.
const WEBGL_ATLAS_REFRESH_MIN_HIDDEN_MS = 10_000;
import { toast } from "sonner";
import { logError, logInfo, logWarn } from "../lib/logger";
import { registerTerminalSnapshotSource } from "../lib/sessionSnapshotPersistence";

const CODEX_IME_DEBUG_WINDOW_MS = 250;
const CODEX_IME_DUPLICATE_WINDOW_MS = 120;
type TerminalSubsystemDisposable = IDisposable;

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

type TerminalLinkIconKind = "link" | "file" | "directory" | "relative-file" | "relative-directory";
type TerminalPathKind = "file" | "directory" | "missing";

interface TerminalLinkHoverIcon extends IDisposable {
  hide(): void;
  showBufferRange(kind: TerminalLinkIconKind, range: IBufferRange): void;
  showViewportRange(kind: TerminalLinkIconKind, range: IViewportRange): void;
}

const createTerminalLinkHoverIcon = (
  terminal: Terminal,
  terminalContainer: HTMLElement,
  fallbackFontSize: number,
): TerminalLinkHoverIcon => {
  const element = document.createElement("div");
  element.className = "terminal-link-hover-icon xterm-hover";
  element.setAttribute("aria-hidden", "true");
  element.hidden = true;
  terminal.element?.appendChild(element);

  const showAt = (kind: TerminalLinkIconKind, x: number, y: number) => {
    const terminalElement = terminal.element;
    const screen = terminalElement?.querySelector<HTMLElement>(".xterm-screen");
    if (!terminalElement || !screen || y < 0 || y >= terminal.rows) {
      element.hidden = true;
      return;
    }

    const terminalRect = terminalElement.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const cell = getTerminalRenderedCellSize(terminal, terminalContainer, fallbackFontSize);
    const left = screenRect.left - terminalRect.left + x * cell.width - 10;
    const top = screenRect.top - terminalRect.top + y * cell.height - 8;
    element.dataset.kind = kind;
    element.style.setProperty("--terminal-link-icon-fg", terminal.options.theme?.foreground ?? "#d8dee9");
    element.style.setProperty("--terminal-link-icon-bg", terminal.options.theme?.background ?? "#111827");
    element.style.transform = `translate3d(${Math.max(2, left)}px, ${Math.max(2, top)}px, 0)`;
    element.hidden = false;
  };

  return {
    hide: () => {
      element.hidden = true;
    },
    showBufferRange: (kind, range) => {
      showAt(
        kind,
        range.start.x - 1,
        range.start.y - terminal.buffer.active.viewportY - 1,
      );
    },
    showViewportRange: (kind, range) => {
      showAt(kind, range.start.x, range.start.y);
    },
    dispose: () => {
      element.remove();
    },
  };
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

let expiredAttachmentsCleanup: Promise<number> | null = null;

const cleanupExpiredAttachmentsOnce = () => {
  if (expiredAttachmentsCleanup) return expiredAttachmentsCleanup;
  expiredAttachmentsCleanup = invoke<number>("file_cleanup_expired_attachments").catch((err) => {
    expiredAttachmentsCleanup = null;
    throw err;
  });
  return expiredAttachmentsCleanup;
};

const openHttpUrl = (sessionId: string, uri: string) => {
  if (!/^https?:\/\//i.test(uri)) return;
  void openUrl(uri).catch((err) => logError("Failed to open terminal link", { sessionId, uri, err }));
};

const getTerminalFileLinkContext = (sessionId: string, rawPath: string) => {
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
  return {
    supportsFiles: projectSupportsCapability(currentProject, "files"),
    rootPath: currentRootPath,
    systemPath: resolveTerminalFileSystemPath(rawPath, currentRootPath),
  };
};

const resolveRelativeTerminalSystemPath = (rootPath: string, relativePath: string) => (
  `${rootPath.replace(/[\\/]+$/u, "")}\\${relativePath.replace(/\//g, "\\")}`
);

const openTerminalFilePath = async (sessionId: string, rawPath: string) => {
  const context = getTerminalFileLinkContext(sessionId, rawPath);
  if (!context.supportsFiles) {
    toast.info(translateCurrent("remoteCapabilities.unsupportedTitle"), {
      description: translateCurrent("remoteCapabilities.unsupportedDescription"),
    });
    return;
  }
  if (!context.systemPath) return;

  void invoke("open_folder_in_explorer", { path: context.systemPath }).catch((err) => {
    logError("Failed to open terminal file", { sessionId, path: context.systemPath, err });
    toast.error(translateCurrent("files.toast.openFileFailed"), { description: String(err) });
  });
};

const openTerminalRelativeFilePath = async (sessionId: string, match: TerminalFileLinkMatch) => {
  if (!useSettingsStore.getState().terminalToolbarVisibility.files) return;
  const context = getTerminalFileLinkContext(sessionId, match.path);
  const relativePath = normalizeTerminalRelativePath(match.path);
  if (!context.supportsFiles || !context.rootPath || !relativePath) return;

  try {
    const kind = await invoke<TerminalPathKind>("file_get_path_kind", {
      path: resolveRelativeTerminalSystemPath(context.rootPath, relativePath),
    });
    if (kind !== "file" && kind !== "directory") return;
    requestTerminalFileNavigation({
      sessionId,
      path: relativePath,
      kind,
      ...(match.lineNumber ? { lineNumber: match.lineNumber } : {}),
      ...(match.columnNumber ? { columnNumber: match.columnNumber } : {}),
    });
  } catch {
    // 路径不存在、权限不足或会话已关闭时不产生终端噪声。
  }
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
  const snapshotBeforeUnmountRef = useRef<(() => void) | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const isActiveRef = useRef(isActive);
  // The orchestrator mirrors the visibility prop; display/viewport code reads it only.
  const isVisibleRef = useRef(isVisible);
  const visibilityRestorePendingRef = useRef(false);
  const visibilityRestoreRevealTimerRef = useRef<number | null>(null);
  const visibilityRestoreRevealRafRef = useRef<number | null>(null);
  const visibilityRestoreFallbackRafRef = useRef<number | null>(null);
  const codexCursorShowTimerRef = useRef<number | null>(null);
  const codexSessionDetectedRef = useRef(false);
  const grokSessionDetectedRef = useRef(false);
  const osc52ClipboardChainRef = useRef(Promise.resolve());
  const osc52ClipboardPendingRef = useRef(0);
  const displayNormalizeOutputRef = useRef<(text: string) => string>((text) => text);
  const displayTransformOutputRef = useRef<(text: string) => string>((text) => text);
  const displayAfterWriteRef = useRef<((terminal: Terminal) => void) | null>(null);
  const piTerminalCompatibilityRef = useRef<PiTerminalCompatibility | null>(null);
  const terminalScrollbackCustomEnabled = useSettingsStore((s) => s.terminalScrollbackCustomEnabled);
  const terminalScrollbackRows = useSettingsStore((s) => s.terminalScrollbackRows);
  const updateSettings = useSettingsStore((s) => s.update);
  const effectiveTerminalScrollbackRows = terminalScrollbackCustomEnabled
    ? terminalScrollbackRows
    : TERMINAL_SCROLLBACK_ROWS_DEFAULT;
  const lowMemoryMode = useSettingsStore((s) => s.lowMemoryMode);
  const disableHardwareAcceleration = useSettingsStore((s) => s.disableHardwareAcceleration);
  const terminalInputSuggestionsEnabled = useSettingsStore((s) => s.terminalInputSuggestionsEnabled);
  const terminalInputSuggestionProvider = useSettingsStore((s) => s.terminalInputSuggestionProvider);
  const hideCodexRuntimeCursor = useSettingsStore((s) => s.hideCodexRuntimeCursor);
  const hideCodexRuntimeCursorRef = useRef(hideCodexRuntimeCursor);
  hideCodexRuntimeCursorRef.current = hideCodexRuntimeCursor;
  const terminalTextColor = useSettingsStore((s) => s.terminalTextColor);
  const terminalTuiUserColor = useSettingsStore((s) => s.terminalTuiUserColor);
  const terminalTuiAssistantColor = useSettingsStore((s) => s.terminalTuiAssistantColor);
  const terminalTextColorRef = useRef(terminalTextColor);
  const terminalTuiUserColorRef = useRef(terminalTuiUserColor);
  const terminalTuiAssistantColorRef = useRef(terminalTuiAssistantColor);
  terminalTextColorRef.current = terminalTextColor;
  terminalTuiUserColorRef.current = terminalTuiUserColor;
  terminalTuiAssistantColorRef.current = terminalTuiAssistantColor;

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
  const terminalSession = useTerminalStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const terminalSessionStatus = useTerminalStore((state) => state.sessionStatuses[sessionId] ?? null);
  const terminalProject = useProjectStore((state) => (
    terminalSession?.projectId
      ? state.projects.find((item) => item.id === terminalSession.projectId) ?? null
      : null
  ));
  const markdownPreviewSupported = isTerminalMarkdownPreviewSupported(terminalSession, terminalProject);
  const markdownPreviewButtonVisible = Boolean(
    terminalSession?.isAgentSession
    || terminalSession?.cliTool?.trim()
    || terminalProject?.cli_tool?.trim(),
  );
  const markdownPreviewCanOpen = markdownPreviewSupported
    && Boolean(terminalSession?.cliSessionId?.trim());

  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [visibilityRestorePending, setVisibilityRestorePending] = useState(false);
  const [suggestionGhost, setSuggestionGhost] = useState<TerminalSuggestionGhostState | null>(null);
  const [isScrolledAwayFromBottom, setIsScrolledAwayFromBottom] = useState(false);
  const { fontSizeControlVisible, showFontSizeControl } = useFontSizeControlVisibility();
  const [linuxGraphicsConstrained, setLinuxGraphicsConstrained] = useState(false);
  const [linuxGraphicsDisableWebgl, setLinuxGraphicsDisableWebgl] = useState(false);
  const [markdownPreviewOpen, setMarkdownPreviewOpen] = useState(false);
  const [markdownPreviewRatio, setMarkdownPreviewRatio] = useState(0.5);
  const markdownPreviewDragCleanupRef = useRef<(() => void) | null>(null);
  const { menuState, menuRef, openMenu, closeContextMenu } = useTerminalContextMenu();
  const osPlatformRef = useRef<OsPlatform>("unknown");
  const codexImeDebugRef = useRef<CodexImeDebugState>({
    compositionEndAt: -1,
    compositionEndSummary: null,
    lastNearCompositionFingerprint: null,
    lastNearCompositionAt: -1,
  });

  useLayoutEffect(() => () => {
    snapshotBeforeUnmountRef.current?.();
    snapshotBeforeUnmountRef.current = null;
  }, [sessionId]);

  const getOsPlatformForPathQuoting = async () => {
    if (osPlatformRef.current !== "unknown") return osPlatformRef.current;
    const platform = await getOsPlatform();
    osPlatformRef.current = platform;
    return platform;
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
  const terminalTheme = withTerminalTextColor(
    getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette),
    terminalTextColor,
  );
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
    isComposingRef,
    attachInputForwarding,
    clearSuggestion: clearSuggestionGhost,
    acceptSuggestion,
    attachPasteAndDrop,
    pasteText,
    readClipboardPasteText,
    attachSelection,
    attachIme,
    onCommandSubmitted,
  } = useTerminalInput({
    sessionId,
    wrapperRef,
    containerRef,
    isActiveRef,
    isVisibleRef,
    fontSize,
    canShowSuggestionAtCurrentInputEnd,
    getTerminalRenderedCellSize,
    setSuggestionGhost,
    getOsPlatformForPathQuoting,
  });

  // Clear suggestions when search opens (must come after hook call to read searchOpen)
  useEffect(() => {
    if (terminalInputSuggestionsEnabled && !searchOpen) return;
    clearSuggestionGhost();
  }, [searchOpen, terminalInputSuggestionsEnabled]);

  useEffect(() => {
    clearSuggestionGhost();
  }, [terminalInputSuggestionProvider]);

  useEffect(() => () => {
    markdownPreviewDragCleanupRef.current?.();
    markdownPreviewDragCleanupRef.current = null;
  }, []);

  useEffect(() => {
    if (!markdownPreviewOpen) return;
    const frame = window.requestAnimationFrame(() => fitAddonRef.current?.fit());
    return () => window.cancelAnimationFrame(frame);
  }, [markdownPreviewOpen, markdownPreviewRatio]);

  const handleMarkdownPreviewResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    markdownPreviewDragCleanupRef.current?.();
    const startX = event.clientX;
    const startRatio = markdownPreviewRatio;
    let frame: number | null = null;
    let pendingRatio: number | null = null;

    const updateRatio = (clientX: number) => {
      const width = wrapper.getBoundingClientRect().width;
      if (width <= 0) return;
      const next = Math.min(0.68, Math.max(0.28, startRatio + (startX - clientX) / width));
      pendingRatio = next;
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (pendingRatio !== null) setMarkdownPreviewRatio(pendingRatio);
      });
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      updateRatio(moveEvent.clientX);
    };
    const finish = () => {
      if (pendingRatio !== null) setMarkdownPreviewRatio(pendingRatio);
      cleanup();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cleanup);
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      markdownPreviewDragCleanupRef.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cleanup);
    markdownPreviewDragCleanupRef.current = cleanup;
  }, [markdownPreviewRatio]);

  const getSessionToolContext = useCallback(() => {
    const session = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
    const project = session?.projectId
      ? useProjectStore.getState().projects.find((item) => item.id === session.projectId)
      : null;
    return createTerminalCliContext(session, project);
  }, [sessionId]);
  const tuiColorSync = useMemo(
    () => createTerminalTuiColorSyncController(() => ({
      getContext: getSessionToolContext,
      isVisible: isVisibleRef.current,
      isTransparent: isTransparentRef.current,
      isLightTheme: isLightTerminalRef.current,
      terminalTextColor: terminalTextColorRef.current,
      tuiUserColor: terminalTuiUserColorRef.current,
      tuiAssistantColor: terminalTuiAssistantColorRef.current,
    })),
    [getSessionToolContext],
  );
  if (piTerminalCompatibilityRef.current?.sessionId !== sessionId) {
    piTerminalCompatibilityRef.current = createPiTerminalCompatibility(
      sessionId,
      (message, payload) => logInfo(message, payload),
    );
  }
  piTerminalCompatibilityRef.current.updateContext(getSessionToolContext());

  const {
    syncWebglRenderer,
    scheduleHiddenWebglDispose,
    clearHiddenWebglDisposeTimer,
    clearWebglTextureAtlas,
    disposeWebglRenderer,
    scheduleFit,
    scheduleViewportRefresh,
    markViewportRefreshNeeded,
    enqueueActiveWrite,
    attachPtyOutput,
    attachViewport,
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
    disableHardwareAcceleration,
    linuxGraphicsDisableWebgl,
    isTransparentRef,
    normalizeOutputRef: displayNormalizeOutputRef,
    transformOutputRef: displayTransformOutputRef,
    afterTerminalWriteRef: displayAfterWriteRef,
    outputDiagnosticsRef: piTerminalCompatibilityRef,
    onPtyOutputListenError: (err) => logError("Failed to listen PTY output", { sessionId, err }),
  });

  useEffect(() => {
    void cleanupExpiredAttachmentsOnce().catch((err) => {
      logError("Failed to cleanup expired terminal attachments", { sessionId, err });
    });
  }, [sessionId]);

  const getPtyWriteErrorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const isRecoverablePtyHostDisconnect = (message: string): boolean =>
    message.startsWith("PtyHost WebSocket disconnected") || message.startsWith("PtyHost heartbeat timed out");

  const reportPtyWriteError = (stage: string, err: unknown) => {
    const message = getPtyWriteErrorMessage(err);
    if (isRecoverablePtyHostDisconnect(message)) {
      toast.warning(t("terminal.transport.connectionLostTitle"), {
        description: t("terminal.transport.connectionLostDescription"),
      });
      logWarn("PTY write failed because transport disconnected", { sessionId, stage, err });
      return;
    }
    toast.error(t("terminal.transport.writeFailed"), { description: message });
    logError("PTY write failed in XTermTerminal", { sessionId, stage, err });
  };

  const queueOsc52ClipboardAction = (
    action: () => Promise<void> | void,
    onError?: (err: unknown) => void,
  ) => {
    if (osc52ClipboardPendingRef.current >= OSC52_MAX_PENDING_CLIPBOARD_ACTIONS) return;
    osc52ClipboardPendingRef.current += 1;
    osc52ClipboardChainRef.current = osc52ClipboardChainRef.current
      .catch(() => undefined)
      .then(action)
      .catch((err) => onError?.(err))
      .finally(() => {
        osc52ClipboardPendingRef.current -= 1;
      });
  };

  const {
    normalizeTerminalOutput,
    updateSessionCwdIfChanged,
  } = useTerminalOsc({
    sessionId,
    osPlatformRef,
    onOsc52Write: (text) => {
      if (!useSettingsStore.getState().osc52ClipboardEnabled) return;
      queueOsc52ClipboardAction(() => {
        if (!useSettingsStore.getState().osc52ClipboardEnabled) return;
        return copyTextToClipboard(text);
      });
    },
    onOsc52Query: (selection) => {
      if (!useSettingsStore.getState().osc52ClipboardQueryEnabled) return;
      queueOsc52ClipboardAction(async () => {
        if (!useSettingsStore.getState().osc52ClipboardQueryEnabled) return;
        const text = await readTextFromClipboard();
        if (!useSettingsStore.getState().osc52ClipboardQueryEnabled) return;
        const reply = formatOsc52Reply(text, selection || "c");
        if (reply === null) return;
        await terminalProcessManager.write(sessionId, reply);
      }, (err) => {
        logError("Failed to answer OSC 52 clipboard query", { sessionId, err });
      });
    },
  });
  displayNormalizeOutputRef.current = normalizeTerminalOutput;

  const isCodexSession = (
    context = getSessionToolContext(),
    runtimeTerminal?: Terminal,
  ) => {
    const detected = (
      isCodexTerminalContext(context)
      || codexSessionDetectedRef.current
      || (runtimeTerminal !== undefined && hasCodexTuiViewport(runtimeTerminal))
    );
    if (detected) codexSessionDetectedRef.current = true;
    return detected;
  };
  const isGrokSession = (
    context = getSessionToolContext(),
    runtimeTerminal?: Terminal,
  ) => {
    const stableDetected = isGrokTerminalContext(context);
    const hasVisibleTuiPrompt = runtimeTerminal !== undefined
      && hasTuiComposerPromptViewport(runtimeTerminal);
    const detected = isGrokRuntimeContext(context, {
      manualLaunchDetected: grokSessionDetectedRef.current,
      hasVisibleTuiPrompt,
    });
    if (
      !stableDetected
      && grokSessionDetectedRef.current
      && runtimeTerminal !== undefined
      && !hasVisibleTuiPrompt
    ) {
      grokSessionDetectedRef.current = false;
    }
    return detected;
  };
  const shouldHideCodexCursor = (runtimeTerminal = terminalRef.current) => (
    hideCodexRuntimeCursorRef.current
    && runtimeTerminal !== null
    && isCodexSession(undefined, runtimeTerminal)
  );
  const cancelPendingCodexCursorShow = () => {
    if (codexCursorShowTimerRef.current !== null) {
      window.clearTimeout(codexCursorShowTimerRef.current);
      codexCursorShowTimerRef.current = null;
    }
  };
  const scheduleCodexCursorShow = () => {
    cancelPendingCodexCursorShow();
    codexCursorShowTimerRef.current = window.setTimeout(() => {
      codexCursorShowTimerRef.current = null;
      terminalRef.current?.write("\x1b[?25h");
    }, 80);
  };
  const processCodexCursorVisibility = (text: string) => {
    const plainText = text.replace(ANSI_CSI_SEQUENCE_PATTERN, "");
    if (CODEX_OUTPUT_SIGNATURE_PATTERN.test(plainText)) {
      codexSessionDetectedRef.current = true;
    }
    if (!shouldHideCodexCursor()) return text;
    const cursorPattern = /\x1b\[\?25[hl]/g;
    let processed = "";
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = cursorPattern.exec(text)) !== null) {
      processed += text.slice(lastIndex, match.index);
      if (match[0].endsWith("l")) {
        cancelPendingCodexCursorShow();
        processed += match[0];
      } else {
        scheduleCodexCursorShow();
      }
      lastIndex = match.index + match[0].length;
    }

    return processed + text.slice(lastIndex);
  };
  displayAfterWriteRef.current = (terminal) => {
    if (!isVisibleRef.current) return;
    tuiColorSync.normalize(terminal);
    tuiColorSync.schedule(terminal);
  };

  displayTransformOutputRef.current = (text) => processCodexCursorVisibility(
    piTerminalCompatibilityRef.current?.transformOutput(text) ?? text,
  );

  const applyCodexCursorVisibility = (terminal: Terminal) => {
    cancelPendingCodexCursorShow();
    terminal.write(shouldHideCodexCursor(terminal) ? "\x1b[?25l" : "\x1b[?25h");
  };
  const focusTerminalWithCodexCursorPolicy = (terminal: Terminal) => {
    terminal.focus();
    if (shouldHideCodexCursor(terminal)) terminal.write("\x1b[?25l");
  };

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    applyCodexCursorVisibility(terminal);
  }, [hideCodexRuntimeCursor, sessionId]);

  const clearVisibilityRestoreRevealSchedule = () => {
    if (visibilityRestoreRevealTimerRef.current !== null) {
      window.clearTimeout(visibilityRestoreRevealTimerRef.current);
      visibilityRestoreRevealTimerRef.current = null;
    }
    if (visibilityRestoreRevealRafRef.current !== null) {
      window.cancelAnimationFrame(visibilityRestoreRevealRafRef.current);
      visibilityRestoreRevealRafRef.current = null;
    }
    if (visibilityRestoreFallbackRafRef.current !== null) {
      window.cancelAnimationFrame(visibilityRestoreFallbackRafRef.current);
      visibilityRestoreFallbackRafRef.current = null;
    }
  };

  const finishVisibilityRestoreReveal = () => {
    clearVisibilityRestoreRevealSchedule();
    if (!visibilityRestorePendingRef.current) return;
    visibilityRestorePendingRef.current = false;
    setVisibilityRestorePending(false);
  };

  const scheduleVisibilityRestoreFallbackRefresh = () => {
    visibilityRestoreFallbackRafRef.current = window.requestAnimationFrame(() => {
      visibilityRestoreFallbackRafRef.current = window.requestAnimationFrame(() => {
        visibilityRestoreFallbackRafRef.current = null;
        if (!visibilityRestorePendingRef.current || !isVisibleRef.current) return;
        markViewportRefreshNeeded();
        scheduleFit(true, true);
      });
    });
  };

  const beginVisibilityRestoreReveal = (deferViewportRefresh = false) => {
    clearVisibilityRestoreRevealSchedule();
    if (!visibilityRestorePendingRef.current) {
      visibilityRestorePendingRef.current = true;
      setVisibilityRestorePending(true);
    }
    if (deferViewportRefresh) {
      scheduleVisibilityRestoreFallbackRefresh();
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
    clearVisibilityRestoreRevealSchedule();
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
    const baseTheme = withTerminalTextColor(
      getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette),
      terminalTextColor,
    );
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
    if (isVisibleRef.current) {
      tuiColorSync.normalize(terminal);
      tuiColorSync.schedule(terminal);
    }
  }, [fontSize, effectiveFontFamily, effectiveTerminalScrollbackRows, resolvedTheme, terminalThemeName, terminalTextColor, terminalTuiUserColor, terminalTuiAssistantColor, lightThemePalette, darkThemePalette, isTransparent, background.overlayDarken, lowMemoryMode, disableHardwareAcceleration, linuxGraphicsDisableWebgl, searchOpen, tuiColorSync]);

  // Hidden terminals stay attached and continue parsing output. Visibility only
  // controls renderer resources and when pending layout work is flushed.
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
    const baseTheme = withTerminalTextColor(
      getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette),
      terminalTextColor,
    );
    const rendererRestored = terminal ? syncWebglRenderer(terminal, baseTheme) : false;
    const becameVisible = !wasVisible;

    if (!fitAddonRef.current || !containerRef.current) return;
    if (becameVisible || rendererRestored) {
      beginVisibilityRestoreReveal(becameVisible && !rendererRestored);
    }
    if (rendererRestored) {
      markViewportRefreshNeeded();
    }
    scheduleFit(true, rendererRestored);
    if (terminalRef.current) {
      tuiColorSync.normalize(terminalRef.current);
      tuiColorSync.schedule(terminalRef.current);
    }
  }, [isVisible, lowMemoryMode, disableHardwareAcceleration, linuxGraphicsConstrained, linuxGraphicsDisableWebgl, resolvedTheme, terminalThemeName, terminalTextColor, lightThemePalette, darkThemePalette, tuiColorSync]);

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
  // focus. Visibility restoration temporarily hides the xterm container, so
  // wait for that mask to clear before focusing the helper textarea.
  useEffect(() => {
    isActiveRef.current = isActive;
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (!isActive || !isVisible) {
      terminal.blur();
      return;
    }
    if (visibilityRestorePending) return;
    const focusRaf = window.requestAnimationFrame(() => {
      if (
        terminalRef.current === terminal
        && isActiveRef.current
        && isVisibleRef.current
        && !visibilityRestorePendingRef.current
      ) {
        focusTerminalWithCodexCursorPolicy(terminal);
      }
    });
    return () => window.cancelAnimationFrame(focusRaf);
  }, [isActive, isVisible, visibilityRestorePending]);

  useEffect(() => {
    if (terminalSessionStatus === "exited" || terminalSessionStatus === "error") {
      grokSessionDetectedRef.current = false;
    }
  }, [terminalSessionStatus]);

  useEffect(() => {
    if (!containerRef.current) return;
    codexSessionDetectedRef.current = false;
    grokSessionDetectedRef.current = false;
    tuiColorSync.reset();

    const baseTheme = withTerminalTextColor(
      getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette),
      terminalTextColor,
    );
    let linkHoverIcon: TerminalLinkHoverIcon | null = null;
    let ctrlKeyDown = false;
    let fileHoverGeneration = 0;
    const pathKindCache = new Map<string, TerminalPathKind>();
    const shouldActivateTerminalLink = (event: MouseEvent) => (
      event.button === 0 && (event.ctrlKey || ctrlKeyDown)
    );
    const hideLinkHoverIcon = () => {
      fileHoverGeneration += 1;
      linkHoverIcon?.hide();
    };
    const showBufferLinkIcon = (range: IBufferRange) => {
      fileHoverGeneration += 1;
      linkHoverIcon?.showBufferRange("link", range);
    };
    const showViewportLinkIcon = (range: IViewportRange) => {
      fileHoverGeneration += 1;
      linkHoverIcon?.showViewportRange("link", range);
    };
    const showFileLinkIcon = (match: TerminalFileLinkMatch, range: IBufferRange) => {
      const generation = ++fileHoverGeneration;
      const context = getTerminalFileLinkContext(sessionId, match.path);
      const relativePath = match.kind === "relative" ? normalizeTerminalRelativePath(match.path) : null;
      const systemPath = match.kind === "relative"
        ? (context.rootPath && relativePath ? resolveRelativeTerminalSystemPath(context.rootPath, relativePath) : null)
        : context.systemPath;
      if (!context.supportsFiles || !systemPath || (match.kind === "relative" && !useSettingsStore.getState().terminalToolbarVisibility.files)) {
        linkHoverIcon?.hide();
        return;
      }

      const showKind = (kind: TerminalPathKind) => {
        if (generation !== fileHoverGeneration) return;
        if (kind === "file" || kind === "directory") {
          linkHoverIcon?.showBufferRange(match.kind === "relative" ? `relative-${kind}` : kind, range);
        } else {
          linkHoverIcon?.hide();
        }
      };
      const cachedKind = pathKindCache.get(systemPath);
      if (cachedKind) {
        showKind(cachedKind);
        return;
      }

      invoke<TerminalPathKind>("file_get_path_kind", { path: systemPath })
        .then((kind) => {
          if (kind !== "missing") pathKindCache.set(systemPath, kind);
          showKind(kind);
        })
        .catch(() => showKind("missing"));
    };
    const terminal = new Terminal({
      ...createTerminalMouseInteractionOptions(),
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
      minimumContrastRatio: getTerminalMinimumContrastRatio(baseTheme, isTransparentRef.current),
      // xterm cannot toggle transparency after construction, so keep it enabled
      // even though WebGL is disabled while a background image is active.
      allowTransparency: true,
      theme: withVisibleSelectionTheme(isTransparentRef.current ? applyTransparency(baseTheme, background.overlayDarken) : baseTheme, false),
      // OSC 8 超链接（codex 等 CLI 输出）默认点击行为是 window.open，在 Tauri
      // webview 里会被拦成"是否导航"确认框。接管为系统默认浏览器打开，仅放行
      // http/https，避免恶意 scheme。
      linkHandler: {
        activate: (event, uri) => {
          if (shouldActivateTerminalLink(event)) openHttpUrl(sessionId, uri);
        },
        hover: (_event, _uri, range) => showBufferLinkIcon(range),
        leave: hideLinkHoverIcon,
      },
    });
    const baseDisposables: TerminalSubsystemDisposable[] = [];
    const displayDisposables: TerminalSubsystemDisposable[] = [];
    const inputDisposables: TerminalSubsystemDisposable[] = [];
    baseDisposables.push({ dispose: cancelPendingCodexCursorShow });
    let processTraitsApplied = false;
    const applyProcessTraits = (traits: TerminalProcessTraits | null | undefined) => {
      if (!traits || processTraitsApplied) return;
      processTraitsApplied = true;
      if (traits.os === "windows" || traits.os === "macos" || traits.os === "linux") {
        osPlatformRef.current = traits.os;
      }
      // Unix PTYs redraw the cursor line asynchronously after SIGWINCH. Reflow
      // it locally as well so rapid live shrinking never exposes the stale,
      // old-width cursor row while waiting for the shell/TUI repaint.
      terminal.options.reflowCursorLine = shouldReflowTerminalCursorLine(traits);
      const windowsPty = traits.windowsPty;
      if (!windowsPty) return;
      terminal.options.windowsPty = {
        backend: windowsPty.backend,
        buildNumber: windowsPty.buildNumber ?? undefined,
      };
      if (windowsPty.backend === "conpty") {
        baseDisposables.push(terminal.parser.registerCsiHandler({ final: "c" }, (params) => {
          if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
            terminalProcessManager
              .write(sessionId, "\x1b[?61;4c")
              .catch((err) => reportPtyWriteError("conpty_da1", err));
            return true;
          }
          return false;
        }));
      }
    };
    applyProcessTraits(terminalProcessManager.getProcessTraits(sessionId));
    // Keep Claude Code / other TUIs from overriding the app-wide thin cursor via DECSCUSR.
    baseDisposables.push(terminal.parser.registerCsiHandler({ intermediates: " ", final: "q" }, () => true));

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
    const serializeAddon = new SerializeAddon();
    const unicode11Addon = new Unicode11Addon();
    const webLinksAddon = new WebLinksAddon(
      (event, uri) => {
        if (shouldActivateTerminalLink(event)) openHttpUrl(sessionId, uri);
      },
      {
        hover: (_event, _uri, range) => showViewportLinkIcon(range),
        leave: hideLinkHoverIcon,
      },
    );
    baseDisposables.push(terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeSession = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
        if (activeSession?.environmentType === "ssh") {
          callback(undefined);
          return;
        }
        const bufferLine = terminal.buffer.active.getLine(bufferLineNumber - 1);
        const line = bufferLine?.translateToString(true) ?? "";
        const absoluteLinks = findTerminalFileLinks(line);
        const relativeLinks = useSettingsStore.getState().terminalToolbarVisibility.files
          ? findTerminalRelativeFileLinks(line)
          : [];
        const buildLinks = (matches: TerminalFileLinkMatch[]): ILink[] => matches.flatMap((match) => {
          if (!bufferLine) return [];
          const columns = terminalStringRangeToBufferColumns(bufferLine, match.startIndex, match.endIndex);
          if (!columns) return [];
          const range: IBufferRange = {
            start: { x: columns.startColumn + 1, y: bufferLineNumber },
            end: { x: columns.endColumn, y: bufferLineNumber },
          };
          return [{
            range,
            text: match.text,
            activate: (event) => {
              if (!shouldActivateTerminalLink(event)) return;
              if (match.kind === "relative") {
                void openTerminalRelativeFilePath(sessionId, match);
              } else {
                void openTerminalFilePath(sessionId, match.path);
              }
            },
            hover: () => showFileLinkIcon(match, range),
            leave: hideLinkHoverIcon,
            decorations: { pointerCursor: true, underline: true },
          }];
        });
        if (relativeLinks.length === 0) {
          const links = buildLinks(absoluteLinks);
          callback(links.length > 0 ? links : undefined);
          return;
        }

        void Promise.all(relativeLinks.map(async (match) => {
          const context = getTerminalFileLinkContext(sessionId, match.path);
          const relativePath = normalizeTerminalRelativePath(match.path);
          if (!context.supportsFiles || !context.rootPath || !relativePath) return null;
          const systemPath = resolveRelativeTerminalSystemPath(context.rootPath, relativePath);
          const cachedKind = pathKindCache.get(systemPath);
          if (cachedKind === "file" || cachedKind === "directory") return match;
          try {
            const kind = await invoke<TerminalPathKind>("file_get_path_kind", { path: systemPath });
            if (kind !== "file" && kind !== "directory") return null;
            pathKindCache.set(systemPath, kind);
            return match;
          } catch {
            return null;
          }
        })).then((resolvedRelativeLinks) => {
          const links = buildLinks([
            ...absoluteLinks,
            ...resolvedRelativeLinks.filter((match): match is TerminalFileLinkMatch => match !== null),
          ]);
          callback(links.length > 0 ? links : undefined);
        });
      },
    }));
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(serializeAddon);
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = "11";
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);
    const updateScrollToBottomButton = () => {
      const buffer = terminal.buffer.active;
      const next = buffer.type === "normal" && buffer.viewportY < buffer.baseY;
      setIsScrolledAwayFromBottom((current) => current === next ? current : next);
    };
    const updateCtrlKeyState = (event: KeyboardEvent) => {
      if (event.key === "Control") ctrlKeyDown = event.type === "keydown";
    };
    const resetCtrlKeyState = () => {
      ctrlKeyDown = false;
    };
    window.addEventListener("keydown", updateCtrlKeyState, true);
    window.addEventListener("keyup", updateCtrlKeyState, true);
    window.addEventListener("blur", resetCtrlKeyState);
    baseDisposables.push({
      dispose: () => {
        window.removeEventListener("keydown", updateCtrlKeyState, true);
        window.removeEventListener("keyup", updateCtrlKeyState, true);
        window.removeEventListener("blur", resetCtrlKeyState);
      },
    });
    linkHoverIcon = createTerminalLinkHoverIcon(terminal, containerRef.current, fontSize);
    baseDisposables.push(linkHoverIcon);
    // 注册定时节流落盘的快照来源：让崩溃/强杀也能恢复到最近一次落盘的画面。
    const serializeAfterWriteBarrier = () => new Promise<string>((resolve) => {
      terminal.write("", () => resolve(serializeAddon.serialize()));
    });
    const unregisterSnapshotSource = registerTerminalSnapshotSource(
      sessionId,
      serializeAfterWriteBarrier,
      async (serialized) => {
        await terminalProcessManager.checkpoint(
          sessionId,
          terminal.cols,
          terminal.rows,
          serialized,
        );
      },
    );
    baseDisposables.push(searchAddon.onDidChangeResults(handleSearchResults));

    const initialWebglReady = syncWebglRenderer(terminal, baseTheme);
    if (initialWebglReady) {
      if (!canUseTerminalImageAddonWasm()) {
        if (!terminalImageAddonFallbackLogged) {
          terminalImageAddonFallbackLogged = true;
          logWarn("Terminal image addon disabled because WebAssembly is blocked by the current WebView CSP");
        }
      } else {
        const imageAddon = new ImageAddon({
          enableSizeReports: false,
          pixelLimit: IMAGE_ADDON_PIXEL_LIMIT,
          storageLimit: IMAGE_ADDON_STORAGE_LIMIT_MB,
          sixelSizeLimit: IMAGE_ADDON_SEQUENCE_LIMIT,
          iipSizeLimit: IMAGE_ADDON_SEQUENCE_LIMIT,
        });
        try {
          terminal.loadAddon(imageAddon);
        } catch (err) {
          imageAddon.dispose();
          logWarn("Failed to load terminal image addon; continuing without terminal image support", {
            sessionId,
            err,
          });
        }
      }
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    applyCodexCursorVisibility(terminal);
    scheduleFit(true);
    const sessionSnapshot = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
    const initialTerminalOutput = sessionSnapshot?.initialTerminalOutput;
    const writeDeferredStartup = () => {
      if (!sessionSnapshot?.deferStartupUntilInitialOutput || !sessionSnapshot.startupCmd) return;
      terminalProcessManager.write(
        sessionId,
        formatStartupInputForPty(sessionSnapshot.startupCmd, normalizeShellKey(sessionSnapshot.shell) ?? null),
      ).catch((err) => reportPtyWriteError("deferredStartup", err));
    };
    let resolveInitialDisplayReady: (() => void) | null = null;
    const initialDisplayReady = new Promise<void>((resolve) => {
      resolveInitialDisplayReady = resolve;
    });
    const markInitialDisplayReady = () => {
      const resolve = resolveInitialDisplayReady;
      resolveInitialDisplayReady = null;
      resolve?.();
    };
    const finishInitialDisplayRestore = (hasSnapshot: boolean) => {
      scheduleFit(true);
      requestAnimationFrame(() => {
        if (terminalRef.current !== terminal) return;
        snapshotBeforeUnmountRef.current = () => {
          try {
            useTerminalStore.getState().updateSessionTerminalSnapshot(sessionId, serializeAddon.serialize());
          } catch (err) {
            logError("Failed to snapshot terminal buffer before dispose", { sessionId, err });
          }
        };
        if (!hasSnapshot) {
          markInitialDisplayReady();
          return;
        }
        // RAF-A (scheduleFit) fires before RAF-B below. If a horizontal resize occurs
        // in RAF-A, xterm reflows the buffer and may move the cursor away from the
        // clean bottom line written by the snapshot restore sequence. RAF-B runs after
        // RAF-A, so re-push the cursor to the bottom before releasing the PTY output
        // gate. This must stay in the snapshot path: a new shell has no stale cursor
        // to repair and should keep its normal initial cursor position.
        terminal.write("\x1b[999B\r\n", () => {
          if (terminalRef.current !== terminal) return;
          terminal.scrollToBottom();
          markInitialDisplayReady();
        });
      });
    };
    let initialDisplayRestoreRaf: number | null = null;
    if (initialTerminalOutput) {
      // The serialized shell snapshot contains cursor coordinates from the old
      // terminal geometry. Fit first, then end on a clean line so output from
      // the recreated PTY cannot overwrite restored text at that stale cursor.
      initialDisplayRestoreRaf = window.requestAnimationFrame(() => {
        initialDisplayRestoreRaf = null;
        if (terminalRef.current !== terminal) return;
        const dimensions = fitAddon.proposeDimensions();
        if (
          dimensions
          && dimensions.cols > 0
          && dimensions.rows > 0
          && (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows)
        ) {
          terminal.resize(dimensions.cols, dimensions.rows);
        }
        const restoredOutput = displayTransformOutputRef.current(initialTerminalOutput);
        const restoredCursor = shouldHideCodexCursor(terminal) ? "\x1b[?25l" : "\x1b[?25h";
        terminal.write(`${restoredOutput}\x1b[?6l\x1b[r\x1b[0m${restoredCursor}\x1b[999B\r\n`, () => {
          if (terminalRef.current !== terminal) return;
          terminal.scrollToBottom();
          refreshTerminalViewport(terminal);
          scheduleViewportRefresh();
          writeDeferredStartup();
          finishInitialDisplayRestore(true);
        });
      });
    } else {
      writeDeferredStartup();
      finishInitialDisplayRestore(false);
    }
    if (isActive && isVisible) {
      focusTerminalWithCodexCursorPolicy(terminal);
    }

    const copySelection = async () => {
      const selection = terminal.getSelection();
      if (!selection) return;
      await copyTextToClipboard(selection);
    };

    const markAttentionInputHandled = () => useTerminalStore.getState().markAttentionInputHandled(sessionId);

    const detachPasteAndDrop = attachPasteAndDrop(terminal);
    const contextMenuTarget = containerRef.current;
    const inputSelection = attachSelection(terminal, {
      markAttentionInputHandled,
      reportPtyWriteError,
    });
    inputDisposables.push({ dispose: inputSelection.dispose });
    if (contextMenuTarget && isOpenCodeTerminalContext(getSessionToolContext())) {
      inputDisposables.push({
        dispose: attachOpenCodeTuiClipboard({
          container: contextMenuTarget,
          terminal,
          isActive: () => isActiveRef.current,
          isVisible: () => isVisibleRef.current,
          hasInputFocus: () => contextMenuTarget.contains(document.activeElement),
          isMac: () => (
            osPlatformRef.current === "macos"
            || (osPlatformRef.current === "unknown" && navigator.platform.toLowerCase().includes("mac"))
          ),
          readClipboardText: readClipboardPasteText,
          pasteText: (text) => pasteText(terminal, text),
          wrapMultilinePaste: wrapTerminalPasteTextForCtrlShiftV,
          copyText: copyTextToClipboard,
          clearInputSelection: inputSelection.clearInputSelectionState,
          focusTerminal: () => focusTerminalWithCodexCursorPolicy(terminal),
          logError,
        }),
      });
    }
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (terminal.hasSelection()) {
        void copySelection();
        terminal.clearSelection();
        inputSelection.clearInputSelectionState();
        focusTerminalWithCodexCursorPolicy(terminal);
        closeContextMenu();
        return;
      }
      openMenu(e.clientX, e.clientY, false);
    };
    contextMenuTarget.addEventListener("contextmenu", onContextMenu);

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
        inputSelection.selectCurrentInputText();
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
        inputSelection.extendKeyboardInputSelection(e.key === "ArrowLeft" ? -1 : 1);
        return false;
      }

      if (
        e.type === "keydown" &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        inputSelection.collapseKeyboardInputSelection(e.key === "ArrowLeft" ? -1 : 1)
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
        if (inputSelection.removeSelectedInputText()) {
          e.preventDefault();
          return false;
        }
      }
      if (e.type === "keydown" && e.key === "Enter") {
        const sessionContext = getSessionToolContext();
        const newlineDecision = resolveTerminalNewlineKeyEvent(e, {
          shortcut: useSettingsStore.getState().terminalNewlineShortcut,
          usesEscCrComposerNewline:
            isCodexSession(sessionContext, terminal)
            || isGrokSession(sessionContext, terminal),
        });
        if (newlineDecision.action === "write") {
          e.preventDefault();
          markAttentionInputHandled();
          terminalProcessManager.write(sessionId, newlineDecision.data).catch((err) => reportPtyWriteError("newline", err));
          return false;
        }
        if (newlineDecision.action === "swallow") {
          e.preventDefault();
          return false;
        }
        if (newlineDecision.action === "pass") return true;
      }
      if (
        e.type === "keydown" &&
        e.key === "Tab" &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        if (acceptSuggestion(suggestionGhost?.suffix)) {
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
      if (e.type === "keydown") {
        const copyShortcut = useSettingsStore.getState().keyboardShortcuts.copyTerminalSelection;
        if (copyShortcut && eventToCombo(e) === copyShortcut) {
          e.preventDefault();
          if (terminal.hasSelection()) {
            void copySelection();
          }
          return false;
        }
      }
      if (e.type === "keydown" && terminal.buffer.active.type === "normal") {
        const scrollShortcuts = useSettingsStore.getState().keyboardShortcuts;
        const combo = eventToCombo(e);
        if (scrollShortcuts.scrollToBottom.trim() && combo === scrollShortcuts.scrollToBottom) {
          e.preventDefault();
          terminal.scrollToBottom();
          setIsScrolledAwayFromBottom(false);
          return false;
        }
        if (scrollShortcuts.pageUp.trim() && combo === scrollShortcuts.pageUp) {
          e.preventDefault();
          terminal.scrollPages(-1);
          return false;
        }
        if (scrollShortcuts.pageDown.trim() && combo === scrollShortcuts.pageDown) {
          e.preventDefault();
          terminal.scrollPages(1);
          return false;
        }
      }
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        readClipboardPasteText().then((text) => {
          pasteText(terminal, wrapTerminalPasteTextForCtrlShiftV(text));
        }).catch((err) => {
          logError("Failed to read clipboard text", { sessionId, err });
        });
        return false;
      }
      if (e.type === "keydown" && e.key.toLowerCase() === "c" && !e.shiftKey && !e.altKey) {
        const copyAndClearSelection = () => {
          void copySelection();
          terminal.clearSelection();
          inputSelection.clearInputSelectionState();
        };
        const sendInterrupt = () => {
          markAttentionInputHandled();
          inputSelection.clearInputSelectionState();
          terminalProcessManager.write(sessionId, "\x03").catch((err) => reportPtyWriteError("interrupt", err));
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
        readClipboardPasteText().then((text) => {
          pasteText(terminal, text);
        }).catch((err) => {
          logError("Failed to read clipboard text", { sessionId, err });
        });
        return false;
      }
      return true;
    });

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

    const inputForwarding = attachInputForwarding(terminal, {
      selection: inputSelection,
      osPlatformRef,
      markAttentionInputHandled,
      reportPtyWriteError,
      updateSessionCwdIfChanged,
      onInputForwarded: maybeLogCodexImeDuplicate,
      onCommandSubmitted: (command) => {
        onCommandSubmitted(command);
        if (isGrokLaunchCommand(command)) {
          grokSessionDetectedRef.current = true;
        }
      },
    });
    inputDisposables.push({ dispose: inputForwarding.dispose });

    let ptyOutput: ReturnType<typeof attachPtyOutput> | null = null;
    const attachOutput = () => {
      const output = attachPtyOutput({
        waitForReplay: useTerminalStore.getState().daemonAttachPendingSessionIds.has(sessionId),
      });
      ptyOutput = output;
      if (!useTerminalStore.getState().daemonAttachPendingSessionIds.has(sessionId)) return;
      void output.ready.then(async () => {
        if (terminalRef.current !== terminal) return;
        const attach = await terminalProcessManager.attach(sessionId);
        if (terminalRef.current !== terminal) return;
        applyProcessTraits(attach.processTraits);
        const replayCompleted = await output.completeReplay(attach.replay);
        if (!replayCompleted) return;
        useTerminalStore.setState((state) => ({
          daemonAttachPendingSessionIds: new Set(
            [...state.daemonAttachPendingSessionIds].filter((id) => id !== sessionId)
          ),
        }));
        if (!attach.attached) {
          toast.error(t("terminal.backgroundTasks.restoreFailed"));
        } else if (attach.replayTruncated) {
          toast.warning(t("terminal.backgroundTasks.replayTruncated"));
        }
      }).catch(async (err) => {
        const replayCompleted = await output.completeReplay([]);
        if (!replayCompleted) return;
        useTerminalStore.setState((state) => ({
          daemonAttachPendingSessionIds: new Set(
            [...state.daemonAttachPendingSessionIds].filter((id) => id !== sessionId)
          ),
        }));
        logError("Failed to attach daemon terminal output", { sessionId, err });
        toast.error(t("terminal.backgroundTasks.restoreFailed"), { description: String(err) });
      });
    };
    // Restore the local display before subscribing so the PTY stream cannot race the snapshot.
    let attachOutputTimer: number | null = null;
    void initialDisplayReady.then(() => {
      if (terminalRef.current !== terminal) return;
      attachOutputTimer = window.setTimeout(() => {
        attachOutputTimer = null;
        if (terminalRef.current !== terminal) return;
        attachOutput();
      }, 0);
    });
    const detachViewport = attachViewport(terminal);
    displayDisposables.push({ dispose: detachViewport });
    displayDisposables.push(terminal.onRender((range) => {
      updateScrollToBottomButton();
      handleVisibilityRestoreRender(terminal, range);
      if (isVisibleRef.current) tuiColorSync.schedule(terminal);
    }));
    displayDisposables.push(terminal.onScroll(() => {
      updateScrollToBottomButton();
      if (isVisibleRef.current) tuiColorSync.schedule(terminal);
    }));
    displayDisposables.push(terminal.onWriteParsed(updateScrollToBottomButton));
    displayDisposables.push(terminal.onResize(updateScrollToBottomButton));
    updateScrollToBottomButton();
    const detachIme = attachIme(terminal, {
      forwarding: inputForwarding,
      osPlatformRef,
      scheduleFit,
      resolveCompositionAnchor: (runtimeTerminal, anchor) => {
        const piAnchor = piTerminalCompatibilityRef.current?.resolveImeCompositionAnchor(runtimeTerminal, anchor) ?? anchor;
        return isClaudeTerminalContext(getSessionToolContext())
          ? resolveClaudeImeCompositionAnchor(runtimeTerminal, piAnchor)
          : piAnchor;
      },
      resolveTextareaAnchor: piTerminalCompatibilityRef.current?.resolveImeTextareaAnchor,
      shouldRefreshCompositionAnchor: piTerminalCompatibilityRef.current?.shouldRefreshImeCompositionAnchor,
      onCompositionCommitted: (textareaValue) => {
        if (!isCodexSession()) return;
        codexImeDebugRef.current.compositionEndAt = Date.now();
        codexImeDebugRef.current.compositionEndSummary = summarizeTextForDiagnostics(textareaValue);
        codexImeDebugRef.current.lastNearCompositionFingerprint = null;
        codexImeDebugRef.current.lastNearCompositionAt = -1;
      },
    });
    inputDisposables.push({ dispose: detachIme });


    return () => {
      detachPasteAndDrop();
      contextMenuTarget.removeEventListener("contextmenu", onContextMenu);
      disposeTerminalSubsystem(inputDisposables);
      disposeTerminalSubsystem(displayDisposables);
      cancelScheduledFit();
      if (attachOutputTimer !== null) {
        window.clearTimeout(attachOutputTimer);
        attachOutputTimer = null;
      }
      if (initialDisplayRestoreRaf !== null) {
        window.cancelAnimationFrame(initialDisplayRestoreRaf);
        initialDisplayRestoreRaf = null;
      }
      resolveInitialDisplayReady?.();
      resolveInitialDisplayReady = null;
      ptyOutput?.dispose();
      tuiColorSync.dispose();
      resetOutputState();
      grokSessionDetectedRef.current = false;
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
      setIsScrolledAwayFromBottom(false);
    };
  }, [sessionId, tuiColorSync]);

  const backgroundOverlayColor = getTerminalBackgroundOverlayColor(terminalTheme);
  const showBackgroundImage = isTransparent && assetUrl !== null;
  const terminalForegroundColor = normalizeHexColor(terminalTheme.foreground, "#d8dee9");
  const terminalBackgroundColor = normalizeHexColor(terminalTheme.background, backgroundColor);
  useEffect(() => {
    terminalProcessManager.setTerminalColors(sessionId, {
      foreground: terminalForegroundColor,
      background: terminalBackgroundColor,
    }).catch((err) => reportPtyWriteError("terminal_colors", err));
  }, [sessionId, terminalForegroundColor, terminalBackgroundColor]);
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
  const markdownPreviewPanelPercent = markdownPreviewRatio * 100;
  const markdownPreviewRightOffset = markdownPreviewOpen
    ? `calc(${markdownPreviewPanelPercent}% + 12px)`
    : "12px";
  const searchRightOffset = markdownPreviewOpen
    ? `calc(${markdownPreviewPanelPercent}% + 56px)`
    : markdownPreviewButtonVisible
      ? "56px"
      : "12px";

  const terminalSearchShellStyle: CSSProperties = {
    position: "absolute",
    right: searchRightOffset,
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
  const terminalFontSizeControlStyle: CSSProperties = {
    backgroundColor: hexToRgba(searchBackground, showBackgroundImage ? 0.78 : 0.92, "rgba(0, 0, 0, 0.86)"),
    borderColor: hexToRgba(searchForeground, 0.24, "rgba(255, 255, 255, 0.22)"),
    boxShadow: `0 12px 30px ${hexToRgba(searchBackground, 0.55, "rgba(0, 0, 0, 0.45)")}`,
    color: searchForeground,
    fontFamily: effectiveFontFamily,
  };
  const handleTerminalFontSizeWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey && event.deltaY !== 0) showFontSizeControl();
  };
  const handleScrollToBottom = () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.scrollToBottom();
    setIsScrolledAwayFromBottom(false);
  };

  const handleMenuCopy = () => {
    const terminal = terminalRef.current;
    closeContextMenu();
    if (!terminal) return;
    void copyTextToClipboard(terminal.getSelection());
    terminal.clearSelection();
    focusTerminalWithCodexCursorPolicy(terminal);
  };

  const handleMenuPaste = () => {
    const terminal = terminalRef.current;
    closeContextMenu();
    if (!terminal) return;
    readClipboardPasteText().then((text) => {
      if (text) pasteText(terminal, text);
      focusTerminalWithCodexCursorPolicy(terminal);
    }).catch((err) => {
      logError("Failed to read clipboard text", { sessionId, err });
    });
  };

  const handleMenuSelectAll = () => {
    const terminal = terminalRef.current;
    closeContextMenu();
    if (!terminal) return;
    terminal.selectAll();
    focusTerminalWithCodexCursorPolicy(terminal);
  };

  const handleMenuCopyAll = () => {
    const terminal = terminalRef.current;
    closeContextMenu();
    if (!terminal) return;
    void copyTextToClipboard(serializeBufferPlainText(terminal));
    focusTerminalWithCodexCursorPolicy(terminal);
  };

  const handleMenuClear = () => {
    const terminal = terminalRef.current;
    closeContextMenu();
    if (!terminal) return;
    useTerminalStore.getState().markAttentionInputHandled(sessionId);
    enqueueActiveWrite("\x1b[2J\x1b[H");
    terminalProcessManager.write(sessionId, "\x0c").catch((err) => reportPtyWriteError("clear", err));
    focusTerminalWithCodexCursorPolicy(terminal);
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
  const terminalContainerStyle: CSSProperties | undefined = visibilityRestorePending || visibilityRestoreStarting
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
      {markdownPreviewButtonVisible && (
        <button
          type="button"
          onClick={() => {
            if (!markdownPreviewOpen && !markdownPreviewCanOpen) return;
            setMarkdownPreviewOpen((open) => !open);
          }}
          disabled={!markdownPreviewOpen && !markdownPreviewCanOpen}
          className="terminal-markdown-preview-toggle ui-focus-ring absolute top-3 z-20 inline-flex h-8 w-8 items-center justify-center rounded-md border backdrop-blur-md transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          style={{ ...terminalSearchButtonStyle, right: markdownPreviewRightOffset }}
          aria-label={markdownPreviewOpen
            ? t("terminal.markdownPreview.close")
            : markdownPreviewCanOpen
              ? t("terminal.markdownPreview.open")
              : t("terminal.markdownPreview.unavailable")}
          title={markdownPreviewOpen
            ? t("terminal.markdownPreview.close")
            : markdownPreviewCanOpen
              ? t("terminal.markdownPreview.open")
              : t("terminal.markdownPreview.unavailable")}
          aria-pressed={markdownPreviewOpen}
        >
          {markdownPreviewOpen ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
        </button>
      )}
      {searchOpen && (
        <div
          className="terminal-search-shell absolute right-3 top-3 z-20 flex h-8 items-center gap-1 rounded-md border px-2 text-[12px] backdrop-blur-md"
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
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 min-w-0 overflow-hidden"
          style={{ width: markdownPreviewOpen ? `${100 - markdownPreviewPanelPercent}%` : "100%" }}
          onWheelCapture={handleTerminalFontSizeWheel}
        >
          <div ref={containerRef} className="relative h-full w-full overflow-hidden pl-2" style={terminalContainerStyle} />
          {(isScrolledAwayFromBottom || fontSizeControlVisible) && (
            <div className="absolute bottom-3 right-3 z-20 flex flex-col items-end gap-2">
              {isScrolledAwayFromBottom && (
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleScrollToBottom}
                  className="terminal-scroll-to-bottom ui-focus-ring inline-flex h-7 w-7 items-center justify-center rounded-full border backdrop-blur-md transition hover:brightness-110"
                  style={terminalFontSizeControlStyle}
                  aria-label={t("terminal.scrollToBottom")}
                  title={t("terminal.scrollToBottom")}
                >
                  <ArrowDown size={14} aria-hidden="true" />
                </button>
              )}
              {fontSizeControlVisible && (
                <FontSizeControl
                  fontSize={fontSize}
                  defaultFontSize={TERMINAL_FONT_SIZE_DEFAULT}
                  min={TERMINAL_FONT_SIZE_MIN}
                  max={TERMINAL_FONT_SIZE_MAX}
                  onChange={(next) => {
                    showFontSizeControl();
                    void updateSettings("fontSize", next);
                  }}
                  style={terminalFontSizeControlStyle}
                  variant="terminal"
                />
              )}
            </div>
          )}
        </div>
        {markdownPreviewOpen && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("terminal.markdownPreview.resize")}
            className="absolute inset-y-0 z-20 w-1 -translate-x-1/2 cursor-col-resize bg-transparent transition-colors hover:bg-[color-mix(in_srgb,var(--primary)_55%,transparent)]"
            style={{ left: `${100 - markdownPreviewPanelPercent}%` }}
            onPointerDown={handleMarkdownPreviewResizeStart}
          />
        )}
        <div
          className="absolute inset-y-0 right-0 min-w-0 overflow-hidden"
          style={{ width: markdownPreviewOpen ? `${markdownPreviewPanelPercent}%` : "0%", pointerEvents: markdownPreviewOpen ? "auto" : "none" }}
        >
          <TerminalMarkdownPreview
            sessionId={sessionId}
            open={markdownPreviewOpen}
            onClose={() => setMarkdownPreviewOpen(false)}
          />
        </div>
      </div>
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
