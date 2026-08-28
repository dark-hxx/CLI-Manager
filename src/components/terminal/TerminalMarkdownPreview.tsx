import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type WheelEvent as ReactWheelEvent } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { invoke } from "@tauri-apps/api/core";
import { useI18n, type AppLanguage } from "../../lib/i18n";
import { normalizeFontFamilyStack } from "../../lib/systemFonts";
import type { HistoryMessage, HistorySessionDetail, HistorySource, Project, TerminalSession } from "../../lib/types";
import { resolveCliToolHistorySourceId } from "../../lib/cliTools";
import { formatTime } from "../history/historyViewUtils";
import { useTerminalPreviewTheme } from "../../hooks/useTerminalPreviewTheme";
import { resolveTerminalProjectPath } from "../../lib/terminalOscPath";
import { buildSshAgentHistoryContext, type SshAgentHistoryContext } from "../../lib/sshAgentHistory";
import { useProjectStore } from "../../stores/projectStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  fetchLatestProjectSessionDetail,
  fetchRemoteLatestProjectSessionDetail,
} from "../../stores/historyStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { Check, ChevronDown } from "lucide-react";
import { FileText, RefreshCw, X } from "../icons";
import { SessionTranscriptContent } from "../history/SessionTranscriptContent";
import { FontSizeControl, useFontSizeControlVisibility } from "../ui/FontSizeControl";

const LOCAL_RETRY_DELAYS_MS = [0, 180, 420];
type PreviewError = "noSession" | "loadFailed";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function inferSourceFromText(value: string): HistorySource | null {
  const normalized = value.toLowerCase();
  if (/\bclaude\b/u.test(normalized)) return "claude";
  if (/\bcodex\b/u.test(normalized)) return "codex";
  return null;
}

export function resolveTerminalMarkdownSource(
  session: TerminalSession | null | undefined,
  project: Project | null | undefined,
): HistorySource | null {
  if (!session && !project) return null;
  const explicitSource = [session?.cliTool, project?.cli_tool]
    .map((value) => resolveCliToolHistorySourceId(value))
    .find((value): value is HistorySource => value !== null);
  if (explicitSource) return explicitSource;

  const inferredSource = inferSourceFromText(
    `${session?.startupCmd ?? ""} ${session?.title ?? ""} ${project?.cli_tool ?? ""}`,
  );
  return inferredSource;
}

export function isTerminalMarkdownPreviewSupported(
  session: TerminalSession | null | undefined,
  project: Project | null | undefined,
): boolean {
  return resolveTerminalMarkdownSource(session, project) !== null;
}

interface MarkdownPreviewMessage {
  messageIndex: number;
  order: number;
  content: string;
  timestamp: string | null;
}

function selectAssistantMarkdownMessages(detail: HistorySessionDetail): MarkdownPreviewMessage[] {
  const messages: MarkdownPreviewMessage[] = [];
  for (let messageIndex = 0; messageIndex < detail.messages.length; messageIndex += 1) {
    const message: HistoryMessage | undefined = detail.messages[messageIndex];
    if (message?.role.toLowerCase() !== "assistant" || message.content.trim().length === 0) continue;
    messages.push({
      messageIndex,
      order: messages.length + 1,
      content: message.content,
      timestamp: message.timestamp ?? null,
    });
  }
  return messages;
}

const MARKDOWN_SOURCE_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*(?:md|markdown)[ \t]*\n([\s\S]*?)\n\1[ \t]*$/i;
const MARKDOWN_PREVIEW_FONT_SIZE_MIN = 8;
const MARKDOWN_PREVIEW_FONT_SIZE_MAX = 32;

function unwrapFencedMarkdown(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  const match = MARKDOWN_SOURCE_FENCE.exec(normalized);
  return match?.[2] ?? content;
}

function formatPreviewMessageTime(timestamp: string | null, language: AppLanguage): string {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? formatTime(parsed, language) : "—";
}

interface MarkdownPreviewAnswerSelectProps {
  messages: readonly MarkdownPreviewMessage[];
  selectedMessageIndex: number | null;
  onSelect: (messageIndex: number) => void;
  formatOption: (message: MarkdownPreviewMessage) => string;
  ariaLabel: string;
  title: string;
  terminalPreviewStyle: CSSProperties;
}

function MarkdownPreviewAnswerSelect({
  messages,
  selectedMessageIndex,
  onSelect,
  formatOption,
  ariaLabel,
  title,
  terminalPreviewStyle,
}: MarkdownPreviewAnswerSelectProps) {
  const selectedValue = selectedMessageIndex ?? messages[0]?.messageIndex;
  if (selectedValue == null) return null;

  return (
    <SelectPrimitive.Root
      value={String(selectedValue)}
      onValueChange={(value) => onSelect(Number(value))}
    >
      <SelectPrimitive.Trigger
        className="terminal-markdown-preview-message-select ui-focus-ring inline-flex min-w-0 max-w-[48%] items-center justify-between gap-1 rounded-md px-1.5 py-1 text-[10px] outline-none"
        aria-label={ariaLabel}
        title={title}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          <SelectPrimitive.Value />
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown size={11} className="shrink-0 opacity-70 transition-transform data-[state=open]:rotate-180" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          align="end"
          sideOffset={4}
          className="terminal-markdown-preview-answer-popover z-[1000] overflow-hidden rounded-md border py-1 text-[10px] shadow-lg"
          style={{
            ...terminalPreviewStyle,
            width: "var(--radix-select-trigger-width)",
            maxHeight: 228,
          }}
        >
          <SelectPrimitive.Viewport className="ui-thin-scroll max-h-[220px] overflow-y-auto p-0">
            {messages.map((message) => (
              <SelectPrimitive.Item
                key={message.messageIndex}
                value={String(message.messageIndex)}
                className="terminal-markdown-preview-answer-option relative flex cursor-pointer items-center gap-2 outline-none"
              >
                <SelectPrimitive.ItemText asChild>
                  <span className="min-w-0 flex-1 truncate">{formatOption(message)}</span>
                </SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator asChild>
                  <Check size={11} className="shrink-0" aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

interface TerminalMarkdownPreviewProps {
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

export function TerminalMarkdownPreview({ sessionId, open, onClose }: TerminalMarkdownPreviewProps) {
  const { language, t } = useI18n();
  const { tone: terminalCodeTheme, panelStyle: terminalPreviewStyle } = useTerminalPreviewTheme();
  const uiFontFamily = useSettingsStore((state) => state.uiFontFamily);
  const uiFontSize = useSettingsStore((state) => state.uiFontSize);
  const effectiveUiFontFamily = normalizeFontFamilyStack(uiFontFamily);
  const session = useTerminalStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const hookStatus = useTerminalStore((state) => state.tabStatuses[sessionId]?.hook ?? "none");
  const hookUpdatedAt = useTerminalStore((state) => state.tabStatuses[sessionId]?.hookUpdatedAt ?? null);
  const projects = useProjectStore((state) => state.projects);
  const worktrees = useWorktreeStore((state) => state.worktrees);
  const project = useMemo(
    () => (session?.projectId ? projects.find((item) => item.id === session.projectId) ?? null : null),
    [projects, session?.projectId],
  );
  const worktree = useMemo(
    () => (session?.worktreeId ? worktrees.find((item) => item.id === session.worktreeId) ?? null : null),
    [session?.worktreeId, worktrees],
  );
  const source = resolveTerminalMarkdownSource(session, project);
  const cliSessionId = session?.cliSessionId?.trim() || null;
  const isSshProject = project?.environment_type === "ssh" || session?.environmentType === "ssh";
  const lookupProjectPath = useMemo(() => {
    if (worktree?.path?.trim()) return worktree.path.trim();
    return resolveTerminalProjectPath(
      session?.cwd,
      isSshProject ? project?.remote_path : project?.path,
      "unknown",
    ) ?? "";
  }, [isSshProject, project?.path, project?.remote_path, session?.cwd, worktree?.path]);

  const [previewMessages, setPreviewMessages] = useState<MarkdownPreviewMessage[]>([]);
  const [selectedMessageIndex, setSelectedMessageIndex] = useState<number | null>(null);
  const [fontSize, setFontSize] = useState(uiFontSize);
  const { fontSizeControlVisible, showFontSizeControl } = useFontSizeControlVisibility();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PreviewError | null>(null);
  const remoteContextRef = useRef<SshAgentHistoryContext | null>(null);
  const requestSeqRef = useRef(0);
  const loadedTriggerRef = useRef<string | null>(null);
  const previewLoadTrigger = `${cliSessionId ?? ""}:${source ?? ""}:${lookupProjectPath}:${hookStatus}:${hookUpdatedAt ?? ""}`;
  const selectedMessage = useMemo(
    () => previewMessages.find((message) => message.messageIndex === selectedMessageIndex) ?? null,
    [previewMessages, selectedMessageIndex],
  );
  const content = selectedMessage ? unwrapFencedMarkdown(selectedMessage.content) : null;
  useEffect(() => setFontSize(uiFontSize), [uiFontSize]);

  const handlePreviewWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
    event.preventDefault();
    showFontSizeControl();
    const direction = event.deltaY < 0 ? 1 : -1;
    setFontSize((current) => Math.min(
      MARKDOWN_PREVIEW_FONT_SIZE_MAX,
      Math.max(MARKDOWN_PREVIEW_FONT_SIZE_MIN, current + direction),
    ));
  }, [showFontSizeControl]);

  const closeRemoteContext = useCallback((context: SshAgentHistoryContext | null) => {
    if (!context) return;
    void invoke("history_remote_close", {
      hostId: context.hostId,
      consumerId: context.consumerId,
    }).catch(() => undefined);
  }, []);

  useEffect(() => () => {
    closeRemoteContext(remoteContextRef.current);
    remoteContextRef.current = null;
  }, [closeRemoteContext]);

  const loadLatest = useCallback(async (trigger: string) => {
    const requestSeq = ++requestSeqRef.current;
    if (!source) return;
    if (!cliSessionId) {
      setError("noSession");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      let detail: HistorySessionDetail | null = null;
      for (let attempt = 0; attempt < LOCAL_RETRY_DELAYS_MS.length; attempt += 1) {
        if (LOCAL_RETRY_DELAYS_MS[attempt] > 0) await wait(LOCAL_RETRY_DELAYS_MS[attempt]);
        if (requestSeq !== requestSeqRef.current) return;

        if (isSshProject && project) {
          if (remoteContextRef.current?.launch.projectId !== project.id) {
            closeRemoteContext(remoteContextRef.current);
            remoteContextRef.current = await buildSshAgentHistoryContext(project);
          }
          const remote = await fetchRemoteLatestProjectSessionDetail(
            remoteContextRef.current,
            undefined,
            cliSessionId,
            session?.remoteTranscriptRef,
          );
          remoteContextRef.current = remote.context;
          detail = remote.result === "unchanged" ? null : remote.result;
        } else if (lookupProjectPath) {
          if (remoteContextRef.current) {
            closeRemoteContext(remoteContextRef.current);
            remoteContextRef.current = null;
          }
          const waitForCatalogRefresh = attempt === 0;
          const local = await fetchLatestProjectSessionDetail(
            lookupProjectPath,
            undefined,
            source,
            cliSessionId,
            { forceCatalogRefresh: true, freshDetail: true, waitForCatalogRefresh },
          );
          detail = local === "unchanged" ? null : local;
        }

        if (detail) break;
      }

      if (requestSeq !== requestSeqRef.current) return;
      if (detail) {
        loadedTriggerRef.current = trigger;
        const nextMessages = selectAssistantMarkdownMessages(detail);
        setPreviewMessages(nextMessages);
        setSelectedMessageIndex((current) => {
          if (current !== null && nextMessages.some((message) => message.messageIndex === current)) return current;
          return nextMessages[nextMessages.length - 1]?.messageIndex ?? null;
        });
        setError(null);
      } else {
        setError("loadFailed");
      }
    } catch {
      if (requestSeq === requestSeqRef.current) setError("loadFailed");
    } finally {
      if (requestSeq === requestSeqRef.current) setLoading(false);
    }
  }, [cliSessionId, closeRemoteContext, isSshProject, lookupProjectPath, project, session?.remoteTranscriptRef, source]);

  useEffect(() => {
    if (!source) return;
    const completed = hookStatus === "done" || hookStatus === "failed";
    if (!open && !completed) return;
    if (loadedTriggerRef.current === previewLoadTrigger) return;
    void loadLatest(previewLoadTrigger);
  }, [hookStatus, loadLatest, open, previewLoadTrigger, source]);

  if (!open) return null;

  return (
    <aside
      className="subagent-transcript-shell ai-replay-transcript terminal-markdown-preview flex h-full w-full min-w-0 flex-col overflow-hidden border-l text-[var(--term-panel-fg)] shadow-[-12px_0_30px_rgb(0_0_0/0.12)]"
      style={terminalPreviewStyle}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,var(--border)_58%,transparent)] px-3">
        <FileText size={14} className="shrink-0 text-[var(--primary)]" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{t("terminal.markdownPreview.title")}</span>
        {previewMessages.length > 0 && (
          <MarkdownPreviewAnswerSelect
            messages={previewMessages}
            selectedMessageIndex={selectedMessageIndex}
            onSelect={setSelectedMessageIndex}
            formatOption={(message) => t("terminal.markdownPreview.answerOption", {
              index: message.order,
              time: formatPreviewMessageTime(message.timestamp, language),
            })}
            ariaLabel={t("terminal.markdownPreview.selectAnswer")}
            title={t("terminal.markdownPreview.selectAnswer")}
            terminalPreviewStyle={terminalPreviewStyle}
          />
        )}
        <button
          type="button"
          onClick={() => void loadLatest(previewLoadTrigger)}
          disabled={loading}
          className="ui-focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-secondary)] transition hover:bg-[var(--interactive-hover-bg)] hover:text-[var(--text-primary)] disabled:cursor-wait disabled:opacity-50"
          aria-label={t("terminal.markdownPreview.refresh")}
          title={t("terminal.markdownPreview.refresh")}
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : undefined} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="ui-focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-secondary)] transition hover:bg-[var(--interactive-hover-bg)] hover:text-[var(--text-primary)]"
          aria-label={t("terminal.markdownPreview.close")}
          title={t("terminal.markdownPreview.close")}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          className="ui-scrollbar h-full overflow-auto px-4 py-3"
          onWheel={handlePreviewWheel}
          style={{
            "--markdown-preview-font-size": `${fontSize}px`,
            fontFamily: effectiveUiFontFamily,
          } as CSSProperties}
        >
          {loading && !content ? (
            <div className="flex h-full items-center justify-center text-xs text-[var(--text-muted)]">
              {t("terminal.markdownPreview.loading")}
            </div>
          ) : content ? (
            <SessionTranscriptContent
              content={content}
              variant="terminal"
              terminalCodeTheme={terminalCodeTheme}
              markdownClassName="subagent-transcript-markdown"
            />
          ) : (
            <div className="flex h-full items-center justify-center px-5 text-center text-xs leading-5 text-[var(--text-muted)]">
              {error === "noSession"
                ? t("terminal.markdownPreview.noSession")
                : error === "loadFailed"
                  ? t("terminal.markdownPreview.loadFailed")
                  : t("terminal.markdownPreview.empty")}
            </div>
          )}
        </div>
        {fontSizeControlVisible && (
          <FontSizeControl
            fontSize={fontSize}
            defaultFontSize={uiFontSize}
            min={MARKDOWN_PREVIEW_FONT_SIZE_MIN}
            max={MARKDOWN_PREVIEW_FONT_SIZE_MAX}
            onChange={(next) => {
              showFontSizeControl();
              setFontSize(next);
            }}
            className="absolute bottom-3 right-3 z-20"
            style={{
              backgroundColor: "var(--term-panel-card)",
              borderColor: "var(--term-panel-border)",
              color: "var(--term-panel-fg)",
            }}
            variant="terminal"
          />
        )}
      </div>
    </aside>
  );
}
