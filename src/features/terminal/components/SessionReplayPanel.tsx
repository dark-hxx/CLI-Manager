import { invoke } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUpRight,
  Bell,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  Code2,
  CornerDownRight,
  FileCode2,
  FileText,
  GitFork,
  Globe,
  History,
  Image as ImageIcon,
  KeyRound,
  ListTodo,
  MessageSquare,
  Network,
  PencilLine,
  PlugZap,
  RotateCcw,
  Search,
  SearchCode,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import { debugConsoleInfo, debugConsoleWarn } from "../../../shared/platform/debugConsole";
import { useI18n, type TranslationKey } from "../../../shared/i18n/index";
import type { HistoryFileChangeSummary, HistoryMessage, HistorySessionDetail } from "../../../shared/types/index";
import { buildSshAgentHistoryContext, type SshAgentHistoryContext } from "../../remote/api/sshAgentHistory";
import {
  fetchLatestProjectSessionDetail,
  fetchRemoteLatestProjectSessionDetail,
  type HistoryMessageTarget,
} from "../../history/index";
import { useProjectStore } from "../../projects/api/projectStore";
import {
  useReplayStore,
  type ReplayEvent,
  type ReplayEventKind,
  type ReplaySession,
  type ReplayWorktreeSnapshot,
} from "../api/replayStore";
import { ConfirmDialog } from "../../../shared/ui/ConfirmDialog";
import { DiffModal } from "../../history/api/DiffModal";
import { SessionTranscriptContent } from "../../history/api/SessionTranscriptContent";
import { useTerminalPreviewTheme } from "../api/useTerminalPreviewTheme";
import { EmptyHint, TERM_PANEL, panelColorTint } from "../../stats/api/termStatsUi";
import {
  buildReplayProgressModel,
  cleanUserPromptText,
  type ReplayProgressActivity,
  type ReplayProgressModel,
  type ReplayProgressPhase,
  type ReplayProgressStatus,
  type ReplayProgressStep,
  type ReplayProgressTurn,
} from "./replayProgressModel";
import { TerminalPanelHeader } from "../api/TerminalPanelHeader";

interface SessionReplayPanelProps {
  activeSessionId: string | null;
  open: boolean;
  visible?: boolean;
  onOpenHistoryMessage?: (target: HistoryMessageTarget) => void;
}

type IconComponent = ComponentType<{ size?: number; strokeWidth?: number; className?: string; style?: CSSProperties }>;
type TimelineFilter = "all" | "changes" | "issues";
type TimelineFocusRequest = { turnId: string; nonce: number };
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
  { icon: IconComponent; color: string; labelKey: TranslationKey }
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

const ACTIVITY_META: Record<
  ReplayProgressActivity,
  { icon: IconComponent; color: string; labelKey: TranslationKey }
> = {
  read: { icon: FileText, color: TERM_PANEL.cyan, labelKey: "aiReplay.activity.read" },
  edit: { icon: PencilLine, color: TERM_PANEL.yellow, labelKey: "aiReplay.activity.edit" },
  search: { icon: SearchCode, color: TERM_PANEL.blue, labelKey: "aiReplay.activity.search" },
  command: { icon: Terminal, color: TERM_PANEL.fg, labelKey: "aiReplay.activity.command" },
  web: { icon: Globe, color: TERM_PANEL.cyan, labelKey: "aiReplay.activity.web" },
  plan: { icon: ListTodo, color: TERM_PANEL.dim, labelKey: "aiReplay.activity.plan" },
  validation: { icon: CheckCircle2, color: TERM_PANEL.green, labelKey: "aiReplay.activity.validation" },
  mcp: { icon: PlugZap, color: TERM_PANEL.magenta, labelKey: "aiReplay.activity.mcp" },
  skill: { icon: Sparkles, color: TERM_PANEL.yellow, labelKey: "aiReplay.activity.skill" },
  subtask: { icon: Network, color: TERM_PANEL.magenta, labelKey: "aiReplay.activity.subtask" },
  permission: { icon: KeyRound, color: TERM_PANEL.red, labelKey: "aiReplay.activity.permission" },
  notification: { icon: Bell, color: TERM_PANEL.yellow, labelKey: "aiReplay.activity.notification" },
  snapshot: { icon: Camera, color: TERM_PANEL.yellow, labelKey: "aiReplay.activity.snapshot" },
  error: { icon: AlertTriangle, color: TERM_PANEL.red, labelKey: "aiReplay.activity.error" },
  file: { icon: FileCode2, color: TERM_PANEL.cyan, labelKey: "aiReplay.activity.file" },
  other: { icon: Wrench, color: TERM_PANEL.dim, labelKey: "aiReplay.activity.other" },
};

// 轮次卡片上的活动计数顺序：先产出（编辑/命令/验证），再探索（读/搜/联网），最后是外部能力与异常。
const CHIP_ORDER: ReplayProgressActivity[] = [
  "edit", "command", "validation", "read", "search", "web", "mcp", "skill", "subtask", "plan", "other", "permission", "error", "snapshot",
];

const TIMELINE_FILTERS: Array<{ value: TimelineFilter; labelKey: TranslationKey }> = [
  { value: "all", labelKey: "aiReplay.timeline.filter.all" },
  { value: "changes", labelKey: "aiReplay.timeline.filter.changes" },
  { value: "issues", labelKey: "aiReplay.timeline.filter.issues" },
];

const GAP_MARKER_MS = 2 * 60 * 1000;

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

// 系统色语义：运行中蓝、完成绿、失败红，需要留意的状态用黄，不再把未完成渲染成失败。
function statusColor(status: ReplayProgressStatus): string {
  if (status === "failed") return TERM_PANEL.red;
  if (status === "running") return TERM_PANEL.blue;
  if (status === "attention" || status === "incomplete" || status === "saved" || status === "planned") return TERM_PANEL.yellow;
  return TERM_PANEL.green;
}

// 苹果风格的材质：卡片用填充 + 发丝描边代替粗边框，浅色皮肤下仍能和背景分层；色值全部取自面板主题变量。
const TINT = TERM_PANEL.blue;
const FILL = panelColorTint(TERM_PANEL.fg, 7);
const HAIRLINE = panelColorTint(TERM_PANEL.border, 75);
const CARD_STYLE: CSSProperties = { backgroundColor: TERM_PANEL.card, boxShadow: `0 0 0 1px ${HAIRLINE}` };
const GROUP_STYLE: CSSProperties = { backgroundColor: TERM_PANEL.cardInner };

function IconTile({ icon: Icon, color, size = 18 }: { icon: IconComponent; color: string; size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-[6px]" style={{ width: size, height: size, backgroundColor: panelColorTint(color, 16) }}>
      <Icon size={Math.round(size * 0.62)} strokeWidth={2.2} style={{ color }} />
    </span>
  );
}

function StatusPill({ status, label }: { status: ReplayProgressStatus; label: string }) {
  const tone = statusColor(status);
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-semibold" style={{ color: tone, backgroundColor: panelColorTint(tone, 14) }}>
      {status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ backgroundColor: tone }} />}
      {label}
    </span>
  );
}

function Disclosure({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <ChevronRight
      size={size}
      className="shrink-0 transition-transform duration-200"
      style={{ color: TERM_PANEL.dim, opacity: 0.7, transform: open ? "rotate(90deg)" : undefined }}
    />
  );
}

// 分组列表的内缩分隔线，起点对齐图标后的文字。
function InsetDivider() {
  return <span aria-hidden className="absolute left-[34px] right-0 top-0 h-px" style={{ backgroundColor: HAIRLINE }} />;
}

function splitFilePath(path: string): { name: string; dir: string } {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() ?? path;
  return { name, dir: parts.join("/") };
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

// 人类可读的时间跨度：45s / 12m / 1h 05m。
function formatSpan(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return "-";
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

function durationBetweenTimestamps(startedAt: string | null, endedAt: string | null): number | null {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const end = endedAt ? Date.parse(endedAt) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

// 预览里只保留路径末段或命令首段，避免长路径挤掉其它目标。
function shortTarget(target: string): string {
  const firstLine = target.split("\n")[0].trim();
  if (/^[\w.@:-]*[\\/]/.test(firstLine) && !/\s/.test(firstLine)) {
    return firstLine.split(/[\\/]/).filter(Boolean).pop() ?? firstLine;
  }
  return firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine;
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
  const normalized = cleanUserPromptText(message).text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69).trimEnd()}...`;
}

function isCommandPrompt(prompt: string): boolean {
  return /^[/!]\S/.test(prompt);
}

function turnTitle(turn: ReplayProgressTurn, t: TranslateFn): string {
  return compactText(turn.prompt, 240) || (turn.images > 0 ? t("aiReplay.timeline.imageOnly") : t("aiReplay.progress.untitledTurn"));
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
      className="ui-focus-ring flex min-w-0 items-center justify-center gap-1.5 rounded-[9px] px-2.5 py-1.5 text-[11px] font-semibold transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        color: disabled ? TERM_PANEL.dim : TINT,
        backgroundColor: disabled ? FILL : panelColorTint(TINT, 14),
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
    !event.payload.patchTruncated &&
      (getStringPayload(event.payload, "patch") || getStringPayload(event.payload, "patchPath")) &&
      getStringPayload(event.payload, "head") &&
      getStringPayload(event.payload, "projectPath") &&
      latestSnapshot &&
      !latestSnapshot.payload.patchTruncated &&
      (getStringPayload(latestSnapshot.payload, "patch") || getStringPayload(latestSnapshot.payload, "patchPath"))
  );
  const canView = Boolean(getStringPayload(event.payload, "patch") || getStringPayload(event.payload, "patchPath"));

  return (
    <div className="space-y-2">
      {files.length > 0 && (
        <div className="overflow-hidden rounded-[10px]" style={{ backgroundColor: TERM_PANEL.bg }}>
          {files.slice(0, 6).map((file, index) => (
            <div
              key={file}
              className="truncate px-2.5 py-1.5 font-mono text-[10px]"
              style={{ color: TERM_PANEL.fg, borderTop: index > 0 ? `1px solid ${HAIRLINE}` : undefined }}
              title={file}
            >
              {file}
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-3 gap-1.5">
        <ActionButton icon={<Code2 size={12} />} label={t("aiReplay.action.viewSnapshot")} disabled={!canView} onClick={() => onViewSnapshot(event)} />
        <ActionButton
          icon={<RotateCcw size={12} />}
          label={rollbackPending ? t("aiReplay.action.rollbackRunning") : t("aiReplay.action.rollback")}
          disabled={!canRollback || rollbackPending || !latestSnapshot}
          onClick={() => latestSnapshot && onRollback(event, latestSnapshot)}
        />
        <ActionButton
          icon={<GitFork size={12} />}
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
  const { tone: previewCodeTheme } = useTerminalPreviewTheme();
  const [open, setOpen] = useState(false);
  const finalResponse = turn.assistantMessages[turn.assistantMessages.length - 1]?.content ?? turn.response;

  return (
    <div className="overflow-hidden rounded-xl" style={GROUP_STYLE}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="ui-focus-ring flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <IconTile icon={MessageSquare} color={TERM_PANEL.green} />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium" style={{ color: TERM_PANEL.fg }}>{t("aiReplay.progress.conversation")}</span>
        <Disclosure open={open} />
      </button>
      {open && (
        <div className="ai-replay-transcript space-y-3 px-2.5 pb-3 pt-2.5" style={{ borderTop: `1px solid ${HAIRLINE}` }}>
          <div>
            <div className="mb-1.5 text-[10px] font-semibold" style={{ color: TERM_PANEL.dim }}>
              {t("aiReplay.progress.userPrompt")}
            </div>
            <SessionTranscriptContent
              content={turn.prompt}
              variant="terminal"
              terminalCodeTheme={previewCodeTheme}
              linkBehavior="preview"
            />
          </div>
          {finalResponse ? (
            <div>
              <div className="mb-1.5 text-[10px] font-semibold" style={{ color: TERM_PANEL.dim }}>
                {t("aiReplay.progress.aiResponse")}
              </div>
              <SessionTranscriptContent
                content={finalResponse}
                variant="terminal"
                terminalCodeTheme={previewCodeTheme}
                linkBehavior="preview"
              />
            </div>
          ) : (
            <div className="text-[11px]" style={{ color: TERM_PANEL.dim }}>
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
    <div className="overflow-hidden rounded-xl" style={GROUP_STYLE}>
      {files.map((file, index) => {
        const { name, dir } = splitFilePath(file.file_path);
        return (
          <button
            key={file.file_path}
            type="button"
            onClick={() => onViewFiles([file])}
            className="ui-focus-ring relative flex w-full items-center gap-2 px-2.5 py-[7px] text-left"
            title={file.file_path}
          >
            {index > 0 && <InsetDivider />}
            <IconTile icon={FileCode2} color={TERM_PANEL.cyan} />
            <span className="min-w-0 flex-1 truncate text-[11px]">
              <span className="font-medium" style={{ color: TERM_PANEL.fg }}>{name}</span>
              {dir && <span className="ml-1.5 text-[10px]" style={{ color: TERM_PANEL.dim }}>{dir}</span>}
            </span>
            <span className="shrink-0 font-mono text-[10px] tabular-nums">
              <span style={{ color: TERM_PANEL.green }}>+{file.additions}</span>
              <span className="ml-1" style={{ color: TERM_PANEL.red }}>-{file.deletions}</span>
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => onViewFiles(files)}
        className="ui-focus-ring flex w-full items-center justify-center gap-1.5 px-2.5 py-2 text-[11px] font-semibold transition-opacity hover:opacity-80"
        style={{ color: TINT, borderTop: `1px solid ${HAIRLINE}` }}
      >
        <Code2 size={12} />
        {t("aiReplay.progress.viewChanges", { count: files.length, additions, deletions })}
      </button>
    </div>
  );
}

function activityColor(activity: ReplayProgressActivity, status: ReplayProgressStatus): string {
  if (status === "failed") return TERM_PANEL.red;
  return ACTIVITY_META[activity].color;
}

function stepHeadline(step: ReplayProgressStep, t: TranslateFn): string {
  return step.target || step.summary || step.title || t(ACTIVITY_META[step.activity].labelKey);
}

function isTurnActive(turn: ReplayProgressTurn, latest: boolean, sessionRunning: boolean): boolean {
  return latest && (turn.status === "running" || (sessionRunning && turn.status === "incomplete"));
}

function displayTurnStatus(turn: ReplayProgressTurn, latest: boolean, sessionRunning: boolean): ReplayProgressStatus {
  return isTurnActive(turn, latest, sessionRunning) ? "running" : turn.status;
}

function currentRunningStep(turn: ReplayProgressTurn): ReplayProgressStep | null {
  for (let index = turn.steps.length - 1; index >= 0; index -= 1) {
    if (turn.steps[index].status === "running") return turn.steps[index];
  }
  return turn.steps[turn.steps.length - 1] ?? null;
}

function turnMatchesQuery(turn: ReplayProgressTurn, matcher: RegExp | null): boolean {
  if (!matcher) return true;
  if (matcher.test(turn.prompt) || (turn.response && matcher.test(turn.response))) return true;
  return turn.steps.some((step) =>
    [step.title, step.target, step.summary, step.sourceLabel, ...step.files.map((file) => file.file_path)]
      .some((value) => value && matcher.test(value))
  );
}

function turnMatchesFilter(turn: ReplayProgressTurn, filter: TimelineFilter): boolean {
  if (filter === "changes") return turn.counts.files > 0 || Boolean(turn.activityCounts.edit);
  if (filter === "issues") return turn.counts.errors > 0 || turn.status === "failed" || turn.status === "attention";
  return true;
}

function StepDetailBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold" style={{ color: TERM_PANEL.dim }}>{label}</div>
      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-lg p-2 font-mono text-[10px] leading-4 ui-thin-scroll" style={{ color: TERM_PANEL.fg, backgroundColor: TERM_PANEL.bg }}>{value}</pre>
    </div>
  );
}

function StepRow({
  step,
  compact,
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
  compact: boolean;
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
  const meta = ACTIVITY_META[step.activity];
  const color = activityColor(step.activity, step.status);
  const hasDetail = Boolean(step.inputSummary || step.outputSummary || step.files.length || step.snapshotEvent);
  const headline = stepHeadline(step, t);
  const showRawName = Boolean(step.target) && step.title !== headline;
  const flagged = step.status !== "completed" && step.status !== "recorded" && step.status !== "saved";
  const trailing = (
    <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>
      {flagged && <span className="font-semibold" style={{ color: statusColor(step.status) }}>{t(STATUS_KEYS[step.status])}</span>}
      {step.durationMs !== null ? <span>{formatSpan(step.durationMs)}</span> : <span>{formatClock(step.startedAt, language)}</span>}
      {hasDetail && <Disclosure open={expanded} size={11} />}
    </span>
  );

  return (
    <div>
      <button
        type="button"
        aria-expanded={hasDetail ? expanded : undefined}
        onClick={() => hasDetail && setExpanded((value) => !value)}
        className={`ui-focus-ring flex w-full items-center gap-2 text-left ${compact ? "py-[5px] pl-[34px] pr-2.5" : "px-2.5 py-[7px]"}`}
        style={{ cursor: hasDetail ? "pointer" : "default" }}
        title={step.inputSummary ?? headline}
      >
        {compact ? (
          <>
            <span className="h-[5px] w-[5px] shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span className={`min-w-0 flex-1 truncate text-[10.5px] ${step.target ? "font-mono" : ""}`} style={{ color: TERM_PANEL.fg }}>{headline}</span>
          </>
        ) : (
          <>
            <IconTile icon={meta.icon} color={color} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0 text-[11px] font-medium" style={{ color: TERM_PANEL.fg }}>{t(meta.labelKey)}</span>
                {(showRawName || step.sourceLabel) && (
                  <span className="min-w-0 truncate text-[9.5px]" style={{ color: TERM_PANEL.dim }}>{step.sourceLabel ?? step.title}</span>
                )}
              </span>
              <span className={`block truncate text-[10px] ${step.target ? "font-mono" : ""}`} style={{ color: TERM_PANEL.dim }}>{headline}</span>
            </span>
          </>
        )}
        {trailing}
      </button>
      {expanded && hasDetail && (
        <div className="space-y-2 pb-2.5 pl-[34px] pr-2.5 pt-0.5">
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
          {step.inputSummary && <StepDetailBlock label={t("aiReplay.progress.input")} value={step.inputSummary} />}
          {step.outputSummary && <StepDetailBlock label={t("aiReplay.progress.output")} value={step.outputSummary} />}
        </div>
      )}
    </div>
  );
}

type StepHandlers = Omit<Parameters<typeof StepRow>[0], "step" | "compact">;

function PhaseRow({ phase, handlers }: { phase: ReplayProgressPhase; handlers: StepHandlers }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (phase.steps.length === 1) return <StepRow step={phase.steps[0]} compact={false} {...handlers} />;

  const meta = ACTIVITY_META[phase.activity];
  const color = activityColor(phase.activity, phase.failed > 0 ? "failed" : phase.status);
  const preview = Array.from(new Set(phase.steps.map((step) => step.target ? shortTarget(step.target) : null).filter(Boolean))).slice(0, 3).join(" · ");
  const span = durationBetweenTimestamps(phase.startedAt, phase.endedAt);

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="ui-focus-ring flex w-full items-center gap-2 px-2.5 py-[7px] text-left"
      >
        <IconTile icon={meta.icon} color={color} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1">
            <span className="text-[11px] font-medium" style={{ color: TERM_PANEL.fg }}>{t(meta.labelKey)}</span>
            <span className="text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>×{phase.steps.length}</span>
          </span>
          {preview && <span className="block truncate font-mono text-[10px]" style={{ color: TERM_PANEL.dim }}>{preview}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>
          {phase.failed > 0 && <span className="font-semibold" style={{ color: TERM_PANEL.red }}>{t("aiReplay.timeline.failedCount", { count: phase.failed })}</span>}
          {phase.status === "running" && <span className="font-semibold" style={{ color: statusColor("running") }}>{t(STATUS_KEYS.running)}</span>}
          {span !== null && span > 0 && <span>{formatSpan(span)}</span>}
          <Disclosure open={expanded} size={11} />
        </span>
      </button>
      {expanded && (
        <div className="pb-1.5">
          {phase.steps.map((step) => <StepRow key={step.id} step={step} compact {...handlers} />)}
        </div>
      )}
    </div>
  );
}

function ActivityChips({ turn }: { turn: ReplayProgressTurn }) {
  const { t } = useI18n();
  const fileSteps = turn.steps.filter((step) => step.activity === "file");
  const additions = fileSteps.reduce((sum, step) => sum + step.files.reduce((total, file) => total + file.additions, 0), 0);
  const deletions = fileSteps.reduce((sum, step) => sum + step.files.reduce((total, file) => total + file.deletions, 0), 0);
  const failedValidations = turn.steps.filter((step) => step.activity === "validation" && step.status === "failed").length;
  const chips = CHIP_ORDER.filter((activity) => turn.activityCounts[activity]);
  if (chips.length === 0 && turn.counts.files === 0) return null;
  const chipClass = "inline-flex items-center gap-1 rounded-full px-1.5 py-[2px] text-[10px] tabular-nums";

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {turn.counts.files > 0 && (
        <span className={chipClass} style={{ color: TERM_PANEL.fg, backgroundColor: FILL }} title={t("aiReplay.activity.file")}>
          <FileCode2 size={10} style={{ color: TERM_PANEL.cyan }} />
          {turn.counts.files}
          <span style={{ color: TERM_PANEL.green }}>+{additions}</span>
          <span style={{ color: TERM_PANEL.red }}>-{deletions}</span>
        </span>
      )}
      {chips.map((activity) => {
        const meta = ACTIVITY_META[activity];
        const Icon = meta.icon;
        const failed = activity === "validation" && failedValidations > 0;
        return (
          <span
            key={activity}
            className={chipClass}
            style={{ color: failed ? TERM_PANEL.red : TERM_PANEL.dim, backgroundColor: failed ? panelColorTint(TERM_PANEL.red, 14) : FILL }}
            title={t(meta.labelKey)}
          >
            <Icon size={10} style={{ color: failed ? TERM_PANEL.red : meta.color }} />
            {turn.activityCounts[activity]}
          </span>
        );
      })}
    </div>
  );
}

function RawEventList({ events, language }: { events: ReplayEvent[]; language: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (events.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="ui-focus-ring flex items-center gap-1 rounded-md px-1 py-0.5 text-[10px]"
        style={{ color: TERM_PANEL.dim }}
      >
        <Disclosure open={open} size={10} />
        {t("aiReplay.timeline.rawEvents", { count: events.length })}
      </button>
      {open && (
        <div className="mt-1 max-h-48 space-y-0.5 overflow-y-auto rounded-xl p-2 ui-thin-scroll" style={GROUP_STYLE}>
          {events.map((event) => {
            const meta = KIND_META[event.kind];
            const Icon = meta.icon;
            return (
              <div
                key={`${event.sessionKey}:${event.eventIndex}`}
                className="grid grid-cols-[52px_12px_minmax(0,1fr)] items-center gap-1.5 text-[10px]"
                title={stringifyPayload(event.payload)}
              >
                <span className="font-mono tabular-nums" style={{ color: TERM_PANEL.dim }}>{formatClock(event.timestamp, language)}</span>
                <Icon size={10} style={{ color: meta.color }} />
                <span className="truncate" style={{ color: TERM_PANEL.fg }}>
                  {event.title}
                  {event.detail && event.detail !== event.title && <span style={{ color: TERM_PANEL.dim }}> · {event.detail}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TurnNode({
  turn,
  index,
  latest,
  first,
  last,
  sessionRunning,
  expanded,
  onToggle,
  onOpenInHistory,
  handlers,
  nodeRef,
}: {
  turn: ReplayProgressTurn;
  index: number;
  latest: boolean;
  first: boolean;
  last: boolean;
  sessionRunning: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenInHistory: (() => void) | null;
  handlers: StepHandlers;
  nodeRef: (element: HTMLDivElement | null) => void;
}) {
  const { t } = useI18n();
  const status = displayTurnStatus(turn, latest, sessionRunning);
  const active = status === "running";
  const tone = statusColor(status);
  const running = active ? currentRunningStep(turn) : null;
  const processSteps = turn.phases.reduce((sum, phase) => sum + phase.steps.length, 0);
  const fileSteps = turn.steps.filter((step) => step.activity === "file");
  const command = isCommandPrompt(turn.prompt);
  const duration = active
    ? <LiveElapsed startedAt={turn.startedAt} status="running" />
    : turn.durationMs !== null ? <span>{formatSpan(turn.durationMs)}</span> : null;

  return (
    <div ref={nodeRef} className="relative grid grid-cols-[14px_minmax(0,1fr)] gap-2.5">
      <span
        aria-hidden
        className="absolute left-[6.5px] w-px"
        style={{ top: first ? 16 : 0, bottom: last ? "calc(100% - 16px)" : 0, backgroundColor: HAIRLINE }}
      />
      <span
        aria-hidden
        className="relative z-[1] mt-[12px] h-[9px] w-[9px] justify-self-center rounded-full"
        style={{ backgroundColor: tone, boxShadow: `0 0 0 3px ${TERM_PANEL.bg}` }}
      >
        {active && <span className="absolute -inset-[3px] animate-ping rounded-full" style={{ backgroundColor: panelColorTint(tone, 45) }} />}
      </span>
      <section
        className="mb-2.5 min-w-0 overflow-hidden rounded-2xl"
        style={{ ...CARD_STYLE, boxShadow: active ? `0 0 0 1px ${panelColorTint(tone, 55)}` : CARD_STYLE.boxShadow }}
      >
        {/* 鼠标点标题行也能展开；键盘与读屏走下方的主按钮。 */}
        <div className="flex cursor-pointer items-center gap-1.5 px-3 pt-2.5 text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }} onClick={onToggle}>
          <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
            <span className="font-semibold" style={{ color: latest ? TINT : TERM_PANEL.dim }}>{t("aiReplay.timeline.turn", { index })}</span>
            <span aria-hidden>·</span>
            <span>{formatClock(turn.startedAt, handlers.language)}</span>
            {duration && <><span aria-hidden>·</span>{duration}</>}
          </span>
          {onOpenInHistory && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpenInHistory();
              }}
              title={t("aiReplay.timeline.openInHistory")}
              aria-label={t("aiReplay.timeline.openInHistory")}
              className="ui-focus-ring flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--jump-bg)] text-[var(--jump-fg)] transition-colors hover:bg-[var(--jump-hover-bg)] hover:text-[var(--jump-hover-fg)]"
              style={{
                "--jump-fg": TERM_PANEL.dim,
                "--jump-bg": FILL,
                "--jump-hover-fg": TINT,
                "--jump-hover-bg": panelColorTint(TINT, 16),
              } as CSSProperties}
            >
              <ArrowUpRight size={12} strokeWidth={2.4} />
            </button>
          )}
          {status !== "completed" && <StatusPill status={status} label={t(STATUS_KEYS[status])} />}
        </div>
        <button type="button" aria-expanded={expanded} onClick={onToggle} className="ui-focus-ring block w-full px-3 pb-2.5 pt-1 text-left">
          <div className="flex items-start gap-2">
            <div
              className={`min-w-0 flex-1 line-clamp-3 whitespace-pre-wrap break-words leading-[18px] ${command ? "font-mono text-[12px] font-medium" : "text-[12.5px] font-semibold"}`}
              style={{ color: command ? TINT : TERM_PANEL.fg }}
              title={turn.prompt}
            >
              {turn.images > 0 && (
                <span className="mr-1.5 inline-flex items-center gap-0.5 rounded-full px-1.5 align-[1px] font-sans text-[10px] font-medium" style={{ color: TERM_PANEL.dim, backgroundColor: FILL }}>
                  <ImageIcon size={10} />
                  {turn.images}
                </span>
              )}
              {turnTitle(turn, t)}
            </div>
            <span className="mt-[3px]"><Disclosure open={expanded} /></span>
          </div>
          {active && running ? (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px]">
              <span className="shrink-0 font-medium" style={{ color: tone }}>{t("aiReplay.timeline.now", { activity: t(ACTIVITY_META[running.activity].labelKey) })}</span>
              <span className={`truncate ${running.target ? "font-mono text-[10.5px]" : ""}`} style={{ color: TERM_PANEL.dim }}>{stepHeadline(running, t)}</span>
            </div>
          ) : turn.response ? (
            <div className="mt-1 flex gap-1.5 text-[11px] leading-4" style={{ color: TERM_PANEL.dim }}>
              <CornerDownRight size={11} className="mt-[2px] shrink-0" style={{ color: TERM_PANEL.green }} />
              <span className="line-clamp-2">{compactText(turn.response, 220)}</span>
            </div>
          ) : null}
          <ActivityChips turn={turn} />
        </button>
        {expanded && (
          <div className="space-y-2.5 px-2.5 pb-2.5 pt-2.5" style={{ borderTop: `1px solid ${HAIRLINE}` }}>
            <ConversationDetail turn={turn} />
            {fileSteps.map((step) => (
              <FileChangeDetail key={step.id} files={step.files} onViewFiles={handlers.onViewFiles} />
            ))}
            {turn.phases.length > 0 ? (
              <div>
                <div className="mb-1 px-1 text-[10px] font-semibold" style={{ color: TERM_PANEL.dim }}>
                  {t("aiReplay.timeline.process", { count: processSteps })}
                </div>
                <div className="overflow-hidden rounded-xl" style={GROUP_STYLE}>
                  {turn.phases.map((phase, position) => (
                    <div key={phase.id} className="relative">
                      {position > 0 && <InsetDivider />}
                      <PhaseRow phase={phase} handlers={handlers} />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="px-1 text-[11px]" style={{ color: TERM_PANEL.dim }}>{t("aiReplay.progress.noActions")}</div>
            )}
            <RawEventList events={turn.replayEvents} language={handlers.language} />
          </div>
        )}
      </section>
    </div>
  );
}

function TimelineView({
  model,
  sessionRunning,
  focusRequest,
  handlers,
  onOpenTurnInHistory,
}: {
  model: ReplayProgressModel;
  sessionRunning: boolean;
  focusRequest: TimelineFocusRequest | null;
  handlers: StepHandlers;
  onOpenTurnInHistory: ((turn: ReplayProgressTurn) => void) | null;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [expandedTurnIds, setExpandedTurnIds] = useState<Set<string>>(() => new Set());
  const [pinned, setPinned] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const autoExpandedId = useRef<string | null>(null);
  const latestTurnId = model.turns[0]?.id ?? null;

  const chronological = useMemo(() => [...model.turns].reverse(), [model.turns]);
  const matcher = useMemo(() => {
    const normalized = query.trim();
    return normalized ? new RegExp(normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
  }, [query]);
  const visibleTurns = useMemo(
    () => chronological
      .map((turn, index) => ({ turn, index: index + 1 }))
      .filter(({ turn }) => turnMatchesFilter(turn, filter) && turnMatchesQuery(turn, matcher)),
    [chronological, filter, matcher]
  );

  // 新一轮出现时自动展开它，并收起上一轮由系统自动展开的卡片，用户手动展开的保持不动。
  useEffect(() => {
    if (!latestTurnId || autoExpandedId.current === latestTurnId) return;
    const previous = autoExpandedId.current;
    autoExpandedId.current = latestTurnId;
    setExpandedTurnIds((current) => {
      const next = new Set(current);
      if (previous) next.delete(previous);
      next.add(latestTurnId);
      return next;
    });
  }, [latestTurnId]);

  // 贴底时跟随新事件滚动；用户上翻后不打扰，由「回到最新」恢复。
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (container && pinned) container.scrollTop = container.scrollHeight;
  }, [model, pinned, visibleTurns.length]);

  useEffect(() => {
    if (!focusRequest || !model.turns.some((turn) => turn.id === focusRequest.turnId)) return;
    setQuery("");
    setFilter("all");
    setPinned(false);
    setExpandedTurnIds((current) => new Set(current).add(focusRequest.turnId));
    const frame = window.requestAnimationFrame(() => {
      nodeRefs.current.get(focusRequest.turnId)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);

  const toggleTurn = (turnId: string) => {
    if (turnId === autoExpandedId.current) autoExpandedId.current = `${turnId}:manual`;
    setExpandedTurnIds((current) => {
      const next = new Set(current);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  };

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
    if (nearBottom !== pinned) setPinned(nearBottom);
  };

  if (model.turns.length === 0) return <EmptyHint text={t("aiReplay.empty.timeline")} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex shrink-0 items-center gap-1.5">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[9px] px-2" style={{ backgroundColor: FILL }}>
          <Search size={12} className="shrink-0" style={{ color: TERM_PANEL.dim }} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("aiReplay.timeline.search")}
            aria-label={t("aiReplay.timeline.search")}
            className="min-w-0 flex-1 bg-transparent text-[11px] outline-none"
            style={{ color: TERM_PANEL.fg }}
          />
        </label>
        <div role="radiogroup" className="flex h-7 shrink-0 items-stretch rounded-[9px] p-[2px]" style={{ backgroundColor: FILL }}>
          {TIMELINE_FILTERS.map((item) => {
            const selected = filter === item.value;
            return (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setFilter(item.value)}
                className="ui-focus-ring rounded-[7px] px-2 text-[10.5px] transition-colors"
                style={{
                  color: selected ? TERM_PANEL.fg : TERM_PANEL.dim,
                  fontWeight: selected ? 600 : 500,
                  backgroundColor: selected ? TERM_PANEL.card : "transparent",
                  boxShadow: selected ? `0 1px 3px rgba(0, 0, 0, 0.18), 0 0 0 1px ${HAIRLINE}` : undefined,
                }}
              >
                {t(item.labelKey)}
              </button>
            );
          })}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={handleScroll} className="ui-thin-scroll h-full overflow-y-auto overflow-x-hidden pr-0.5">
          {visibleTurns.length === 0 ? (
            <EmptyHint text={t("aiReplay.timeline.emptyFilter")} />
          ) : visibleTurns.map(({ turn, index }, position) => {
            const previous = visibleTurns[position - 1]?.turn;
            const gap = previous ? durationBetweenTimestamps(previous.endedAt ?? previous.startedAt, turn.startedAt) : null;
            return (
              <div key={turn.id}>
                {gap !== null && gap >= GAP_MARKER_MS && (
                  <div className="relative grid grid-cols-[14px_minmax(0,1fr)] gap-2.5 pb-2.5">
                    <span aria-hidden className="absolute bottom-0 left-[6.5px] top-0 border-l border-dashed" style={{ borderColor: HAIRLINE }} />
                    <span />
                    <span className="text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>{t("aiReplay.timeline.gap", { duration: formatSpan(gap) })}</span>
                  </div>
                )}
                <TurnNode
                  turn={turn}
                  index={index}
                  latest={turn.id === latestTurnId}
                  first={position === 0}
                  last={position === visibleTurns.length - 1}
                  sessionRunning={sessionRunning}
                  expanded={expandedTurnIds.has(turn.id)}
                  onToggle={() => toggleTurn(turn.id)}
                  onOpenInHistory={onOpenTurnInHistory && turn.messageIndex !== null ? () => onOpenTurnInHistory(turn) : null}
                  handlers={handlers}
                  nodeRef={(element) => {
                    if (element) nodeRefs.current.set(turn.id, element);
                    else nodeRefs.current.delete(turn.id);
                  }}
                />
              </div>
            );
          })}
        </div>
        {!pinned && (
          <button
            type="button"
            onClick={() => setPinned(true)}
            className="ui-focus-ring absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold"
            style={{
              color: TINT,
              backgroundColor: panelColorTint(TERM_PANEL.card, 94),
              backdropFilter: "blur(14px) saturate(1.6)",
              WebkitBackdropFilter: "blur(14px) saturate(1.6)",
              boxShadow: `0 8px 24px rgba(0, 0, 0, 0.32), 0 0 0 1px ${HAIRLINE}`,
            }}
          >
            <ArrowDown size={12} />
            {t("aiReplay.timeline.jumpLatest")}
          </button>
        )}
      </div>
    </div>
  );
}

function OverviewCard({
  model,
  sessionRunning,
  historyLoading,
  historyAvailable,
  language,
  onFocusTurn,
}: {
  model: ReplayProgressModel;
  sessionRunning: boolean;
  historyLoading: boolean;
  historyAvailable: boolean;
  language: string;
  onFocusTurn: (turnId: string) => void;
}) {
  const { t } = useI18n();
  const latest = model.turns[0];
  if (!latest) return <EmptyHint text={t("aiReplay.empty.timeline")} />;
  const status = displayTurnStatus(latest, true, sessionRunning);
  const tone = statusColor(status);
  const running = status === "running" ? currentRunningStep(latest) : null;
  const stateKey: TranslationKey = status === "running"
    ? "aiReplay.timeline.state.running"
    : status === "failed"
      ? "aiReplay.timeline.state.failed"
      : status === "attention"
        ? "aiReplay.timeline.state.attention"
        : status === "incomplete"
          ? "aiReplay.timeline.state.incomplete"
          : "aiReplay.timeline.state.idle";
  const StateIcon = status === "running"
    ? Sparkles
    : status === "failed"
      ? AlertTriangle
      : status === "attention" || status === "incomplete"
        ? Bell
        : CheckCircle2;
  const chronological = [...model.turns].reverse();
  const longest = Math.max(1, ...chronological.map((turn) => turn.durationMs ?? 0));
  const stats: Array<{ label: TranslationKey; value: string; color?: string }> = [
    { label: "aiReplay.timeline.stat.turns", value: String(model.counts.turns) },
    { label: "aiReplay.timeline.stat.workTime", value: formatSpan(model.counts.workMs) },
    { label: "aiReplay.timeline.stat.files", value: String(model.counts.files) },
    { label: "aiReplay.timeline.stat.issues", value: String(model.counts.errors), color: model.counts.errors > 0 ? TERM_PANEL.red : undefined },
  ];
  const syncColor = historyLoading ? TINT : historyAvailable ? TERM_PANEL.green : TERM_PANEL.dim;

  return (
    <section className="shrink-0 rounded-2xl px-3 pb-2.5 pt-3" style={CARD_STYLE}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]" style={{ backgroundColor: panelColorTint(tone, 16) }}>
          <StateIcon size={16} strokeWidth={2.2} className={status === "running" ? "animate-pulse" : undefined} style={{ color: tone }} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[13px] font-semibold" style={{ color: TERM_PANEL.fg }}>{t(stateKey)}</span>
            <span className="shrink-0 text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>
              {status === "running"
                ? <LiveElapsed startedAt={latest.startedAt} status="running" />
                : t("aiReplay.timeline.lastFinished", { time: formatClock(latest.endedAt ?? latest.startedAt, language) })}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px]" style={{ color: TERM_PANEL.dim }} title={running ? running.inputSummary ?? undefined : latest.prompt}>
            {running ? (
              <>
                <span className="shrink-0 font-medium" style={{ color: tone }}>{t("aiReplay.timeline.now", { activity: t(ACTIVITY_META[running.activity].labelKey) })}</span>
                <span className={`truncate ${running.target ? "font-mono text-[10.5px]" : ""}`}>{stepHeadline(running, t)}</span>
              </>
            ) : (
              <span className="truncate">{turnTitle(latest, t)}</span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-[1fr_1.4fr_1fr_1fr]">
        {stats.map((stat, index) => (
          <div key={stat.label} className="min-w-0 px-1 text-center" style={{ borderLeft: index > 0 ? `1px solid ${HAIRLINE}` : undefined }}>
            <div className="truncate text-[15px] font-semibold leading-5 tabular-nums tracking-tight" style={{ color: stat.color ?? TERM_PANEL.fg }} title={stat.value}>{stat.value}</div>
            <div className="mt-0.5 truncate text-[10px]" style={{ color: TERM_PANEL.dim }}>{t(stat.label)}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex h-1.5 items-stretch gap-[3px]" title={t("aiReplay.timeline.rhythm")}>
        {chronological.map((turn, index) => {
          const turnStatus = displayTurnStatus(turn, turn.id === latest.id, sessionRunning);
          const weight = Math.max(longest * 0.04, turn.durationMs ?? 0);
          return (
            <button
              key={turn.id}
              type="button"
              aria-label={t("aiReplay.timeline.turn", { index: index + 1 })}
              title={`${t("aiReplay.timeline.turn", { index: index + 1 })} · ${formatSpan(turn.durationMs)}\n${turnTitle(turn, t)}`}
              onClick={() => onFocusTurn(turn.id)}
              className={`ui-focus-ring min-w-[4px] rounded-full transition-opacity hover:opacity-100 ${turnStatus === "running" ? "animate-pulse" : ""}`}
              style={{ flexGrow: weight, flexBasis: 0, backgroundColor: statusColor(turnStatus), opacity: turn.id === latest.id ? 1 : 0.5 }}
            />
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px]" style={{ color: TERM_PANEL.dim }}>
        <span className="truncate">{t("aiReplay.timeline.rhythmLabel")}</span>
        <span className="flex shrink-0 items-center gap-1">
          <span className={`h-1.5 w-1.5 rounded-full ${historyLoading ? "animate-pulse" : ""}`} style={{ backgroundColor: syncColor }} />
          {historyLoading ? t("aiReplay.progress.syncing") : historyAvailable ? t("aiReplay.progress.synced") : t("aiReplay.progress.hookOnly")}
        </span>
      </div>
    </section>
  );
}

export function SessionReplayPanel({ activeSessionId, open, visible = true, onOpenHistoryMessage }: SessionReplayPanelProps) {
  const { t, language } = useI18n();
  const { panelStyle, accentStyle } = useTerminalPreviewTheme();
  const sessions = useReplayStore((state) => state.sessions);
  const eventsBySession = useReplayStore((state) => state.eventsBySession);
  const selectedSessionKey = useReplayStore((state) => state.selectedSessionKey);
  const loading = useReplayStore((state) => state.loading);
  const error = useReplayStore((state) => state.error);
  const loadRecentSessions = useReplayStore((state) => state.loadRecentSessions);
  const loadSession = useReplayStore((state) => state.loadSession);
  const selectSession = useReplayStore((state) => state.selectSession);
  const captureCodeSnapshot = useReplayStore((state) => state.captureCodeSnapshot);
  const loadSnapshotPatch = useReplayStore((state) => state.loadSnapshotPatch);
  const projects = useProjectStore((state) => state.projects);
  const [focusRequest, setFocusRequest] = useState<TimelineFocusRequest | null>(null);
  const [rollbackPending, setRollbackPending] = useState(false);
  const [forkPending, setForkPending] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingReplayAction | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const [historyDetail, setHistoryDetail] = useState<HistorySessionDetail | null>(null);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const historyDetailRef = useRef<{ sessionKey: string; detail: HistorySessionDetail } | null>(null);
  const remoteHistoryContextRef = useRef<SshAgentHistoryContext | null>(null);
  const panelActive = open && visible;
  const patchAction = useRef({ generation: 0, busy: false });

  useEffect(() => {
    patchAction.current = { generation: patchAction.current.generation + 1, busy: false };
    setDiffState(null);
    return () => { patchAction.current.generation++; };
  }, [panelActive, selectedSessionKey]);

  useEffect(() => {
    if (!panelActive) return;
    void loadRecentSessions(12, activeSessionId);
    if (activeSessionId) void selectSession(activeSessionId);
  }, [activeSessionId, loadRecentSessions, panelActive, selectSession]);

  useEffect(() => {
    setHistoryOpen(false);
    setFocusRequest(null);
  }, [activeSessionId]);

  const selectedSession = sessions.find((session) => session.sessionKey === selectedSessionKey) ?? null;
  const events = selectedSessionKey ? eventsBySession[selectedSessionKey] ?? [] : [];
  const remoteProjectId = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const projectId = getStringPayload(events[index].payload, "remoteProjectId");
      if (projectId) return projectId;
    }
    return null;
  }, [events]);
  const remoteProject = remoteProjectId
    ? projects.find((project) => project.id === remoteProjectId && project.environment_type === "ssh") ?? null
    : null;
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
    if (!panelActive || !selectedSessionKey || (!selectedSession?.projectPath && !remoteProject) || !selectedSession?.cliSessionId) {
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
      const loadDetail = async () => {
        const previousRef = previous
          ? { filePath: previous.file_path, updatedAt: previous.updated_at, fileSize: previous.file_size }
          : undefined;
        if (remoteProject) {
          if (remoteHistoryContextRef.current?.launch.projectId !== remoteProject.id) {
            remoteHistoryContextRef.current = await buildSshAgentHistoryContext(remoteProject);
          }
          const remote = await fetchRemoteLatestProjectSessionDetail(
            remoteHistoryContextRef.current,
            previousRef,
            selectedSession.cliSessionId,
          );
          remoteHistoryContextRef.current = remote.context;
          return remote.result;
        }
        return fetchLatestProjectSessionDetail(
          selectedSession.projectPath!,
          previousRef,
          source,
          selectedSession.cliSessionId,
        );
      };
      void loadDetail().then((result) => {
        if (cancelled) return;
        if (result !== "unchanged") {
          setHistoryDetail(result);
          historyDetailRef.current = result ? { sessionKey: selectedSessionKey, detail: result } : null;
        }
      }).catch(() => {
        if (!cancelled) {
          setHistoryDetail(null);
          historyDetailRef.current = null;
        }
      }).finally(() => {
        if (!cancelled) setHistoryDetailLoading(false);
      });
    }, events.length > 0 ? 450 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [events.length, panelActive, remoteProject, selectedSession?.cliSessionId, selectedSession?.eventCount, selectedSession?.projectPath, selectedSession?.source, selectedSession?.updatedAt, selectedSessionKey]);

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
  const sessionRunning = selectedSession?.status === "running";
  const jumpDetail = historyDetailAvailable ? historyDetail : null;
  // 轮次的 messageIndex 与历史页同口径（均为未聚合子任务的父会话），可直接定位。
  const handleOpenTurnInHistory = onOpenHistoryMessage && jumpDetail
    ? (turn: ReplayProgressTurn) => {
        if (turn.messageIndex === null) return;
        onOpenHistoryMessage({
          session: jumpDetail,
          messageIndex: turn.messageIndex,
          projectPath: remoteProject ? null : selectedSession?.projectPath ?? null,
          projectId: remoteProject?.id ?? null,
        });
      }
    : null;

  const handleSelectReplaySession = async (sessionKey: string) => {
    setHistoryOpen(false);
    await selectSession(sessionKey);
  };

  const handleBackToCurrent = async () => {
    if (!activeSessionId) return;
    setHistoryOpen(false);
    await selectSession(activeSessionId);
  };

  const withSnapshotPatches = async (event: ReplayEvent, latest: ReplayEvent | null,
    action: (patch: string, current: string) => void) => {
    if (patchAction.current.busy) return;
    const generation = patchAction.current.generation;
    patchAction.current.busy = true;
    try {
      const [patch, current] = await Promise.all([
        loadSnapshotPatch(event), latest ? loadSnapshotPatch(latest) : Promise.resolve(""),
      ]);
      if (generation === patchAction.current.generation) action(patch, current);
    } catch (err) {
      if (generation === patchAction.current.generation) {
        toast.error(t("aiReplay.snapshot.readFailed"), { description: String(err) });
      }
    } finally {
      if (generation === patchAction.current.generation) patchAction.current.busy = false;
    }
  };

  const handleRollback = async (event: ReplayEvent, latest: ReplayEvent) => {
    const projectPath = getStringPayload(event.payload, "projectPath");
    const targetHead = getStringPayload(event.payload, "head");
    if (!selectedSessionKey || !projectPath || !targetHead || event.payload.patchTruncated || latest.payload.patchTruncated) return;
    await withSnapshotPatches(event, latest, (targetPatch, expectedCurrentPatch) => {
      setPendingAction({ kind: "rollback", sessionKey: selectedSessionKey, projectPath, targetPatch, expectedCurrentPatch, targetHead });
    });
  };

  const handleFork = async (event: ReplayEvent, latest: ReplayEvent) => {
    const projectPath = getStringPayload(event.payload, "projectPath");
    const targetHead = getStringPayload(event.payload, "head");
    if (!selectedSessionKey || !projectPath || !targetHead || event.payload.patchTruncated || latest.payload.patchTruncated) return;
    await withSnapshotPatches(event, latest, (targetPatch, expectedCurrentPatch) => {
      setPendingAction({
        kind: "fork",
        sessionKey: selectedSessionKey,
        projectPath,
        targetPatch,
        expectedCurrentPatch,
        targetHead,
        branchName: buildSnapshotForkBranchName(event),
      });
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

  const handleViewSnapshot = async (event: ReplayEvent) => {
    await withSnapshotPatches(event, null, (patch) => {
      const patchBytes = stringByteLength(patch);
      logReplayPanelOomDiagnostic("viewSnapshotDiff", {
        sessionKey: event.sessionKey,
        eventIndex: event.eventIndex,
        patchBytes,
        currentEvents: events.length,
        thresholdExceeded: patchBytes >= OOM_PATCH_WARN_BYTES || events.length >= OOM_REPLAY_EVENTS_WARN_COUNT,
      }, patchBytes >= OOM_PATCH_WARN_BYTES || events.length >= OOM_REPLAY_EVENTS_WARN_COUNT);
      setDiffState({ messages: [{ role: "assistant", content: patch, timestamp: event.timestamp }] });
    });
  };

  if (!panelActive) return null;

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden font-sans"
      style={{
        ...panelStyle,
        // 状态胶囊、图标方块、命令标题把主题色当界面强调色用，需保证在卡片上可读。
        ...accentStyle,
        backgroundColor: TERM_PANEL.bg,
        "--ui-scrollbar-thumb": TERM_PANEL.border,
        "--ui-scrollbar-track": TERM_PANEL.bg,
      } as CSSProperties}
    >
      <TerminalPanelHeader
        icon={<Sparkles size={14} />}
        accent={TERM_PANEL.cyan}
        title={t("aiReplay.title")}
        subtitle={selectedSessionTitle}
        subtitleTitle={selectedSessionTitle}
        actions={(
          <>
          {viewingHistory && activeSessionId && (
            <button type="button" onClick={() => void handleBackToCurrent()} className="ui-focus-ring rounded-full px-2.5 py-1 text-[10.5px] font-semibold transition-opacity hover:opacity-80" style={{ color: TINT, backgroundColor: panelColorTint(TINT, 14) }}>
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
            className="ui-focus-ring flex h-7 w-7 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-45"
            style={{ color: historyOpen ? TINT : TERM_PANEL.dim, backgroundColor: historyOpen ? panelColorTint(TINT, 14) : FILL }}
          >
            <History size={13} />
          </button>
          </>
        )}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-2.5">

      {historyOpen && (
        <section className="shrink-0 overflow-hidden rounded-2xl" style={CARD_STYLE}>
          <div className="flex items-center justify-between px-3 pb-1.5 pt-2.5 text-[11.5px] font-semibold" style={{ color: TERM_PANEL.fg }}>
            <span>{t("aiReplay.history")}</span>
            <span className="text-[10px] font-normal tabular-nums" style={{ color: TERM_PANEL.dim }}>{historySessions.length}</span>
          </div>
          <div className="max-h-40 overflow-y-auto pb-1 ui-thin-scroll">
            {historySessions.map((session, index) => {
              const selected = session.sessionKey === selectedSessionKey;
              const tone = statusColor(session.status);
              return (
                <button
                  key={session.sessionKey}
                  type="button"
                  onClick={() => void handleSelectReplaySession(session.sessionKey)}
                  className="ui-focus-ring relative flex w-full items-center gap-2 px-3 py-2 text-left"
                  style={{ backgroundColor: selected ? panelColorTint(TINT, 8) : undefined }}
                >
                  {index > 0 && <span aria-hidden className="absolute left-3 right-0 top-0 h-px" style={{ backgroundColor: HAIRLINE }} />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] font-medium" style={{ color: TERM_PANEL.fg }}>{resolveReplaySessionTitle(session, eventsBySession[session.sessionKey], t)}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tone }} />
                      <span className="truncate">{t(STATUS_KEYS[session.status])} · {formatClock(session.updatedAt, language)} · {session.eventCount} {t("aiReplay.metric.events")}</span>
                    </span>
                  </span>
                  {selected && <Check size={14} strokeWidth={2.6} className="shrink-0" style={{ color: TINT }} />}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {loading && events.length === 0 ? (
        <EmptyHint text={t("common.loading")} />
      ) : error && events.length === 0 ? (
        <EmptyHint text={t("aiReplay.empty.error")} />
      ) : progressModel.turns.length === 0 ? (
        <EmptyHint text={t("aiReplay.empty.timeline")} />
      ) : (
        <>
          <OverviewCard
            model={progressModel}
            sessionRunning={sessionRunning}
            historyLoading={historyDetailLoading}
            historyAvailable={historyDetailAvailable}
            language={language}
            onFocusTurn={(turnId) => setFocusRequest((current) => ({ turnId, nonce: (current?.nonce ?? 0) + 1 }))}
          />
          <TimelineView
            key={`timeline:${selectedSessionKey ?? "none"}`}
            model={progressModel}
            sessionRunning={sessionRunning}
            focusRequest={focusRequest}
            handlers={{
              latestSnapshot,
              rollbackPending,
              forkPending,
              language,
              onViewFiles: (files) => setDiffState({ fileChanges: files }),
              onViewSnapshot: handleViewSnapshot,
              onRollback: handleRollback,
              onFork: handleFork,
            }}
            onOpenTurnInHistory={handleOpenTurnInHistory}
          />
        </>
      )}

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
    </div>
  );
}
