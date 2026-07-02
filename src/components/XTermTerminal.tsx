import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal, type IBufferCell, type IBufferLine } from "@xterm/xterm";
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
import { backgroundAssetUrl } from "../lib/assetUrl";
import { TERMINAL_FILE_PATH_MIME } from "../lib/aiPathFormatter";
import { useI18n } from "../lib/i18n";
import { isDirectCodexStartupCommand } from "../lib/projectStartupCommand";
import { normalizeTerminalFontFamily } from "../lib/terminalFontFamily";
import { endTerminalFileDrag, getTerminalFileDragText } from "../lib/terminalFileDrag";
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
import { formatManualDirectCodexInputForPty, useTerminalStore, type ShellRuntimeEventName } from "../stores/terminalStore";
import { useSettingsStore, type LightThemePalette, type DarkThemePalette } from "../stores/settingsStore";

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;
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
// Box-drawing glyphs used by TUI input boxes (Claude Code / Codex draw "│ > … │").
const TUI_BORDER_CHAR_PATTERN = /^[│┃║▏▎▍▌▋▊▉█┆┊╎╏]$/u;
const TUI_BORDER_PREFIX_PATTERN = /^[\s│┃║▏▎▍▌▋▊▉█┆┊╎╏]+/u;
import { toast } from "sonner";
import { logError, logInfo } from "../lib/logger";

// Shell integration OSC 序列在原始 PTY 流上解析（而非 xterm parser hook）：
// 后台 Tab 的输出会进入 inactive ring buffer 且可能被截断丢弃，状态事件必须
// 在丢弃之前提取，否则后台 Tab 不再上报状态。
// 777 为本应用私有协议（消费后剥离）；133/633 为 FinalTerm / VS Code 标准
// shell integration 序列（消费后原样放行，xterm 会忽略），借此兼容 oh-my-posh、
// VS Code shell integration 等用户自带集成。
const LEGACY_RUNTIME_OSC_PREFIX = "\x1b]777;cli-manager;";
const INTEGRATION_OSC_PREFIXES = ["\x1b]133;", "\x1b]633;", LEGACY_RUNTIME_OSC_PREFIX];
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

type SpecialColorQueryId = 10 | 11;

type OscPrefixMatch =
  | { kind: "match"; prefix: string }
  | { kind: "partial" }
  | { kind: "none" };

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

const trimTerminalPasteBoundaryLineBreaks = (text: string) => (
  text.replace(/^(?:\r\n?|\n)+|(?:\r\n?|\n)+$/gu, "")
);

const wrapTerminalPasteTextForCtrlShiftV = (text: string) => {
  const trimmed = trimTerminalPasteBoundaryLineBreaks(text);
  return /[\r\n]/u.test(trimmed) ? `'${trimmed}'` : trimmed;
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

export function XTermTerminal({ sessionId, isActive = true, isVisible = true, fontSize = 14, fontFamily = "Cascadia Code, Consolas, monospace", resolvedTheme = "dark", terminalThemeName = "auto", lightThemePalette = "warm-paper", darkThemePalette = "night-indigo", onNewTab, onCloseSession, onCloseOthers, onCloseToLeft, onCloseToRight, onSplitRight, onSplitDown }: Props) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const inputBuffer = useRef("");
  const fitRafRef = useRef<number | null>(null);
  const isComposingRef = useRef(false);
  const isActiveRef = useRef(isActive);
  const isVisibleRef = useRef(isVisible);
  const lastObservedSizeRef = useRef<{ width: number; height: number } | null>(null);
  const inactiveBufferRef = useRef<string[]>([]);
  const inactiveBufferSizeRef = useRef(0);
  const activeWriteQueueRef = useRef<string[]>([]);
  const activeWriteQueueSizeRef = useRef(0);
  const activeWriteQueueLastDropLogAtRef = useRef(0);
  const activeWriteRafRef = useRef<number | null>(null);
  const cursorShowTimerRef = useRef<number | null>(null);
  const tuiComposerNormalizeRafRef = useRef<number | null>(null);
  const runtimeOscBufferRef = useRef("");
  const specialOscBufferRef = useRef("");
  const terminalColorRepliesRef = useRef<{ foreground: string; background: string }>({
    foreground: formatSpecialColorReply(10, "#d8dee9"),
    background: formatSpecialColorReply(11, "#0c0e10"),
  });
  const terminalScrollbackRows = useSettingsStore((s) => s.terminalScrollbackRows);
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

  const isTransparent = background.enabled && background.imagePath !== null && !hiddenForThisSession;
  const isTransparentRef = useRef(isTransparent);
  isTransparentRef.current = isTransparent;
  const terminalTheme = getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
  const isLightTerminalRef = useRef(isLightTerminalTheme(terminalTheme));
  isLightTerminalRef.current = isLightTerminalTheme(terminalTheme);
  const effectiveFontFamily = normalizeTerminalFontFamily(fontFamily);

  const syncWebglRenderer = (terminal: Terminal, theme: ReturnType<typeof getTerminalTheme>) => {
    const shouldUseWebgl = !isTransparentRef.current && !isLightTerminalTheme(theme);
    if (!shouldUseWebgl) {
      if (!webglAddonRef.current) return false;
      webglAddonRef.current?.dispose();
      webglAddonRef.current = null;
      return true;
    }
    if (webglAddonRef.current) return false;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        if (webglAddonRef.current === addon) {
          webglAddonRef.current = null;
        }
      });
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
    if (!container || !fitAddon) return;
    if (!force && (!isVisibleRef.current || isComposingRef.current)) return;
    if (container.offsetWidth <= 0 || container.offsetHeight <= 0) return;

    const dims = fitAddon.proposeDimensions();
    if (!dims || dims.cols < MIN_TERMINAL_COLS || dims.rows < MIN_TERMINAL_ROWS) return;
    fitAddon.fit();
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

  // 标准 OSC 133/633：A=prompt 开始，C=命令开始执行，D[;exit]=命令结束。
  // D 不带 exit code 表示没跑命令（空回车 / prompt 处 Ctrl+C），不改变状态。
  const handleStandardIntegrationOsc = (body: string) => {
    const separator = body.indexOf(";");
    const command = separator < 0 ? body : body.slice(0, separator);
    const rest = separator < 0 ? "" : body.slice(separator + 1);
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

  const flushActiveWriteQueue = () => {
    activeWriteRafRef.current = null;
    if (!isVisibleRef.current || activeWriteQueueRef.current.length === 0) return;
    const terminal = terminalRef.current;
    if (!terminal) return;

    const writeTerminalChunk = (chunk: string) => {
      terminal.write(chunk, () => {
        if (terminalRef.current !== terminal) return;
        normalizeTuiComposerBackground(terminal);
        scheduleTuiComposerBackgroundNormalization(terminal);
      });
    };

    let budget = ACTIVE_WRITE_FRAME_BUDGET;
    while (budget > 0 && activeWriteQueueRef.current.length > 0) {
      const chunk = activeWriteQueueRef.current[0];
      if (chunk.length <= budget) {
        writeTerminalChunk(chunk);
        activeWriteQueueRef.current.shift();
        activeWriteQueueSizeRef.current = Math.max(0, activeWriteQueueSizeRef.current - chunk.length);
        budget -= chunk.length;
        continue;
      }
      writeTerminalChunk(chunk.slice(0, budget));
      activeWriteQueueRef.current[0] = chunk.slice(budget);
      activeWriteQueueSizeRef.current = Math.max(0, activeWriteQueueSizeRef.current - budget);
      budget = 0;
    }

    if (activeWriteQueueRef.current.length > 0) {
      activeWriteRafRef.current = requestAnimationFrame(flushActiveWriteQueue);
    }
  };

  const enqueueActiveWrite = (text: string) => {
    if (!text) return;
    let nextText = processCursorVisibility(text);
    let droppedChars = 0;
    if (nextText.length >= ACTIVE_WRITE_QUEUE_MAX_CHARS) {
      droppedChars += activeWriteQueueSizeRef.current + nextText.length - ACTIVE_WRITE_QUEUE_MAX_CHARS;
      nextText = nextText.slice(-ACTIVE_WRITE_QUEUE_MAX_CHARS);
      activeWriteQueueRef.current = [];
      activeWriteQueueSizeRef.current = 0;
    }
    activeWriteQueueRef.current.push(nextText);
    activeWriteQueueSizeRef.current += nextText.length;
    while (activeWriteQueueSizeRef.current > ACTIVE_WRITE_QUEUE_MAX_CHARS && activeWriteQueueRef.current.length > 0) {
      const overflow = activeWriteQueueSizeRef.current - ACTIVE_WRITE_QUEUE_MAX_CHARS;
      const head = activeWriteQueueRef.current[0];
      if (!head || head.length <= overflow) {
        const removed = activeWriteQueueRef.current.shift();
        const removedLength = removed?.length ?? 0;
        activeWriteQueueSizeRef.current -= removedLength;
        droppedChars += removedLength;
        continue;
      }
      activeWriteQueueRef.current[0] = head.slice(overflow);
      activeWriteQueueSizeRef.current -= overflow;
      droppedChars += overflow;
    }
    if (droppedChars > 0) {
      const now = Date.now();
      if (now - activeWriteQueueLastDropLogAtRef.current >= ACTIVE_WRITE_QUEUE_LOG_INTERVAL_MS) {
        activeWriteQueueLastDropLogAtRef.current = now;
        console.warn("[oom-diagnostics:webview]", {
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
    terminal.options.theme = isTransparent ? applyTransparency(baseTheme, background.overlayDarken) : baseTheme;
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
  }, [fontSize, effectiveFontFamily, terminalScrollbackRows, resolvedTheme, terminalThemeName, lightThemePalette, darkThemePalette, isTransparent, background.overlayDarken]);

  // Visibility drives live rendering. A pane tab is "visible" when it is the
  // shown tab in its own pane — which, in a split, includes panes that are not
  // the globally focused one. When a tab becomes visible, flush any output
  // stashed while it was hidden and refit to its current size. This keeps a
  // split's unfocused half rendering live instead of freezing until clicked.
  useEffect(() => {
    const wasVisible = isVisibleRef.current;
    isVisibleRef.current = isVisible;
    if (!isVisible || !fitAddonRef.current || !containerRef.current) return;
    // Flush data stashed while this tab was hidden
    if (!wasVisible && inactiveBufferRef.current.length > 0 && terminalRef.current) {
      const combined = inactiveBufferRef.current.join("");
      inactiveBufferRef.current = [];
      inactiveBufferSizeRef.current = 0;
      enqueueActiveWrite(combined);
    }
    // Wait one frame to ensure display:block has taken effect and layout is stable.
    scheduleFit(true);
    if (terminalRef.current) {
      normalizeTuiComposerBackground(terminalRef.current);
      scheduleTuiComposerBackgroundNormalization(terminalRef.current);
    }
  }, [isVisible]);

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
      theme: isTransparentRef.current ? applyTransparency(baseTheme, background.overlayDarken) : baseTheme,
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
    if (!isTransparentRef.current && !isLightTerminalTheme(baseTheme)) {
      try {
        webglAddon = new WebglAddon();
      // GPU 上下文丢失（驱动崩溃 / GPU 进程重启 / 长会话）后 WebGL 渲染会僵死。
      // 注册 contextLoss 回调，丢失时 dispose 让 xterm 自动回落到 Canvas 渲染器。
        webglAddon.onContextLoss(() => {
          webglAddon?.dispose();
          webglAddon = null;
        });
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
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      pasteIntoTerminal(text);
    };

    pasteTarget.addEventListener("paste", onPaste, pasteListenerOptions);

    const isPointInsidePasteTarget = (x: number, y: number) => {
      const rect = pasteTarget.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    const hasTerminalFileDragData = (dataTransfer: DataTransfer | null) => (
      Boolean(getTerminalFileDragText()) || Boolean(dataTransfer?.types.includes(TERMINAL_FILE_PATH_MIME))
    );
    const getShellForPathQuoting = async () => {
      const os = await getOsPlatformForPathQuoting();
      const session = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
      const sessionShell = normalizeShellForKnownOs(session?.shell, os);
      if (sessionShell) return sessionShell;
      const defaultShell = normalizeShellForKnownOs(useSettingsStore.getState().defaultShell, os);
      return defaultShell ?? defaultShellForOs(os);
    };

    const onDragOver = (e: DragEvent) => {
      const isActiveTerminalFileDrag = Boolean(getTerminalFileDragText());
      if (!isActiveTerminalFileDrag && (!isPointInsidePasteTarget(e.clientX, e.clientY) || !hasTerminalFileDragData(e.dataTransfer))) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      if (!isPointInsidePasteTarget(e.clientX, e.clientY) || !hasTerminalFileDragData(e.dataTransfer)) return;
      const text = getTerminalFileDragText()
        || e.dataTransfer?.getData(TERMINAL_FILE_PATH_MIME)
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
      const scaleFactor = await getCurrentWindow().scaleFactor().catch(() => window.devicePixelRatio || 1);
      if (fileDropCancelled) return;
      const position = payload.position.toLogical(scaleFactor);
      if (!isPointInsidePasteTarget(position.x, position.y)) return;

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

    terminal.attachCustomKeyEventHandler((e) => {
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
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        navigator.clipboard.readText().then((text) => {
          pasteIntoTerminal(wrapTerminalPasteTextForCtrlShiftV(text));
        }).catch((err) => {
          logError("Failed to read clipboard text", { sessionId, err });
        });
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
        navigator.clipboard.readText().then((text) => {
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

    terminal.onData((data) => {
      markAttentionInputHandled();
      const inputBufferBefore = inputBuffer.current;
      const sessionShell = useTerminalStore.getState().sessions.find((s) => s.id === sessionId)?.shell;
      const ptyData = data === "\r" && isDirectCodexStartupCommand(inputBufferBefore)
        ? formatManualDirectCodexInputForPty(inputBufferBefore.trim(), normalizeShellKey(sessionShell) ?? null)
        : data;
      invoke("pty_write", { sessionId, data: ptyData }).catch((err) => reportPtyWriteError("onData", err));
      maybeLogCodexImeDuplicate(data);

      if (data === "\r") {
        const cmd = inputBuffer.current;
        if (cmd.trim()) {
          addCommand(getProjectId(), cmd);
          // 回车猜测仅作为 cmd 的 command_started 信号（store 按 origin 过滤）；
          // 其余 shell 由 shell integration OSC 序列驱动，猜测会误判。
          useTerminalStore.getState().handleShellRuntimeEvent({ sessionId, event: "command_started", origin: "input" });
        }
        inputBuffer.current = "";
      } else if (data === "\x7f" || data === "\b") {
        inputBuffer.current = inputBuffer.current.slice(0, -1);
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        inputBuffer.current += data;
      } else if (data.length > 1) {
        const pastedText = data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
        if (!pastedText.startsWith("\x1b")) {
          inputBuffer.current += pastedText.replace(/\r\n?/g, "\n");
        }
      }
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
      const fallbackFontSize = typeof terminal.options.fontSize === "number" ? terminal.options.fontSize : fontSize;
      return {
        width: rect.width > 0 ? rect.width / Math.max(1, terminal.cols) : Math.max(1, fallbackFontSize * 0.6),
        height: rect.height > 0 ? rect.height / Math.max(1, terminal.rows) : Math.max(1, fallbackFontSize * 1.2),
      };
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
        scheduleCompositionScrollRestore();
        scheduleCompositionAnchorFix();
        return;
      }
      if (!textarea || document.activeElement !== textarea) return;
      scheduleTerminalContainerScrollReset();
      scheduleHelperTextareaAnchorPin();
    });
    const renderDisposable = terminal.onRender(() => {
      scheduleTuiComposerBackgroundNormalization(terminal);
      if (!isComposingRef.current) return;
      scheduleCompositionScrollRestore();
      scheduleCompositionAnchorFix();
    });

    const onCompositionStart = () => {
      isComposingRef.current = true;
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
      const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, current + (e.deltaY > 0 ? -1 : 1)));
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
      cancelPendingCursorShow();
      pasteTarget.removeEventListener("paste", onPaste, pasteListenerOptions);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
      fileDropCancelled = true;
      unlistenFileDrop?.();
      contextMenuTarget.removeEventListener("contextmenu", onContextMenu);
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
      if (activeWriteRafRef.current !== null) {
        cancelAnimationFrame(activeWriteRafRef.current);
        activeWriteRafRef.current = null;
      }
      if (tuiComposerNormalizeRafRef.current !== null) {
        cancelAnimationFrame(tuiComposerNormalizeRafRef.current);
        tuiComposerNormalizeRafRef.current = null;
      }
      pendingChunks = [];
      activeWriteQueueRef.current = [];
      activeWriteQueueSizeRef.current = 0;
      inactiveBufferRef.current = [];
      inactiveBufferSizeRef.current = 0;
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
    navigator.clipboard.readText().then((text) => {
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

  return (
    <div
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
      <div ref={containerRef} className="h-full w-full overflow-hidden pl-2" />
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
