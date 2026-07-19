import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, BarChart3, ChevronDown, ChevronRight, Coins, Database, Folder, Layers, LineChart, RefreshCw, ScrollText, Search, Terminal, X } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
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
} from "../../lib/types";
import { fetchHistoryStatsPayload } from "../../stores/historyStore";
import { useProjectStore } from "../../stores/projectStore";
import { HISTORY_SOURCE_DESCRIPTORS, HISTORY_SOURCE_DESCRIPTOR_BY_ID } from "../../lib/historySources";
import { TimelineHeatmap } from "./TimelineHeatmap";
import { StatsHourlyActivityChart } from "./StatsHourlyActivityChart";
import { StatsDatePicker } from "./StatsDatePicker";
import { Skeleton } from "../ui/Skeleton";
import { Portal } from "../ui/Portal";
import {
  ACCENT,
  COST_COLOR,
  HISTORY_SERIES_COLORS,
  HISTORY_TREND_COLORS,
  PEAK,
  RECHARTS_AXIS_CURSOR,
  RECHARTS_BAR_CURSOR,
  RECHARTS_TOOLTIP_ITEM_STYLE,
  RECHARTS_TOOLTIP_LABEL_STYLE,
  RECHARTS_TOOLTIP_WRAPPER_STYLE,
} from "./statsPalette";
import { useI18n, type AppLanguage, type TranslationKey } from "../../lib/i18n";
import { VendorIcon, inferVendor } from "../VendorIcon";
import { CliToolIcon } from "../CliToolIcon";
import { resolveHistorySourceIconKey } from "../../lib/cliTools";
import { RequestLogsView } from "./RequestLogsView";
import { projectSupportsCapability } from "../../lib/projectCapabilities";

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
    project.path.toLowerCase().includes(query) ||
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
  const vendor = project.cli_tool ? inferVendor(project.cli_tool) : null;
  return vendor ? <VendorIcon vendor={vendor} size={size} /> : <Terminal size={size} strokeWidth={1.5} />;
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

const RECHARTS_TOOLTIP_STYLE = {
  backgroundColor: "var(--bg-secondary)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  boxShadow: "0 8px 28px rgba(0,0,0,0.18)",
  color: "var(--text-primary)",
  fontSize: 12,
} as const;

const RECHARTS_AXIS_STYLE = {
  fill: "var(--text-muted)",
  fontSize: 11,
} as const;

type RechartsTooltipName = string | number;
type TrendTooltipEntry = TooltipPayloadEntry<TooltipValueType, RechartsTooltipName>;

function tooltipNumberValue(value: TooltipValueType | undefined): number {
  if (Array.isArray(value)) return Number(value[0] ?? 0);
  return Number(value ?? 0);
}

function tooltipEntryColor(entry: TrendTooltipEntry): string {
  return entry.color ?? entry.stroke ?? entry.fill ?? "var(--text-muted)";
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
  const rows = payload as readonly TrendTooltipEntry[];
  const bucketTitle = String(rows[0]?.payload?.bucketTitle ?? label ?? "");

  return (
    <div style={{ ...RECHARTS_TOOLTIP_STYLE, minWidth: 278, padding: "10px 12px" }}>
      <div style={RECHARTS_TOOLTIP_LABEL_STYLE}>{bucketTitle}</div>
      <div className="mt-2 space-y-2">
        {rows.map((entry) => {
          const name = String(entry.name ?? "");
          const color = tooltipEntryColor(entry);
          const value = tooltipNumberValue(entry.value);
          const display = name === costLabel ? formatCost(value) : `${formatCount(value, language)} Token`;
          return (
            <div key={`${String(entry.dataKey ?? name)}-${name}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-6">
              <span className="inline-flex min-w-0 items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                <span className="truncate font-medium" style={{ color }}>
                  {name}
                </span>
              </span>
              <span className="shrink-0 text-right font-semibold" style={{ color }}>{display}</span>
            </div>
          );
        })}
      </div>
    </div>
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
    <div className="space-y-3 animate-fade-in">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i} className="rounded-xl bg-bg-secondary p-3 space-y-2">
            <Skeleton className="h-2.5 w-1/2" />
            <Skeleton className="h-5 w-2/3" />
          </Card>
        ))}
      </div>
      <Card className="rounded-2xl bg-bg-secondary p-4 space-y-2">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-[260px] w-full" />
      </Card>
    </div>
  );
}

function SectionHeading({
  icon: Icon,
  title,
  hint,
  right,
}: {
  icon: typeof BarChart3;
  title: string;
  hint?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-bg-tertiary text-accent">
        <Icon size={14} />
      </span>
      <div className="text-[13px] font-semibold tracking-tight text-text-primary">{title}</div>
      {hint && <div className="ml-auto text-[11px] text-text-muted">{hint}</div>}
      {right}
    </div>
  );
}

function KpiStrip({ stats }: { stats: HistoryStatsPayload }) {
  const { language, t } = useI18n();
  const totalTokens = totalTokensOf({
    input_tokens: stats.total_input_tokens,
    output_tokens: stats.total_output_tokens,
    cache_read_tokens: stats.total_cache_read_tokens,
    cache_creation_tokens: stats.total_cache_creation_tokens,
  });
  const peak = stats.daily_series.reduce<HistoryStatsDailySeriesItem | null>((current, item) => {
    if (!current) return item;
    return totalTokensOf(item) > totalTokensOf(current) ? item : current;
  }, null);
  const peakTokens = peak ? totalTokensOf(peak) : 0;
  const pricedTokens = Math.max(0, totalTokens - stats.total_unpriced_tokens);
  const coverage = totalTokens > 0 ? (pricedTokens / totalTokens) * 100 : 0;

  const items = [
    {
      label: t("stats.kpi.totalToken"),
      value: formatCompactCount(totalTokens, language),
      hint: t("stats.kpi.fullValue", { value: formatCount(totalTokens, language) }),
      icon: Layers,
      accent: "var(--accent)",
    },
    {
      label: t("stats.kpi.estimatedCost"),
      value: formatCost(stats.total_cost_usd),
      hint: stats.total_unpriced_tokens > 0
        ? t("stats.kpi.unpriced", { value: formatCompactCount(stats.total_unpriced_tokens, language) })
        : t("stats.kpi.localEstimate"),
      icon: Coins,
      accent: "var(--warning)",
    },
    {
      label: t("stats.kpi.peakDay"),
      value: peak && peakTokens > 0 ? formatDay(peak.day_start_utc, language) : "-",
      hint: peak && peakTokens > 0 ? `${formatCompactCount(peakTokens, language)} Token` : t("stats.kpi.noDailyToken"),
      icon: LineChart,
      accent: "var(--accent)",
    },
    {
      label: t("stats.kpi.pricingCoverage"),
      value: totalTokens > 0 ? formatPercent(coverage) : "0%",
      hint: t("stats.kpi.coverageHint"),
      icon: Activity,
      accent: coverage >= 60 ? "var(--success)" : "var(--warning)",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div
            key={item.label}
            className="relative min-w-0 overflow-hidden rounded-2xl border border-border/60 bg-bg-secondary px-4 py-3.5"
          >
            <div className="flex items-center gap-2">
              <span
                className="inline-flex h-6 w-6 items-center justify-center rounded-lg"
                style={{ backgroundColor: `color-mix(in srgb, ${item.accent} 16%, transparent)`, color: item.accent }}
              >
                <Icon size={13} />
              </span>
              <div className="text-[11px] font-medium text-text-muted">{item.label}</div>
            </div>
            <div className="mt-2 truncate text-[24px] font-semibold leading-none tracking-tight text-text-primary">
              {item.value}
            </div>
            <div className="mt-1.5 truncate text-[11px] text-text-secondary" title={item.hint}>
              {item.hint}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TokenCompositionStrip({ stats }: { stats: HistoryStatsPayload }) {
  const { language, t } = useI18n();
  const parts = useMemo(() => [
    { key: "input", label: t("termStats.input"), value: stats.total_input_tokens, color: HISTORY_SERIES_COLORS.input },
    { key: "output", label: t("termStats.output"), value: stats.total_output_tokens, color: HISTORY_SERIES_COLORS.output },
    { key: "cacheCreation", label: t("termStats.cacheWrite"), value: stats.total_cache_creation_tokens, color: HISTORY_SERIES_COLORS.cacheCreation },
    { key: "cacheRead", label: t("termStats.cacheHit"), value: stats.total_cache_read_tokens, color: HISTORY_SERIES_COLORS.cacheRead },
  ], [stats.total_cache_creation_tokens, stats.total_cache_read_tokens, stats.total_input_tokens, stats.total_output_tokens, t]);
  const total = parts.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  const chartData = parts.filter((item) => item.value > 0);

  return (
    <section className="rounded-2xl border border-border/60 bg-bg-secondary px-4 py-3">
      <div className="flex flex-col gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-text-primary">
            <Layers size={13} className="text-accent" />
            {t("stats.tokenComposition")}
          </div>
          <div className="mt-0.5 text-[11px] text-text-muted">{t("stats.tokenCompositionHint")}</div>
        </div>
        <div className="h-[150px] w-full">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={chartData} dataKey="value" nameKey="label" innerRadius={38} outerRadius={58} paddingAngle={2}>
                  {chartData.map((item) => (
                    <Cell key={item.key} fill={item.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={RECHARTS_TOOLTIP_STYLE}
                  itemStyle={RECHARTS_TOOLTIP_ITEM_STYLE}
                  labelStyle={RECHARTS_TOOLTIP_LABEL_STYLE}
                  wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                  formatter={(value, name) => [`${formatCount(Number(value), language)} Token`, String(name)]}
                />
                <Legend iconType="circle" wrapperStyle={{ color: "var(--text-secondary)", fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <EmptyBlock text={t("stats.trend.empty")} />
          )}
        </div>
        <div className="grid w-full grid-cols-1 gap-1.5 text-[11px] text-text-secondary">
          {parts.map((item) => (
            <div key={item.key} className="flex items-center justify-between gap-3 rounded-lg bg-bg-primary px-2 py-1.5">
              <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
              <span>{item.label}</span>
              </span>
              <span className="font-semibold text-text-primary">{formatCompactCount(item.value, language)}</span>
              <span className="text-text-muted">{formatPercent(total > 0 ? (item.value / total) * 100 : 0)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
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
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-bg-secondary px-3 py-2 text-[11px] text-text-secondary">
      <span className="inline-flex items-center gap-1 font-semibold text-text-primary">
        <Database size={13} />
        {t("stats.context.localEstimate")}
      </span>
      <span>{t("stats.context.source", { value: sourceLabel })}</span>
      <span>{t("stats.context.project", { value: projectLabel })}</span>
      <span>{t("stats.context.range", { value: dateRangeLabel })}</span>
      <span>{t("stats.context.unpriced", { value: formatCompactCount(stats.total_unpriced_tokens, language) })}</span>
      <span className="text-text-muted">{t("stats.context.billingNote")}</span>
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

  return (
    <section className="rounded-2xl border border-border/60 bg-bg-secondary p-4 lg:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-bg-tertiary text-accent">
          <LineChart size={14} />
        </span>
        <div>
          <div className="text-[14px] font-semibold tracking-tight text-text-primary">{t("stats.trend.title")}</div>
          <div className="mt-0.5 text-[11px] text-text-muted">
            {granularity === "hour" ? t("stats.trend.hourHint") : t("stats.trend.dayHint")}
          </div>
        </div>
        <div className="ml-auto rounded-full border border-border/60 bg-bg-primary px-3 py-1 text-[11px] font-medium text-text-secondary">
          {peak
            ? t("stats.trend.peak", {
                bucket: formatBucketLabel(peak.day_start_utc, granularity, language),
                tokens: formatCount(totalTokensOf(peak), language),
              })
            : t("stats.trend.noPeak")}
        </div>
      </div>
      {hasData ? (
        <div className="h-[380px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 12, right: 10, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeOpacity={0.42} vertical={false} />
              <XAxis dataKey="bucketLabel" tick={RECHARTS_AXIS_STYLE} tickLine={false} axisLine={{ stroke: "var(--border)" }} minTickGap={18} />
              <YAxis yAxisId="tokens" tick={RECHARTS_AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={(value) => formatCompactCount(Number(value), language)} allowDecimals={false} />
              <YAxis yAxisId="cost" orientation="right" tick={RECHARTS_AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={(value) => formatCost(Number(value))} />
              <Tooltip
                cursor={RECHARTS_AXIS_CURSOR}
                wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                content={(props) => <DailyUsageTrendTooltip {...props} language={language} costLabel={costLabel} />}
              />
              <Legend wrapperStyle={{ color: "var(--text-secondary)", fontSize: 11 }} />
              <Line yAxisId="tokens" type="monotone" dataKey="totalTokens" name={t("stats.trend.totalToken")} stroke={HISTORY_TREND_COLORS.total} strokeWidth={3} dot={{ r: 2.5 }} activeDot={{ r: 5, fill: PEAK }} />
              <Line yAxisId="tokens" type="monotone" dataKey="input_tokens" name={t("termStats.input")} stroke={HISTORY_TREND_COLORS.input} strokeWidth={1.8} dot={false} />
              <Line yAxisId="tokens" type="monotone" dataKey="output_tokens" name={t("termStats.output")} stroke={HISTORY_TREND_COLORS.output} strokeWidth={1.8} strokeDasharray="6 4" dot={false} />
              <Line yAxisId="tokens" type="monotone" dataKey="cache_creation_tokens" name={t("termStats.cacheWrite")} stroke={HISTORY_TREND_COLORS.cacheCreation} strokeWidth={1.8} strokeDasharray="3 3" dot={false} />
              <Line yAxisId="tokens" type="monotone" dataKey="cache_read_tokens" name={t("termStats.cacheHit")} stroke={HISTORY_TREND_COLORS.cacheRead} strokeWidth={1.8} strokeDasharray="8 3 2 3" dot={false} />
              <Line yAxisId="cost" type="monotone" dataKey="costValue" name={costLabel} stroke={COST_COLOR} strokeWidth={2.2} dot={false} activeDot={{ r: 4, fill: COST_COLOR }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <EmptyBlock text={t("stats.trend.empty")} />
      )}
    </section>
  );
}

function EmptyBlock({ text }: { text: string }) {
  return <div className="rounded-lg bg-bg-primary py-8 text-center text-[12px] text-text-muted">{text}</div>;
}

function ModelRankingChart({ items }: { items: HistoryStatsModelItem[] }) {
  const { language, t } = useI18n();
  const models = useMemo(
    () =>
      items
        .filter((item) => totalTokensOf(item) > 0)
        .slice(0, 8),
    [items]
  );
  const data = useMemo(
    () =>
      models.map((model, index) => ({
        ...model,
        shortName: model.model.replace(/^claude-/, ""),
        tokens: totalTokensOf(model),
        fill: index === 0 ? PEAK : ACCENT,
      })),
    [models]
  );

  return (
    <section className="flex h-[320px] flex-col rounded-2xl border border-border/60 bg-bg-secondary p-4">
      <SectionHeading icon={BarChart3} title={t("stats.modelRanking")} hint="Top models by Token" />
      <div className="min-h-0 flex-1">
        {models.length === 0 ? (
          <EmptyBlock text={t("stats.modelRanking.empty")} />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 36, bottom: 8, left: 8 }}>
              <CartesianGrid stroke="var(--border)" strokeOpacity={0.42} horizontal={false} />
              <XAxis type="number" tick={RECHARTS_AXIS_STYLE} tickFormatter={(value) => formatCompactCount(Number(value), language)} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="shortName" width={112} tick={RECHARTS_AXIS_STYLE} axisLine={false} tickLine={false} />
              <Tooltip
                cursor={RECHARTS_BAR_CURSOR}
                contentStyle={RECHARTS_TOOLTIP_STYLE}
                itemStyle={RECHARTS_TOOLTIP_ITEM_STYLE}
                labelStyle={RECHARTS_TOOLTIP_LABEL_STYLE}
                wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                formatter={(value, _, payload) => {
                  const model = payload?.payload as HistoryStatsModelItem | undefined;
                  return [
                    model
                      ? `${formatCount(totalTokensOf(model), language)} Token · ${formatCost(model.total_cost_usd)} · ${t("termStats.cacheHit")}/${t("termStats.cacheWrite")} ${formatCount(model.cache_creation_tokens + model.cache_read_tokens, language)}`
                      : `${formatCount(Number(value), language)} Token`,
                    "Token",
                  ];
                }}
                labelFormatter={(_, payload) => payload?.[0]?.payload?.model ?? ""}
              />
              <Bar dataKey="tokens" name="Token" radius={[0, 7, 7, 0]}>
                {data.map((item) => (
                  <Cell key={item.model} fill={item.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}

function ProjectRanking({ items, selectedProjectKey, onSelectProject, onClearProject }: {
  items: HistoryStatsProjectItem[];
  selectedProjectKey: string;
  onSelectProject: (projectKey: string) => void;
  onClearProject: () => void;
}) {
  const { language, t } = useI18n();
  const topItems = useMemo(
    () =>
      items.slice(0, 8).map((item) => ({
        ...item,
        tokens: totalTokensOf(item),
        selected: item.project_key === selectedProjectKey,
      })),
    [items, selectedProjectKey]
  );
  return (
    <section className="flex h-[320px] flex-col rounded-2xl border border-border/60 bg-bg-secondary p-4">
      <SectionHeading
        icon={Folder}
        title={t("stats.projectRanking")}
        right={
          selectedProjectKey ? (
            <Button className="ml-auto" onClick={onClearProject} size="sm" variant="ghost">
              {t("stats.projectRanking.clear")}
            </Button>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1">
        {topItems.length === 0 ? (
          <EmptyBlock text={t("stats.projectRanking.empty")} />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topItems} layout="vertical" margin={{ top: 4, right: 36, bottom: 8, left: 8 }}>
              <CartesianGrid stroke="var(--border)" strokeOpacity={0.42} horizontal={false} />
              <XAxis type="number" tick={RECHARTS_AXIS_STYLE} tickFormatter={(value) => formatCompactCount(Number(value), language)} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="project_key" width={112} tick={RECHARTS_AXIS_STYLE} axisLine={false} tickLine={false} />
              <Tooltip
                cursor={RECHARTS_BAR_CURSOR}
                contentStyle={RECHARTS_TOOLTIP_STYLE}
                itemStyle={RECHARTS_TOOLTIP_ITEM_STYLE}
                labelStyle={RECHARTS_TOOLTIP_LABEL_STYLE}
                wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                formatter={(value) => [`${formatCount(Number(value), language)} Token`, "Token"]}
                labelFormatter={(label) => String(label)}
              />
              <Bar
                dataKey="tokens"
                name="Token"
                radius={[0, 7, 7, 0]}
                cursor="pointer"
                onClick={(entry) => {
                  const payload = (entry as { payload?: HistoryStatsProjectItem }).payload;
                  if (payload?.project_key) onSelectProject(payload.project_key);
                }}
              >
                {topItems.map((item) => (
                  <Cell key={item.project_key} fill={item.selected ? PEAK : ACCENT} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}

function SourceBreakdown({ items }: { items: HistoryStatsSourceItem[] }) {
  const { language, t } = useI18n();
  const tokenParts = useMemo(() => [
    { key: "input", label: t("termStats.input"), color: HISTORY_SERIES_COLORS.input },
    { key: "output", label: t("termStats.output"), color: HISTORY_SERIES_COLORS.output },
    { key: "cacheCreation", label: t("termStats.cacheWrite"), color: HISTORY_SERIES_COLORS.cacheCreation },
    { key: "cacheRead", label: t("termStats.cacheHit"), color: HISTORY_SERIES_COLORS.cacheRead },
  ], [t]);
  const sourcePies = useMemo(() => {
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
        chartParts: parts.filter((part) => part.value > 0),
        parts,
      };
    }).filter((item) => item.total > 0);
  }, [items, tokenParts]);

  return (
    <section className="flex h-[420px] flex-col rounded-2xl border border-border/60 bg-bg-secondary p-4">
      <SectionHeading icon={Database} title={t("stats.sourceBreakdown")} />
      <div className="min-h-0 flex-1">
        {sourcePies.length === 0 ? (
          <EmptyBlock text={t("stats.sourceBreakdown.empty")} />
        ) : (
          <div className={`ui-thin-scroll grid h-full auto-rows-[320px] gap-3 overflow-y-auto pr-1 ${sourcePies.length === 1 ? "grid-cols-1" : "grid-cols-1 lg:grid-cols-2"}`} role="group" aria-label={t("stats.sourceBreakdown")}>
            {sourcePies.map((source) => (
              <div key={source.source} className={`flex min-w-0 flex-col rounded-xl border border-border/50 bg-bg-tertiary/30 p-3 ${sourcePies.length === 1 ? "mx-auto w-full max-w-md" : ""}`}>
                <div>
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary">
                    <span className="inline-flex shrink-0" aria-hidden="true">
                      {source.icon ? <CliToolIcon icon={source.icon} size={15} /> : <Database size={15} />}
                    </span>
                    <span>{source.descriptor ? t(source.descriptor.labelKey) : source.source}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-text-muted">{formatCompactCount(source.total, language)} Token</div>
                </div>
                <div className="h-[140px] shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={source.chartParts} dataKey="value" nameKey="label" innerRadius={42} outerRadius={64} paddingAngle={1.5}>
                        {source.chartParts.map((part) => <Cell key={part.key} fill={part.color} />)}
                      </Pie>
                      <Tooltip
                        contentStyle={RECHARTS_TOOLTIP_STYLE}
                        itemStyle={RECHARTS_TOOLTIP_ITEM_STYLE}
                        labelStyle={RECHARTS_TOOLTIP_LABEL_STYLE}
                        wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                        formatter={(value, name) => [`${formatCount(Number(value), language)} Token`, String(name)]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex flex-wrap justify-center gap-x-2.5 gap-y-1 text-[10px] text-text-secondary">
                  {source.parts.map((part) => (
                    <span key={part.key} className="inline-flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: part.color }} />
                      {part.label}
                    </span>
                  ))}
                </div>
                <div className="mt-2 min-h-0 space-y-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {source.parts.map((part) => (
                    <div key={part.key} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg bg-bg-primary/60 px-2.5 py-1.5 text-[11px]">
                      <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-text-secondary">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: part.color }} />
                        {part.label}
                      </span>
                      <span className="font-medium tabular-nums text-text-primary">{formatCompactCount(part.value, language)}</span>
                      <span className="w-11 text-right tabular-nums text-text-muted">{formatPercent((part.value / source.total) * 100)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
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
        className={`ui-focus-ring flex h-8 w-full items-center gap-2 rounded-md border border-border bg-bg-secondary px-2 text-left text-xs text-text-primary ${className ?? ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("common.allSources")}
      >
        <span className="shrink-0">{renderIcon(value)}</span>
        <span className="min-w-0 flex-1 truncate font-semibold">{label}</span>
        <ChevronDown size={13} className="shrink-0 text-text-muted transition-transform" style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 max-h-72 w-[min(220px,calc(100vw-32px))] overflow-y-auto rounded-xl border border-border/70 bg-surface-container-lowest p-1 shadow-lg" role="listbox" aria-label={t("common.allSources")}>
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
  selectedProjectPath,
  rawProjectKey,
  onSelectProjectPath,
  onClear,
}: {
  projects: Project[];
  groups: Group[];
  selectedProjectPath: string;
  rawProjectKey: string;
  onSelectProjectPath: (path: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);

  const selectedProject = useMemo(
    () => projects.find((project) => project.path === selectedProjectPath) ?? null,
    [projects, selectedProjectPath]
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
  const title = selectedProject?.path || rawProjectKey || t("common.allProjects");

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
    (path: string) => {
      onSelectProjectPath(path);
      setOpen(false);
    },
    [onSelectProjectPath]
  );

  const renderNode = (node: StatsProjectTreeNode, depth = 0): ReactNode => {
    const paddingLeft = 8 + depth * 14;
    if (node.type === "group") {
      const isOpen = Boolean(normalizedQuery) || !collapsedGroups.has(node.group.id);
      return (
        <div key={`group:${node.group.id}`}>
          <button
            type="button"
            onClick={() => toggleGroup(node.group.id)}
            className="ui-tree-node ui-tree-group ui-focus-ring flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-[11px] font-semibold"
            style={{ paddingLeft }}
            aria-expanded={isOpen}
          >
            <ChevronRight size={12} className="shrink-0 transition-transform" style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }} />
            <Folder size={13} className="shrink-0" />
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

    const selected = selectedProjectPath === node.project.path;
    return (
      <button
        key={`project:${node.project.id}`}
        type="button"
        onClick={() => handleSelectProject(node.project.path)}
        className="ui-tree-node ui-tree-project ui-focus-ring flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-[12px]"
        data-selected={selected ? "true" : "false"}
        style={{ paddingLeft }}
        title={node.project.path}
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
        className="ui-focus-ring flex h-8 w-full items-center gap-2 rounded-md border border-border bg-bg-secondary px-2 text-left text-xs text-text-primary"
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
        <span className="min-w-0 flex-1 truncate font-semibold">{label}</span>
        <ChevronDown size={13} className="shrink-0 text-text-muted transition-transform" style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-[min(320px,calc(100vw-32px))] rounded-xl border border-border/70 bg-surface-container-lowest p-1 shadow-lg">
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
              data-selected={!selectedProjectPath && !rawProjectKey ? "true" : "false"}
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
  const projects = useProjectStore((s) => s.projects);
  const statisticsProjects = useMemo(
    () => projects.filter((project) => projectSupportsCapability(project, "statistics")),
    [projects]
  );
  const groups = useProjectStore((s) => s.groups);
  const projectsLoaded = useProjectStore((s) => s.loaded);
  const fetchProjects = useProjectStore((s) => s.fetchAll);

  const [projectKey, setProjectKey] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [sourceFilter, setSourceFilter] = useState<HistorySourceFilter>("all");
  const [activeTab, setActiveTab] = useState<StatsPanelTab>("overview");
  const [timeWindow, setTimeWindow] = useState<StatsTimeWindowState>(() => getDefaultStatsTimeWindow());
  const [manualRefresh, setManualRefresh] = useState<{ key: string; nonce: number } | null>(null);
  const [selectedDayStart, setSelectedDayStart] = useState<number | null>(null);
  const [dayVisibleCount, setDayVisibleCount] = useState(DAY_SESSION_PAGE_SIZE);
  const resolvedTimeWindow = useMemo(() => resolveStatsTimeWindow(timeWindow), [timeWindow]);
  const dateRange = useMemo(() => dateRangeFromStatsTimeWindow(resolvedTimeWindow), [resolvedTimeWindow]);

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
    () => `${sourceFilter}|path=${projectPath || ALL_PROJECTS_VALUE}|key=${projectKey || ALL_PROJECTS_VALUE}|${dateBounds.startAt ?? "invalid"}|${dateBounds.endAt ?? "invalid"}`,
    [dateBounds.endAt, dateBounds.startAt, projectKey, projectPath, sourceFilter]
  );
  const effectiveRefreshNonce = manualRefresh?.key === statsBaseQueryKey ? manualRefresh.nonce : 0;
  const statsQuery = useQuery({
    queryKey: ["historyStats", sourceFilter, projectPath || null, projectKey || null, dateBounds.startAt, dateBounds.endAt, effectiveRefreshNonce],
    queryFn: () => {
      if (dateBounds.startAt === null || dateBounds.endAt === null) {
        throw new Error(dateBounds.error ?? "Invalid stats range");
      }
      return fetchHistoryStatsPayload({
        sourceFilter,
        projectKey: projectPath ? null : projectKey || null,
        projectPath: projectPath || null,
        rangeDays: null,
        startAt: dateBounds.startAt,
        endAt: dateBounds.endAt,
        force: effectiveRefreshNonce > 0,
      });
    },
    enabled: open && activeTab === "overview" && dateBounds.error === null && dateBounds.startAt !== null && dateBounds.endAt !== null,
  });
  const stats = statsQuery.data ?? null;
  const loadingStats = statsQuery.isFetching;
  const statsError = statsQuery.error ? String(statsQuery.error) : null;
  const statsUpdatedAt = statsQuery.dataUpdatedAt || null;
  const selectedProject = useMemo(
    () => projects.find((project) => project.path === projectPath) ?? null,
    [projectPath, projects]
  );

  useEffect(() => {
    if (!open) return;
    setProjectKey("");
    setProjectPath("");
    setSourceFilter("all");
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
    if (!projectPath || projects.length === 0) return;
    if (!projects.some((project) => project.path === projectPath)) setProjectPath("");
  }, [projectPath, projects]);

  useEffect(() => {
    if (!open) return;
    setSelectedDayStart(null);
    setDayVisibleCount(DAY_SESSION_PAGE_SIZE);
  }, [open, sourceFilter, projectKey, projectPath, dateRange.startDate, dateRange.endDate]);

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
    setManualRefresh({ key: statsBaseQueryKey, nonce: Date.now() });
  };
  const controlClass = "h-8 rounded-md border border-border bg-bg-secondary px-2 text-xs text-text-primary";
  const timeInputClass = `${controlClass} min-w-[132px]`;

  if (!open) return null;

  return (
    <Portal>
      <Card className="ui-stats-panel fixed inset-0 flex flex-col overflow-hidden rounded-none border-0 bg-bg-primary" style={{ zIndex: 57 }}>
        <div className="ui-stats-panel-header flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <div className="inline-flex items-center gap-1.5 text-[16px] font-semibold text-text-primary">
              <span className="ui-stats-panel-badge"><BarChart3 size={15} /></span>
              {t("stats.title")}
            </div>
            <div className="ui-dev-label mt-1 text-[11px] text-text-muted">{t("stats.subtitle")}</div>
          </div>
          <Button onClick={onClose} aria-label={t("stats.closeDashboard")} size="icon" variant="ghost" title={t("common.close")}>
            <X size={15} />
          </Button>
        </div>

        <div className="flex items-center gap-1 border-b border-border px-5 py-2" role="tablist" aria-label={t("stats.title")}>
          {([
            { value: "overview" as const, label: t("stats.tab.overview"), icon: BarChart3 },
            { value: "requests" as const, label: t("stats.tab.requestLogs"), icon: ScrollText },
          ]).map((tab) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActiveTab(tab.value)}
                className="ui-tab-trigger ui-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-colors"
                data-selected={selected ? "true" : "false"}
              >
                <Icon size={13} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {activeTab === "overview" && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2">
            <StatsSourceFilterDropdown
              value={sourceFilter}
              onChange={setSourceFilter}
            />
            <StatsProjectFilterDropdown
              projects={statisticsProjects}
              groups={groups}
              selectedProjectPath={projectPath}
              rawProjectKey={projectKey}
              onSelectProjectPath={(path) => { setProjectPath(path); setProjectKey(""); }}
              onClear={() => { setProjectPath(""); setProjectKey(""); }}
            />
            <Select
              value={timeWindow.mode}
              onChange={(e) => setTimeWindow((prev) => nextStatsTimeWindowForMode(e.target.value as StatsTimeWindowMode, prev))}
              className={`${controlClass} w-auto min-w-[92px] shrink-0`}
              aria-label={t("stats.timeWindow")}
            >
              {STATS_TIME_WINDOW_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
            </Select>
            {timeWindow.mode === "day" && <StatsDatePicker mode="date" value={resolvedTimeWindow.day} onChange={(value) => setTimeWindow((prev) => ({ ...prev, day: value }))} className={timeInputClass} ariaLabel={t("stats.date")} />}
            {timeWindow.mode === "week" && <span className={`${controlClass} inline-flex items-center`}>{t("stats.weekLabel")}</span>}
            {timeWindow.mode === "month" && <StatsDatePicker mode="month" value={resolvedTimeWindow.month} onChange={(value) => setTimeWindow((prev) => ({ ...prev, month: value }))} className={timeInputClass} ariaLabel={t("stats.month")} />}
            {timeWindow.mode === "year" && <input type="number" min="2000" max="9999" value={resolvedTimeWindow.year} onChange={(e) => setTimeWindow((prev) => ({ ...prev, year: e.target.value }))} className={`${controlClass} w-[92px]`} aria-label={t("stats.year")} />}
            {timeWindow.mode === "custom" && (
              <>
                <StatsDatePicker mode="date" value={resolvedTimeWindow.customStart} onChange={(value) => setTimeWindow((prev) => ({ ...prev, customStart: value }))} className={timeInputClass} ariaLabel={t("stats.customStart")} />
                <span className="text-[11px] text-text-muted">{t("common.to")}</span>
                <StatsDatePicker mode="date" value={resolvedTimeWindow.customEnd} onChange={(value) => setTimeWindow((prev) => ({ ...prev, customEnd: value }))} className={timeInputClass} ariaLabel={t("stats.customEnd")} />
              </>
            )}
            <Button onClick={refreshStats} disabled={dateBounds.error !== null || waitingForStatsQuery} aria-label={t("common.refresh")} size="sm">
              <RefreshCw size={12} className={loadingStats ? "animate-spin" : ""} />{t("common.refresh")}
            </Button>
            <div className="ml-auto text-[12px] font-medium text-text-secondary">{t("stats.lastRefresh", { value: waitingForStatsQuery ? "-" : formatDateTime(statsUpdatedAt, language) })}</div>
            <div className="w-full text-[12px] font-medium text-text-secondary">{t("stats.currentRange", { value: dateRangeLabel })}</div>
            {dateBounds.error && <div className="w-full text-[12px] font-medium text-danger">{dateBounds.error}</div>}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden xl:p-5">
          {activeTab === "requests" ? (
            <RequestLogsView onOpenSession={async (key) => { await onOpenSession(key); onClose(); }} />
          ) : (
            <div className="w-full space-y-3">
              {(waitingForStatsQuery || (loadingStats && !stats)) && <StatsSkeleton />}
              {!waitingForStatsQuery && !loadingStats && statsError && (
                <section className="space-y-2 rounded-2xl border border-border/60 bg-bg-secondary p-4 text-[12px] text-danger">
                  <div>{t("stats.loadFailed", { error: statsError })}</div>
                  <Button onClick={refreshStats} disabled={dateBounds.error !== null} size="sm"><RefreshCw size={12} />{t("common.retry")}</Button>
                </section>
              )}
              {!waitingForStatsQuery && stats && (
                <>
                  {loadingStats && <div className="text-[12px] font-medium text-text-muted">{t("stats.updating")}</div>}
                  <KpiStrip stats={stats} />
                  <ContextNote sourceLabel={sourceLabel} projectLabel={projectLabel} dateRangeLabel={dateRangeLabel} stats={stats} />
                  <DailyUsageTrendChart items={trendItems} granularity={statsGranularity} />

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-12 [&>*]:h-full [&>*]:min-w-0 [&>*>*]:h-full">
                    <div className="2xl:col-span-3">
                      <ProjectRanking
                        items={stats.project_ranking}
                        selectedProjectKey={projectKey}
                        onSelectProject={(nextProjectKey) => { setProjectPath(""); setProjectKey((prev) => (prev === nextProjectKey ? "" : nextProjectKey)); }}
                        onClearProject={() => { setProjectPath(""); setProjectKey(""); }}
                      />
                    </div>
                    <div className="2xl:col-span-3"><ModelRankingChart items={stats.model_distribution} /></div>
                    <div className="2xl:col-span-4"><StatsHourlyActivityChart items={stats.hourly_activity} /></div>
                    <div className="2xl:col-span-2"><TokenCompositionStrip stats={stats} /></div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 [&>*]:h-full">
                    <SourceBreakdown items={stats.source_distribution} />
                    <section className="rounded-2xl border border-border/60 bg-bg-secondary p-4">
                      <SectionHeading icon={Activity} title={heatmapTitle} />
                      <TimelineHeatmap days={heatmapItems} selectedDayStart={selectedDayStart} onSelectDay={(day) => setSelectedDayStart(day.day_start_utc)} granularity={statsGranularity} />
                    </section>
                  </div>

                  <section className="rounded-2xl border border-border/60 bg-bg-secondary p-4">
                    <SectionHeading icon={Layers} title={selectedBucketTitle} />
                    {!selectedBucket && <div className="text-[12px] font-medium text-text-muted">{selectHintText}</div>}
                    {selectedBucket && selectedBucket.session_refs.length === 0 && <div className="text-[12px] font-medium text-text-muted">{emptyBucketText}</div>}
                    {visibleBucketSessions.map((session) => (
                      <button key={makeSessionKey(session)} onClick={() => { void onOpenSession(makeSessionKey(session)).then(() => onClose()); }} className="ui-list-row w-full border-b border-border py-2 text-left last:border-b-0">
                        <div className="truncate text-[13px] font-semibold text-text-primary">{session.title}</div>
                        <div className="ui-dev-label mt-0.5 text-[11px] text-text-muted">{session.source} · {session.project_key} · {t("stats.session.messageCount", { count: session.message_count })}</div>
                      </button>
                    ))}
                    {selectedBucket && dayVisibleCount < selectedBucket.session_refs.length && (
                      <Button onClick={() => setDayVisibleCount((prev) => prev + DAY_SESSION_PAGE_SIZE)} className="mt-2 w-full" size="sm">{t("stats.session.loadMore", { shown: dayVisibleCount, total: selectedBucket.session_refs.length })}</Button>
                    )}
                  </section>
                </>
              )}
            </div>
          )}
        </div>
      </Card>
    </Portal>
  );
}
