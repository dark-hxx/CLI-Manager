import type { Terminal } from "@xterm/xterm";
import {
  hasCodexTuiViewport,
  hasKnownAiTuiViewport,
  hasTuiComposerPromptViewport,
  normalizeTerminalTuiComposerBackground,
} from "./terminalTuiDisplay";
import {
  isClaudeTerminalContext,
  isCodexTerminalContext,
  isPiTerminalContext,
  type TerminalCliContext,
} from "../terminal/browser/TerminalCliContext";

export interface TerminalTuiColorSyncOptions {
  isVisible: boolean;
  isTransparent: boolean;
  isLightTheme: boolean;
  terminalTextColor?: string;
  tuiUserColor?: string;
  tuiAssistantColor?: string;
  getContext: () => TerminalCliContext;
}

export interface TerminalTuiColorSyncController {
  normalize: (terminal: Terminal) => void;
  schedule: (terminal: Terminal | null) => void;
  reset: () => void;
  dispose: () => void;
}

export function createTerminalTuiColorSyncController(
  getOptions: () => TerminalTuiColorSyncOptions,
): TerminalTuiColorSyncController {
  let frameId: number | null = null;
  let tuiSessionDetected = false;

  const normalize = (terminal: Terminal) => {
    const options = getOptions();
    // Hidden terminals still parse every PTY frame, but their TUI color scan only
    // affects rendered cells. Defer that expensive work until the tab is visible.
    if (!options.isVisible) return;
    const context = options.getContext();
    const isClaudeContext = isClaudeTerminalContext(context);
    const isPiContext = isPiTerminalContext(context);
    const hasContextualTuiPrompt = (
      (isCodexTerminalContext(context) || isClaudeContext)
      && hasTuiComposerPromptViewport(terminal)
    );
    if (hasKnownAiTuiViewport(terminal) || hasContextualTuiPrompt) tuiSessionDetected = true;

    const isTuiCodexSession = tuiSessionDetected && (
      hasCodexTuiViewport(terminal) || isCodexTerminalContext(context)
    );
    const isTuiClaudeSession = tuiSessionDetected && isClaudeContext;
    // Claude and Pi keep painting dark-theme message blocks on a light terminal even
    // before any TUI signature is latched, so session identity alone enables this pass.
    // A latched AI TUI signature covers CLIs started by hand inside a plain shell.
    const shouldEraseDarkBlocks = options.isLightTheme
      && (isClaudeContext || isPiContext || tuiSessionDetected);
    normalizeTerminalTuiComposerBackground(terminal, {
      shouldNormalize: options.isTransparent
        || ((isTuiCodexSession || isTuiClaudeSession) && options.isLightTheme)
        || shouldEraseDarkBlocks,
      isTransparent: options.isTransparent,
      isLightTheme: options.isLightTheme,
      isTuiSession: tuiSessionDetected,
      isCodexSession: isTuiCodexSession,
      isClaudeSession: isTuiClaudeSession,
      shouldEraseDarkBlocks,
      terminalTextColor: options.terminalTextColor,
      tuiUserColor: options.tuiUserColor,
      tuiAssistantColor: options.tuiAssistantColor,
    });
  };

  const schedule = (terminal: Terminal | null) => {
    if (!terminal || frameId !== null) return;
    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      normalize(terminal);
    });
  };

  const reset = () => {
    tuiSessionDetected = false;
  };

  const dispose = () => {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    reset();
  };

  return { normalize, schedule, reset, dispose };
}
