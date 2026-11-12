import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, ChevronDown, ChevronRight, Coins, Database, Folder, Info, Layers, MessagesSquare, RefreshCw, ScrollText, Search, X } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
  type TooltipPayloadEntry,
  type TooltipValueType,
} from "recharts";
import { Button } from "../../../shared/ui/button";
import type {
  HistorySessionSummary,
  HistorySourceFilter,
  HistoryStatsDailySeriesItem,
  HistoryStatsHeatmapDay,
  HistoryStatsHourlyActivityItem,
  HistoryStatsModelItem,
  HistoryStatsPayload,
  HistoryStatsProjectItem,
  HistoryStatsSourceItem,
  Group,
  Project,
  RequestLogSource,
  RequestLogStatsPayload,
} from "../../../shared/types/index";
import { fetchHistoryRequestLogStats, fetchHistoryStatsPayload, fetchRemoteHistoryStatsPayload, syncHistoryRequestLogs } from "../../history/index";
import { useProjectStore } from "../../projects/api/projectStore";
import { resolveNodeAppearance } from "../../projects/api/nodeAppearance";
import { NodeAppearanceIcon } from "../../projects/api/NodeAppearanceIcon";
import { HISTORY_SOURCE_DESCRIPTORS, HISTORY_SOURCE_DESCRIPTOR_BY_ID } from "../../../shared/lib/historySources";
import { TimelineHeatmap } from "../components/TimelineHeatmap";
import { StatsHourlyActivityChart } from "../components/StatsHourlyActivityChart";
import { StatsDatePicker } from "../components/StatsDatePicker";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { Portal } from "../../../shared/ui/Portal";
import {
  RECHARTS_TOOLTIP_WRAPPER_STYLE,
  STATS_AXIS_CURSOR,
  STATS_AXIS_TICK,
  STATS_CATEGORICAL,
  STATS_COLORS,
  STATS_GRID_STROKE,
} from "./statsPalette";
import { useI18n, type AppLanguage, type TranslationKey } from "../../../shared/i18n/index";
import { CliToolIcon } from "../../../shared/ui/CliToolIcon";
import { resolveHistorySourceIconKey } from "../../../shared/lib/cliTools";
import { RequestLogsView } from "../components/RequestLogsView";
import { projectSupportsCapability } from "../../projects/api/projectCapabilities";
import { resolveHistoryProjectPath } from "../../history/api/historyProjectPaths";
import { logWarn } from "../../../shared/platform/logger";
import { useWorkspaceBackground } from "../../workspace/api/WorkspaceBackground";

interface StatsPanelProps {
  open: boolean;
  onClose: () => void;
  onOpenSession: (sessionKey: string) => Promise<void>;
}

const DAY_SESSION_PAGE_SIZE = 120;
const ALL_PROJECTS_VALUE = "__all_projects__";
const DATE_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_INPUT_PATTERN = /^(\d{4})-(\d{2})$/;
const YEAR_INPUT_PATTERN = /^(\d{4})$/;
const HOUR_MS = 60 * 60 * 1000;
const REQUEST_LOG_SOURCE_IDS = new Set(["claude", "codex", "gemini", "opencode", "grok"]);

type StatsProjectTreeNode =
  | { type: "group"; group: Group; children: StatsProjectTreeNode[] }
  | { type: "project"; project: Project };

interface DateRangeInput {
  startDate: string;
  endDate: string;
}

type StatsTimeWindowMode = "day" | "week" | "month" | "year" | "custom";
type StatsBucketGranularity = "day" | "hour";
type StatsPanelTab = "overview" | "requests";

interface StatsTimeWindowState {
  mode: StatsTimeWindowMode;
  day: string;
  week: string;
  month: string;
  year: string;
  customStart: string;
  customEnd: string;
}

const STATS_TIME_WINDOW_OPTIONS: { value: StatsTimeWindowMode; labelKey: TranslationKey }[] = [
  { value: "day", labelKey: "stats.window.day" },
  { value: "week", labelKey: "stats.window.week" },
  { value: "month", labelKey: "stats.window.month" },
  { value: "year", labelKey: "stats.window.year" },
  { value: "custom", labelKey: "stats.window.custom" },
];

function buildStatsProjectTree(groups: Group[], projects: Project[]): StatsProjectTreeNode[] {
  const childGroups = new Map<string | null, Group[]>();
  const groupProjects = new Map<string | null, Project[]>();

  for (const group of groups) {
    const list = childGroups.get(group.parent_id) ?? [];
    list.push(group);
    childGroups.set(group.parent_id, list);
  }

  for (const project of projects) {
    const list = groupProjects.get(project.group_id) ?? [];
    list.push(project);
    groupProjects.set(project.group_id, list);
  }

  const buildLevel = (parentId: string | null): StatsProjectTreeNode[] => {
    const nodes: StatsProjectTreeNode[] = [];
    const sortedGroups = [...(childGroups.get(parentId) ?? [])].sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    );
    const sortedProjects = [...(groupProjects.get(parentId) ?? [])].sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    );

    for (const group of sortedGroups) {
      nodes.push({ type: "group", group, children: buildLevel(group.id) });
    }
    for (const project of sortedProjects) {
      nodes.push({ type: "project", project });
    }
    return nodes;
  };

  return buildLevel(null);
}

function countStatsProjects(node: StatsProjectTreeNode): number {
  if (node.type === "project") return 1;
  return node.children.reduce((sum, child) => sum + countStatsProjects(child), 0);
}

function collectStatsGroupIds(nodes: StatsProjectTreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type !== "group") continue;
    out.push(node.group.id);
    collectStatsGroupIds(node.children, out);
  }
  return out;
}

function normalizeProjectSearch(value: string): string {
  return value.trim().toLowerCase();
}

function statsProjectMatchesSearch(project: Project, query: string): boolean {
  if (!query) return true;
  return (
    project.name.toLowerCase().includes(query) ||
    resolveHistoryProjectPath(project).toLowerCase().includes(query) ||
    project.cli_tool.toLowerCase().includes(query)
  );
}

function filterStatsProjectTree(nodes: StatsProjectTreeNode[], query: string): StatsProjectTreeNode[] {
  if (!query) return nodes;

  const result: StatsProjectTreeNode[] = [];
  for (const node of nodes) {
    if (node.type === "project") {
      if (statsProjectMatchesSearch(node.project, query)) result.push(node);
      continue;
    }

    const groupMatches = node.group.name.toLowerCase().includes(query);
    const children = groupMatches ? node.children : filterStatsProjectTree(node.children, query);
    if (groupMatches || children.length > 0) {
      result.push({ ...node, children });
    }
  }
  return result;
}

function StatsProjectFilterIcon({ project, size = 13 }: { project: Project; size?: number }) {
  // 与侧边栏、History 项目树共用同一套图标解析：单字符标记 → 内置 key → CLI 工具图标 → 终端兜底。
  // 此前这里走 inferVendor + VendorIcon，是三处项目树里唯一的第三种图标口径。
  const appearance = resolveNodeAppearance({ icon: project.icon, color: project.color });
  return (
    <NodeAppearanceIcon
      mark={appearance.emoji}
      iconKey={appearance.iconKey}
      cliTool={project.cli_tool}
      fallback="terminal"
      size={size}
    />
  );
}

function formatCount(value: number, language: AppLanguage = "zh-CN"): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(language).format(Math.max(0, Math.round(value)));
}

function formatCompactCount(value: number, language: AppLanguage = "zh-CN"): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatCount(value, language);
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  return `${value.toFixed(1)}%`;
}

function formatDay(dayStartUtc: number, language: AppLanguage = "zh-CN"): string {
  if (!Number.isFinite(dayStartUtc) || dayStartUtc <= 0) return "-";
  return new Intl.DateTimeFormat(language, {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(new Date(dayStartUtc));
}

function formatHour(hourStartUtc: number): string {
  if (!Number.isFinite(hourStartUtc) || hourStartUtc <= 0) return "-";
  const date = new Date(hourStartUtc);
  return `${String(date.getHours()).padStart(2, "0")}:00`;
}

function formatBucketLabel(bucketStartUtc: number, granularity: StatsBucketGranularity, language: AppLanguage = "zh-CN"): string {
  return granularity === "hour" ? formatHour(bucketStartUtc) : formatDay(bucketStartUtc, language);
}

function formatDateTime(ts: number | null, language: AppLanguage = "zh-CN"): string {
  if (!ts || !Number.isFinite(ts)) return "-";
  return new Intl.DateTimeFormat(language, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getRecentSevenDaysDateRange(): DateRangeInput {
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6);
  return {
    startDate: formatDateInput(start),
    endDate: formatDateInput(end),
  };
}

function getDefaultStatsTimeWindow(): StatsTimeWindowState {
  const now = new Date();
  const recentSevenDays = getRecentSevenDaysDateRange();
  return {
    mode: "week",
    day: formatDateInput(now),
    week: "",
    month: formatDateInput(now).slice(0, 7),
    year: String(now.getFullYear()),
    customStart: recentSevenDays.startDate,
    customEnd: recentSevenDays.endDate,
  };
}

function resolveStatsTimeWindow(window: StatsTimeWindowState): StatsTimeWindowState {
  const fallback = getDefaultStatsTimeWindow();
  return {
    mode: window.mode,
    day: window.day || fallback.day,
    week: window.week || fallback.week,
    month: window.month || fallback.month,
    year: window.year || fallback.year,
    customStart: window.customStart || fallback.customStart,
    customEnd: window.customEnd || fallback.customEnd,
  };
}

function nextStatsTimeWindowForMode(mode: StatsTimeWindowMode, current: StatsTimeWindowState): StatsTimeWindowState {
  const resolved = resolveStatsTimeWindow({ ...current, mode });
  if (mode !== "week") return resolved;
  const recentSevenDays = getRecentSevenDaysDateRange();
  return {
    ...resolved,
    customStart: recentSevenDays.startDate,
    customEnd: recentSevenDays.endDate,
  };
}

function dateRangeFromStatsTimeWindow(window: StatsTimeWindowState): DateRangeInput {
  if (window.mode === "day") {
    return { startDate: window.day, endDate: window.day };
  }
  if (window.mode === "week") {
    return getRecentSevenDaysDateRange();
  }
  if (window.mode === "month") {
    const match = MONTH_INPUT_PATTERN.exec(window.month);
    if (!match) return { startDate: "", endDate: "" };
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) return { startDate: "", endDate: "" };
    return {
      startDate: formatDateInput(new Date(year, month - 1, 1)),
      endDate: formatDateInput(new Date(year, month, 0)),
    };
  }
  if (window.mode === "year") {
    const match = YEAR_INPUT_PATTERN.exec(window.year);
    if (!match) return { startDate: "", endDate: "" };
    const year = Number(match[1]);
    return {
      startDate: formatDateInput(new Date(year, 0, 1)),
      endDate: formatDateInput(new Date(year, 11, 31)),
    };
  }
  return {
    startDate: window.customStart,
    endDate: window.customEnd,
  };
}

function statsTimeWindowLabel(
  window: StatsTimeWindowState,
  range: DateRangeInput,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
): string {
  if (window.mode === "day") return window.day;
  if (window.mode === "week") return t("stats.weekRange", { start: range.startDate, end: range.endDate });
  if (window.mode === "month") return t("stats.monthLabel", { month: window.month });
  if (window.mode === "year") return t("stats.yearLabel", { year: window.year });
  return t("stats.rangeLabel", { start: range.startDate, end: range.endDate });
}

function parseDateInput(value: string, endOfDay: boolean): number | null {
  const match = DATE_INPUT_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date.getTime();
}

function makeSessionKey(summary: HistorySessionSummary): string {
  return `${summary.source}:${summary.session_id}:${summary.file_path}`;
}

function totalTokensOf(value: {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}): number {
  return value.input_tokens + value.output_tokens + value.cache_read_tokens + value.cache_creation_tokens;
}

function axisDayLabel(dayStartUtc: number): string {
  if (!Number.isFinite(dayStartUtc) || dayStartUtc <= 0) return "-";
  const date = new Date(dayStartUtc);
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function axisHourLabel(hourStartUtc: number): string {
  if (!Number.isFinite(hourStartUtc) || hourStartUtc <= 0) return "-";
  return String(new Date(hourStartUtc).getHours()).padStart(2, "0");
}

function axisBucketLabel(bucketStartUtc: number, granularity: StatsBucketGranularity): string {
  return granularity === "hour" ? axisHourLabel(bucketStartUtc) : axisDayLabel(bucketStartUtc);
}

type RechartsTooltipName = string | number;
type TrendTooltipEntry = TooltipPayloadEntry<TooltipValueType, RechartsTooltipName>;

function tooltipNumberValue(value: TooltipValueType | undefined): number {
  if (Array.isArray(value)) return Number(value[0] ?? 0);
  return Number(value ?? 0);
}

function tooltipEntryColor(entry: TrendTooltipEntry): string {
  return entry.color ?? entry.stroke ?? entry.fill ?? "var(--stats-axis)";
}

interface StatsTooltipRow {
  key: string;
  label: string;
  color: string;
  value: string;
}

function StatsTooltipCard({ title, rows, footer }: { title?: string; rows: StatsTooltipRow[]; footer?: string }) {
  return (
    <div className="ui-stats-tooltip">
      {title && <div className="mb-1.5 text-[12px] font-semibold text-text-primary">{title}</div>}
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5">
            <span className="inline-flex min-w-0 items-center gap-2 text-text-secondary">
              <span className="ui-stats-legend-dot" style={{ backgroundColor: row.color }} />
              <span className="truncate">{row.label}</span>
            </span>
            <span className="font-semibold tabular-nums text-text-primary">{row.value}</span>
          </div>
        ))}
      </div>
      {footer && <div className="mt-1.5 text-[11px] text-text-muted">{footer}</div>}
    </div>
  );
}

function DailyUsageTrendTooltip({
  active,
  payload,
  label,
  language,
  costLabel,
}: Pick<TooltipContentProps<TooltipValueType, RechartsTooltipName>, "active" | "payload" | "label"> & {
  language: AppLanguage;
  costLabel: string;
}) {
  if (!active || !payload?.length) return null;
  const entries = payload as readonly TrendTooltipEntry[];
  const bucketTitle = String(entries[0]?.payload?.bucketTitle ?? label ?? "");
  const rows = entries.map((entry) => {
    const name = String(entry.name ?? "");
    const value = tooltipNumberValue(entry.value);
    return {
      key: `${String(entry.dataKey ?? name)}-${name}`,
      label: name,
      color: tooltipEntryColor(entry),
      value: name === costLabel ? formatCost(value) : formatCount(value, language),
    };
  });
  return <StatsTooltipCard title={bucketTitle} rows={rows} />;
}

function PieSliceTooltip({
  active,
  payload,
  language,
}: Pick<TooltipContentProps<TooltipValueType, RechartsTooltipName>, "active" | "payload"> & { language: AppLanguage }) {
  if (!active || !payload?.length) return null;
  const entry = payload[0] as TrendTooltipEntry;
  const color = String((entry.payload as { color?: string } | undefined)?.color ?? tooltipEntryColor(entry));
  return (
    <StatsTooltipCard
      rows={[{ key: String(entry.name ?? ""), label: String(entry.name ?? ""), color, value: `${formatCount(tooltipNumberValue(entry.value), language)} Token` }]}
    />
  );
}

function hourlyBucketStart(item: HistoryStatsHourlyActivityItem, dayStartAt: number | null): number {
  if (Number.isFinite(item.hour_start_utc) && item.hour_start_utc > 0) return item.hour_start_utc;
  if (dayStartAt !== null && Number.isFinite(dayStartAt)) return dayStartAt + item.hour * HOUR_MS;
  return 0;
}

function hourlyToTrendItem(item: HistoryStatsHourlyActivityItem, dayStartAt: number | null): HistoryStatsDailySeriesItem {
  return {
    day_start_utc: hourlyBucketStart(item, dayStartAt),
    sessions: item.sessions,
    messages: item.messages,
    input_tokens: item.input_tokens,
    output_tokens: item.output_tokens,
    cache_read_tokens: item.cache_read_tokens,
    cache_creation_tokens: item.cache_creation_tokens,
    total_cost_usd: item.total_cost_usd,
    unpriced_tokens: item.unpriced_tokens,
  };
}

function hourlyToHeatmapDay(item: HistoryStatsHourlyActivityItem, dayStartAt: number | null): HistoryStatsHeatmapDay {
  return {
    day_start_utc: hourlyBucketStart(item, dayStartAt),
    sessions: item.sessions,
    messages: item.messages,
    level: item.level,
    session_refs: item.session_refs,
  };
}

function StatsSkeleton() {
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="ui-stats-card space-y-3 px-5 py-4">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-7 w-1/2" />
            <Skeleton className="h-2.5 w-2/3" />
          </div>
        ))}
      </div>
      <div className="ui-stats-card space-y-3 p-5">
        <Skeleton className="h-4 w-1/4" />
        <Skeleton className="h-[300px] w-full" />
      </div>
    </div>
  );
}

function StatsCard({
  title,
  subtitle,
  right,
  className,
  children,
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`ui-stats-card flex min-w-0 flex-col p-5 ${className ?? ""}`}>
      {(title || right) && (
        <header className="mb-4 flex items-start gap-3">
          <div className="min-w-0">
            {title && <h3 className="text-[15px] font-semibold tracking-tight text-text-primary">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-[12px] text-text-muted">{subtitle}</p>}
          </div>
          {right && <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

function StatsPill({ children }: { children: ReactNode }) {
  return (
    <span className="ui-stats-inset inline-flex max-w-full items-center gap-1.5 truncate px-2.5 py-1 text-[11px] font-medium text-text-secondary">
      {children}
    </span>
  );
}

function EmptyBlock({ text }: { text: string }) {
  return (
    <div className="flex min-h-[120px] flex-1 items-center justify-center rounded-xl px-6 text-center text-[12px] text-text-muted">
      {text}
    </div>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const gradientId = useId().replace(/:/g, "");
  const data = useMemo(() => values.map((value, index) => ({ index, value })), [values]);
  if (data.length < 2 || !values.some((value) => value > 0)) return null;
  return (
    <div className="pointer-events-none h-9 w-full" aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.32} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.75} fill={`url(#${gradientId})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function KpiStrip({ stats, trend }: { stats: HistoryStatsPayload; trend: HistoryStatsDailySeriesItem[] }) {
  const { language, t } = useI18n();
  const totalTokens = totalTokensOf({
    input_tokens: stats.total_input_tokens,
    output_tokens: stats.total_output_tokens,
    cache_read_tokens: stats.total_cache_read_tokens,
    cache_creation_tokens: stats.total_cache_creation_tokens,
  });
  // 缓存命中率口径与请求级用量一致：缓存读取 / 输入上下文（输入 + 缓存读取 + 缓存写入）。
  const contextTokens = stats.total_input_tokens + stats.total_cache_read_tokens + stats.total_cache_creation_tokens;
  const cacheHitRate = contextTokens > 0 ? (stats.total_cache_read_tokens / contextTokens) * 100 : 0;
  const tokensPerSession = stats.total_sessions > 0 ? totalTokens / stats.total_sessions : 0;
  const tokenTrend = useMemo(() => trend.map(totalTokensOf), [trend]);
  const costTrend = useMemo(() => trend.map((item) => item.total_cost_usd), [trend]);
  const sessionTrend = useMemo(() => trend.map((item) => item.sessions), [trend]);

  const items: {
    label: string;
    value: string;
    hint: string;
    icon: typeof Layers;
    tint: string;
    footer?: ReactNode;
  }[] = [
    {
      label: t("stats.kpi.totalToken"),
      value: formatCompactCount(totalTokens, language),
      hint: t("stats.kpi.fullValue", { value: formatCount(totalTokens, language) }),
      icon: Layers,
      tint: STATS_COLORS.total,
      footer: <Sparkline values={tokenTrend} color={STATS_COLORS.total} />,
    },
    {
      label: t("stats.kpi.estimatedCost"),
      value: formatCost(stats.total_cost_usd),
      hint: stats.total_unpriced_tokens > 0
        ? t("stats.kpi.unpriced", { value: formatCompactCount(stats.total_unpriced_tokens, language) })
        : t("stats.kpi.localEstimate"),
      icon: Coins,
      tint: STATS_COLORS.cost,
      footer: <Sparkline values={costTrend} color={STATS_COLORS.cost} />,
    },
    {
      label: t("stats.kpi.sessions"),
      value: formatCount(stats.total_sessions, language),
      hint: t("stats.kpi.sessionsHint", {
        messages: formatCount(stats.total_messages, language),
        tokens: formatCompactCount(tokensPerSession, language),
      }),
      icon: MessagesSquare,
      tint: "var(--stats-purple)",
      footer: <Sparkline values={sessionTrend} color="var(--stats-purple)" />,
    },
    {
      label: t("stats.kpi.cacheHitRate"),
      value: formatPercent(cacheHitRate),
      hint: t("stats.kpi.cacheHitHint", { value: formatCompactCount(stats.total_cache_read_tokens, language) }),
      icon: Database,
      tint: STATS_COLORS.cacheRead,
      footer: (
        <div className="ui-stats-meter mt-3" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.max(0, cacheHitRate))}%`, backgroundColor: STATS_COLORS.cacheRead }} />
        </div>
      ),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div key={item.label} className="ui-stats-card flex min-w-0 flex-col px-5 pb-4 pt-4">
            <div className="inline-flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: item.tint }}>
              <Icon size={13} strokeWidth={2.2} />
              <span className="truncate">{item.label}</span>
            </div>
            <div className="ui-stats-value mt-3 truncate text-[28px] leading-none">{item.value}</div>
            <div className="mt-2 truncate text-[12px] text-text-muted" title={item.hint}>{item.hint}</div>
            {item.footer && <div className="mt-auto pt-2">{item.footer}</div>}
          </div>
        );
      })}
    </div>
  );
}

function MetricRow({ items }: { items: { label: string; value: string; hint?: string }[] }) {
  return (
    <div className="grid grid-cols-2 gap-y-4 sm:grid-cols-3 xl:grid-cols-5">
      {items.map((item, index) => (
        <div
          key={item.label}
          className={`min-w-0 px-4 ${index === 0 ? "pl-0" : ""} xl:border-l xl:border-[color:var(--stats-divider)] xl:first:border-l-0`}
        >
          <div className="ui-stats-eyebrow truncate">{item.label}</div>
          <div className="ui-stats-value mt-1.5 truncate text-[22px] leading-tight">{item.value}</div>
          {item.hint && <div className="mt-1 truncate text-[11px] text-text-muted" title={item.hint}>{item.hint}</div>}
        </div>
      ))}
    </div>
  );
}

function RankMeterRow({
  rank,
  label,
  value,
  detail,
  ratio,
  color,
  leading,
  title,
}: {
  rank?: number;
  label: string;
  value: string;
  detail?: string;
  ratio: number;
  color: string;
  leading?: ReactNode;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <div className="flex items-center gap-2 text-[12px]">
        {rank !== undefined && <span className="w-4 shrink-0 text-right text-[11px] font-semibold tabular-nums text-text-muted">{rank}</span>}
        {leading && <span className="inline-flex shrink-0">{leading}</span>}
        <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{label}</span>
        <span className="shrink-0 font-semibold tabular-nums text-text-primary">{value}</span>
      </div>
      <div className={`mt-1.5 flex items-center gap-2 ${rank !== undefined ? "pl-6" : ""}`}>
        <div className="ui-stats-meter min-w-0 flex-1">
          <span style={{ width: `${Math.max(2, Math.min(100, ratio * 100))}%`, backgroundColor: color }} />
        </div>
        {detail && <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-text-muted">{detail}</span>}
      </div>
    </div>
  );
}

function RequestUsageOverview({ stats }: { stats: RequestLogStatsPayload }) {
  const { language, t } = useI18n();
  const gradientId = useId().replace(/:/g, "");
  const trendData = stats.trend.map((item) => ({
    ...item,
    bucketLabel: axisBucketLabel(item.bucket_start_ms, stats.granularity),
    bucketTitle: formatBucketLabel(item.bucket_start_ms, stats.granularity, language),
    totalTokens: item.total_tokens,
    costValue: Number(item.total_cost_usd.toFixed(4)),
  }));
  const pricedTokens = Math.max(0, stats.total_tokens - stats.total_unpriced_tokens);
  const coverage = stats.total_tokens > 0 ? (pricedTokens / stats.total_tokens) * 100 : 0;
  const metrics = [
    { label: t("stats.requestUsage.totalTokens"), value: formatCompactCount(stats.total_tokens, language), hint: formatCount(stats.total_tokens, language) },
    { label: t("stats.requestUsage.requests"), value: formatCompactCount(stats.total_requests, language), hint: formatCount(stats.total_requests, language) },
    { label: t("stats.requestUsage.cacheHitRate"), value: formatPercent(stats.cache_hit_rate * 100), hint: t("stats.requestUsage.cacheHitHint") },
    { label: t("stats.requestUsage.cost"), value: formatCost(stats.total_cost_usd), hint: stats.total_unpriced_tokens > 0 ? t("stats.kpi.unpriced", { value: formatCompactCount(stats.total_unpriced_tokens, language) }) : t("stats.kpi.localEstimate") },
    { label: t("stats.requestUsage.coverage"), value: formatPercent(coverage), hint: t("stats.kpi.coverageHint") },
  ];
  const legend = [
    { key: "total", label: t("stats.trend.totalToken"), color: STATS_COLORS.total },
    { key: "input", label: t("termStats.input"), color: STATS_COLORS.input },
    { key: "output", label: t("termStats.output"), color: STATS_COLORS.output },
  ];

  return (
    <StatsCard title={t("stats.requestUsage.title")} subtitle={t("stats.requestUsage.subtitle")}>
      <MetricRow items={metrics} />
      <div className="my-5 h-px bg-[var(--stats-divider)]" />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.8fr)_minmax(260px,1fr)]">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="text-[13px] font-semibold text-text-primary">{t("stats.requestUsage.trend")}</div>
            <div className="ml-auto"><LegendList items={legend} /></div>
          </div>
          {trendData.length > 0 ? (
            <div className="h-[240px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={trendData} margin={{ top: 8, right: 4, bottom: 0, left: -8 }}>
                  <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={STATS_COLORS.total} stopOpacity={0.26} />
                      <stop offset="100%" stopColor={STATS_COLORS.total} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={STATS_GRID_STROKE} strokeDasharray="3 4" vertical={false} />
                  <XAxis dataKey="bucketLabel" tick={STATS_AXIS_TICK} tickLine={false} axisLine={false} minTickGap={18} dy={6} />
                  <YAxis tick={STATS_AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(value) => formatCompactCount(Number(value), language)} allowDecimals={false} width={48} />
                  <Tooltip
                    cursor={STATS_AXIS_CURSOR}
                    wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                    content={(props) => <DailyUsageTrendTooltip {...props} language={language} costLabel={t("stats.trend.cost")} />}
                  />
                  <Area type="monotone" dataKey="totalTokens" name={t("stats.trend.totalToken")} stroke={STATS_COLORS.total} strokeWidth={2.25} fill={`url(#${gradientId})`} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--stats-card)" }} />
                  <Line type="monotone" dataKey="input_tokens" name={t("termStats.input")} stroke={STATS_COLORS.input} strokeWidth={1.75} dot={false} activeDot={{ r: 3 }} />
                  <Line type="monotone" dataKey="output_tokens" name={t("termStats.output")} stroke={STATS_COLORS.output} strokeWidth={1.75} dot={false} activeDot={{ r: 3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyBlock text={t("stats.requestUsage.empty")} />}
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-1">
          <div className="min-w-0">
            <div className="mb-3 text-[13px] font-semibold text-text-primary">{t("stats.requestUsage.sources")}</div>
            <div className="space-y-3">
              {stats.source_distribution.length === 0 && <div className="text-[12px] text-text-muted">{t("stats.requestUsage.empty")}</div>}
              {stats.source_distribution.map((item, index) => {
                const icon = resolveHistorySourceIconKey(item.source);
                return (
                  <RankMeterRow
                    key={item.source}
                    label={t(HISTORY_SOURCE_DESCRIPTOR_BY_ID.get(item.source)?.labelKey ?? "common.allSources")}
                    leading={icon ? <CliToolIcon icon={icon} size={14} /> : <Database size={14} className="text-text-muted" />}
                    value={formatPercent(item.ratio * 100)}
                    detail={formatCompactCount(item.total_tokens, language)}
                    ratio={item.ratio}
                    color={STATS_CATEGORICAL[index % STATS_CATEGORICAL.length]}
                    title={`${formatCount(item.total_tokens, language)} Token · ${formatCount(item.requests, language)} ${t("stats.requestUsage.requestUnit")}`}
                  />
                );
              })}
            </div>
          </div>
          <div className="min-w-0">
            <div className="mb-3 text-[13px] font-semibold text-text-primary">{t("stats.requestUsage.models")}</div>
            <div className="space-y-3">
              {stats.model_distribution.length === 0 && <div className="text-[12px] text-text-muted">{t("stats.requestUsage.empty")}</div>}
              {stats.model_distribution.slice(0, 6).map((item, index) => (
                <RankMeterRow
                  key={item.model}
                  label={item.model === "unknown" ? t("requestLogs.unknownModel") : item.model}
                  value={formatPercent(item.ratio * 100)}
                  ratio={item.ratio}
                  color={STATS_CATEGORICAL[index % STATS_CATEGORICAL.length]}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </StatsCard>
  );
}

function LegendList({
  items,
  hidden,
  onToggle,
}: {
  items: { key: string; label: string; color: string }[];
  hidden?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[11px] text-text-secondary">
      {items.map((item) => {
        const off = hidden?.has(item.key) ?? false;
        const content = (
          <>
            <span className="ui-stats-legend-dot" style={{ backgroundColor: off ? "var(--stats-fill-strong)" : item.color }} />
            <span className={off ? "text-text-muted line-through" : ""}>{item.label}</span>
          </>
        );
        return onToggle ? (
          <button
            key={item.key}
            type="button"
            aria-pressed={!off}
            onClick={() => onToggle(item.key)}
            className="ui-focus-ring inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-opacity hover:opacity-80"
          >
            {content}
          </button>
        ) : (
          <span key={item.key} className="inline-flex items-center gap-1.5">{content}</span>
        );
      })}
    </div>
  );
}

function TokenCompositionCard({ stats }: { stats: HistoryStatsPayload }) {
  const { language, t } = useI18n();
  const parts = useMemo(() => [
    { key: "input", label: t("termStats.input"), value: stats.total_input_tokens, color: STATS_COLORS.input },
    { key: "output", label: t("termStats.output"), value: stats.total_output_tokens, color: STATS_COLORS.output },
    { key: "cacheCreation", label: t("termStats.cacheWrite"), value: stats.total_cache_creation_tokens, color: STATS_COLORS.cacheCreation },
    { key: "cacheRead", label: t("termStats.cacheHit"), value: stats.total_cache_read_tokens, color: STATS_COLORS.cacheRead },
  ], [stats.total_cache_creation_tokens, stats.total_cache_read_tokens, stats.total_input_tokens, stats.total_output_tokens, t]);
  const total = parts.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  const chartData = parts.filter((item) => item.value > 0);

  return (
    <StatsCard title={t("stats.tokenComposition")} subtitle={t("stats.tokenCompositionHint")} className="h-full">
      {chartData.length > 0 ? (
        <>
          <div className="relative mx-auto h-[168px] w-full max-w-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey="value"
                  nameKey="label"
                  innerRadius="72%"
                  outerRadius="100%"
                  paddingAngle={2.5}
                  cornerRadius={6}
                  stroke="none"
                  startAngle={90}
                  endAngle={-270}
                >
                  {chartData.map((item) => <Cell key={item.key} fill={item.color} />)}
                </Pie>
                <Tooltip wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE} content={(props) => <PieSliceTooltip {...props} language={language} />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <div className="ui-stats-eyebrow">{t("stats.kpi.totalToken")}</div>
              <div className="ui-stats-value mt-0.5 text-[20px] leading-tight">{formatCompactCount(total, language)}</div>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {parts.map((item) => (
              <div key={item.key} className="flex items-center gap-2 text-[12px]">
                <span className="ui-stats-legend-dot" style={{ backgroundColor: item.color }} />
                <span className="min-w-0 flex-1 truncate text-text-secondary">{item.label}</span>
                <span className="font-semibold tabular-nums text-text-primary">{formatCompactCount(item.value, language)}</span>
                <span className="w-12 text-right tabular-nums text-text-muted">{formatPercent(total > 0 ? (item.value / total) * 100 : 0)}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <EmptyBlock text={t("stats.trend.empty")} />
      )}
    </StatsCard>
  );
}

function ContextNote({
  sourceLabel,
  projectLabel,
  dateRangeLabel,
  stats,
}: {
  sourceLabel: string;
  projectLabel: string;
  dateRangeLabel: string;
  stats: HistoryStatsPayload;
}) {
  const { language, t } = useI18n();
  const parts = [
    t("stats.context.source", { value: sourceLabel }),
    t("stats.context.project", { value: projectLabel }),
    t("stats.context.range", { value: dateRangeLabel }),
    t("stats.context.unpriced", { value: formatCompactCount(stats.total_unpriced_tokens, language) }),
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] text-text-muted">
      <span className="inline-flex items-center gap-1 font-semibold text-text-secondary">
        <Info size={12} />
        {t("stats.context.localEstimate")}
      </span>
      {parts.map((part) => (
        <span key={part} className="inline-flex items-center gap-2">
          <span aria-hidden="true">·</span>
          {part}
        </span>
      ))}
      <span className="w-full sm:w-auto sm:before:mr-2 sm:before:content-['·']">{t("stats.context.billingNote")}</span>
    </div>
  );
}

function DailyUsageTrendChart({
  items,
  granularity,
}: {
  items: HistoryStatsDailySeriesItem[];
  granularity: StatsBucketGranularity;
}) {
  const { language, t } = useI18n();
  const gradientId = useId().replace(/:/g, "");
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set());
  const data = useMemo(
    () =>
      items.map((item) => ({
        ...item,
        bucketLabel: axisBucketLabel(item.day_start_utc, granularity),
        bucketTitle: formatBucketLabel(item.day_start_utc, granularity, language),
        totalTokens: totalTokensOf(item),
        costValue: Number(item.total_cost_usd.toFixed(4)),
      })),
    [granularity, items, language]
  );
  const peak = useMemo(() => {
    const found = items.reduce<HistoryStatsDailySeriesItem | null>((current, item) => {
      if (!current) return item;
      return totalTokensOf(item) > totalTokensOf(current) ? item : current;
    }, null);
    return found && totalTokensOf(found) > 0 ? found : null;
  }, [items]);

  const hasData = items.some((item) => totalTokensOf(item) > 0 || item.total_cost_usd > 0);
  const costLabel = t("stats.trend.cost");
  const series = [
    { key: "totalTokens", label: t("stats.trend.totalToken"), color: STATS_COLORS.total },
    { key: "input_tokens", label: t("termStats.input"), color: STATS_COLORS.input },
    { key: "output_tokens", label: t("termStats.output"), color: STATS_COLORS.output },
    { key: "cache_creation_tokens", label: t("termStats.cacheWrite"), color: STATS_COLORS.cacheCreation },
    { key: "cache_read_tokens", label: t("termStats.cacheHit"), color: STATS_COLORS.cacheRead },
    { key: "costValue", label: costLabel, color: STATS_COLORS.cost },
  ];
  const toggleSeries = (key: string) => {
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <StatsCard
      title={t("stats.trend.title")}
      subtitle={granularity === "hour" ? t("stats.trend.hourHint") : t("stats.trend.dayHint")}
      right={
        <StatsPill>
          <span className="ui-stats-legend-dot" style={{ backgroundColor: STATS_COLORS.peak }} />
          {peak
            ? t("stats.trend.peak", {
                bucket: formatBucketLabel(peak.day_start_utc, granularity, language),
                tokens: formatCount(totalTokensOf(peak), language),
              })
            : t("stats.trend.noPeak")}
        </StatsPill>
      }
    >
      {hasData ? (
        <>
          <div className="mb-3">
            <LegendList items={series} hidden={hiddenSeries} onToggle={toggleSeries} />
          </div>
          <div className="h-[340px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 8, right: 0, bottom: 0, left: -8 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={STATS_COLORS.total} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={STATS_COLORS.total} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={STATS_GRID_STROKE} strokeDasharray="3 4" vertical={false} />
                <XAxis dataKey="bucketLabel" tick={STATS_AXIS_TICK} tickLine={false} axisLine={false} minTickGap={18} dy={6} />
                <YAxis yAxisId="tokens" tick={STATS_AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(value) => formatCompactCount(Number(value), language)} allowDecimals={false} width={52} />
                <YAxis yAxisId="cost" orientation="right" tick={STATS_AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(value) => formatCost(Number(value))} width={56} hide={hiddenSeries.has("costValue")} />
                <Tooltip
                  cursor={STATS_AXIS_CURSOR}
                  wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                  content={(props) => <DailyUsageTrendTooltip {...props} language={language} costLabel={costLabel} />}
                />
                <Area yAxisId="tokens" type="monotone" dataKey="totalTokens" name={series[0].label} stroke={STATS_COLORS.total} strokeWidth={2.5} fill={`url(#${gradientId})`} hide={hiddenSeries.has("totalTokens")} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--stats-card)", fill: STATS_COLORS.total }} />
                <Line yAxisId="tokens" type="monotone" dataKey="input_tokens" name={series[1].label} stroke={STATS_COLORS.input} strokeWidth={1.75} dot={false} activeDot={{ r: 3.5 }} hide={hiddenSeries.has("input_tokens")} />
                <Line yAxisId="tokens" type="monotone" dataKey="output_tokens" name={series[2].label} stroke={STATS_COLORS.output} strokeWidth={1.75} dot={false} activeDot={{ r: 3.5 }} hide={hiddenSeries.has("output_tokens")} />
                <Line yAxisId="tokens" type="monotone" dataKey="cache_creation_tokens" name={series[3].label} stroke={STATS_COLORS.cacheCreation} strokeWidth={1.75} dot={false} activeDot={{ r: 3.5 }} hide={hiddenSeries.has("cache_creation_tokens")} />
                <Line yAxisId="tokens" type="monotone" dataKey="cache_read_tokens" name={series[4].label} stroke={STATS_COLORS.cacheRead} strokeWidth={1.75} dot={false} activeDot={{ r: 3.5 }} hide={hiddenSeries.has("cache_read_tokens")} />
                <Line yAxisId="cost" type="monotone" dataKey="costValue" name={costLabel} stroke={STATS_COLORS.cost} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4, fill: STATS_COLORS.cost }} hide={hiddenSeries.has("costValue")} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      ) : (
        <EmptyBlock text={t("stats.trend.empty")} />
      )}
    </StatsCard>
  );
}

function ModelRankingCard({ items }: { items: HistoryStatsModelItem[] }) {
  const { language, t } = useI18n();
  const models = useMemo(
    () => items.filter((item) => totalTokensOf(item) > 0).slice(0, 8),
    [items]
  );
  const maxTokens = models.reduce((max, item) => Math.max(max, totalTokensOf(item)), 0);

  return (
    <StatsCard title={t("stats.modelRanking")} className="h-full">
      {models.length === 0 ? (
        <EmptyBlock text={t("stats.modelRanking.empty")} />
      ) : (
        <div className="space-y-3.5">
          {models.map((model, index) => {
            const tokens = totalTokensOf(model);
            return (
              <RankMeterRow
                key={model.model}
                rank={index + 1}
                label={model.model.replace(/^claude-/, "")}
                value={formatCompactCount(tokens, language)}
                detail={formatCost(model.total_cost_usd)}
                ratio={maxTokens > 0 ? tokens / maxTokens : 0}
                color={index === 0 ? STATS_COLORS.accent : "color-mix(in srgb, var(--stats-blue) 55%, transparent)"}
                title={`${model.model}\n${formatCount(tokens, language)} Token · ${formatCost(model.total_cost_usd)} · ${t("termStats.cacheHit")}/${t("termStats.cacheWrite")} ${formatCount(model.cache_creation_tokens + model.cache_read_tokens, language)}`}
              />
            );
          })}
        </div>
      )}
    </StatsCard>
  );
}

function ProjectRankingCard({ items, selectedProjectKey, onSelectProject, onClearProject }: {
  items: HistoryStatsProjectItem[];
  selectedProjectKey: string;
  onSelectProject: (projectKey: string) => void;
  onClearProject: () => void;
}) {
  const { language, t } = useI18n();
  const topItems = useMemo(() => items.slice(0, 8), [items]);
  const maxTokens = topItems.reduce((max, item) => Math.max(max, totalTokensOf(item)), 0);

  return (
    <StatsCard
      title={t("stats.projectRanking")}
      className="h-full"
      right={
        selectedProjectKey ? (
          <Button onClick={onClearProject} size="sm" variant="ghost">
            {t("stats.projectRanking.clear")}
          </Button>
        ) : undefined
      }
    >
      {topItems.length === 0 ? (
        <EmptyBlock text={t("stats.projectRanking.empty")} />
      ) : (
        <div className="-mx-2 space-y-0.5">
          {topItems.map((item, index) => {
            const tokens = totalTokensOf(item);
            const selected = item.project_key === selectedProjectKey;
            return (
              <button
                key={item.project_key}
                type="button"
                onClick={() => onSelectProject(item.project_key)}
                className="ui-stats-row ui-focus-ring block w-full px-2 py-1.5 text-left"
                data-selected={selected ? "true" : "false"}
                aria-pressed={selected}
                title={t("stats.projectRanking.filterTitle", { project: item.project_key })}
              >
                <RankMeterRow
                  rank={index + 1}
                  label={item.project_key}
                  value={formatCompactCount(tokens, language)}
                  ratio={maxTokens > 0 ? tokens / maxTokens : 0}
                  color={selected || (!selectedProjectKey && index === 0) ? STATS_COLORS.accent : "color-mix(in srgb, var(--stats-blue) 55%, transparent)"}
                />
              </button>
            );
          })}
        </div>
      )}
    </StatsCard>
  );
}

function SourceBreakdown({ items }: { items: HistoryStatsSourceItem[] }) {
  const { language, t } = useI18n();
  const tokenParts = useMemo(() => [
    { key: "input", label: t("termStats.input"), color: STATS_COLORS.input },
    { key: "output", label: t("termStats.output"), color: STATS_COLORS.output },
    { key: "cacheCreation", label: t("termStats.cacheWrite"), color: STATS_COLORS.cacheCreation },
    { key: "cacheRead", label: t("termStats.cacheHit"), color: STATS_COLORS.cacheRead },
  ], [t]);
  const sources = useMemo(() => {
    return items.map((item) => {
      const parts = [
        { ...tokenParts[0], value: item.input_tokens },
        { ...tokenParts[1], value: item.output_tokens },
        { ...tokenParts[2], value: item.cache_creation_tokens },
        { ...tokenParts[3], value: item.cache_read_tokens },
      ];
      return {
        source: item.source,
        descriptor: HISTORY_SOURCE_DESCRIPTORS.find((descriptor) => descriptor.id === item.source),
        icon: resolveHistorySourceIconKey(item.source),
        total: parts.reduce((sum, part) => sum + part.value, 0),
        parts,
      };
    }).filter((item) => item.total > 0);
  }, [items, tokenParts]);

  return (
    <StatsCard title={t("stats.sourceBreakdown")} right={sources.length > 0 ? <LegendList items={tokenParts} /> : undefined}>
      {sources.length === 0 ? (
        <EmptyBlock text={t("stats.sourceBreakdown.empty")} />
      ) : (
        <div className="grid grid-cols-1 gap-x-8 gap-y-5 lg:grid-cols-2" role="group" aria-label={t("stats.sourceBreakdown")}>
          {sources.map((source) => (
            <div key={source.source} className="min-w-0">
              <div className="flex items-center gap-2 text-[13px]">
                <span className="inline-flex shrink-0" aria-hidden="true">
                  {source.icon ? <CliToolIcon icon={source.icon} size={16} /> : <Database size={16} />}
                </span>
                <span className="min-w-0 flex-1 truncate font-semibold text-text-primary">{source.descriptor ? t(source.descriptor.labelKey) : source.source}</span>
                <span className="shrink-0 font-semibold tabular-nums text-text-primary">{formatCompactCount(source.total, language)}</span>
                <span className="shrink-0 text-[11px] text-text-muted">Token</span>
              </div>
              <div className="mt-2.5 flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full" aria-hidden="true">
                {source.parts.filter((part) => part.value > 0).map((part) => (
                  <span
                    key={part.key}
                    className="h-full first:rounded-l-full last:rounded-r-full"
                    style={{ width: `${(part.value / source.total) * 100}%`, minWidth: 3, backgroundColor: part.color }}
                    title={`${part.label} · ${formatCount(part.value, language)}`}
                  />
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
                {source.parts.map((part) => (
                  <div key={part.key} className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
                      <span className="ui-stats-legend-dot" style={{ backgroundColor: part.color }} />
                      <span className="truncate">{part.label}</span>
                    </div>
                    <div className="mt-0.5 flex items-baseline gap-1.5 pl-3.5">
                      <span className="text-[13px] font-semibold tabular-nums text-text-primary">{formatCompactCount(part.value, language)}</span>
                      <span className="text-[10px] tabular-nums text-text-muted">{formatPercent((part.value / source.total) * 100)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </StatsCard>
  );
}

function StatsSegmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  role = "radiogroup",
}: {
  value: T;
  options: { value: T; label: string; icon?: typeof BarChart3 }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  role?: "radiogroup" | "tablist";
}) {
  const itemRole = role === "tablist" ? "tab" : "radio";
  return (
    <div className="ui-stats-segmented" role={role} aria-label={ariaLabel}>
      {options.map((option) => {
        const Icon = option.icon;
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role={itemRole}
            aria-selected={itemRole === "tab" ? selected : undefined}
            aria-checked={itemRole === "radio" ? selected : undefined}
            onClick={() => onChange(option.value)}
            className="ui-stats-segment ui-focus-ring"
            data-selected={selected ? "true" : "false"}
          >
            {Icon && <Icon size={13} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function StatsSourceFilterDropdown({
  value,
  onChange,
  className,
}: {
  value: HistorySourceFilter;
  onChange: (value: HistorySourceFilter) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const selectedDescriptor = value === "all"
    ? null
    : HISTORY_SOURCE_DESCRIPTORS.find((descriptor) => descriptor.id === value) ?? null;
  const label = selectedDescriptor ? t(selectedDescriptor.labelKey) : t("common.allSources");

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (!dropdownRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const renderIcon = (source: HistorySourceFilter, size = 13) => {
    const icon = source === "all" ? null : resolveHistorySourceIconKey(source);
    return icon ? <CliToolIcon icon={icon} size={size} /> : <Database size={size} className="text-text-muted" />;
  };

  return (
    <div ref={dropdownRef} className="relative min-w-[132px] shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={`ui-stats-control ui-focus-ring w-full text-left ${className ?? ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("common.allSources")}
      >
        <span className="shrink-0">{renderIcon(value)}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <ChevronDown size={13} className="shrink-0 text-text-muted transition-transform" style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1.5 max-h-72 w-[min(220px,calc(100vw-32px))] overflow-y-auto ui-stats-popover p-1" role="listbox" aria-label={t("common.allSources")}>
          <button
            type="button"
            role="option"
            aria-selected={value === "all"}
            onClick={() => { onChange("all"); setOpen(false); }}
            className="ui-tree-node ui-focus-ring flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs"
            data-selected={value === "all" ? "true" : "false"}
          >
            {renderIcon("all")}
            <span className="min-w-0 flex-1 truncate">{t("common.allSources")}</span>
          </button>
          {HISTORY_SOURCE_DESCRIPTORS.map((descriptor) => (
            <button
              key={descriptor.id}
              type="button"
              role="option"
              aria-selected={value === descriptor.id}
              onClick={() => { onChange(descriptor.id); setOpen(false); }}
              className="ui-tree-node ui-focus-ring flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs"
              data-selected={value === descriptor.id ? "true" : "false"}
            >
              {renderIcon(descriptor.id)}
              <span className="min-w-0 flex-1 truncate">{t(descriptor.labelKey)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatsProjectFilterDropdown({
  projects,
  groups,
  selectedProjectId,
  rawProjectKey,
  onSelectProjectId,
  onClear,
}: {
  projects: Project[];
  groups: Group[];
  selectedProjectId: string;
  rawProjectKey: string;
  onSelectProjectId: (projectId: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );
  const projectTree = useMemo(() => buildStatsProjectTree(groups, projects), [groups, projects]);
  const groupIds = useMemo(() => collectStatsGroupIds(projectTree), [projectTree]);
  const normalizedQuery = useMemo(() => normalizeProjectSearch(query), [query]);
  const filteredTree = useMemo(
    () => filterStatsProjectTree(projectTree, normalizedQuery),
    [normalizedQuery, projectTree]
  );
  const filteredProjectCount = useMemo(
    () => filteredTree.reduce((sum, node) => sum + countStatsProjects(node), 0),
    [filteredTree]
  );
  const label = selectedProject?.name || rawProjectKey || t("common.allProjects");
  const title = resolveHistoryProjectPath(selectedProject) || rawProjectKey || t("common.allProjects");

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;

    if (!open) {
      setQuery("");
      return;
    }
    if (!wasOpen) {
      setCollapsedGroups(new Set(groupIds));
    }
  }, [groupIds, open]);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (dropdownRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const handleClear = useCallback(() => {
    onClear();
    setOpen(false);
  }, [onClear]);

  const handleSelectProject = useCallback(
    (projectId: string) => {
      onSelectProjectId(projectId);
      setOpen(false);
    },
    [onSelectProjectId]
  );

  const renderNode = (node: StatsProjectTreeNode, depth = 0): ReactNode => {
    const paddingLeft = 8 + depth * 14;
    if (node.type === "group") {
      const isOpen = Boolean(normalizedQuery) || !collapsedGroups.has(node.group.id);
      const groupAppearance = resolveNodeAppearance({
        icon: node.group.icon,
        color: node.group.color,
      });
      return (
        <div key={`group:${node.group.id}`}>
          <button
            type="button"
            onClick={() => toggleGroup(node.group.id)}
            className="ui-tree-node ui-tree-group ui-focus-ring flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-[11px] font-semibold"
            style={{
              paddingLeft,
              ...(groupAppearance.hasColor ? { "--node-accent": groupAppearance.colorVar } : {}),
            } as CSSProperties}
            aria-expanded={isOpen}
          >
            <ChevronRight size={12} className="shrink-0 transition-transform" style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }} />
            <span className="ui-tree-leading-icon shrink-0">
              <NodeAppearanceIcon
                mark={groupAppearance.emoji}
                iconKey={groupAppearance.iconKey}
                fallback="folder"
                size={13}
              />
            </span>
            <span className="min-w-0 flex-1 truncate">{node.group.name}</span>
            <span className="ui-tree-count-badge rounded-full px-1.5 text-[10px] font-medium">{countStatsProjects(node)}</span>
          </button>
          {isOpen && node.children.length > 0 && (
            <div className="mt-0.5 space-y-0.5">
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    const selected = selectedProjectId === node.project.id;
    const projectPath = resolveHistoryProjectPath(node.project);
    const projectAppearance = resolveNodeAppearance({
      icon: node.project.icon,
      color: node.project.color,
    });
    return (
      <button
        key={`project:${node.project.id}`}
        type="button"
        onClick={() => handleSelectProject(node.project.id)}
        className="ui-tree-node ui-tree-project ui-focus-ring flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-[12px]"
        data-selected={selected ? "true" : "false"}
        data-accent={projectAppearance.hasColor ? "true" : undefined}
        style={{
          paddingLeft,
          ...(projectAppearance.hasColor ? { "--node-accent": projectAppearance.colorVar } : {}),
        } as CSSProperties}
        title={projectPath}
      >
        <span className="ui-tree-leading-icon">
          <StatsProjectFilterIcon project={node.project} size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{node.project.name}</span>
      </button>
    );
  };

  return (
    <div ref={dropdownRef} className="relative min-w-[124px] shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="ui-stats-control ui-focus-ring w-full text-left"
        aria-haspopup="tree"
        aria-expanded={open}
        aria-label={t("stats.projectFilter")}
        title={title}
      >
        {selectedProject ? (
          <span className="ui-tree-leading-icon">
            <StatsProjectFilterIcon project={selectedProject} size={13} />
          </span>
        ) : (
          <Folder size={13} className="shrink-0 text-text-muted" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <ChevronDown size={13} className="shrink-0 text-text-muted transition-transform" style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 w-[min(320px,calc(100vw-32px))] ui-stats-popover p-1">
          <div className="ui-history-search-shell mb-1 gap-2 px-2 py-1.5 text-text-secondary">
            <Search size={13} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("history.projectFilter.searchAria")}
              placeholder={t("history.projectFilter.searchPlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="ui-flat-action inline-flex h-5 w-5 items-center justify-center rounded-md px-0 text-text-muted"
                aria-label={t("history.projectFilter.clearSearch")}
                title={t("history.projectFilter.clearSearch")}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <div className="ui-thin-scroll max-h-56 space-y-0.5 overflow-y-auto pr-1" role="tree" aria-label={t("history.projectFilter.treeAria")}>
            <button
              type="button"
              onClick={handleClear}
              className="ui-tree-node ui-tree-project ui-focus-ring flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-left text-[12px]"
              data-selected={!selectedProjectId && !rawProjectKey ? "true" : "false"}
            >
              <Folder size={13} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate font-medium">{t("common.allProjects")}</span>
              <span className="ui-tree-count-badge rounded-full px-1.5 text-[10px] font-medium">{projects.length}</span>
            </button>
            {filteredTree.length > 0 ? (
              filteredTree.map((node) => renderNode(node))
            ) : (
              <div className="px-2 py-1.5 text-[11px] text-text-muted">
                {normalizedQuery ? t("history.projectFilter.noMatches") : t("history.projectFilter.empty")}
              </div>
            )}
            {normalizedQuery && filteredTree.length > 0 && (
              <div className="px-2 py-1 text-[10px] text-text-muted">{t("history.projectFilter.matchCount", { count: filteredProjectCount })}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function StatsPanel({ open, onClose, onOpenSession }: StatsPanelProps) {
  const { language, t } = useI18n();
  const { active: workspaceBackgroundActive } = useWorkspaceBackground();
  const projects = useProjectStore((s) => s.projects);
  const statisticsProjects = useMemo(
    () => projects.filter((project) => projectSupportsCapability(project, "statistics")),
    [projects]
  );
  const groups = useProjectStore((s) => s.groups);
  const projectsLoaded = useProjectStore((s) => s.loaded);
  const fetchProjects = useProjectStore((s) => s.fetchAll);

  const [projectKey, setProjectKey] = useState("");
  const [projectId, setProjectId] = useState("");
  const [sourceFilter, setSourceFilter] = useState<HistorySourceFilter>("all");
  const [modelFilter, setModelFilter] = useState("");
  const [activeTab, setActiveTab] = useState<StatsPanelTab>("overview");
  const [timeWindow, setTimeWindow] = useState<StatsTimeWindowState>(() => getDefaultStatsTimeWindow());
  const [manualRefresh, setManualRefresh] = useState<{ key: string; nonce: number } | null>(null);
  const [syncingLocalStats, setSyncingLocalStats] = useState(false);
  const [localStatsSyncError, setLocalStatsSyncError] = useState<string | null>(null);
  const [selectedDayStart, setSelectedDayStart] = useState<number | null>(null);
  const [dayVisibleCount, setDayVisibleCount] = useState(DAY_SESSION_PAGE_SIZE);
  const resolvedTimeWindow = useMemo(() => resolveStatsTimeWindow(timeWindow), [timeWindow]);
  const dateRange = useMemo(() => dateRangeFromStatsTimeWindow(resolvedTimeWindow), [resolvedTimeWindow]);
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? null,
    [projectId, projects]
  );
  const projectPath = resolveHistoryProjectPath(selectedProject);

  const dateBounds = useMemo(() => {
    const startAt = parseDateInput(dateRange.startDate, false);
    const endAt = parseDateInput(dateRange.endDate, true);
    if (!dateRange.startDate || !dateRange.endDate) return { startAt, endAt, error: t("stats.rangeInvalid.missing") };
    if (startAt === null || endAt === null) return { startAt, endAt, error: t("stats.rangeInvalid.format") };
    if (endAt < startAt) return { startAt, endAt, error: t("stats.rangeInvalid.order") };
    return { startAt, endAt, error: null };
  }, [dateRange.endDate, dateRange.startDate, t]);

  const dateRangeLabel = dateBounds.error ? t("stats.rangeInactive") : statsTimeWindowLabel(resolvedTimeWindow, dateRange, t);
  const statsBaseQueryKey = useMemo(
    () => `${sourceFilter}|project_id=${projectId || ALL_PROJECTS_VALUE}|path=${projectPath || ALL_PROJECTS_VALUE}|key=${projectKey || ALL_PROJECTS_VALUE}|model=${modelFilter || "all"}|${dateBounds.startAt ?? "invalid"}|${dateBounds.endAt ?? "invalid"}`,
    [dateBounds.endAt, dateBounds.startAt, modelFilter, projectId, projectKey, projectPath, sourceFilter]
  );
  const effectiveRefreshNonce = manualRefresh?.key === statsBaseQueryKey ? manualRefresh.nonce : 0;
  const statsQuery = useQuery({
    queryKey: ["historyStats", sourceFilter, projectId || null, projectPath || null, projectKey || null, dateBounds.startAt, dateBounds.endAt, effectiveRefreshNonce],
    queryFn: () => {
      if (dateBounds.startAt === null || dateBounds.endAt === null) {
        throw new Error(dateBounds.error ?? "Invalid stats range");
      }
      const options = {
        sourceFilter,
        projectKey: projectPath ? null : projectKey || null,
        projectPath: projectPath || null,
        rangeDays: null,
        startAt: dateBounds.startAt,
        endAt: dateBounds.endAt,
        force: selectedProject?.environment_type === "ssh" && effectiveRefreshNonce > 0,
      };
      return selectedProject?.environment_type === "ssh"
        ? fetchRemoteHistoryStatsPayload(selectedProject, options)
        : fetchHistoryStatsPayload(options);
    },
    enabled: open && activeTab === "overview" && dateBounds.error === null && dateBounds.startAt !== null && dateBounds.endAt !== null,
  });
  const stats = statsQuery.data ?? null;
  const loadingStats = statsQuery.isFetching || syncingLocalStats;
  const statsError = statsQuery.error ? String(statsQuery.error) : null;
  const statsUpdatedAt = statsQuery.dataUpdatedAt || null;
  const requestStatsSupported = sourceFilter === "all" || REQUEST_LOG_SOURCE_IDS.has(sourceFilter);
  const requestLogSourceFilter: RequestLogSource | null = requestStatsSupported && sourceFilter !== "all"
    ? sourceFilter as RequestLogSource
    : null;
  const requestStatsQuery = useQuery({
    queryKey: ["historyRequestLogStats", sourceFilter, projectId || null, projectPath || null, projectKey || null, modelFilter || null, dateBounds.startAt, dateBounds.endAt, effectiveRefreshNonce],
    queryFn: async () => {
      if (dateBounds.startAt === null || dateBounds.endAt === null) {
        throw new Error(dateBounds.error ?? "Invalid stats range");
      }
      return fetchHistoryRequestLogStats({
        sourceFilter,
        projectKey: projectPath ? null : projectKey || null,
        projectPath: projectPath || null,
        model: modelFilter || null,
        startAt: dateBounds.startAt,
        endAt: dateBounds.endAt,
        force: false,
      });
    },
    enabled: open
      && activeTab === "overview"
      && selectedProject?.environment_type !== "ssh"
      && requestStatsSupported
      && dateBounds.error === null
      && dateBounds.startAt !== null
      && dateBounds.endAt !== null,
    refetchInterval: 60_000,
  });
  const requestStats = requestStatsQuery.data ?? null;
  useEffect(() => {
    if (!open) return;
    setProjectKey("");
    setProjectId("");
    setSourceFilter("all");
    setModelFilter("");
    setActiveTab("overview");
    setTimeWindow(getDefaultStatsTimeWindow());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open || projectsLoaded) return;
    void fetchProjects("interactive");
  }, [fetchProjects, open, projectsLoaded]);

  useEffect(() => {
    if (!projectId || projects.length === 0) return;
    if (!projects.some((project) => project.id === projectId)) setProjectId("");
  }, [projectId, projects]);

  useEffect(() => {
    if (!open) return;
    setSelectedDayStart(null);
    setDayVisibleCount(DAY_SESSION_PAGE_SIZE);
  }, [dateRange.endDate, dateRange.startDate, modelFilter, open, projectId, projectKey, sourceFilter]);

  useEffect(() => {
    setDayVisibleCount(DAY_SESSION_PAGE_SIZE);
  }, [selectedDayStart]);

  const sourceLabel = sourceFilter === "all"
    ? t("common.allSources")
    : t(HISTORY_SOURCE_DESCRIPTOR_BY_ID.get(sourceFilter)?.labelKey ?? "common.allSources");
  const projectLabel = selectedProject?.name || projectKey || t("common.allProjects");
  const waitingForStatsQuery = dateBounds.error === null && statsQuery.isPending;
  const statsGranularity: StatsBucketGranularity = resolvedTimeWindow.mode === "day" ? "hour" : "day";
  const trendItems = useMemo(() => {
    if (!stats) return [];
    if (statsGranularity === "hour") {
      return stats.hourly_activity.map((item) => hourlyToTrendItem(item, dateBounds.startAt));
    }
    return stats.daily_series;
  }, [dateBounds.startAt, stats, statsGranularity]);
  const heatmapItems = useMemo(() => {
    if (!stats) return [];
    if (statsGranularity === "hour") {
      return stats.hourly_activity.map((item) => hourlyToHeatmapDay(item, dateBounds.startAt));
    }
    return stats.heatmap;
  }, [dateBounds.startAt, stats, statsGranularity]);
  const selectedBucket = useMemo(() => {
    if (selectedDayStart === null) return null;
    return heatmapItems.find((item) => item.day_start_utc === selectedDayStart) ?? null;
  }, [heatmapItems, selectedDayStart]);
  const visibleBucketSessions = useMemo(
    () => selectedBucket?.session_refs.slice(0, dayVisibleCount) ?? [],
    [dayVisibleCount, selectedBucket]
  );
  const heatmapTitle = statsGranularity === "hour" ? t("stats.heatmap.hourTitle") : t("stats.heatmap.dayTitle");
  const selectedBucketTitle = selectedBucket
    ? t("stats.bucket.sessionTitle", { bucket: formatBucketLabel(selectedBucket.day_start_utc, statsGranularity, language) })
    : statsGranularity === "hour"
      ? t("stats.bucket.hourSelect")
      : t("stats.bucket.daySelect");
  const emptyBucketText = statsGranularity === "hour" ? t("stats.bucket.hourEmpty") : t("stats.bucket.dayEmpty");
  const selectHintText =
    statsGranularity === "hour"
      ? t("stats.bucket.hourHint")
      : t("stats.bucket.dayHint");

  useEffect(() => {
    if (selectedDayStart === null) return;
    if (!heatmapItems.some((item) => item.day_start_utc === selectedDayStart)) {
      setSelectedDayStart(null);
      setDayVisibleCount(DAY_SESSION_PAGE_SIZE);
    }
  }, [heatmapItems, selectedDayStart]);

  const refreshStats = () => {
    if (dateBounds.error || dateBounds.startAt === null || dateBounds.endAt === null) return;
    setLocalStatsSyncError(null);
    if (selectedProject?.environment_type === "ssh") {
      setManualRefresh({ key: statsBaseQueryKey, nonce: Date.now() });
      return;
    }
    if (syncingLocalStats) return;
    setSyncingLocalStats(true);
    void (async () => {
      try {
        await syncHistoryRequestLogs(true);
        await Promise.allSettled([
          statsQuery.refetch(),
          requestStatsSupported ? requestStatsQuery.refetch() : Promise.resolve(),
        ]);
      } catch (error) {
        logWarn("history.stats.manualSyncFailed", { error: String(error) });
        setLocalStatsSyncError(String(error));
      } finally {
        setSyncingLocalStats(false);
      }
    })();
  };
  const timeInputClass = "ui-stats-control ui-focus-ring min-w-[128px]";

  const tabOptions = [
    { value: "overview" as const, label: t("stats.tab.overview"), icon: BarChart3 },
    { value: "requests" as const, label: t("stats.tab.requestLogs"), icon: ScrollText },
  ];
  const timeWindowOptions = STATS_TIME_WINDOW_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }));

  if (!open) return null;

  return (
    <Portal>
      <div
        className="ui-stats-panel fixed inset-0 flex flex-col overflow-hidden"
        data-workspace-background={workspaceBackgroundActive ? "true" : undefined}
        style={{ zIndex: 57 }}
      >
        <div className="ui-stats-chrome shrink-0 px-6 pb-3 pt-5">
          <div className="flex items-start gap-4">
            <div className="min-w-0">
              <h2 className="ui-stats-title truncate">{t("stats.title")}</h2>
              <div className="ui-dev-label mt-1 truncate text-[12px] text-text-muted">{t("stats.subtitle")}</div>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-3">
              <StatsSegmented value={activeTab} options={tabOptions} onChange={setActiveTab} ariaLabel={t("stats.title")} role="tablist" />
              <Button onClick={onClose} aria-label={t("stats.closeDashboard")} size="icon" variant="ghost" title={t("common.close")} className="rounded-full">
                <X size={16} />
              </Button>
            </div>
          </div>

          {activeTab === "overview" && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <StatsSourceFilterDropdown value={sourceFilter} onChange={setSourceFilter} />
              <StatsProjectFilterDropdown
                projects={statisticsProjects}
                groups={groups}
                selectedProjectId={projectId}
                rawProjectKey={projectKey}
                onSelectProjectId={(id) => { setProjectId(id); setProjectKey(""); }}
                onClear={() => { setProjectId(""); setProjectKey(""); }}
              />
              <label className="ui-stats-control min-w-[160px] max-w-[240px] text-text-secondary">
                <Search size={13} className="shrink-0" />
                <input
                  value={modelFilter}
                  onChange={(event) => setModelFilter(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-text-primary outline-none placeholder:text-text-muted"
                  placeholder={t("stats.requestUsage.modelFilter")}
                  aria-label={t("stats.requestUsage.modelFilter")}
                />
                {modelFilter && (
                  <button type="button" onClick={() => setModelFilter("")} className="inline-flex shrink-0 text-text-muted hover:text-text-primary" aria-label={t("history.projectFilter.clearSearch")}>
                    <X size={12} />
                  </button>
                )}
              </label>

              <div className="ml-auto flex flex-wrap items-center gap-2">
                <StatsSegmented
                  value={timeWindow.mode}
                  options={timeWindowOptions}
                  onChange={(mode) => setTimeWindow((prev) => nextStatsTimeWindowForMode(mode, prev))}
                  ariaLabel={t("stats.timeWindow")}
                />
                {timeWindow.mode === "day" && <StatsDatePicker mode="date" value={resolvedTimeWindow.day} onChange={(value) => setTimeWindow((prev) => ({ ...prev, day: value }))} className={timeInputClass} ariaLabel={t("stats.date")} />}
                {timeWindow.mode === "month" && <StatsDatePicker mode="month" value={resolvedTimeWindow.month} onChange={(value) => setTimeWindow((prev) => ({ ...prev, month: value }))} className={timeInputClass} ariaLabel={t("stats.month")} />}
                {timeWindow.mode === "year" && <input type="number" min="2000" max="9999" value={resolvedTimeWindow.year} onChange={(e) => setTimeWindow((prev) => ({ ...prev, year: e.target.value }))} className="ui-stats-control w-[88px] tabular-nums outline-none" aria-label={t("stats.year")} />}
                {timeWindow.mode === "custom" && (
                  <>
                    <StatsDatePicker mode="date" value={resolvedTimeWindow.customStart} onChange={(value) => setTimeWindow((prev) => ({ ...prev, customStart: value }))} className={timeInputClass} ariaLabel={t("stats.customStart")} />
                    <span className="text-[12px] text-text-muted">{t("common.to")}</span>
                    <StatsDatePicker mode="date" value={resolvedTimeWindow.customEnd} onChange={(value) => setTimeWindow((prev) => ({ ...prev, customEnd: value }))} className={timeInputClass} ariaLabel={t("stats.customEnd")} />
                  </>
                )}
                <button
                  type="button"
                  onClick={refreshStats}
                  disabled={dateBounds.error !== null || waitingForStatsQuery || syncingLocalStats}
                  className="ui-stats-control is-icon ui-focus-ring text-text-secondary disabled:cursor-not-allowed disabled:opacity-45"
                  aria-label={t("common.refresh")}
                  title={t("common.refresh")}
                >
                  <RefreshCw size={13} className={loadingStats ? "animate-spin" : ""} />
                </button>
              </div>
            </div>
          )}

          {activeTab === "overview" && (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
              <span>{t("stats.currentRange", { value: dateRangeLabel })}</span>
              <span className="ml-auto">{t("stats.lastRefresh", { value: waitingForStatsQuery ? "-" : formatDateTime(statsUpdatedAt, language) })}</span>
              {dateBounds.error && <div className="w-full font-medium text-danger">{dateBounds.error}</div>}
              {localStatsSyncError && (
                <div className="w-full font-medium text-danger">{t("stats.refreshSyncFailed", { error: localStatsSyncError })}</div>
              )}
            </div>
          )}
        </div>

        <div className="ui-stats-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 py-5">
          {activeTab === "requests" ? (
            <RequestLogsView
              globalFilters={selectedProject?.environment_type === "ssh" ? undefined : {
                source: requestLogSourceFilter,
                project_key: projectPath ? null : projectKey || null,
                project_path: projectPath || null,
                model: modelFilter.trim() || null,
                start_at: dateBounds.startAt,
                end_at: dateBounds.endAt,
              }}
              onOpenSession={async (key) => { await onOpenSession(key); onClose(); }}
            />
          ) : (
            <div className="w-full space-y-4">
              {(waitingForStatsQuery || (loadingStats && !stats)) && <StatsSkeleton />}
              {!waitingForStatsQuery && !loadingStats && statsError && (
                <section className="ui-stats-card flex flex-wrap items-center gap-3 p-5 text-[12px] text-danger">
                  <div className="min-w-0 flex-1">{t("stats.loadFailed", { error: statsError })}</div>
                  <Button onClick={refreshStats} disabled={dateBounds.error !== null} size="sm"><RefreshCw size={12} />{t("common.retry")}</Button>
                </section>
              )}
              {!waitingForStatsQuery && stats && (
                <>
                  {loadingStats && (
                    <div className="inline-flex items-center gap-1.5 px-1 text-[12px] text-text-muted">
                      <RefreshCw size={11} className="animate-spin" />
                      {t("stats.updating")}
                    </div>
                  )}
                  <KpiStrip stats={stats} trend={trendItems} />
                  <ContextNote sourceLabel={sourceLabel} projectLabel={projectLabel} dateRangeLabel={dateRangeLabel} stats={stats} />
                  <DailyUsageTrendChart items={trendItems} granularity={statsGranularity} />

                  {requestStatsQuery.isFetching && !requestStats && requestStatsSupported && <div className="px-1 text-[12px] text-text-muted">{t("stats.requestUsage.loading")}</div>}
                  {requestStatsQuery.error && requestStatsSupported && (
                    <section className="ui-stats-card p-4 text-[12px]" style={{ color: "var(--stats-orange)" }}>
                      {t("stats.requestUsage.loadFailed", { error: String(requestStatsQuery.error) })}
                    </section>
                  )}
                  {requestStats && <RequestUsageOverview stats={requestStats} />}

                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(260px,0.8fr)]">
                    <ProjectRankingCard
                      items={stats.project_ranking}
                      selectedProjectKey={projectKey}
                      onSelectProject={(nextProjectKey) => { setProjectId(""); setProjectKey((prev) => (prev === nextProjectKey ? "" : nextProjectKey)); }}
                      onClearProject={() => { setProjectId(""); setProjectKey(""); }}
                    />
                    <ModelRankingCard items={stats.model_distribution} />
                    <div className="lg:col-span-2 2xl:col-span-1"><TokenCompositionCard stats={stats} /></div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    <StatsHourlyActivityChart items={stats.hourly_activity} />
                    <StatsCard title={heatmapTitle} className="h-full">
                      <TimelineHeatmap days={heatmapItems} selectedDayStart={selectedDayStart} onSelectDay={(day) => setSelectedDayStart(day.day_start_utc)} granularity={statsGranularity} />
                    </StatsCard>
                  </div>

                  <SourceBreakdown items={stats.source_distribution} />

                  <StatsCard
                    title={selectedBucketTitle}
                    right={selectedBucket ? <StatsPill>{t("stats.unit.sessions", { count: formatCount(selectedBucket.session_refs.length, language) })}</StatsPill> : undefined}
                  >
                    {!selectedBucket && <div className="ui-stats-inset px-4 py-6 text-center text-[12px] text-text-muted">{selectHintText}</div>}
                    {selectedBucket && selectedBucket.session_refs.length === 0 && <div className="ui-stats-inset px-4 py-6 text-center text-[12px] text-text-muted">{emptyBucketText}</div>}
                    {visibleBucketSessions.length > 0 && (
                      <div className="-mx-2">
                        {visibleBucketSessions.map((session) => {
                          const icon = resolveHistorySourceIconKey(session.source);
                          return (
                            <button
                              key={makeSessionKey(session)}
                              type="button"
                              onClick={() => { void onOpenSession(makeSessionKey(session)).then(() => onClose()); }}
                              className="ui-stats-row ui-focus-ring flex w-full items-center gap-3 px-2 py-2 text-left"
                            >
                              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--stats-fill-strong)]" aria-hidden="true">
                                {icon ? <CliToolIcon icon={icon} size={16} /> : <Database size={15} className="text-text-muted" />}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-medium text-text-primary">{session.title}</span>
                                <span className="ui-dev-label mt-0.5 block truncate text-[11px] text-text-muted">{session.project_key} · {t("stats.session.messageCount", { count: session.message_count })}</span>
                              </span>
                              <ChevronRight size={14} className="shrink-0 text-text-muted" />
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {selectedBucket && dayVisibleCount < selectedBucket.session_refs.length && (
                      <Button onClick={() => setDayVisibleCount((prev) => prev + DAY_SESSION_PAGE_SIZE)} className="mt-3 w-full" size="sm" variant="ghost">{t("stats.session.loadMore", { shown: dayVisibleCount, total: selectedBucket.session_refs.length })}</Button>
                    )}
                  </StatsCard>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}
