import { useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Terminal } from "@xterm/xterm";
import {
  TERMINAL_INPUT_SUGGESTION_AI_MODEL,
  TERMINAL_INPUT_SUGGESTION_BUILTIN_PROMPT,
  getLocalTerminalInputSuggestions,
  getTerminalInputSuggestionAiResult,
  getTerminalPathInputSuggestions,
  mergeTerminalInputSuggestions,
  type TerminalInputSuggestion,
  type TerminalInputSuggestionContext,
} from "../lib/terminalInputSuggestions";
import type { CommandHistoryEntry, CommandTemplate, TerminalSession } from "../lib/types";
import { useCommandHistoryStore } from "../stores/commandHistoryStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useTemplateStore } from "../stores/templateStore";
import { useTerminalStore } from "../stores/terminalStore";

const SUGGESTION_CONTEXT_CACHE_TTL_MS = 2_000;
const SUGGESTION_LOCAL_DEBOUNCE_MS = 80;
const SUGGESTION_AI_DEBOUNCE_MS = 400;

export interface TerminalSuggestionGhostState {
  suffix: string;
  left: number;
  top: number;
  height: number;
  maxWidth: number;
}

interface TerminalCellSize {
  width: number;
  height: number;
}

interface UseTerminalInputOptions {
  sessionId: string;
  wrapperRef: RefObject<HTMLDivElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  isActiveRef: RefObject<boolean>;
  isVisibleRef: RefObject<boolean>;
  isComposingRef: RefObject<boolean>;
  fontSize: number;
  getInput: () => string;
  canShowSuggestionAtCurrentInputEnd: (terminal: Terminal, input: string) => boolean;
  getTerminalRenderedCellSize: (terminal: Terminal, container: HTMLElement, fallbackFontSize: number) => TerminalCellSize;
  setSuggestionGhost: Dispatch<SetStateAction<TerminalSuggestionGhostState | null>>;
}

interface SuggestionContextCache {
  loadedAt: number;
  projectId: string | null;
  history: CommandHistoryEntry[];
  templates: CommandTemplate[];
}

export interface UseTerminalInputResult {
  attachSuggestions: (terminal: Terminal, forwardSuggestionInput: (data: string) => void) => () => void;
  clearSuggestion: () => void;
  cancelAiSuggestionRefresh: () => void;
  scheduleSuggestionRefresh: () => void;
  updateSuggestionGhostPosition: () => void;
  acceptSuggestion: () => boolean;
  onCommandSubmitted: (command: string) => void;
}

export function useTerminalInput({
  sessionId,
  wrapperRef,
  containerRef,
  isActiveRef,
  isVisibleRef,
  isComposingRef,
  fontSize,
  getInput,
  canShowSuggestionAtCurrentInputEnd,
  getTerminalRenderedCellSize,
  setSuggestionGhost,
}: UseTerminalInputOptions): UseTerminalInputResult {
  const suggestionRef = useRef<TerminalInputSuggestion | null>(null);
  const suggestionRequestIdRef = useRef(0);
  const suggestionRefreshTimerIdRef = useRef<number | null>(null);
  const aiSuggestionTimerIdRef = useRef<number | null>(null);
  const aiSuggestionInFlightRef = useRef(false);
  const aiSuggestionQueuedRef = useRef(false);
  const pendingAiSuggestionContextRef = useRef<TerminalInputSuggestionContext | null>(null);
  const pendingAiSuggestionRequestIdRef = useRef(0);
  const suggestionDisposedRef = useRef(false);
  const attachmentGenerationRef = useRef(0);
  const suggestionTemplatesLoadedRef = useRef(false);
  const lastSubmittedCommandRef = useRef<string | null>(null);
  const suggestionContextCacheRef = useRef<SuggestionContextCache | null>(null);
  const clearSuggestionRef = useRef<() => void>(() => {});
  const cancelAiSuggestionRefreshRef = useRef<() => void>(() => {});
  const scheduleSuggestionRefreshRef = useRef<() => void>(() => {});
  const updateSuggestionGhostPositionRef = useRef<() => void>(() => {});
  const acceptSuggestionRef = useRef<() => boolean>(() => false);

  const resetSuggestionState = () => {
    const generation = attachmentGenerationRef.current + 1;
    attachmentGenerationRef.current = generation;
    if (suggestionRefreshTimerIdRef.current !== null) {
      window.clearTimeout(suggestionRefreshTimerIdRef.current);
    }
    if (aiSuggestionTimerIdRef.current !== null) {
      window.clearTimeout(aiSuggestionTimerIdRef.current);
    }
    suggestionRef.current = null;
    suggestionRequestIdRef.current = 0;
    suggestionRefreshTimerIdRef.current = null;
    aiSuggestionTimerIdRef.current = null;
    aiSuggestionInFlightRef.current = false;
    aiSuggestionQueuedRef.current = false;
    pendingAiSuggestionContextRef.current = null;
    pendingAiSuggestionRequestIdRef.current = 0;
    suggestionDisposedRef.current = false;
    suggestionTemplatesLoadedRef.current = false;
    lastSubmittedCommandRef.current = null;
    suggestionContextCacheRef.current = null;
    setSuggestionGhost(null);
    return generation;
  };

  const attachSuggestions = (terminal: Terminal, forwardSuggestionInput: (data: string) => void) => {
    // Input contract: session-scoped suggestion state must reset before every attach.
    const attachmentGeneration = resetSuggestionState();
    const isCurrentAttachment = () => (
      attachmentGenerationRef.current === attachmentGeneration && !suggestionDisposedRef.current
    );

    const clearSuggestion = () => {
      suggestionRef.current = null;
      setSuggestionGhost(null);
    };

    const cancelAiSuggestionRefresh = () => {
      if (aiSuggestionTimerIdRef.current !== null) {
        window.clearTimeout(aiSuggestionTimerIdRef.current);
        aiSuggestionTimerIdRef.current = null;
      }
      pendingAiSuggestionContextRef.current = null;
      aiSuggestionQueuedRef.current = false;
    };

    const updateSuggestionGhostPosition = () => {
      const suggestion = suggestionRef.current;
      if (
        !suggestion
        || !isCurrentAttachment()
        || !isActiveRef.current
        || !isVisibleRef.current
        || isComposingRef.current
      ) {
        clearSuggestion();
        return;
      }
      const input = getInput();
      if (!canShowSuggestionAtCurrentInputEnd(terminal, input)) {
        clearSuggestion();
        return;
      }
      const wrapper = wrapperRef.current;
      const container = containerRef.current;
      if (!wrapper || !container) {
        clearSuggestion();
        return;
      }

      const screen = container.querySelector(".xterm-screen") as HTMLElement | null;
      const wrapperRect = wrapper.getBoundingClientRect();
      const screenRect = (screen ?? container).getBoundingClientRect();
      const fallbackFontSize = typeof terminal.options.fontSize === "number" ? terminal.options.fontSize : fontSize;
      const cell = getTerminalRenderedCellSize(terminal, container, fallbackFontSize);
      const buffer = terminal.buffer.active;
      const left = screenRect.left - wrapperRect.left + Math.max(0, buffer.cursorX) * cell.width;
      const top = screenRect.top - wrapperRect.top + Math.max(0, buffer.cursorY) * cell.height;
      const maxWidth = Math.max(0, wrapperRect.right - wrapperRect.left - left - 8);
      if (maxWidth < cell.width || top < 0 || top > wrapperRect.height) {
        clearSuggestion();
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
          current
          && current.suffix === nextGhost.suffix
          && current.left === nextGhost.left
          && current.top === nextGhost.top
          && current.height === nextGhost.height
          && current.maxWidth === nextGhost.maxWidth
        ) {
          return current;
        }
        return nextGhost;
      });
    };

    const loadSuggestionContext = async (projectId: string | null) => {
      const now = Date.now();
      const cached = suggestionContextCacheRef.current;
      if (cached && cached.projectId === projectId && now - cached.loadedAt <= SUGGESTION_CONTEXT_CACHE_TTL_MS) {
        return cached;
      }

      const templateStore = useTemplateStore.getState();
      if (!suggestionTemplatesLoadedRef.current && templateStore.templates.length === 0) {
        suggestionTemplatesLoadedRef.current = true;
        await templateStore.fetchTemplates().catch(() => {});
      }
      const [history, templates] = await Promise.all([
        useCommandHistoryStore.getState().getRecent(null, 120),
        Promise.resolve(useTemplateStore.getState().getForContext(projectId, sessionId)),
      ]);
      const context = {
        loadedAt: Date.now(),
        projectId,
        history,
        templates,
      };
      suggestionContextCacheRef.current = context;
      return context;
    };

    const buildSuggestionContext = (
      input: string,
      session: TerminalSession | undefined,
      history: CommandHistoryEntry[],
      templates: CommandTemplate[],
    ): TerminalInputSuggestionContext => {
      const settings = useSettingsStore.getState();
      return {
        input,
        projectId: session?.projectId ?? null,
        cwd: session?.cwd ?? null,
        shell: session?.shell ?? null,
        sessionId,
        previousCommand: lastSubmittedCommandRef.current,
        history,
        templates,
        provider: settings.terminalInputSuggestionProvider,
        model: TERMINAL_INPUT_SUGGESTION_AI_MODEL,
        debugLogging: settings.debugMode,
        aiConfig: {
          enabled: settings.terminalInputSuggestionLlmEnabled,
          baseUrl: settings.terminalInputSuggestionBaseUrl,
          apiKey: settings.terminalInputSuggestionApiKey,
          model: settings.terminalInputSuggestionModel,
          prompt: settings.terminalInputSuggestionUseBuiltinPrompt
            ? TERMINAL_INPUT_SUGGESTION_BUILTIN_PROMPT
            : settings.terminalInputSuggestionCustomPrompt,
        },
      };
    };

    const hasUsableAiConfig = (context: TerminalInputSuggestionContext) => Boolean(
      context.aiConfig?.enabled
      && context.aiConfig.baseUrl.trim()
      && context.aiConfig.apiKey.trim()
      && context.aiConfig.model.trim()
      && context.aiConfig.prompt.trim(),
    );

    const runPendingAiSuggestion = async (): Promise<void> => {
      if (aiSuggestionInFlightRef.current) {
        aiSuggestionQueuedRef.current = true;
        return;
      }
      const context = pendingAiSuggestionContextRef.current;
      const requestId = pendingAiSuggestionRequestIdRef.current;
      if (!context) return;
      pendingAiSuggestionContextRef.current = null;
      aiSuggestionQueuedRef.current = false;
      aiSuggestionInFlightRef.current = true;
      const result = await getTerminalInputSuggestionAiResult(context);
      aiSuggestionInFlightRef.current = false;
      if (result.aiAttempt) {
        useSettingsStore.getState().recordTerminalInputSuggestionUsage(result.aiAttempt);
      }
      if (
        isCurrentAttachment()
        && requestId === suggestionRequestIdRef.current
        && useSettingsStore.getState().terminalInputSuggestionsEnabled
        && context.input === getInput()
        && result.suggestions.length > 0
      ) {
        suggestionRef.current = result.suggestions[0];
        updateSuggestionGhostPosition();
      }
      if (aiSuggestionQueuedRef.current && pendingAiSuggestionContextRef.current) {
        void runPendingAiSuggestion();
      }
    };

    const scheduleAiSuggestionRefresh = (context: TerminalInputSuggestionContext, requestId: number) => {
      if (!hasUsableAiConfig(context)) {
        cancelAiSuggestionRefresh();
        return;
      }
      pendingAiSuggestionContextRef.current = context;
      pendingAiSuggestionRequestIdRef.current = requestId;
      if (aiSuggestionTimerIdRef.current !== null) {
        window.clearTimeout(aiSuggestionTimerIdRef.current);
      }
      aiSuggestionTimerIdRef.current = window.setTimeout(() => {
        aiSuggestionTimerIdRef.current = null;
        void runPendingAiSuggestion();
      }, SUGGESTION_AI_DEBOUNCE_MS);
    };

    const refreshSuggestionGhost = async () => {
      const requestId = ++suggestionRequestIdRef.current;
      const settings = useSettingsStore.getState();
      const input = getInput();
      if (
        !isCurrentAttachment()
        || !settings.terminalInputSuggestionsEnabled
        || !input
        || input.includes("\n")
        || input.includes("\r")
        || isComposingRef.current
      ) {
        cancelAiSuggestionRefresh();
        clearSuggestion();
        return;
      }

      const session = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
      const projectId = session?.projectId ?? null;
      const { history, templates } = await loadSuggestionContext(projectId);
      if (!isCurrentAttachment() || requestId !== suggestionRequestIdRef.current || input !== getInput()) return;
      if (!useSettingsStore.getState().terminalInputSuggestionsEnabled) {
        cancelAiSuggestionRefresh();
        clearSuggestion();
        return;
      }

      const context = buildSuggestionContext(input, session, history, templates);
      const localSuggestions = getLocalTerminalInputSuggestions(context, { limit: 1 });
      suggestionRef.current = localSuggestions[0] ?? null;
      updateSuggestionGhostPosition();
      scheduleAiSuggestionRefresh(context, requestId);

      void getTerminalPathInputSuggestions(context, { limit: 1 })
        .then((pathSuggestions) => {
          if (
            !isCurrentAttachment()
            || requestId !== suggestionRequestIdRef.current
            || input !== getInput()
            || !useSettingsStore.getState().terminalInputSuggestionsEnabled
            || suggestionRef.current?.source === "ai"
          ) {
            return;
          }
          suggestionRef.current = mergeTerminalInputSuggestions(
            [...localSuggestions, ...pathSuggestions],
            { limit: 1 },
          )[0] ?? null;
          updateSuggestionGhostPosition();
        })
        .catch(() => {});
    };

    const scheduleSuggestionRefresh = () => {
      if (suggestionRefreshTimerIdRef.current !== null) {
        window.clearTimeout(suggestionRefreshTimerIdRef.current);
      }
      suggestionRefreshTimerIdRef.current = window.setTimeout(() => {
        suggestionRefreshTimerIdRef.current = null;
        void refreshSuggestionGhost();
      }, SUGGESTION_LOCAL_DEBOUNCE_MS);
    };

    const acceptSuggestion = () => {
      const suggestion = suggestionRef.current;
      const settings = useSettingsStore.getState();
      if (!settings.terminalInputSuggestionsEnabled || !suggestion?.suffix) return false;
      clearSuggestion();
      forwardSuggestionInput(suggestion.suffix);
      settings.recordTerminalInputSuggestionUsage({ accepted: true });
      return true;
    };

    clearSuggestionRef.current = clearSuggestion;
    cancelAiSuggestionRefreshRef.current = cancelAiSuggestionRefresh;
    scheduleSuggestionRefreshRef.current = scheduleSuggestionRefresh;
    updateSuggestionGhostPositionRef.current = updateSuggestionGhostPosition;
    acceptSuggestionRef.current = acceptSuggestion;

    return () => {
      if (attachmentGenerationRef.current !== attachmentGeneration) return;
      suggestionDisposedRef.current = true;
      if (suggestionRefreshTimerIdRef.current !== null) {
        window.clearTimeout(suggestionRefreshTimerIdRef.current);
        suggestionRefreshTimerIdRef.current = null;
      }
      cancelAiSuggestionRefresh();
      clearSuggestion();
      clearSuggestionRef.current = () => {};
      cancelAiSuggestionRefreshRef.current = () => {};
      scheduleSuggestionRefreshRef.current = () => {};
      updateSuggestionGhostPositionRef.current = () => {};
      acceptSuggestionRef.current = () => false;
    };
  };

  return {
    attachSuggestions,
    clearSuggestion: () => clearSuggestionRef.current(),
    cancelAiSuggestionRefresh: () => cancelAiSuggestionRefreshRef.current(),
    scheduleSuggestionRefresh: () => scheduleSuggestionRefreshRef.current(),
    updateSuggestionGhostPosition: () => updateSuggestionGhostPositionRef.current(),
    acceptSuggestion: () => acceptSuggestionRef.current(),
    onCommandSubmitted: (command) => {
      lastSubmittedCommandRef.current = command;
      suggestionContextCacheRef.current = null;
    },
  };
}
