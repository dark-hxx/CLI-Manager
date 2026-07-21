import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Bell,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  FileCode2,
  GitFork,
  History,
  KeyRound,
  MessageSquare,
  Network,
  PlugZap,
  RotateCcw,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import { debugConsoleInfo, debugConsoleWarn } from "../../lib/debugConsole";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import type { HistoryFileChangeSummary, HistoryMessage, HistorySessionDetail } from "../../lib/types";
import { fetchLatestProjectSessionDetail } from "../../stores/historyStore";
import {
  useReplayStore,
  type ReplayEvent,
  type ReplayEventKind,
  type ReplaySession,
  type ReplayWorktreeSnapshot,
} from "../../stores/replayStore";
import { ConfirmDialog } from "../ConfirmDialog";
import { DiffModal } from "../history/DiffModal";
import { SessionTranscriptContent } from "../history/SessionTranscriptContent";
import { EmptyHint, HeaderPill, TERM_PANEL, panelColorTint } from "../stats/termStatsUi";
import {
  buildReplayProgressModel,
  createReplayEventMatcher,
  type ReplayProgressModel,
  type ReplayProgressStatus,
  type ReplayProgressStep,
  type ReplayProgressStepKind,
  type ReplayProgressTurn,
} from "./replayProgressModel";

interface SessionReplayPanelProps {
  activeSessionId: string | null;
  open: boolean;
  visible?: boolean;
}

type ReplayViewMode = "progress" | "log";
type RawLogFilter = "all" | ReplayEventKind;
type TranslateFn = (key: TranslationKey, params?: Record<string, string | number>) => string;
type DiffState = { messages?: HistoryMessage[]; fileChanges?: HistoryFileChangeSummary[] };
type PendingReplayAction =
  | {
      kind: "rollback";
      sessionKey: string;
      projectPath: string;
      targetPatch: string;
      expectedCurrentPatch: string;
      targetHead: string;
    }
  | {
      kind: "fork";
      sessionKey: string;
      projectPath: string;
      targetPatch: string;
      expectedCurrentPatch: string;
      targetHead: string;
      branchName: string;
    };

const STATUS_KEYS: Record<ReplayProgressStatus, TranslationKey> = {
  recorded: "aiReplay.status.recorded",
  running: "aiReplay.status.running",
  completed: "aiReplay.status.completed",
  failed: "aiReplay.status.failed",
  attention: "aiReplay.status.attention",
  saved: "aiReplay.status.saved",
  planned: "aiReplay.status.planned",
  incomplete: "aiReplay.status.incomplete",
};

const KIND_META: Record<
  ReplayEventKind,
  { icon: ComponentType<{ size?: number; strokeWidth?: number }>; color: string; labelKey: TranslationKey }
> = {
  session: { icon: Terminal, color: TERM_PANEL.cyan, labelKey: "aiReplay.kind.session" },
  prompt: { icon: MessageSquare, color: TERM_PANEL.green, labelKey: "aiReplay.kind.prompt" },
  tool: { icon: Wrench, color: TERM_PANEL.blue, labelKey: "aiReplay.kind.tool" },
  mcp: { icon: PlugZap, color: TERM_PANEL.magenta, labelKey: "aiReplay.kind.mcp" },
  skill: { icon: Sparkles, color: TERM_PANEL.yellow, labelKey: "aiReplay.kind.skill" },
  subtask: { icon: Network, color: TERM_PANEL.cyan, labelKey: "aiReplay.kind.subtask" },
  permission: { icon: KeyRound, color: TERM_PANEL.red, labelKey: "aiReplay.kind.permission" },
  notification: { icon: Bell, color: TERM_PANEL.yellow, labelKey: "aiReplay.kind.notification" },
  snapshot: { icon: Camera, color: TERM_PANEL.yellow, labelKey: "aiReplay.kind.snapshot" },
  error: { icon: AlertTriangle, color: TERM_PANEL.red, labelKey: "aiReplay.kind.error" },
};

const STEP_META: Record<
  ReplayProgressStepKind,
  { icon: ComponentType<{ size?: number; strokeWidth?: number }>; color: string; labelKey: TranslationKey }
> = {
  tool: { icon: Wrench, color: TERM_PANEL.blue, labelKey: "aiReplay.progress.section.tools" },
  mcp: { icon: PlugZap, color: TERM_PANEL.magenta, labelKey: "aiReplay.kind.mcp" },
  skill: { icon: Sparkles, color: TERM_PANEL.yellow, labelKey: "aiReplay.kind.skill" },
  validation: { icon: CheckCircle2, color: TERM_PANEL.green, labelKey: "aiReplay.progress.section.validation" },
  file: { icon: FileCode2, color: TERM_PANEL.cyan, labelKey: "aiReplay.progress.section.files" },
  subtask: { icon: Network, color: TERM_PANEL.magenta, labelKey: "aiReplay.kind.subtask" },
  permission: { icon: KeyRound, color: TERM_PANEL.red, labelKey: "aiReplay.kind.permission" },
  notification: { icon: Bell, color: TERM_PANEL.yellow, labelKey: "aiReplay.kind.notification" },
  snapshot: { icon: Camera, color: TERM_PANEL.yellow, labelKey: "aiReplay.kind.snapshot" },
  error: { icon: AlertTriangle, color: TERM_PANEL.red, labelKey: "aiReplay.kind.error" },
};

const RAW_LOG_FILTERS: Array<{ value: RawLogFilter; labelKey: TranslationKey }> = [
  { value: "all", labelKey: "aiReplay.filter.all" },
  { value: "prompt", labelKey: "aiReplay.kind.prompt" },
  { value: "tool", labelKey: "aiReplay.filter.tool" },
  { value: "mcp", labelKey: "aiReplay.filter.mcp" },
  { value: "skill", labelKey: "aiReplay.filter.skill" },
  { value: "subtask", labelKey: "aiReplay.filter.subtask" },
  { value: "snapshot", labelKey: "aiReplay.filter.snapshot" },
  { value: "error", labelKey: "aiReplay.filter.error" },
  { value: "permission", labelKey: "aiReplay.kind.permission" },
  { value: "notification", labelKey: "aiReplay.kind.notification" },
  { value: "session", labelKey: "aiReplay.kind.session" },
];

const OOM_PATCH_WARN_BYTES = 1024 * 1024;
const OOM_REPLAY_EVENTS_WARN_COUNT = 200;

function stringByteLength(value: string): number {
  if (typeof Blob !== "undefined") return new Blob([value]).size;
  return value.length;
}

function logReplayPanelOomDiagnostic(phase: string, fields: Record<string, unknown>, warn = false): void {
  const payload = { area: "aiReplayPanel", phase, ...fields };
  if (warn) debugConsoleWarn("[oom-diagnostics:webview]", payload);
  else debugConsoleInfo("[oom-diagnostics:webview]", payload);
}

function statusColor(status: ReplayProgressStatus): string {
  if (status === "failed" || status === "attention" || status === "incomplete") return TERM_PANEL.red;
  if (status === "running") return TERM_PANEL.magenta;
  if (status === "saved" || status === "planned") return TERM_PANEL.yellow;
  return TERM_PANEL.green;
}

function formatClock(timestamp: string | null, language: string): string {
  if (!timestamp) return "--:--:--";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString(language, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return "-";
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function compactText(value: string | null | undefined, maxLength = 120): string {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function stringifyPayload(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .slice(0, 16)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

function getStringPayload(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function buildPromptReplayTitle(message: string | null | undefined): string | null {
  const normalized = message?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69).trimEnd()}...`;
}

function getReplaySourceLabel(source: string | null | undefined, t: TranslateFn): string {
  if (source === "codex") return t("aiReplay.source.codex");
  if (source === "claude") return t("aiReplay.source.claude");
  if (source === "pi") return t("aiReplay.source.pi");
  return t("aiReplay.source.default");
}

function isGeneratedReplaySessionTitle(title: string): boolean {
  const normalized = title.trim();
  if (!normalized) return true;
  return [
    /^codex cli (?:session started|running|done|subagent started|subagent done|needs attention)$/i,
    /^claude code (?:session started|running|done|failed|subagent started|subagent done|agent tool started|agent tool done|tool started|tool done|needs attention)$/i,
    /^pi agent (?:session started|running|done|needs attention)$/i,
    /^(?:SessionStart|UserPromptSubmit|Notification|Stop|StopFailure|PermissionRequest)$/i,
    /^(?:codex|claude|pi|cli) replay$/i,
  ].some((pattern) => pattern.test(normalized));
}

function resolveReplaySessionTitle(session: ReplaySession | null, events: ReplayEvent[] | undefined, t: TranslateFn): string {
  if (!session) return t("aiReplay.noSession");
  const storedTitle = session.title.trim();
  const promptEvent = events?.find((event) => event.kind === "prompt");
  const promptTitle = promptEvent
    ? buildPromptReplayTitle(getStringPayload(promptEvent.payload, "message"))
    : null;
  if (storedTitle && !isGeneratedReplaySessionTitle(storedTitle)) return storedTitle;
  if (promptTitle) return promptTitle;
  return getReplaySourceLabel(session.source, t);
}

function buildSnapshotForkBranchName(event: ReplayEvent): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `replay/${stamp}-event-${event.eventIndex}`;
}

function LiveElapsed({ startedAt, status }: { startedAt: string | null; status: ReplayProgressStatus }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== "running" || !startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, status]);
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(start)) return null;
  return <span>{formatDuration(Math.max(0, now - start))}</span>;
}

function ActionButton({
  icon,
  label,
  disabled = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="ui-focus-ring flex min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
      style={{
        color: disabled ? TERM_PANEL.dim : TERM_PANEL.cyan,
        borderColor: disabled ? TERM_PANEL.border : panelColorTint(TERM_PANEL.cyan, 34),
        backgroundColor: disabled ? "transparent" : panelColorTint(TERM_PANEL.cyan, 8),
      }}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function SnapshotActions({
  event,
  latestSnapshot,
  rollbackPending,
  forkPending,
  onViewSnapshot,
  onRollback,
  onFork,
}: {
  event: ReplayEvent;
  latestSnapshot: ReplayEvent | null;
  rollbackPending: boolean;
  forkPending: boolean;
  onViewSnapshot: (event: ReplayEvent) => void;
  onRollback: (event: ReplayEvent, latestSnapshot: ReplayEvent) => void;
  onFork: (event: ReplayEvent, latestSnapshot: ReplayEvent) => void;
}) {
  const { t } = useI18n();
  const files = Array.isArray(event.payload.changedFiles)
    ? event.payload.changedFiles.filter((item): item is string => typeof item === "string")
    : [];
  const canRollback = Boolean(
    getStringPayload(event.payload, "patch") &&
      getStringPayload(event.payload, "head") &&
      getStringPayload(event.payload, "projectPath") &&
      latestSnapshot &&
      getStringPayload(latestSnapshot.payload, "patch")
  );
  const canView = Boolean(getStringPayload(event.payload, "patch"));

  return (
    <div className="space-y-2.5">
      {files.length > 0 && (
        <div className="space-y-1">
          {files.slice(0, 6).map((file) => (
            <div
              key={file}
              className="truncate rounded-lg px-2.5 py-1.5 text-[10px]"
              style={{ color: TERM_PANEL.fg, backgroundColor: TERM_PANEL.cardInner }}
            >
              {file}
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-3 gap-1.5">
        <ActionButton icon={<Code2 size={11} />} label={t("aiReplay.action.viewSnapshot")} disabled={!canView} onClick={() => onViewSnapshot(event)} />
        <ActionButton
          icon={<RotateCcw size={11} />}
          label={rollbackPending ? t("aiReplay.action.rollbackRunning") : t("aiReplay.action.rollback")}
          disabled={!canRollback || rollbackPending || !latestSnapshot}
          onClick={() => latestSnapshot && onRollback(event, latestSnapshot)}
        />
        <ActionButton
          icon={<GitFork size={11} />}
          label={forkPending ? t("aiReplay.action.forkRunning") : t("aiReplay.action.fork")}
          disabled={!canRollback || forkPending || !latestSnapshot}
          onClick={() => latestSnapshot && onFork(event, latestSnapshot)}
        />
      </div>
    </div>
  );
}

function ConversationDetail({ turn }: { turn: ReplayProgressTurn }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const finalResponse = turn.assistantMessages[turn.assistantMessages.length - 1]?.content ?? turn.response;

  return (
    <div className="rounded-lg border" style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="ui-focus-ring flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-2 text-[11px] font-semibold" style={{ color: TERM_PANEL.fg }}>
          <MessageSquare size={12} style={{ color: TERM_PANEL.green }} />
          <span className="truncate">{t("aiReplay.progress.conversation")}</span>
        </span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className="ai-replay-transcript space-y-3 border-t px-2.5 py-2.5" style={{ borderColor: TERM_PANEL.border }}>
          <div>
            <div className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: TERM_PANEL.green }}>
              {t("aiReplay.progress.userPrompt")}
            </div>
            <SessionTranscriptContent content={turn.prompt} />
          </div>
          {finalResponse ? (
            <div>
              <div className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: TERM_PANEL.cyan }}>
                {t("aiReplay.progress.aiResponse")}
              </div>
              <SessionTranscriptContent content={finalResponse} />
            </div>
          ) : (
            <div className="text-[10px]" style={{ color: TERM_PANEL.dim }}>
              {t("aiReplay.progress.responsePending")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FileChangeDetail({ files, onViewFiles }: { files: HistoryFileChangeSummary[]; onViewFiles: (files: HistoryFileChangeSummary[]) => void }) {
  const { t } = useI18n();
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        {files.map((file) => (
          <button
            key={file.file_path}
            type="button"
            onClick={() => onViewFiles([file])}
            className="ui-focus-ring flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-left"
            style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}
          >
            <span className="min-w-0 truncate text-[10px]" style={{ color: TERM_PANEL.fg }}>{file.file_path}</span>
            <span className="shrink-0 text-[9px] tabular-nums">
              <span style={{ color: TERM_PANEL.green }}>+{file.additions}</span>
              <span className="ml-1" style={{ color: TERM_PANEL.red }}>-{file.deletions}</span>
            </span>
          </button>
        ))}
      </div>
      <ActionButton
        icon={<Code2 size={11} />}
        label={t("aiReplay.progress.viewChanges", { count: files.length, additions, deletions })}
        onClick={() => onViewFiles(files)}
      />
    </div>
  );
}

function ProgressStepRow({
  step,
  latestSnapshot,
  rollbackPending,
  forkPending,
  language,
  onViewFiles,
  onViewSnapshot,
  onRollback,
  onFork,
}: {
  step: ReplayProgressStep;
  latestSnapshot: ReplayEvent | null;
  rollbackPending: boolean;
  forkPending: boolean;
  language: string;
  onViewFiles: (files: HistoryFileChangeSummary[]) => void;
  onViewSnapshot: (event: ReplayEvent) => void;
  onRollback: (event: ReplayEvent, latestSnapshot: ReplayEvent) => void;
  onFork: (event: ReplayEvent, latestSnapshot: ReplayEvent) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const meta = STEP_META[step.kind];
  const Icon = meta.icon;
  const hasDetail = Boolean(step.inputSummary || step.outputSummary || step.files.length || step.snapshotEvent);

  return (
    <div className="rounded-lg border" style={{ borderColor: expanded ? panelColorTint(meta.color, 36) : TERM_PANEL.border }}>
      <button
        type="button"
        aria-expanded={hasDetail ? expanded : undefined}
        onClick={() => hasDetail && setExpanded((value) => !value)}
        className="ui-focus-ring grid w-full grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-2 rounded-lg px-2.5 py-2 text-left"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-md" style={{ color: meta.color, backgroundColor: panelColorTint(meta.color, 10) }}>
          <Icon size={12} strokeWidth={2} />
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[11px] font-semibold" style={{ color: TERM_PANEL.fg }}>{step.title || t(meta.labelKey)}</span>
            {step.sourceLabel && <span className="shrink-0 rounded border px-1.5 py-0.5 text-[8px]" style={{ color: meta.color, borderColor: panelColorTint(meta.color, 32) }}>{step.sourceLabel}</span>}
          </span>
          <span className="mt-0.5 block line-clamp-2 text-[9px] leading-4" style={{ color: TERM_PANEL.dim }}>{step.summary || t(meta.labelKey)}</span>
          <span className="mt-1 flex items-center gap-2 text-[8px] tabular-nums" style={{ color: TERM_PANEL.dim }}>
            <span>{formatClock(step.startedAt, language)}</span>
            {step.durationMs !== null && <span>{formatDuration(step.durationMs)}</span>}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <HeaderPill color={statusColor(step.status)}>{t(STATUS_KEYS[step.status])}</HeaderPill>
          {hasDetail && (expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />)}
        </span>
      </button>
      {expanded && hasDetail && (
        <div className="space-y-2.5 border-t px-2.5 py-2.5" style={{ borderColor: TERM_PANEL.border }}>
          {step.files.length > 0 && <FileChangeDetail files={step.files} onViewFiles={onViewFiles} />}
          {step.snapshotEvent && (
            <SnapshotActions
              event={step.snapshotEvent}
              latestSnapshot={latestSnapshot}
              rollbackPending={rollbackPending}
              forkPending={forkPending}
              onViewSnapshot={onViewSnapshot}
              onRollback={onRollback}
              onFork={onFork}
            />
          )}
          {step.inputSummary && (
            <div>
              <div className="mb-1 text-[9px] font-semibold" style={{ color: TERM_PANEL.dim }}>{t("aiReplay.progress.input")}</div>
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-lg p-2 text-[9px] leading-4 ui-thin-scroll" style={{ color: TERM_PANEL.fg, backgroundColor: TERM_PANEL.cardInner }}>{step.inputSummary}</pre>
            </div>
          )}
          {step.outputSummary && (
            <div>
              <div className="mb-1 text-[9px] font-semibold" style={{ color: TERM_PANEL.dim }}>{t("aiReplay.progress.output")}</div>
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-lg p-2 text-[9px] leading-4 ui-thin-scroll" style={{ color: TERM_PANEL.fg, backgroundColor: TERM_PANEL.cardInner }}>{step.outputSummary}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProgressView({
  model,
  historyLoading,
  historyAvailable,
  latestSnapshot,
  rollbackPending,
  forkPending,
  language,
  onViewFiles,
  onViewSnapshot,
  onRollback,
  onFork,
}: {
  model: ReplayProgressModel;
  historyLoading: boolean;
  historyAvailable: boolean;
  latestSnapshot: ReplayEvent | null;
  rollbackPending: boolean;
  forkPending: boolean;
  language: string;
  onViewFiles: (files: HistoryFileChangeSummary[]) => void;
  onViewSnapshot: (event: ReplayEvent) => void;
  onRollback: (event: ReplayEvent, latestSnapshot: ReplayEvent) => void;
  onFork: (event: ReplayEvent, latestSnapshot: ReplayEvent) => void;
}) {
  const { t } = useI18n();
  const [expandedTurnId, setExpandedTurnId] = useState<string | null>(() => model.turns[0]?.id ?? null);

  useEffect(() => {
    if (!model.turns.length) setExpandedTurnId(null);
    else if (!expandedTurnId || !model.turns.some((turn) => turn.id === expandedTurnId)) setExpandedTurnId(model.turns[0].id);
  }, [expandedTurnId, model.turns]);

  if (model.turns.length === 0) return <EmptyHint text={t("aiReplay.empty.timeline")} />;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-0.5 text-[9px]" style={{ color: TERM_PANEL.dim }}>
        <span>{t("aiReplay.progress.latestFirst")}</span>
        <span>{historyLoading ? t("aiReplay.progress.syncing") : historyAvailable ? t("aiReplay.progress.synced") : t("aiReplay.progress.hookOnly")}</span>
      </div>
      {model.turns.map((turn, index) => {
        const expanded = expandedTurnId === turn.id;
        const countParts = [
          turn.counts.tools ? t("aiReplay.progress.countTools", { count: turn.counts.tools }) : null,
          turn.counts.files ? t("aiReplay.progress.countFiles", { count: turn.counts.files }) : null,
          turn.counts.validations ? t("aiReplay.progress.countValidations", { count: turn.counts.validations }) : null,
          turn.counts.subtasks ? t("aiReplay.progress.countSubtasks", { count: turn.counts.subtasks }) : null,
          turn.counts.errors ? t("aiReplay.progress.countErrors", { count: turn.counts.errors }) : null,
        ].filter(Boolean);
        return (
          <section key={turn.id} className="overflow-hidden rounded-xl border" style={{ borderColor: expanded ? panelColorTint(TERM_PANEL.cyan, 34) : TERM_PANEL.border, backgroundColor: TERM_PANEL.card }}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedTurnId(expanded ? null : turn.id)}
              className="ui-focus-ring w-full rounded-xl px-3 py-2.5 text-left"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-1.5 text-[9px] font-semibold" style={{ color: index === 0 ? TERM_PANEL.cyan : TERM_PANEL.dim }}>
                    <MessageSquare size={10} />
                    <span>{index === 0 ? t("aiReplay.progress.currentTurn") : t("aiReplay.progress.previousTurn", { index: model.turns.length - index })}</span>
                    <span>·</span>
                    <span className="tabular-nums">{formatClock(turn.startedAt, language)}</span>
                  </div>
                  <div className="line-clamp-2 text-[11px] font-semibold leading-5" style={{ color: TERM_PANEL.fg }} title={turn.prompt}>{compactText(turn.prompt, 180) || t("aiReplay.progress.untitledTurn")}</div>
                  <div className="mt-1 line-clamp-2 text-[9px] leading-4" style={{ color: TERM_PANEL.dim }}>
                    {turn.response ? compactText(turn.response, 180) : t("aiReplay.progress.responsePending")}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <HeaderPill color={statusColor(turn.status)}>{t(STATUS_KEYS[turn.status])}</HeaderPill>
                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[8px]" style={{ color: TERM_PANEL.dim }}>
                {turn.durationMs !== null && <span>{t("aiReplay.progress.duration", { duration: formatDuration(turn.durationMs) })}</span>}
                {countParts.length > 0 ? countParts.map((part) => <span key={String(part)}>{part}</span>) : <span>{t("aiReplay.progress.noActions")}</span>}
              </div>
            </button>
            {expanded && (
              <div className="space-y-2 border-t px-2.5 py-2.5" style={{ borderColor: TERM_PANEL.border }}>
                <ConversationDetail turn={turn} />
                {turn.steps.length === 0 ? (
                  <div className="px-1 py-2 text-[10px]" style={{ color: TERM_PANEL.dim }}>{t("aiReplay.progress.noActions")}</div>
                ) : turn.steps.map((step) => (
                  <ProgressStepRow
                    key={step.id}
                    step={step}
                    latestSnapshot={latestSnapshot}
                    rollbackPending={rollbackPending}
                    forkPending={forkPending}
                    language={language}
                    onViewFiles={onViewFiles}
                    onViewSnapshot={onViewSnapshot}
                    onRollback={onRollback}
                    onFork={onFork}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function RawLogView({ events, language }: { events: ReplayEvent[]; language: string }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RawLogFilter>("all");
  const [expandedEventIndex, setExpandedEventIndex] = useState<number | null>(null);
  const queryMatcher = useMemo(() => createReplayEventMatcher(query), [query]);
  const visibleEvents = useMemo(
    () => [...events]
      .reverse()
      .filter((event) => (filter === "all" || event.kind === filter) && queryMatcher(event)),
    [events, filter, queryMatcher]
  );

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-1.5">
        <label className="flex min-w-0 items-center gap-1.5 rounded-lg border px-2" style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}>
          <Search size={11} style={{ color: TERM_PANEL.dim }} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("aiReplay.search")}
            aria-label={t("aiReplay.search")}
            className="min-w-0 flex-1 bg-transparent py-2 text-[10px] outline-none"
            style={{ color: TERM_PANEL.fg }}
          />
        </label>
        <select
          value={filter}
          onChange={(event) => setFilter(event.target.value as RawLogFilter)}
          aria-label={t("aiReplay.progress.logFilter")}
          className="ui-focus-ring min-w-0 rounded-lg border px-2 text-[10px] outline-none"
          style={{ color: TERM_PANEL.fg, borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}
        >
          {RAW_LOG_FILTERS.map((item) => <option key={item.value} value={item.value}>{t(item.labelKey)}</option>)}
        </select>
      </div>
      {visibleEvents.length === 0 ? (
        <EmptyHint text={t("aiReplay.progress.emptyLog")} />
      ) : visibleEvents.map((event) => {
        const meta = KIND_META[event.kind];
        const Icon = meta.icon;
        const expanded = expandedEventIndex === event.eventIndex;
        const payloadText = expanded ? stringifyPayload(event.payload) : "";
        return (
          <div key={`${event.sessionKey}:${event.eventIndex}`} className="overflow-hidden rounded-lg border" style={{ borderColor: expanded ? panelColorTint(meta.color, 34) : TERM_PANEL.border, backgroundColor: TERM_PANEL.card }}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedEventIndex(expanded ? null : event.eventIndex)}
              className="ui-focus-ring grid w-full grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-2 rounded-lg px-2.5 py-2 text-left"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-md" style={{ color: meta.color, backgroundColor: panelColorTint(meta.color, 10) }}>
                <Icon size={12} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[11px] font-semibold" style={{ color: TERM_PANEL.fg }}>{event.title}</span>
                <span className="mt-0.5 block line-clamp-2 text-[9px] leading-4" style={{ color: TERM_PANEL.dim }}>{event.detail || t(meta.labelKey)}</span>
                <span className="mt-1 block text-[8px] tabular-nums" style={{ color: TERM_PANEL.dim }}>{formatClock(event.timestamp, language)} · #{event.eventIndex}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <HeaderPill color={statusColor(event.status)}>{t(STATUS_KEYS[event.status])}</HeaderPill>
                {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              </span>
            </button>
            {expanded && (
              <div className="space-y-2 border-t px-2.5 py-2.5" style={{ borderColor: TERM_PANEL.border }}>
                {event.tags.length > 0 && <div className="flex flex-wrap gap-1">{event.tags.slice(0, 10).map((tag) => <span key={tag} className="rounded border px-1.5 py-0.5 text-[8px]" style={{ color: TERM_PANEL.dim, borderColor: TERM_PANEL.border }}>{tag}</span>)}</div>}
                {payloadText && <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border p-2 text-[9px] leading-4 ui-thin-scroll" style={{ color: TERM_PANEL.dim, backgroundColor: TERM_PANEL.cardInner, borderColor: TERM_PANEL.border }}>{payloadText}</pre>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function SessionReplayPanel({ activeSessionId, open, visible = true }: SessionReplayPanelProps) {
  const { t, language } = useI18n();
  const sessions = useReplayStore((state) => state.sessions);
  const eventsBySession = useReplayStore((state) => state.eventsBySession);
  const selectedSessionKey = useReplayStore((state) => state.selectedSessionKey);
  const loading = useReplayStore((state) => state.loading);
  const error = useReplayStore((state) => state.error);
  const loadRecentSessions = useReplayStore((state) => state.loadRecentSessions);
  const loadSession = useReplayStore((state) => state.loadSession);
  const selectSession = useReplayStore((state) => state.selectSession);
  const captureCodeSnapshot = useReplayStore((state) => state.captureCodeSnapshot);
  const [viewMode, setViewMode] = useState<ReplayViewMode>("progress");
  const [rollbackPending, setRollbackPending] = useState(false);
  const [forkPending, setForkPending] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingReplayAction | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const [historyDetail, setHistoryDetail] = useState<HistorySessionDetail | null>(null);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const historyDetailRef = useRef<{ sessionKey: string; detail: HistorySessionDetail } | null>(null);
  const panelActive = open && visible;

  useEffect(() => {
    if (!panelActive) return;
    void loadRecentSessions(12, activeSessionId);
    if (activeSessionId) void selectSession(activeSessionId);
  }, [activeSessionId, loadRecentSessions, panelActive, selectSession]);

  useEffect(() => {
    setHistoryOpen(false);
    setViewMode("progress");
  }, [activeSessionId]);

  const selectedSession = sessions.find((session) => session.sessionKey === selectedSessionKey) ?? null;
  const events = selectedSessionKey ? eventsBySession[selectedSessionKey] ?? [] : [];
  const selectedSessionTitle = resolveReplaySessionTitle(selectedSession, selectedSessionKey ? eventsBySession[selectedSessionKey] : undefined, t);
  const viewingHistory = Boolean(activeSessionId && selectedSessionKey && selectedSessionKey !== activeSessionId);
  const historySessions = useMemo(
    () => sessions.filter((session) => session.sessionKey !== activeSessionId),
    [activeSessionId, sessions]
  );
  const latestSnapshot = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].kind === "snapshot") return events[index];
    }
    return null;
  }, [events]);

  useEffect(() => {
    if (!panelActive || !selectedSessionKey || !selectedSession?.projectPath || !selectedSession.cliSessionId) {
      historyDetailRef.current = null;
      setHistoryDetail(null);
      setHistoryDetailLoading(false);
      return;
    }
    const source = selectedSession.source === "codex" || selectedSession.source === "claude" ? selectedSession.source : null;
    if (!source) {
      historyDetailRef.current = null;
      setHistoryDetail(null);
      setHistoryDetailLoading(false);
      return;
    }

    let cancelled = false;
    const previous = historyDetailRef.current?.sessionKey === selectedSessionKey
      ? historyDetailRef.current.detail
      : null;
    if (!previous) setHistoryDetail(null);
    setHistoryDetailLoading(true);
    const timer = window.setTimeout(() => {
      void fetchLatestProjectSessionDetail(
        selectedSession.projectPath!,
        previous ? { filePath: previous.file_path, updatedAt: previous.updated_at } : undefined,
        source,
        selectedSession.cliSessionId
      ).then((result) => {
        if (cancelled) return;
        if (result !== "unchanged") {
          setHistoryDetail(result);
          historyDetailRef.current = result ? { sessionKey: selectedSessionKey, detail: result } : null;
        }
      }).finally(() => {
        if (!cancelled) setHistoryDetailLoading(false);
      });
    }, events.length > 0 ? 450 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [events.length, panelActive, selectedSession?.cliSessionId, selectedSession?.eventCount, selectedSession?.projectPath, selectedSession?.source, selectedSession?.updatedAt, selectedSessionKey]);

  useEffect(() => {
    if (!panelActive) return;
    logReplayPanelOomDiagnostic("panelActive", {
      activeSessionId,
      knownSessions: sessions.length,
      selectedSessionKey,
      events: events.length,
    }, sessions.length >= 12 || events.length >= OOM_REPLAY_EVENTS_WARN_COUNT);
  }, [activeSessionId, events.length, panelActive, selectedSessionKey, sessions.length]);

  useEffect(() => setPendingAction(null), [panelActive, selectedSessionKey]);

  const progressModel = useMemo(
    () => buildReplayProgressModel(
      events,
      historyDetailRef.current?.sessionKey === selectedSessionKey ? historyDetail : null,
      selectedSession?.status ?? null
    ),
    [events, historyDetail, selectedSession?.status, selectedSessionKey]
  );
  const historyDetailAvailable = Boolean(
    historyDetail && historyDetailRef.current?.sessionKey === selectedSessionKey
  );

  const handleSelectReplaySession = async (sessionKey: string) => {
    setHistoryOpen(false);
    await selectSession(sessionKey);
  };

  const handleBackToCurrent = async () => {
    if (!activeSessionId) return;
    setHistoryOpen(false);
    await selectSession(activeSessionId);
  };

  const handleRollback = (event: ReplayEvent, latest: ReplayEvent) => {
    const projectPath = getStringPayload(event.payload, "projectPath");
    const targetPatch = getStringPayload(event.payload, "patch");
    const expectedCurrentPatch = getStringPayload(latest.payload, "patch");
    const targetHead = getStringPayload(event.payload, "head");
    if (!selectedSessionKey || !projectPath || targetPatch === null || expectedCurrentPatch === null || !targetHead) return;
    setPendingAction({ kind: "rollback", sessionKey: selectedSessionKey, projectPath, targetPatch, expectedCurrentPatch, targetHead });
  };

  const handleFork = (event: ReplayEvent, latest: ReplayEvent) => {
    const projectPath = getStringPayload(event.payload, "projectPath");
    const targetPatch = getStringPayload(event.payload, "patch");
    const expectedCurrentPatch = getStringPayload(latest.payload, "patch");
    const targetHead = getStringPayload(event.payload, "head");
    if (!selectedSessionKey || !projectPath || targetPatch === null || expectedCurrentPatch === null || !targetHead) return;
    setPendingAction({
      kind: "fork",
      sessionKey: selectedSessionKey,
      projectPath,
      targetPatch,
      expectedCurrentPatch,
      targetHead,
      branchName: buildSnapshotForkBranchName(event),
    });
  };

  const handleConfirmPendingAction = async () => {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);
    if (action.kind === "rollback") {
      if (rollbackPending) return;
      setRollbackPending(true);
      try {
        await invoke<ReplayWorktreeSnapshot>("git_restore_worktree_snapshot", {
          projectPath: action.projectPath,
          targetPatch: action.targetPatch,
          expectedCurrentPatch: action.expectedCurrentPatch,
          targetHead: action.targetHead,
        });
        toast.success(t("aiReplay.rollback.success"));
        await captureCodeSnapshot(action.sessionKey, action.projectPath, "rollback");
        await loadSession(action.sessionKey);
      } catch (err) {
        toast.error(t("aiReplay.rollback.failed"), { description: String(err) });
      } finally {
        setRollbackPending(false);
      }
      return;
    }

    if (forkPending) return;
    setForkPending(true);
    try {
      await invoke<ReplayWorktreeSnapshot>("git_fork_worktree_snapshot", {
        projectPath: action.projectPath,
        targetPatch: action.targetPatch,
        expectedCurrentPatch: action.expectedCurrentPatch,
        targetHead: action.targetHead,
        branchName: action.branchName,
      });
      toast.success(t("aiReplay.fork.success"), { description: action.branchName });
      await captureCodeSnapshot(action.sessionKey, action.projectPath, "fork");
      await loadSession(action.sessionKey);
    } catch (err) {
      toast.error(t("aiReplay.fork.failed"), { description: String(err) });
    } finally {
      setForkPending(false);
    }
  };

  const handleViewSnapshot = (event: ReplayEvent) => {
    const patch = getStringPayload(event.payload, "patch");
    if (!patch) return;
    const patchBytes = stringByteLength(patch);
    logReplayPanelOomDiagnostic("viewSnapshotDiff", {
      sessionKey: event.sessionKey,
      eventIndex: event.eventIndex,
      patchBytes,
      currentEvents: events.length,
      thresholdExceeded: patchBytes >= OOM_PATCH_WARN_BYTES || events.length >= OOM_REPLAY_EVENTS_WARN_COUNT,
    }, patchBytes >= OOM_PATCH_WARN_BYTES || events.length >= OOM_REPLAY_EVENTS_WARN_COUNT);
    setDiffState({ messages: [{ role: "assistant", content: patch, timestamp: event.timestamp }] });
  };

  if (!panelActive) return null;

  return (
    <div
      className="ui-thin-scroll flex h-full min-h-0 flex-col gap-2 overflow-x-hidden overflow-y-auto p-2 font-mono"
      style={{
        backgroundColor: TERM_PANEL.bg,
        "--ui-scrollbar-thumb": TERM_PANEL.border,
        "--ui-scrollbar-track": TERM_PANEL.bg,
      } as CSSProperties}
    >
      <header className="flex shrink-0 items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl" style={{ color: TERM_PANEL.cyan, backgroundColor: panelColorTint(TERM_PANEL.cyan, 12) }}>
            <Sparkles size={14} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[12px] font-bold" style={{ color: TERM_PANEL.fg }}>{t("aiReplay.title")}</div>
            <div className="truncate text-[9px]" style={{ color: TERM_PANEL.dim }} title={selectedSessionTitle}>{selectedSessionTitle}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {viewingHistory && activeSessionId && (
            <button type="button" onClick={() => void handleBackToCurrent()} className="ui-focus-ring rounded-lg border px-2 py-1.5 text-[9px] font-semibold" style={{ color: TERM_PANEL.cyan, borderColor: panelColorTint(TERM_PANEL.cyan, 34), backgroundColor: panelColorTint(TERM_PANEL.cyan, 8) }}>
              {t("aiReplay.action.backToCurrent")}
            </button>
          )}
          <button
            type="button"
            disabled={historySessions.length === 0}
            title={t("aiReplay.history")}
            aria-label={t("aiReplay.history")}
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((value) => !value)}
            className="ui-focus-ring flex h-7 w-7 items-center justify-center rounded-lg border disabled:cursor-not-allowed disabled:opacity-45"
            style={{ color: historyOpen ? TERM_PANEL.yellow : TERM_PANEL.dim, borderColor: historyOpen ? panelColorTint(TERM_PANEL.yellow, 34) : TERM_PANEL.border, backgroundColor: historyOpen ? panelColorTint(TERM_PANEL.yellow, 8) : "transparent" }}
          >
            <History size={12} />
          </button>
        </div>
      </header>

      {historyOpen && (
        <section className="shrink-0 rounded-xl border p-2" style={{ backgroundColor: TERM_PANEL.card, borderColor: TERM_PANEL.border }}>
          <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold" style={{ color: TERM_PANEL.fg }}>
            <span>{t("aiReplay.history")}</span>
            <span style={{ color: TERM_PANEL.dim }}>{historySessions.length}</span>
          </div>
          <div className="max-h-36 space-y-1 overflow-y-auto ui-thin-scroll">
            {historySessions.map((session) => {
              const selected = session.sessionKey === selectedSessionKey;
              const tone = statusColor(session.status);
              return (
                <button
                  key={session.sessionKey}
                  type="button"
                  onClick={() => void handleSelectReplaySession(session.sessionKey)}
                  className="ui-focus-ring flex w-full items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-left"
                  style={{ backgroundColor: selected ? panelColorTint(TERM_PANEL.yellow, 10, TERM_PANEL.cardInner) : TERM_PANEL.cardInner, borderColor: selected ? panelColorTint(TERM_PANEL.yellow, 34) : TERM_PANEL.border }}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[10px] font-semibold" style={{ color: selected ? TERM_PANEL.yellow : TERM_PANEL.fg }}>{resolveReplaySessionTitle(session, eventsBySession[session.sessionKey], t)}</span>
                    <span className="mt-0.5 block text-[8px] tabular-nums" style={{ color: TERM_PANEL.dim }}>{formatClock(session.updatedAt, language)} · {session.eventCount} {t("aiReplay.metric.events")}</span>
                  </span>
                  <HeaderPill color={tone}>{t(STATUS_KEYS[session.status])}</HeaderPill>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="shrink-0 rounded-xl border p-2.5" style={{ backgroundColor: TERM_PANEL.card, borderColor: TERM_PANEL.border }}>
        {loading && events.length === 0 ? (
          <EmptyHint text={t("common.loading")} />
        ) : error && events.length === 0 ? (
          <EmptyHint text={t("aiReplay.empty.error")} />
        ) : progressModel.current ? (
          <>
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg" style={{ color: statusColor(progressModel.current.status), backgroundColor: panelColorTint(statusColor(progressModel.current.status), 10) }}>
                  {progressModel.current.status === "running" ? <Clock3 size={12} /> : <CheckCircle2 size={12} />}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[11px] font-semibold" style={{ color: TERM_PANEL.fg }}>{progressModel.current.title}</div>
                  <div className="mt-0.5 line-clamp-2 text-[9px] leading-4" style={{ color: TERM_PANEL.dim }}>{progressModel.current.summary}</div>
                </div>
              </div>
              <HeaderPill color={statusColor(progressModel.current.status)}>{t(STATUS_KEYS[progressModel.current.status])}</HeaderPill>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[8px] tabular-nums" style={{ color: TERM_PANEL.dim }}>
              {progressModel.current.status === "running" && <LiveElapsed startedAt={progressModel.current.timestamp} status={progressModel.current.status} />}
              <span>{t("aiReplay.progress.countTurns", { count: progressModel.counts.turns })}</span>
              <span>{t("aiReplay.progress.countTools", { count: progressModel.counts.tools })}</span>
              <span>{t("aiReplay.progress.countFiles", { count: progressModel.counts.files })}</span>
              <span>{t("aiReplay.progress.countValidations", { count: progressModel.counts.validations })}</span>
              {progressModel.counts.errors > 0 && <span style={{ color: TERM_PANEL.red }}>{t("aiReplay.progress.countErrors", { count: progressModel.counts.errors })}</span>}
            </div>
          </>
        ) : (
          <EmptyHint text={t("aiReplay.empty.timeline")} />
        )}
      </section>

      <div className="grid shrink-0 grid-cols-2 rounded-lg border p-1" style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.card }}>
        {(["progress", "log"] as const).map((mode) => {
          const selected = viewMode === mode;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              className="ui-focus-ring rounded-md px-2 py-1.5 text-[10px] font-semibold transition-colors"
              style={{ color: selected ? TERM_PANEL.cyan : TERM_PANEL.dim, backgroundColor: selected ? panelColorTint(TERM_PANEL.cyan, 10) : "transparent" }}
            >
              {t(mode === "progress" ? "aiReplay.progress.view" : "aiReplay.progress.logView")}
            </button>
          );
        })}
      </div>

      <main className="min-h-0 flex-1">
        {viewMode === "progress" ? (
          <ProgressView
            key={`progress:${selectedSessionKey ?? "none"}`}
            model={progressModel}
            historyLoading={historyDetailLoading}
            historyAvailable={historyDetailAvailable}
            latestSnapshot={latestSnapshot}
            rollbackPending={rollbackPending}
            forkPending={forkPending}
            language={language}
            onViewFiles={(files) => setDiffState({ fileChanges: files })}
            onViewSnapshot={handleViewSnapshot}
            onRollback={handleRollback}
            onFork={handleFork}
          />
        ) : (
          <RawLogView key={`log:${selectedSessionKey ?? "none"}`} events={events} language={language} />
        )}
      </main>

      <DiffModal
        open={Boolean(diffState)}
        messages={diffState?.messages}
        fileChanges={diffState?.fileChanges}
        onClose={() => setDiffState(null)}
      />
      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction ? t(pendingAction.kind === "rollback" ? "aiReplay.action.rollback" : "aiReplay.action.fork") : ""}
        message={
          pendingAction?.kind === "rollback"
            ? t("aiReplay.rollback.confirm")
            : pendingAction?.kind === "fork"
              ? t("aiReplay.fork.confirm", { branch: pendingAction.branchName })
              : undefined
        }
        confirmText={t("common.confirm")}
        cancelText={t("common.cancel")}
        danger={pendingAction?.kind === "rollback"}
        onClose={() => setPendingAction(null)}
        onConfirm={() => void handleConfirmPendingAction()}
      />
    </div>
  );
}
