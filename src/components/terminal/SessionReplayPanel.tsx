import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Bot,
  Camera,
  Clock3,
  Code2,
  GitFork,
  KeyRound,
  ListFilter,
  MessageSquare,
  Network,
  PlugZap,
  RotateCcw,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import {
  useReplayStore,
  type ReplayEvent,
  type ReplayEventKind,
  type ReplayEventStatus,
  type ReplaySession,
  type ReplayWorktreeSnapshot,
} from "../../stores/replayStore";
import type { HistoryMessage } from "../../lib/types";
import { ConfirmDialog } from "../ConfirmDialog";
import { DiffModal } from "../history/DiffModal";
import { EmptyHint, HeaderPill, TERM_PANEL, panelColorTint } from "../stats/termStatsUi";

interface SessionReplayPanelProps {
  activeSessionId: string | null;
  open: boolean;
  visible?: boolean;
}

type ReplayFilter = "all" | ReplayEventKind;

const FILTERS: Array<{ key: ReplayFilter; labelKey: TranslationKey }> = [
  { key: "all", labelKey: "aiReplay.filter.all" },
  { key: "tool", labelKey: "aiReplay.filter.tool" },
  { key: "mcp", labelKey: "aiReplay.filter.mcp" },
  { key: "skill", labelKey: "aiReplay.filter.skill" },
  { key: "subtask", labelKey: "aiReplay.filter.subtask" },
  { key: "snapshot", labelKey: "aiReplay.filter.snapshot" },
  { key: "error", labelKey: "aiReplay.filter.error" },
];

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
  notification: { icon: Bot, color: TERM_PANEL.yellow, labelKey: "aiReplay.kind.notification" },
  snapshot: { icon: Camera, color: TERM_PANEL.yellow, labelKey: "aiReplay.kind.snapshot" },
  error: { icon: AlertTriangle, color: TERM_PANEL.red, labelKey: "aiReplay.kind.error" },
};

const STATUS_KEYS: Record<ReplayEventStatus, TranslationKey> = {
  recorded: "aiReplay.status.recorded",
  running: "aiReplay.status.running",
  completed: "aiReplay.status.completed",
  failed: "aiReplay.status.failed",
  attention: "aiReplay.status.attention",
  saved: "aiReplay.status.saved",
  planned: "aiReplay.status.planned",
};

const TIMELINE_LINE_LEFT = "calc(78px + 12px + 14px)";
const OOM_PATCH_WARN_BYTES = 1024 * 1024;
const OOM_REPLAY_EVENTS_WARN_COUNT = 200;
type TranslateFn = (key: TranslationKey, params?: Record<string, string | number>) => string;
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

function stringByteLength(value: string): number {
  if (typeof Blob !== "undefined") return new Blob([value]).size;
  return value.length;
}

function logReplayPanelOomDiagnostic(phase: string, fields: Record<string, unknown>, warn = false): void {
  const payload = {
    area: "aiReplayPanel",
    phase,
    ...fields,
  };
  if (warn) {
    console.warn("[oom-diagnostics:webview]", payload);
  } else {
    console.info("[oom-diagnostics:webview]", payload);
  }
}

function statusColor(status: ReplayEventStatus): string {
  if (status === "failed" || status === "attention") return TERM_PANEL.red;
  if (status === "running") return TERM_PANEL.magenta;
  if (status === "saved" || status === "planned") return TERM_PANEL.yellow;
  return TERM_PANEL.green;
}

function formatClock(timestamp: string, language: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString(language, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatElapsed(firstTimestamp: string | null, timestamp: string): string {
  if (!firstTimestamp) return "+00:00";
  const start = Date.parse(firstTimestamp);
  const current = Date.parse(timestamp);
  if (!Number.isFinite(start) || !Number.isFinite(current)) return "+00:00";
  const totalSeconds = Math.max(0, Math.round((current - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `+${minutes}:${seconds}`;
}

function stringifyPayload(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .slice(0, 12);
  return entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

function eventMatches(event: ReplayEvent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    event.title,
    event.detail,
    event.kind,
    event.status,
    event.tags.join(" "),
    stringifyPayload(event.payload),
  ].some((value) => value.toLowerCase().includes(q));
}

function getStringPayload(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function buildPromptReplayTitle(message: string | null | undefined): string | null {
  const normalized = message?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const maxLength = 72;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function getReplaySourceLabel(source: string | null | undefined, t: TranslateFn): string {
  if (source === "codex") return t("aiReplay.source.codex");
  if (source === "claude") return t("aiReplay.source.claude");
  return t("aiReplay.source.default");
}

function isGeneratedReplaySessionTitle(title: string): boolean {
  const normalized = title.trim();
  if (!normalized) return true;
  return [
    /^codex cli (?:session started|running|done|subagent started|subagent done|needs attention)$/i,
    /^claude code (?:session started|running|done|failed|subagent started|subagent done|agent tool started|agent tool done|tool started|tool done|needs attention)$/i,
    /^(?:SessionStart|UserPromptSubmit|Notification|Stop|StopFailure|PermissionRequest)$/i,
    /^(?:codex|claude|cli) replay$/i,
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

function SummaryMetricCard({
  icon,
  label,
  value,
  color,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div
      className="min-w-0 rounded-xl border px-2.5 py-2.5"
      style={{ backgroundColor: TERM_PANEL.card, borderColor: TERM_PANEL.border }}
    >
      <div className="flex items-center gap-2 text-[10px] font-semibold" style={{ color: TERM_PANEL.dim }}>
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg"
          style={{ color, backgroundColor: panelColorTint(color, 12) }}
        >
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2.5 truncate text-[20px] font-semibold leading-none tabular-nums" style={{ color }} title={value}>
        {value}
      </div>
    </div>
  );
}

function DetailMetric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div
      className="min-w-0 rounded-xl border px-3 py-2.5"
      style={{ backgroundColor: TERM_PANEL.cardInner, borderColor: TERM_PANEL.border }}
    >
      <div className="truncate text-[10px]" style={{ color: TERM_PANEL.dim }}>
        {label}
      </div>
      <div className="truncate text-[13px] font-semibold tabular-nums" style={{ color }} title={value}>
        {value}
      </div>
    </div>
  );
}

function SessionSummaryCard({
  session,
  title,
  viewingHistory,
  language,
}: {
  session: ReplaySession | null;
  title: string;
  viewingHistory: boolean;
  language: string;
}) {
  const { t } = useI18n();
  if (!session) return null;

  return (
    <section
      className="shrink-0 rounded-xl border px-3 py-3"
      style={{ backgroundColor: TERM_PANEL.card, borderColor: TERM_PANEL.border }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <HeaderPill color={viewingHistory ? TERM_PANEL.yellow : TERM_PANEL.cyan}>
              {viewingHistory ? t("aiReplay.historySession") : t("aiReplay.currentSession")}
            </HeaderPill>
            <span className="truncate text-[10px]" style={{ color: TERM_PANEL.dim }}>
              {getReplaySourceLabel(session.source, t)}
            </span>
          </div>
          <div className="mt-2 truncate text-[13px] font-semibold leading-6" style={{ color: TERM_PANEL.fg }} title={title}>
            {title}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>
            <span>{formatClock(session.updatedAt, language)}</span>
            <span className="inline-block h-1 w-1 rounded-full" style={{ backgroundColor: statusColor(session.status) }} />
            <span>
              {session.eventCount} {t("aiReplay.metric.events")}
            </span>
          </div>
        </div>
        <HeaderPill color={statusColor(session.status)}>{t(STATUS_KEYS[session.status])}</HeaderPill>
      </div>
    </section>
  );
}

function EventMetaGrid({
  event,
  firstTimestamp,
  language,
}: {
  event: ReplayEvent;
  firstTimestamp: string | null;
  language: string;
}) {
  const { t } = useI18n();

  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(108px, 1fr))" }}
    >
      <DetailMetric label={t("aiReplay.detail.event")} value={`#${event.eventIndex}`} color={KIND_META[event.kind].color} />
      <DetailMetric label={t("aiReplay.detail.status")} value={t(STATUS_KEYS[event.status])} color={statusColor(event.status)} />
      <DetailMetric label={t("aiReplay.detail.elapsed")} value={formatElapsed(firstTimestamp, event.timestamp)} color={TERM_PANEL.cyan} />
      <DetailMetric label={t("aiReplay.detail.time")} value={formatClock(event.timestamp, language)} color={TERM_PANEL.fg} />
    </div>
  );
}

function SnapshotDetail({
  event,
  latestSnapshot,
  rollbackPending,
  forkPending,
  firstTimestamp,
  language,
  onViewSnapshot,
  onRollback,
  onFork,
}: {
  event: ReplayEvent;
  latestSnapshot: ReplayEvent | null;
  rollbackPending: boolean;
  forkPending: boolean;
  firstTimestamp: string | null;
  language: string;
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
    <div className="space-y-3">
      <EventMetaGrid event={event} firstTimestamp={firstTimestamp} language={language} />
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}
      >
        <DetailMetric
          label={t("aiReplay.detail.checkpoint")}
          value={String(event.payload.checkpointId ?? `#${event.eventIndex}`)}
          color={TERM_PANEL.yellow}
        />
        <DetailMetric
          label={t("aiReplay.detail.files")}
          value={String(files.length || (event.payload.changedFiles ?? 0))}
          color={TERM_PANEL.blue}
        />
      </div>
      {event.detail && (
        <p className="text-[12px] leading-6" style={{ color: TERM_PANEL.fg }}>
          {event.detail}
        </p>
      )}
      {files.length > 0 && (
        <div className="space-y-2">
          {files.slice(0, 4).map((file) => (
            <div
              key={file}
              className="truncate rounded-xl px-3 py-2 text-[11px]"
              style={{ color: TERM_PANEL.fg, backgroundColor: TERM_PANEL.cardInner }}
            >
              {file}
            </div>
          ))}
        </div>
      )}
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(104px, 1fr))" }}
      >
        <ActionButton
          icon={<Code2 size={12} />}
          label={t("aiReplay.action.viewSnapshot")}
          disabled={!canView}
          onClick={() => onViewSnapshot(event)}
        />
        <ActionButton
          icon={<RotateCcw size={12} />}
          label={rollbackPending ? t("aiReplay.action.rollbackRunning") : t("aiReplay.action.rollback")}
          disabled={!canRollback || rollbackPending || !latestSnapshot}
          onClick={() => {
            if (latestSnapshot) onRollback(event, latestSnapshot);
          }}
        />
        <ActionButton
          icon={<GitFork size={12} />}
          label={forkPending ? t("aiReplay.action.forkRunning") : t("aiReplay.action.fork")}
          disabled={!canRollback || forkPending || !latestSnapshot}
          onClick={() => {
            if (latestSnapshot) onFork(event, latestSnapshot);
          }}
        />
      </div>
    </div>
  );
}

function GenericDetail({
  event,
  firstTimestamp,
  language,
}: {
  event: ReplayEvent;
  firstTimestamp: string | null;
  language: string;
}) {
  const payloadText = stringifyPayload(event.payload);

  return (
    <div className="space-y-3">
      <EventMetaGrid event={event} firstTimestamp={firstTimestamp} language={language} />
      {event.detail && (
        <p className="text-[12px] leading-6" style={{ color: TERM_PANEL.fg }}>
          {event.detail}
        </p>
      )}
      {event.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {event.tags.slice(0, 8).map((tag) => (
            <span
              key={tag}
              className="rounded-full border px-2 py-1 text-[10px]"
              style={{ color: TERM_PANEL.dim, borderColor: TERM_PANEL.border }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      {payloadText && (
        <pre
          className="max-h-36 overflow-auto whitespace-pre-wrap rounded-xl border p-3 text-[10px] leading-5 ui-thin-scroll"
          style={{ color: TERM_PANEL.dim, backgroundColor: TERM_PANEL.cardInner, borderColor: TERM_PANEL.border }}
        >
          {payloadText}
        </pre>
      )}
    </div>
  );
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
      className="ui-focus-ring flex min-w-0 items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
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

export function SessionReplayPanel({ activeSessionId, open, visible = true }: SessionReplayPanelProps) {
  const { t, language } = useI18n();
  const sessions = useReplayStore((state) => state.sessions);
  const eventsBySession = useReplayStore((state) => state.eventsBySession);
  const selectedSessionKey = useReplayStore((state) => state.selectedSessionKey);
  const loading = useReplayStore((state) => state.loading);
  const ready = useReplayStore((state) => state.ready);
  const error = useReplayStore((state) => state.error);
  const loadRecentSessions = useReplayStore((state) => state.loadRecentSessions);
  const loadSession = useReplayStore((state) => state.loadSession);
  const selectSession = useReplayStore((state) => state.selectSession);
  const captureCodeSnapshot = useReplayStore((state) => state.captureCodeSnapshot);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ReplayFilter>("all");
  const [selectedEventIndex, setSelectedEventIndex] = useState<number | null>(null);
  const [rollbackPending, setRollbackPending] = useState(false);
  const [forkPending, setForkPending] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingReplayAction | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [snapshotDiffMessages, setSnapshotDiffMessages] = useState<HistoryMessage[] | null>(null);
  const panelActive = open && visible;

  useEffect(() => {
    if (!panelActive) return;
    void loadRecentSessions(12, activeSessionId);
    if (activeSessionId) void selectSession(activeSessionId);
  }, [activeSessionId, loadRecentSessions, panelActive, selectSession]);

  useEffect(() => {
    setHistoryOpen(false);
  }, [activeSessionId]);

  useEffect(() => {
    if (!panelActive) return;
    logReplayPanelOomDiagnostic("panelActive", {
      activeSessionId,
      knownSessions: sessions.length,
      selectedSessionKey,
    }, sessions.length >= 12);
  }, [activeSessionId, panelActive, selectedSessionKey, sessions.length]);

  const selectedSession = sessions.find((session) => session.sessionKey === selectedSessionKey) ?? null;
  const selectedSessionEvents = selectedSessionKey ? eventsBySession[selectedSessionKey] : undefined;
  const events = selectedSessionKey ? eventsBySession[selectedSessionKey] ?? [] : [];
  const selectedSessionTitle = resolveReplaySessionTitle(selectedSession, selectedSessionEvents, t);
  const viewingHistory = Boolean(activeSessionId && selectedSessionKey && selectedSessionKey !== activeSessionId);
  const historySessions = useMemo(
    () => sessions.filter((session) => session.sessionKey !== activeSessionId),
    [activeSessionId, sessions]
  );
  const firstTimestamp = events[0]?.timestamp ?? null;
  const latestSnapshot = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].kind === "snapshot") return events[index];
    }
    return null;
  }, [events]);

  const summary = useMemo(
    () => ({
      events: events.length,
      tools: events.filter((event) => event.kind === "tool" || event.kind === "mcp" || event.kind === "skill").length,
      subtasks: events.filter((event) => event.kind === "subtask").length,
    }),
    [events]
  );

  const filteredEvents = useMemo(
    () => events.filter((event) => (filter === "all" || event.kind === filter) && eventMatches(event, query)),
    [events, filter, query]
  );
  const timelineEvents = useMemo(
    () => [...filteredEvents].sort((a, b) => b.eventIndex - a.eventIndex),
    [filteredEvents]
  );

  const selectedEvent = useMemo(() => {
    if (timelineEvents.length === 0) return null;
    if (selectedEventIndex !== null) {
      const exact = timelineEvents.find((event) => event.eventIndex === selectedEventIndex);
      if (exact) return exact;
    }
    return timelineEvents[0];
  }, [timelineEvents, selectedEventIndex]);

  useEffect(() => {
    if (!selectedEvent) return;
    setSelectedEventIndex(selectedEvent.eventIndex);
  }, [selectedEvent]);

  useEffect(() => {
    setSelectedEventIndex(null);
  }, [selectedSessionKey]);

  useEffect(() => {
    setPendingAction(null);
  }, [panelActive, selectedSessionKey]);

  const handleSelectReplaySession = async (sessionKey: string) => {
    setHistoryOpen(false);
    setSelectedEventIndex(null);
    await selectSession(sessionKey);
  };

  const handleBackToCurrent = async () => {
    if (!activeSessionId) return;
    setHistoryOpen(false);
    setSelectedEventIndex(null);
    await selectSession(activeSessionId);
  };

  const handleRollback = (event: ReplayEvent, latest: ReplayEvent) => {
    const projectPath = getStringPayload(event.payload, "projectPath");
    const targetPatch = getStringPayload(event.payload, "patch");
    const expectedCurrentPatch = getStringPayload(latest.payload, "patch");
    const targetHead = getStringPayload(event.payload, "head");
    if (!selectedSessionKey || !projectPath || targetPatch === null || expectedCurrentPatch === null || !targetHead) return;
    setPendingAction({
      kind: "rollback",
      sessionKey: selectedSessionKey,
      projectPath,
      targetPatch,
      expectedCurrentPatch,
      targetHead,
    });
  };

  const handleFork = (event: ReplayEvent, latest: ReplayEvent) => {
    const projectPath = getStringPayload(event.payload, "projectPath");
    const targetPatch = getStringPayload(event.payload, "patch");
    const expectedCurrentPatch = getStringPayload(latest.payload, "patch");
    const targetHead = getStringPayload(event.payload, "head");
    if (!selectedSessionKey || !projectPath || targetPatch === null || expectedCurrentPatch === null || !targetHead) return;

    const branchName = buildSnapshotForkBranchName(event);
    setPendingAction({
      kind: "fork",
      sessionKey: selectedSessionKey,
      projectPath,
      targetPatch,
      expectedCurrentPatch,
      targetHead,
      branchName,
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
      filteredEvents: filteredEvents.length,
      thresholdExceeded: patchBytes >= OOM_PATCH_WARN_BYTES || events.length >= OOM_REPLAY_EVENTS_WARN_COUNT,
    }, patchBytes >= OOM_PATCH_WARN_BYTES || events.length >= OOM_REPLAY_EVENTS_WARN_COUNT);
    setSnapshotDiffMessages([
      {
        role: "assistant",
        content: patch,
        timestamp: event.timestamp,
      },
    ]);
  };

  if (!panelActive) return null;

  const selectedMeta = selectedEvent ? KIND_META[selectedEvent.kind] : null;
  const DetailIcon = selectedMeta?.icon ?? Sparkles;

  return (
    <div className="ui-thin-scroll flex h-full min-h-0 flex-col gap-2 overflow-x-hidden overflow-y-auto p-2 font-mono" style={{ backgroundColor: TERM_PANEL.bg }}>
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
            style={{ color: TERM_PANEL.cyan, backgroundColor: panelColorTint(TERM_PANEL.cyan, 12) }}
          >
            <Sparkles size={14} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[12px] font-bold" style={{ color: TERM_PANEL.fg }}>
              {t("aiReplay.title")}
            </div>
            <div className="truncate text-[10px]" style={{ color: TERM_PANEL.dim }}>
              {selectedSessionTitle}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {viewingHistory && activeSessionId && (
            <button
              type="button"
              className="ui-focus-ring rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold transition-colors"
              style={{
                color: TERM_PANEL.cyan,
                borderColor: panelColorTint(TERM_PANEL.cyan, 34),
                backgroundColor: panelColorTint(TERM_PANEL.cyan, 8),
              }}
              onClick={() => void handleBackToCurrent()}
            >
              {t("aiReplay.action.backToCurrent")}
            </button>
          )}
          <button
            type="button"
            disabled={historySessions.length === 0}
            className="ui-focus-ring flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45"
            style={{
              color: historyOpen ? TERM_PANEL.yellow : TERM_PANEL.dim,
              borderColor: historyOpen ? panelColorTint(TERM_PANEL.yellow, 34) : TERM_PANEL.border,
              backgroundColor: historyOpen ? panelColorTint(TERM_PANEL.yellow, 8) : "transparent",
            }}
            onClick={() => setHistoryOpen((value) => !value)}
          >
            <Clock3 size={12} />
            <span>{t("aiReplay.history")}</span>
            {historySessions.length > 0 && <span className="tabular-nums">{historySessions.length}</span>}
          </button>
          <HeaderPill color={error ? TERM_PANEL.red : ready ? TERM_PANEL.green : TERM_PANEL.yellow}>
            {error ? t("aiReplay.health.error") : ready ? t("aiReplay.health.persisted") : t("aiReplay.health.pending")}
          </HeaderPill>
        </div>
      </div>

      <SessionSummaryCard
        session={selectedSession}
        title={selectedSessionTitle}
        viewingHistory={viewingHistory}
        language={language}
      />

      {historyOpen && (
        <section
          className="shrink-0 rounded-xl border px-2.5 py-2.5"
          style={{ backgroundColor: TERM_PANEL.card, borderColor: TERM_PANEL.border }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold" style={{ color: TERM_PANEL.fg }}>
              {t("aiReplay.history")}
            </span>
            <span className="text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>
              {historySessions.length}
            </span>
          </div>
          {historySessions.length === 0 ? (
            <EmptyHint text={t("aiReplay.empty.history")} />
          ) : (
            <div className="max-h-32 space-y-1.5 overflow-y-auto pr-1 ui-thin-scroll">
              {historySessions.map((session) => {
                const selected = session.sessionKey === selectedSessionKey;
                const tone = statusColor(session.status);
                const title = resolveReplaySessionTitle(session, eventsBySession[session.sessionKey], t);
                return (
                  <button
                    key={session.sessionKey}
                    type="button"
                    className="ui-focus-ring w-full rounded-lg border px-2.5 py-2 text-left transition-colors"
                    style={{
                      backgroundColor: selected ? panelColorTint(TERM_PANEL.yellow, 10, TERM_PANEL.cardInner) : TERM_PANEL.cardInner,
                      borderColor: selected ? panelColorTint(TERM_PANEL.yellow, 34) : TERM_PANEL.border,
                    }}
                    onClick={() => void handleSelectReplaySession(session.sessionKey)}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-semibold leading-5" style={{ color: selected ? TERM_PANEL.yellow : TERM_PANEL.fg }}>
                          {title}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>
                          <span>{formatClock(session.updatedAt, language)}</span>
                          <span className="inline-block h-1 w-1 rounded-full" style={{ backgroundColor: tone }} />
                          <span>
                            {session.eventCount} {t("aiReplay.metric.events")}
                          </span>
                        </div>
                      </div>
                      <HeaderPill color={tone}>{t(STATUS_KEYS[session.status])}</HeaderPill>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}

      <div
        className="grid shrink-0 gap-1.5"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(92px, 1fr))" }}
      >
        <SummaryMetricCard icon={<Clock3 size={15} />} label={t("aiReplay.metric.events")} value={String(summary.events)} color={TERM_PANEL.cyan} />
        <SummaryMetricCard icon={<Wrench size={15} />} label={t("aiReplay.metric.tools")} value={String(summary.tools)} color={TERM_PANEL.blue} />
        <SummaryMetricCard icon={<Network size={15} />} label={t("aiReplay.metric.subtasks")} value={String(summary.subtasks)} color={TERM_PANEL.magenta} />
      </div>

      <section
        className="flex min-h-[220px] shrink-0 flex-[1_0_220px] flex-col overflow-hidden rounded-xl border px-2.5 py-2.5"
        style={{ backgroundColor: TERM_PANEL.card, borderColor: TERM_PANEL.border }}
      >
        <div className="flex items-center gap-2 text-[11px] font-bold" style={{ color: TERM_PANEL.fg }}>
          <ListFilter size={12} style={{ color: TERM_PANEL.dim }} />
          <span>{t("aiReplay.timeline")}</span>
        </div>
        <div className="relative mt-2.5">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
            size={12}
            style={{ color: TERM_PANEL.dim }}
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="ui-focus-ring h-9 w-full rounded-lg border bg-transparent pl-9 pr-3 text-[11px] outline-none"
            style={{ color: TERM_PANEL.fg, borderColor: TERM_PANEL.border }}
            placeholder={t("aiReplay.search")}
          />
        </div>
        <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-1 ui-thin-scroll">
          {FILTERS.map((item) => {
            const selected = filter === item.key;
            return (
              <button
                key={item.key}
                type="button"
                className="ui-focus-ring shrink-0 rounded-full border px-3 py-1.5 text-[10px] font-semibold transition-colors"
                style={{
                  color: selected ? TERM_PANEL.cyan : TERM_PANEL.dim,
                  borderColor: selected ? panelColorTint(TERM_PANEL.cyan, 36) : TERM_PANEL.border,
                  backgroundColor: selected ? panelColorTint(TERM_PANEL.cyan, 9) : "transparent",
                }}
                onClick={() => setFilter(item.key)}
              >
                {t(item.labelKey)}
              </button>
            );
          })}
        </div>
        <div
          className="mt-3 min-h-0 flex-1 overflow-y-auto border-t pt-3 ui-thin-scroll"
          style={{ borderColor: panelColorTint(TERM_PANEL.border, 100) }}
        >
          {loading && events.length === 0 ? (
            <EmptyHint text={t("common.loading")} />
          ) : timelineEvents.length === 0 ? (
            <EmptyHint text={t(error ? "aiReplay.empty.error" : "aiReplay.empty.timeline")} />
          ) : (
            <div className="relative space-y-2">
              <div
                className="absolute bottom-3 top-3 w-px"
                style={{ left: TIMELINE_LINE_LEFT, backgroundColor: panelColorTint(TERM_PANEL.border, 100) }}
              />
              {timelineEvents.map((event) => {
                const meta = KIND_META[event.kind];
                const Icon = meta.icon;
                const selected = selectedEvent?.eventIndex === event.eventIndex;
                const color = meta.color;
                return (
                  <button
                    key={`${event.sessionKey}:${event.eventIndex}`}
                    type="button"
                    className="ui-focus-ring relative grid w-full grid-cols-[78px_28px_minmax(0,1fr)_auto] items-start gap-x-3 rounded-lg border px-2.5 py-2.5 text-left transition-colors"
                    style={{
                      backgroundColor: selected ? panelColorTint(color, 10, TERM_PANEL.cardInner) : "transparent",
                      borderColor: selected ? panelColorTint(color, 36) : "transparent",
                    }}
                    onClick={() => setSelectedEventIndex(event.eventIndex)}
                  >
                    {selected && (
                      <span
                        className="absolute bottom-3 left-0 top-3 w-1 rounded-r-full"
                        style={{ backgroundColor: color }}
                      />
                    )}
                    <div className="pr-1 text-right tabular-nums">
                      <div className="text-[11px] font-semibold" style={{ color }}>
                        {formatClock(event.timestamp, language)}
                      </div>
                      <div className="mt-0.5 text-[9px]" style={{ color: TERM_PANEL.dim }}>
                        {formatElapsed(firstTimestamp, event.timestamp)}
                      </div>
                    </div>
                    <span
                      className="relative z-[1] mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border"
                      style={{
                        color,
                        backgroundColor: TERM_PANEL.card,
                        borderColor: panelColorTint(color, 45),
                      }}
                    >
                      <Icon size={14} strokeWidth={2} />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-semibold leading-5" style={{ color: TERM_PANEL.fg }}>
                        {event.title}
                      </div>
                      <div className="mt-1 text-[10px] leading-5" style={{ color: TERM_PANEL.dim }}>
                        {event.detail || t(meta.labelKey)}
                      </div>
                    </div>
                    <HeaderPill color={statusColor(event.status)}>{t(STATUS_KEYS[event.status])}</HeaderPill>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section
        className="flex min-h-[160px] max-h-[38vh] flex-[0_1_220px] flex-col overflow-hidden rounded-xl border px-2.5 py-2.5"
        style={{ backgroundColor: TERM_PANEL.card, borderColor: TERM_PANEL.border }}
      >
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2 text-[12px] font-semibold" style={{ color: TERM_PANEL.fg }}>
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg"
              style={{
                color: selectedMeta?.color ?? TERM_PANEL.cyan,
                backgroundColor: panelColorTint(selectedMeta?.color ?? TERM_PANEL.cyan, 12),
              }}
            >
              <DetailIcon size={13} strokeWidth={2} />
            </span>
            <span className="truncate">
              {selectedEvent?.kind === "snapshot" ? t("aiReplay.snapshotDetail") : t("aiReplay.eventDetail")}
            </span>
          </span>
          {selectedEvent && (
            <span className="shrink-0 text-[11px] font-semibold tabular-nums" style={{ color: TERM_PANEL.dim }}>
              #{selectedEvent.eventIndex}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1 ui-thin-scroll">
          {!selectedEvent ? (
            <EmptyHint text={t("aiReplay.empty.detail")} />
          ) : selectedEvent.kind === "snapshot" ? (
            <SnapshotDetail
              event={selectedEvent}
              latestSnapshot={latestSnapshot}
              rollbackPending={rollbackPending}
              forkPending={forkPending}
              firstTimestamp={firstTimestamp}
              language={language}
              onViewSnapshot={handleViewSnapshot}
              onRollback={handleRollback}
              onFork={handleFork}
            />
          ) : (
            <GenericDetail event={selectedEvent} firstTimestamp={firstTimestamp} language={language} />
          )}
        </div>
      </section>
      <DiffModal
        open={Boolean(snapshotDiffMessages)}
        messages={snapshotDiffMessages ?? undefined}
        onClose={() => setSnapshotDiffMessages(null)}
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
