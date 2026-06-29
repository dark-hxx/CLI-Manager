import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { EChartsOption } from "echarts";
import { BarChart3, CalendarClock, Coins, Database, Flame, Grid3x3, Layers, LineChart, PackageCheck, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "../ConfirmDialog";
import { Portal } from "../ui/Portal";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import type { CcusageSource } from "../../lib/types";
import { resolveCcusageRuntimeScope, resolveCcusageWslTarget, useCcusageStore } from "../../stores/ccusageStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { EChart } from "./EChart";
import { StatsDatePicker } from "./StatsDatePicker";
import {
  CHART_TOOLTIP,
  COST_COLOR,
  ECHARTS_AXIS_LINE,
  ECHARTS_AXIS_SHADOW,
  PEAK,
  USAGE_SERIES_COLORS,
  USAGE_TREND_COLORS,
} from "./statsPalette";

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

interface CcusageStatsPanelProps {
  open: boolean;
  onClose: () => void;
}

interface CcusageModelItem {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
}

interface CcusageDailyItem {
  date: string;
  dayStart: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  models: string[];
  breakdowns: CcusageModelItem[];
}

interface CcusageHourlyItem {
  day: string;
  hour: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  models: string[];
  breakdowns: CcusageModelItem[];
}

interface PayloadFieldSummary {
  key: string;
  description: string;
}

interface CcusageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  modelCount: number;
  daily: CcusageDailyItem[];
  models: CcusageModelItem[];
  modelNames: string[];
  hasDailyData: boolean;
  hasModelBreakdown: boolean;
  schemaLabel: string;
  payloadFields: PayloadFieldSummary[];
}

type CcusageTimeWindowMode = "all" | "year" | "month" | "day" | "custom";

interface CcusageTimeWindowState {
  mode: CcusageTimeWindowMode;
  year: string;
  month: string;
  day: string;
  customStart: string;
  customEnd: string;
}

const DEFAULT_TIME_WINDOW: CcusageTimeWindowState = {
  mode: "all",
  year: "",
  month: "",
  day: "",
  customStart: "",
  customEnd: "",
};

type Translate = ReturnType<typeof useI18n>["t"];

const TIME_WINDOW_OPTIONS: { value: CcusageTimeWindowMode; labelKey: TranslationKey }[] = [
  { value: "all", labelKey: "common.all" },
  { value: "year", labelKey: "stats.window.year" },
  { value: "month", labelKey: "stats.window.month" },
  { value: "day", labelKey: "stats.window.day" },
  { value: "custom", labelKey: "stats.window.custom" },
];

const SOURCE_OPTIONS: { value: CcusageSource; label: string; labelKey?: TranslationKey; descriptionKey: TranslationKey }[] = [
  { value: "all", label: "全部", labelKey: "ccusage.source.all", descriptionKey: "ccusage.source.allDescription" },
  { value: "claude", label: "Claude", descriptionKey: "ccusage.source.claudeDescription" },
  { value: "codex", label: "Codex", descriptionKey: "ccusage.source.codexDescription" },
];

const DATETIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const DAY_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
});
const COUNT_FORMATTER = new Intl.NumberFormat("zh-CN");
const REGISTRY_MIRROR_TEXT = "https://registry.npmmirror.com";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberFieldOrNull(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberField(record: Record<string, unknown> | null, key: string): number {
  return numberFieldOrNull(record, key) ?? 0;
}

function firstNumberField(record: Record<string, unknown> | null, keys: string[]): number | null {
  for (const key of keys) {
    const value = numberFieldOrNull(record, key);
    if (value !== null) return value;
  }
  return null;
}

function stringField(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function stringArrayField(record: Record<string, unknown> | null, keys: string[]): string[] {
  const values = keys.flatMap((key) => asArray(record?.[key]));
  return Array.from(new Set(values.filter((item): item is string => typeof item === "string" && item.length > 0)));
}

function formatCount(value: number): string {
  return COUNT_FORMATTER.format(Math.max(0, Math.round(value)));
}

function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(value)}%`;
}

function formatDateTime(ts: number | null): string {
  if (!ts || !Number.isFinite(ts)) return "-";
  return DATETIME_FORMATTER.format(new Date(ts));
}

function formatDayFromStart(dayStart: number): string {
  if (!Number.isFinite(dayStart) || dayStart <= 0) return "-";
  return DAY_FORMATTER.format(new Date(dayStart));
}

function parseDayStart(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (match) {
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function dateKey(date: string): string {
  return /^(\d{4}-\d{2}-\d{2})/.exec(date)?.[1] ?? "";
}

function monthKey(date: string): string {
  return dateKey(date).slice(0, 7);
}

function ccusageDailyPayload(payload: unknown): unknown {
  return asRecord(payload)?.dailyPayload ?? payload;
}

function ccusageBlocksPayload(payload: unknown): unknown {
  return asRecord(payload)?.blocksPayload ?? null;
}

function niceAxisMax(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const base = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 5, 10]) {
    const candidate = factor * base;
    if (value <= candidate) return candidate;
  }
  return 10 * base;
}

function paddedTrendAxisMax(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const padded = value * 1.3;
  const base = 10 ** Math.floor(Math.log10(padded));
  for (const factor of [1, 1.2, 1.5, 2, 2.5, 5, 10]) {
    const candidate = factor * base;
    if (padded <= candidate) return candidate;
  }
  return 10 * base;
}

function firstDateKey(items: CcusageDailyItem[]): string {
  return items.length > 0 ? dateKey(items[0].date) : "";
}

function latestDateKey(items: CcusageDailyItem[]): string {
  return items.length > 0 ? dateKey(items[items.length - 1].date) : "";
}

function availableYears(items: CcusageDailyItem[]): string[] {
  return Array.from(new Set(items.map((item) => dateKey(item.date).slice(0, 4)).filter(Boolean))).sort((a, b) => b.localeCompare(a));
}

function timeWindowLabel(window: CcusageTimeWindowState, t: Translate): string {
  if (window.mode === "year") return window.year ? t("ccusage.time.year", { year: window.year }) : t("ccusage.time.selectYear");
  if (window.mode === "month") return window.month ? t("ccusage.time.month", { month: window.month }) : t("ccusage.time.selectMonth");
  if (window.mode === "day") return window.day || t("ccusage.time.selectDate");
  if (window.mode === "custom") {
    if (window.customStart && window.customEnd) return t("ccusage.time.range", { start: window.customStart, end: window.customEnd });
    if (window.customStart) return t("ccusage.time.from", { date: window.customStart });
    if (window.customEnd) return t("ccusage.time.until", { date: window.customEnd });
    return t("ccusage.time.customRange");
  }
  return t("ccusage.time.all");
}

function resolveTimeWindow(window: CcusageTimeWindowState, items: CcusageDailyItem[]): CcusageTimeWindowState {
  const latest = latestDateKey(items);
  const first = firstDateKey(items);
  return {
    mode: window.mode,
    year: window.year || latest.slice(0, 4),
    month: window.month || latest.slice(0, 7),
    day: window.day || latest,
    customStart: window.customStart || first,
    customEnd: window.customEnd || latest,
  };
}

function nextTimeWindowForMode(
  mode: CcusageTimeWindowMode,
  current: CcusageTimeWindowState,
  items: CcusageDailyItem[]
): CcusageTimeWindowState {
  return resolveTimeWindow({ ...current, mode }, items);
}

function filterDailyByTimeWindow(items: CcusageDailyItem[], window: CcusageTimeWindowState): CcusageDailyItem[] {
  if (window.mode === "all") return items;
  if (window.mode === "year") return items.filter((item) => dateKey(item.date).startsWith(window.year));
  if (window.mode === "month") return items.filter((item) => dateKey(item.date).startsWith(window.month));
  if (window.mode === "day") return items.filter((item) => dateKey(item.date) === window.day);

  const start = window.customStart <= window.customEnd ? window.customStart : window.customEnd;
  const end = window.customStart <= window.customEnd ? window.customEnd : window.customStart;
  return items.filter((item) => {
    const key = dateKey(item.date);
    if (!key) return false;
    if (start && key < start) return false;
    if (end && key > end) return false;
    return true;
  });
}

function cacheCreationTokenTotal(record: Record<string, unknown> | null): number {
  return firstNumberField(record, ["cacheCreationTokens", "cacheCreationInputTokens"]) ?? 0;
}

function cacheReadTokenTotal(record: Record<string, unknown> | null): number {
  return firstNumberField(record, ["cacheReadTokens", "cacheReadInputTokens"]) ?? 0;
}

function tokenTotal(record: Record<string, unknown> | null): number {
  const total = firstNumberField(record, ["totalTokens"]);
  if (total !== null) return total;
  return (
    numberField(record, "inputTokens") +
    numberField(record, "outputTokens") +
    cacheCreationTokenTotal(record) +
    cacheReadTokenTotal(record)
  );
}

function normalizeModelItem(value: unknown, fallbackModel = "Unknown Model"): CcusageModelItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const model = stringField(record, "model") || stringField(record, "modelName") || fallbackModel;
  const inputTokens = numberField(record, "inputTokens");
  const outputTokens = numberField(record, "outputTokens");
  const cacheCreationTokens = cacheCreationTokenTotal(record);
  const cacheReadTokens = cacheReadTokenTotal(record);
  return {
    model,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: tokenTotal(record),
    totalCost: firstNumberField(record, ["totalCost", "costUSD", "totalCostUSD", "cost"]) ?? 0,
  };
}

function normalizeModelBreakdowns(value: unknown): CcusageModelItem[] {
  const arrayValue = asArray(value);
  if (arrayValue.length > 0) {
    return arrayValue
      .map((item) => normalizeModelItem(item))
      .filter((item): item is CcusageModelItem => item !== null);
  }

  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([model, item]) => {
    const normalized = normalizeModelItem(item, model);
    return normalized ? [normalized] : [];
  });
}

function mergeModel(target: Map<string, CcusageModelItem>, item: CcusageModelItem): void {
  const current = target.get(item.model);
  if (!current) {
    target.set(item.model, { ...item });
    return;
  }
  target.set(item.model, {
    model: item.model,
    inputTokens: current.inputTokens + item.inputTokens,
    outputTokens: current.outputTokens + item.outputTokens,
    cacheCreationTokens: current.cacheCreationTokens + item.cacheCreationTokens,
    cacheReadTokens: current.cacheReadTokens + item.cacheReadTokens,
    totalTokens: current.totalTokens + item.totalTokens,
    totalCost: current.totalCost + item.totalCost,
  });
}

function normalizeDailyItem(value: unknown): CcusageDailyItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const date = stringField(record, "date") || stringField(record, "day") || stringField(record, "period");
  if (!date) return null;
  const breakdowns = [
    ...normalizeModelBreakdowns(record.modelBreakdowns),
    ...normalizeModelBreakdowns(record.breakdown),
  ];
  const models = Array.from(
    new Set([
      ...stringArrayField(record, ["modelsUsed", "models"]),
      ...breakdowns.map((item) => item.model),
    ])
  );
  return {
    date,
    dayStart: parseDayStart(date),
    inputTokens: numberField(record, "inputTokens"),
    outputTokens: numberField(record, "outputTokens"),
    cacheCreationTokens: cacheCreationTokenTotal(record),
    cacheReadTokens: cacheReadTokenTotal(record),
    totalTokens: tokenTotal(record),
    totalCost: firstNumberField(record, ["totalCost", "costUSD", "totalCostUSD", "cost"]) ?? 0,
    models,
    breakdowns,
  };
}

function hourStartsBetween(start: Date, end: Date): Date[] {
  if (!Number.isFinite(end.getTime()) || end.getTime() <= start.getTime()) return [start];
  const cursor = new Date(start);
  cursor.setMinutes(0, 0, 0);
  const hours: Date[] = [];
  while (cursor.getTime() < end.getTime() && hours.length < 48) {
    hours.push(new Date(cursor));
    cursor.setHours(cursor.getHours() + 1);
  }
  return hours.length > 0 ? hours : [start];
}

function normalizeBlockEntryItem(value: unknown): CcusageHourlyItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const startedAt =
    stringField(record, "timestamp") ||
    stringField(record, "time") ||
    stringField(record, "startTime") ||
    stringField(record, "createdAt");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(startedAt)) return null;
  const timestamp = new Date(startedAt);
  if (!Number.isFinite(timestamp.getTime())) return null;
  const usageRecord = asRecord(record.tokenCounts) ?? asRecord(record.usage) ?? record;
  const hasUsageValue =
    firstNumberField(usageRecord, [
      "inputTokens",
      "outputTokens",
      "cacheCreationTokens",
      "cacheCreationInputTokens",
      "cacheReadTokens",
      "cacheReadInputTokens",
      "totalTokens",
    ]) !== null ||
    firstNumberField(record, ["totalCost", "costUSD", "totalCostUSD", "cost"]) !== null ||
    firstNumberField(usageRecord, ["totalCost", "costUSD", "totalCostUSD", "cost"]) !== null;
  if (!hasUsageValue) return null;
  const breakdowns = [
    ...normalizeModelBreakdowns(record.modelBreakdowns),
    ...normalizeModelBreakdowns(record.breakdown),
  ];
  const models = Array.from(
    new Set([
      stringField(record, "model") || stringField(record, "modelName"),
      ...stringArrayField(record, ["modelsUsed", "models"]),
      ...breakdowns.map((item) => item.model),
    ].filter((model): model is string => Boolean(model)))
  );
  const inputTokens = numberField(usageRecord, "inputTokens");
  const outputTokens = numberField(usageRecord, "outputTokens");
  const cacheCreationTokens = cacheCreationTokenTotal(usageRecord);
  const cacheReadTokens = cacheReadTokenTotal(usageRecord);
  return {
    day: localDateKey(timestamp),
    hour: timestamp.getHours(),
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: firstNumberField(record, ["totalTokens"]) ?? tokenTotal(usageRecord),
    totalCost:
      firstNumberField(record, ["totalCost", "costUSD", "totalCostUSD", "cost"]) ??
      firstNumberField(usageRecord, ["totalCost", "costUSD", "totalCostUSD", "cost"]) ??
      0,
    models,
    breakdowns,
  };
}

function normalizeBlockItem(value: unknown): CcusageHourlyItem[] {
  const record = asRecord(value);
  if (!record) return [];
  const entries = asArray(record.entries)
    .map(normalizeBlockEntryItem)
    .filter((item): item is CcusageHourlyItem => item !== null);
  if (entries.length > 0) return entries;

  const blockStart = stringField(record, "blockStart") || stringField(record, "startTime") || stringField(record, "id");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(blockStart)) return [];
  const timestamp = new Date(blockStart);
  if (!Number.isFinite(timestamp.getTime())) return [];
  const blockEnd = stringField(record, "endTime") || stringField(record, "actualEndTime");
  const hourStarts = hourStartsBetween(timestamp, new Date(blockEnd));
  const share = 1 / hourStarts.length;
  const usageRecord = asRecord(record.tokenCounts) ?? record;
  const breakdowns = [
    ...normalizeModelBreakdowns(record.modelBreakdowns),
    ...normalizeModelBreakdowns(record.breakdown),
  ];
  const models = Array.from(
    new Set([
      ...stringArrayField(record, ["modelsUsed", "models"]),
      ...breakdowns.map((item) => item.model),
    ])
  );
  const inputTokens = numberField(usageRecord, "inputTokens");
  const outputTokens = numberField(usageRecord, "outputTokens");
  const cacheCreationTokens = firstNumberField(usageRecord, ["cacheCreationTokens", "cacheCreationInputTokens"]) ?? 0;
  const cacheReadTokens = firstNumberField(usageRecord, ["cacheReadTokens", "cacheReadInputTokens"]) ?? 0;
  const totalTokens = firstNumberField(record, ["totalTokens"]) ?? tokenTotal(usageRecord);
  const totalCost = firstNumberField(record, ["totalCost", "costUSD", "totalCostUSD", "cost"]) ?? 0;
  const splitBreakdowns = breakdowns.map((item) => ({
    ...item,
    inputTokens: item.inputTokens * share,
    outputTokens: item.outputTokens * share,
    cacheCreationTokens: item.cacheCreationTokens * share,
    cacheReadTokens: item.cacheReadTokens * share,
    totalTokens: item.totalTokens * share,
    totalCost: item.totalCost * share,
  }));

  return hourStarts.map((hourStart) => ({
    day: localDateKey(hourStart),
    hour: hourStart.getHours(),
    inputTokens: inputTokens * share,
    outputTokens: outputTokens * share,
    cacheCreationTokens: cacheCreationTokens * share,
    cacheReadTokens: cacheReadTokens * share,
    totalTokens: totalTokens * share,
    totalCost: totalCost * share,
    models,
    breakdowns: splitBreakdowns,
  }));
}

function normalizeBlockItems(payload: unknown): CcusageHourlyItem[] {
  const blocksPayload = ccusageBlocksPayload(payload);
  const root = asRecord(blocksPayload);
  const directBlocks = asArray(blocksPayload);
  const rawBlocks = directBlocks.length > 0
    ? directBlocks
    : asArray(root?.blocks).length > 0
    ? asArray(root?.blocks)
    : asArray(root?.data);
  return rawBlocks
    .flatMap(normalizeBlockItem)
    .sort((a, b) => a.day.localeCompare(b.day) || a.hour - b.hour);
}

function mergeDailyItems(items: CcusageDailyItem[]): CcusageDailyItem[] {
  const map = new Map<string, CcusageDailyItem>();
  for (const item of items) {
    const current = map.get(item.date);
    if (!current) {
      map.set(item.date, { ...item, models: [...item.models], breakdowns: [...item.breakdowns] });
      continue;
    }

    const breakdownMap = new Map<string, CcusageModelItem>();
    for (const model of current.breakdowns) mergeModel(breakdownMap, model);
    for (const model of item.breakdowns) mergeModel(breakdownMap, model);

    map.set(item.date, {
      date: item.date,
      dayStart: item.dayStart || current.dayStart,
      inputTokens: current.inputTokens + item.inputTokens,
      outputTokens: current.outputTokens + item.outputTokens,
      cacheCreationTokens: current.cacheCreationTokens + item.cacheCreationTokens,
      cacheReadTokens: current.cacheReadTokens + item.cacheReadTokens,
      totalTokens: current.totalTokens + item.totalTokens,
      totalCost: current.totalCost + item.totalCost,
      models: Array.from(new Set([...current.models, ...item.models])),
      breakdowns: Array.from(breakdownMap.values()),
    });
  }
  return Array.from(map.values()).sort((a, b) => a.dayStart - b.dayStart || a.date.localeCompare(b.date));
}

function projectDailyRecords(projects: unknown): unknown[] {
  const record = asRecord(projects);
  if (!record) return [];
  return Object.values(record).flatMap((value) => asArray(value));
}

function summarizeField(value: unknown): string {
  if (Array.isArray(value)) return `Array · ${value.length}`;
  const record = asRecord(value);
  if (record) return `Object · ${Object.keys(record).length} fields`;
  if (typeof value === "number") return `Number · ${formatCount(value)}`;
  if (typeof value === "string") return value.length > 36 ? `Text · ${value.slice(0, 36)}...` : `Text · ${value}`;
  if (typeof value === "boolean") return `Boolean · ${value ? "true" : "false"}`;
  if (value === null) return "null";
  return typeof value;
}

function summarizeCcusagePayload(payload: unknown): CcusageSummary {
  const root = asRecord(ccusageDailyPayload(payload));
  const totals = asRecord(root?.totals) ?? asRecord(root?.summary);
  const totalsSource = totals ?? root;
  const dailyCandidates = asArray(root?.daily);
  const dataCandidates = asArray(root?.data);
  const projectCandidates = projectDailyRecords(root?.projects);
  const rawDaily = dailyCandidates.length > 0 ? dailyCandidates : dataCandidates.length > 0 ? dataCandidates : projectCandidates;
  const schemaLabel = dailyCandidates.length > 0
    ? "daily/totals"
    : dataCandidates.length > 0
    ? "data/summary"
    : projectCandidates.length > 0
    ? "projects/totals"
    : root
    ? "summary-only"
    : "empty";
  const daily = mergeDailyItems(
    rawDaily
      .map(normalizeDailyItem)
      .filter((item): item is CcusageDailyItem => item !== null)
  );

  const fallbackTotals = daily.reduce(
    (acc, item) => ({
      inputTokens: acc.inputTokens + item.inputTokens,
      outputTokens: acc.outputTokens + item.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + item.cacheCreationTokens,
      cacheReadTokens: acc.cacheReadTokens + item.cacheReadTokens,
      totalTokens: acc.totalTokens + item.totalTokens,
      totalCost: acc.totalCost + item.totalCost,
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0 }
  );

  const modelMap = new Map<string, CcusageModelItem>();
  for (const item of daily) {
    for (const breakdown of item.breakdowns) mergeModel(modelMap, breakdown);
    for (const model of item.models) {
      if (!modelMap.has(model)) {
        modelMap.set(model, {
          model,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          totalCost: 0,
        });
      }
    }
  }

  const rootBreakdowns = [
    ...normalizeModelBreakdowns(root?.modelBreakdowns),
    ...normalizeModelBreakdowns(root?.breakdown),
    ...normalizeModelBreakdowns(totals?.modelBreakdowns),
    ...normalizeModelBreakdowns(totals?.breakdown),
  ];
  for (const item of rootBreakdowns) mergeModel(modelMap, item);

  for (const model of stringArrayField(root, ["modelsUsed", "models"])) {
    if (!modelMap.has(model)) {
      modelMap.set(model, {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        totalCost: 0,
      });
    }
  }
  for (const model of stringArrayField(totals, ["modelsUsed", "models"])) {
    if (!modelMap.has(model)) {
      modelMap.set(model, {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        totalCost: 0,
      });
    }
  }

  const models = Array.from(modelMap.values()).sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
  const payloadFields = root
    ? Object.entries(root).slice(0, 10).map(([key, value]) => ({ key, description: summarizeField(value) }))
    : [];

  return {
    inputTokens: firstNumberField(totalsSource, ["inputTokens", "totalInputTokens"]) ?? fallbackTotals.inputTokens,
    outputTokens: firstNumberField(totalsSource, ["outputTokens", "totalOutputTokens"]) ?? fallbackTotals.outputTokens,
    cacheCreationTokens:
      firstNumberField(totalsSource, [
        "cacheCreationTokens",
        "cacheCreationInputTokens",
        "totalCacheCreationTokens",
        "totalCacheCreationInputTokens",
      ]) ?? fallbackTotals.cacheCreationTokens,
    cacheReadTokens:
      firstNumberField(totalsSource, [
        "cacheReadTokens",
        "cacheReadInputTokens",
        "totalCacheReadTokens",
        "totalCacheReadInputTokens",
      ]) ?? fallbackTotals.cacheReadTokens,
    totalTokens: totalsSource ? tokenTotal(totalsSource) : fallbackTotals.totalTokens,
    totalCost: firstNumberField(totalsSource, ["totalCost", "totalCostUSD", "costUSD"]) ?? fallbackTotals.totalCost,
    modelCount: models.length,
    daily,
    models: models.slice(0, 10),
    modelNames: models.map((item) => item.model),
    hasDailyData: daily.length > 0,
    hasModelBreakdown: models.some((item) => item.totalTokens > 0 || item.totalCost > 0),
    schemaLabel,
    payloadFields,
  };
}

function summarizeFilteredDaily(base: CcusageSummary, daily: CcusageDailyItem[]): CcusageSummary {
  const totals = daily.reduce(
    (acc, item) => ({
      inputTokens: acc.inputTokens + item.inputTokens,
      outputTokens: acc.outputTokens + item.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + item.cacheCreationTokens,
      cacheReadTokens: acc.cacheReadTokens + item.cacheReadTokens,
      totalTokens: acc.totalTokens + item.totalTokens,
      totalCost: acc.totalCost + item.totalCost,
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0 }
  );

  const modelMap = new Map<string, CcusageModelItem>();
  for (const item of daily) {
    for (const breakdown of item.breakdowns) mergeModel(modelMap, breakdown);
    for (const model of item.models) {
      if (!modelMap.has(model)) {
        modelMap.set(model, {
          model,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          totalCost: 0,
        });
      }
    }
  }

  const models = Array.from(modelMap.values()).sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));

  return {
    ...base,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheCreationTokens: totals.cacheCreationTokens,
    cacheReadTokens: totals.cacheReadTokens,
    totalTokens: totals.totalTokens,
    totalCost: totals.totalCost,
    modelCount: models.length,
    daily,
    models: models.slice(0, 10),
    modelNames: models.map((item) => item.model),
    hasDailyData: daily.length > 0,
    hasModelBreakdown: models.some((item) => item.totalTokens > 0 || item.totalCost > 0),
  };
}


function emptyUsageBucket(date: string, dayStart = 0): CcusageDailyItem {
  return {
    date,
    dayStart,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    models: [],
    breakdowns: [],
  };
}

function aggregateDailyByMonth(items: CcusageDailyItem[]): CcusageDailyItem[] {
  return mergeDailyItems(
    items.map((item) => ({
      ...item,
      date: monthKey(item.date),
      dayStart: parseDayStart(`${monthKey(item.date)}-01`),
    }))
  );
}

function hourlyBucketsForDay(items: CcusageHourlyItem[], day: string): CcusageDailyItem[] {
  const buckets = Array.from({ length: 24 }, (_, hour) => emptyUsageBucket(`${pad2(hour)}:00`, hour));
  for (const item of items) {
    if (item.day !== day || item.hour < 0 || item.hour > 23) continue;
    const bucket = buckets[item.hour];
    const breakdownMap = new Map<string, CcusageModelItem>();
    for (const model of bucket.breakdowns) mergeModel(breakdownMap, model);
    for (const model of item.breakdowns) mergeModel(breakdownMap, model);
    buckets[item.hour] = {
      ...bucket,
      inputTokens: bucket.inputTokens + item.inputTokens,
      outputTokens: bucket.outputTokens + item.outputTokens,
      cacheCreationTokens: bucket.cacheCreationTokens + item.cacheCreationTokens,
      cacheReadTokens: bucket.cacheReadTokens + item.cacheReadTokens,
      totalTokens: bucket.totalTokens + item.totalTokens,
      totalCost: bucket.totalCost + item.totalCost,
      models: Array.from(new Set([...bucket.models, ...item.models])),
      breakdowns: Array.from(breakdownMap.values()),
    };
  }
  return buckets;
}

function chartItemsForTimeWindow(
  summary: CcusageSummary,
  hourlyItems: CcusageHourlyItem[],
  window: CcusageTimeWindowState
): CcusageDailyItem[] {
  if (window.mode === "day") return hourlyBucketsForDay(hourlyItems, window.day);
  if (window.mode === "year") return aggregateDailyByMonth(summary.daily);
  return summary.daily;
}

function chartGranularityLabel(mode: CcusageTimeWindowMode): string {
  if (mode === "day") return "小时";
  if (mode === "year") return "月";
  return "天";
}

function formatBucketAxisLabel(value: string): string {
  if (/^\d{2}:00$/.test(value)) return value;
  if (/^\d{4}-\d{2}$/.test(value)) return value.slice(5);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.slice(5);
  return value;
}

function getPeakDay(items: CcusageDailyItem[]): CcusageDailyItem | null {
  const peak = items.reduce<CcusageDailyItem | null>((currentPeak, item) => {
    if (!currentPeak) return item;
    return item.totalTokens > currentPeak.totalTokens ? item : currentPeak;
  }, null);
  return peak && peak.totalTokens > 0 ? peak : null;
}

function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatCount(value);
}

function formatCompactCostAxis(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value < 10 ? value.toFixed(1) : Math.round(value).toString()}`;
}

function tooltipParamRows(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : [value])
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null);
}

function tooltipDataIndex(value: Record<string, unknown> | undefined): number {
  const index = value?.dataIndex;
  return typeof index === "number" && Number.isFinite(index) ? index : 0;
}

function tooltipString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  return typeof result === "string" ? result : "";
}

function tooltipNumber(value: Record<string, unknown>, key: string): number {
  const result = value[key];
  return typeof result === "number" && Number.isFinite(result) ? result : 0;
}

function KpiStrip({ summary }: { summary: CcusageSummary }) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => (language === "zh-CN" ? zh : en);
  const peak = getPeakDay(summary.daily);
  const peakShare = peak && summary.totalTokens > 0 ? (peak.totalTokens / summary.totalTokens) * 100 : 0;
  const items: { label: string; value: string; hint: string; icon: typeof Coins; accent: string }[] = [
    {
      label: text("总 Token", "Total Token"),
      value: formatCompactCount(summary.totalTokens),
      hint: text(`完整值 ${formatCount(summary.totalTokens)} · 输入 / 输出 / 缓存合计`, `Full value ${formatCount(summary.totalTokens)} · input / output / cache total`),
      icon: Layers,
      accent: "var(--accent)",
    },
    {
      label: text("估算费用", "Estimated Cost"),
      value: formatCost(summary.totalCost),
      hint: text("ccusage 本地估算", "ccusage local estimate"),
      icon: Coins,
      accent: "var(--warning)",
    },
    {
      label: text("最高使用日", "Peak Day"),
      value: peak ? formatDayFromStart(peak.dayStart) : "-",
      hint: peak ? `${formatCompactCount(peak.totalTokens)} Token · ${formatPercent(peakShare)}` : text("暂无逐日数据", "No daily data"),
      icon: Flame,
      accent: peakShare >= 40 ? "var(--danger)" : "var(--accent)",
    },
    {
      label: text("模型 / 天数", "Models / Days"),
      value: `${formatCount(summary.modelCount)} / ${formatCount(summary.daily.length)}`,
      hint: text("识别模型数 / 日报天数", "Detected models / daily records"),
      icon: CalendarClock,
      accent: "var(--success)",
    },
  ];

  return (
    <section className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div key={item.label} className="min-w-0 rounded-2xl border border-border/60 bg-bg-secondary px-4 py-3.5">
            <div className="flex items-center gap-2">
              <span
                className="inline-flex h-6 w-6 items-center justify-center rounded-lg"
                style={{ backgroundColor: `color-mix(in srgb, ${item.accent} 16%, transparent)`, color: item.accent }}
              >
                <Icon size={14} />
              </span>
              <div className="text-[11px] font-medium text-text-muted">{item.label}</div>
            </div>
            <div className="mt-2 truncate text-[24px] font-semibold tracking-tight text-text-primary">{item.value}</div>
            <div className="mt-1 truncate text-[11px] text-text-secondary" title={item.hint}>{item.hint}</div>
          </div>
        );
      })}
    </section>
  );
}

function PeakDaySummaryCard({ summary }: { summary: CcusageSummary }) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => (language === "zh-CN" ? zh : en);
  const peak = getPeakDay(summary.daily);
  const peakShare = peak && summary.totalTokens > 0 ? (peak.totalTokens / summary.totalTokens) * 100 : 0;
  const metrics = peak
    ? [
        { label: "Token", value: formatCompactCount(peak.totalTokens), detail: formatCount(peak.totalTokens) },
        { label: text("费用", "Cost"), value: formatCost(peak.totalCost), detail: text("本地估算", "Local estimate") },
        { label: text("输入", "Input"), value: formatCompactCount(peak.inputTokens), detail: formatCount(peak.inputTokens) },
        { label: text("输出", "Output"), value: formatCompactCount(peak.outputTokens), detail: formatCount(peak.outputTokens) },
      ]
    : [];

  return (
    <section className="rounded-2xl border border-border/60 bg-bg-secondary px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-2 text-[13px] font-semibold text-text-primary">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-bg-tertiary text-accent">
              <Flame size={14} />
            </span>
            {text("峰值日摘要", "Peak Day Summary")}
          </div>
          <div className="mt-1 text-[12px] text-text-muted">
            {peak ? text(`${peak.date} · 占当前窗口 ${formatPercent(peakShare)}`, `${peak.date} · ${formatPercent(peakShare)} of current window`) : text("当前时间窗口暂无峰值日数据。", "No peak day data in the current time window.")}
          </div>
        </div>
        {peak && (
          <div className="rounded-full bg-bg-tertiary px-3 py-1 text-[11px] font-medium text-text-secondary">
            {peak.models.length > 0 ? text(`模型 ${formatCount(peak.models.length)}`, `${formatCount(peak.models.length)} models`) : text("模型未拆分", "Models not split")}
          </div>
        )}
      </div>

      {peak && (
        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          {metrics.map((item) => (
            <div key={item.label} className="rounded-xl bg-bg-primary px-3 py-2">
              <div className="text-[11px] text-text-muted">{item.label}</div>
              <div className="mt-1 text-[15px] font-semibold text-text-primary">{item.value}</div>
              <div className="mt-0.5 text-[10px] text-text-muted">{item.detail}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TokenCompositionStrip({ summary }: { summary: CcusageSummary }) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => (language === "zh-CN" ? zh : en);
  const parts = [
    { key: "input", label: text("输入", "Input"), value: summary.inputTokens, color: USAGE_SERIES_COLORS.input },
    { key: "output", label: text("输出", "Output"), value: summary.outputTokens, color: USAGE_SERIES_COLORS.output },
    { key: "cacheCreation", label: text("缓存写入", "Cache Write"), value: summary.cacheCreationTokens, color: USAGE_SERIES_COLORS.cacheCreation },
    { key: "cacheRead", label: text("缓存命中", "Cache Hit"), value: summary.cacheReadTokens, color: USAGE_SERIES_COLORS.cacheRead },
  ];
  const total = Math.max(1, parts.reduce((sum, item) => sum + item.value, 0));

  return (
    <section className="rounded-2xl border border-border/60 bg-bg-secondary px-4 py-3.5">
      <SectionHeading icon={Layers} title={text("Token 构成", "Token Composition")} hint={text("输入 / 输出 / 缓存", "Input / output / cache")} />
      <div className="flex h-2.5 overflow-hidden rounded-full bg-bg-tertiary">
        {parts.map((item) => (
          <div
            key={item.key}
            className="h-full"
            style={{ width: `${(item.value / total) * 100}%`, backgroundColor: item.color }}
            title={`${item.label} ${formatCount(item.value)}`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-text-secondary">
        {parts.map((item) => (
          <div key={item.key} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
            <span>{item.label}</span>
            <span className="font-semibold text-text-primary">{formatCompactCount(item.value)}</span>
            <span className="text-text-muted">{formatPercent((item.value / total) * 100)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReportContextNote({ reportKind, sourceLabel, schemaLabel }: { reportKind: string; sourceLabel: string; schemaLabel: string }) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => (language === "zh-CN" ? zh : en);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border/60 bg-bg-secondary px-3 py-2 text-[11px] text-text-secondary">
      <span className="inline-flex items-center gap-1 font-semibold text-text-primary">
        <Database size={13} />
        {text("统计口径", "Stats Scope")}
      </span>
      <span>{text(`来源：${sourceLabel}`, `Source: ${sourceLabel}`)}</span>
      <span>{text(`报告：${reportKind}`, `Report: ${reportKind}`)}</span>
      <span>{text(`结构：${schemaLabel}`, `Schema: ${schemaLabel}`)}</span>
      <span className="text-text-muted">{text("费用和 Token 来自本机日志估算，不等同官方账单。", "Costs and tokens come from local log estimates, not official bills.")}</span>
    </div>
  );
}

function TimeWindowSelector({
  baseSummary,
  activeSummary,
  timeWindow,
  onChange,
}: {
  baseSummary: CcusageSummary;
  activeSummary: CcusageSummary;
  timeWindow: CcusageTimeWindowState;
  onChange: (value: CcusageTimeWindowState) => void;
}) {
  const { t } = useI18n();
  const resolved = resolveTimeWindow(timeWindow, baseSummary.daily);
  const years = availableYears(baseSummary.daily);
  const first = firstDateKey(baseSummary.daily);
  const latest = latestDateKey(baseSummary.daily);
  const controlClass = "h-8 rounded-lg border border-primary/25 bg-bg-primary/85 px-3 text-xs text-text-primary shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";
  const inputClass = `${controlClass} min-w-[132px]`;
  const disabled = baseSummary.daily.length === 0;

  return (
    <section className="rounded-xl border border-primary/35 bg-primary/10 px-3 py-2 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[12px] font-semibold text-text-primary">{t("ccusage.timeWindow")}</div>
        <Select
          value={timeWindow.mode}
          onChange={(e) => onChange(nextTimeWindowForMode(e.target.value as CcusageTimeWindowMode, timeWindow, baseSummary.daily))}
          className={`${controlClass} w-auto min-w-[104px]`}
          aria-label={t("ccusage.timeWindowType")}
        >
          {TIME_WINDOW_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </Select>

        {timeWindow.mode === "year" && (
          <Select
            value={resolved.year}
            onChange={(e) => onChange({ ...timeWindow, year: e.target.value })}
            className={`${controlClass} w-auto min-w-[96px]`}
            aria-label={t("ccusage.year")}
            disabled={disabled || years.length === 0}
          >
            {years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </Select>
        )}

        {timeWindow.mode === "month" && (
          <StatsDatePicker
            mode="month"
            value={resolved.month}
            min={first.slice(0, 7)}
            max={latest.slice(0, 7)}
            onChange={(value) => onChange({ ...timeWindow, month: value })}
            className={inputClass}
            ariaLabel={t("ccusage.month")}
            disabled={disabled}
          />
        )}

        {timeWindow.mode === "day" && (
          <StatsDatePicker
            mode="date"
            value={resolved.day}
            min={first}
            max={latest}
            onChange={(value) => onChange({ ...timeWindow, day: value })}
            className={inputClass}
            ariaLabel={t("ccusage.date")}
            disabled={disabled}
          />
        )}

        {timeWindow.mode === "custom" && (
          <>
            <StatsDatePicker
              mode="date"
              value={resolved.customStart}
              min={first}
              max={latest}
              onChange={(value) => onChange({ ...timeWindow, customStart: value })}
              className={inputClass}
              ariaLabel={t("ccusage.customStart")}
              disabled={disabled}
            />
            <span className="text-[11px] text-text-muted">{t("common.to")}</span>
            <StatsDatePicker
              mode="date"
              value={resolved.customEnd}
              min={first}
              max={latest}
              onChange={(value) => onChange({ ...timeWindow, customEnd: value })}
              className={inputClass}
              ariaLabel={t("ccusage.customEnd")}
              disabled={disabled}
            />
          </>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary">
          <span>{t("ccusage.currentWindow", { value: timeWindowLabel(resolved, t) })}</span>
          <span>{t("ccusage.records", { active: formatCount(activeSummary.daily.length), total: formatCount(baseSummary.daily.length) })}</span>
        </div>
      </div>
    </section>
  );
}

function DailyUsageTrendChart({ items, granularity }: { items: CcusageDailyItem[]; granularity: string }) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => (language === "zh-CN" ? zh : en);
  const peak = useMemo(() => getPeakDay(items), [items]);
  const hasItems = items.length > 0;
  const displayGranularity = granularity === "小时" ? text("小时", "hour") : granularity === "月" ? text("月", "month") : text("天", "day");
  const peakLabel = granularity === "小时" ? text("峰值小时", "Peak Hour") : granularity === "月" ? text("峰值月份", "Peak Month") : text("最高使用日", "Peak Day");
  const costLabel = text("费用", "Cost");
  const option = useMemo<EChartsOption>(() => {
    const dates = items.map((item) => item.date);
    const tokenAxisMax = paddedTrendAxisMax(
      Math.max(
        0,
        ...items.flatMap((item) => [
          item.totalTokens,
          item.inputTokens,
          item.outputTokens,
          item.cacheCreationTokens,
          item.cacheReadTokens,
        ])
      )
    );
    const costAxisMax = paddedTrendAxisMax(Math.max(0, ...items.map((item) => item.totalCost)));
    const denseDailyLabels = granularity === "天" && dates.length > 18;
    const xAxisLabelInterval = denseDailyLabels ? Math.ceil(dates.length / 8) : 0;
    return {
      backgroundColor: "transparent",
      animationDuration: 700,
      color: [
        USAGE_TREND_COLORS.total,
        USAGE_SERIES_COLORS.input,
        USAGE_SERIES_COLORS.output,
        USAGE_SERIES_COLORS.cacheCreation,
        USAGE_SERIES_COLORS.cacheRead,
        COST_COLOR,
      ],
      tooltip: {
        trigger: "axis",
        confine: true,
        axisPointer: { type: "line", lineStyle: { color: ECHARTS_AXIS_LINE, width: 1 } },
        ...CHART_TOOLTIP,
        formatter: (params: unknown) => {
          const rows = tooltipParamRows(params);
          const day = items[tooltipDataIndex(rows[0])];
          if (!day) return "";
          const seriesRows = rows
            .map((row) => {
              const name = tooltipString(row, "seriesName");
              const marker = tooltipString(row, "marker");
              const color = tooltipString(row, "color") || "var(--text-primary)";
              const value = tooltipNumber(row, "value");
              const display = name === costLabel ? formatCost(value) : `${formatCount(value)} Token`;
              return `<div style="display:flex;align-items:center;justify-content:space-between;gap:22px;line-height:24px;color:var(--text-secondary);"><span style="display:inline-flex;align-items:center;gap:7px;text-align:left;min-width:0;">${marker}<span style="color:${color};font-weight:600;">${name}</span></span><strong style="min-width:104px;text-align:right;color:${color};font-weight:700;">${display}</strong></div>`;
            })
            .join("");
          return `<div style="min-width:270px;color:var(--text-primary);"><div style="font-weight:700;margin-bottom:8px;color:var(--text-primary);">${day.date}${peak?.date === day.date ? ` · ${peakLabel}` : ""}</div>${seriesRows}<div style="margin-top:8px;color:var(--text-muted);">${text("模型", "Models")}：${day.models.length || "-"}</div></div>`;
        },
      },
      legend: {
        top: 0,
        right: 6,
        itemWidth: 10,
        itemHeight: 6,
        textStyle: { color: "var(--text-secondary)", fontSize: 11 },
      },
      grid: { left: 48, right: 56, top: 42, bottom: denseDailyLabels ? 46 : 34 },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: dates,
        axisLine: { lineStyle: { color: "var(--border)" } },
        axisTick: { show: false },
        axisLabel: {
          show: true,
          interval: xAxisLabelInterval,
          showMinLabel: true,
          showMaxLabel: true,
          hideOverlap: denseDailyLabels,
          rotate: denseDailyLabels ? 28 : 0,
          color: "var(--text-muted)",
          formatter: (value: string) => formatBucketAxisLabel(value),
        },
      },
      yAxis: [
        {
          type: "value",
          name: "Token",
          max: tokenAxisMax,
          nameTextStyle: { color: "var(--text-muted)", fontSize: 10 },
          splitLine: { lineStyle: { color: "var(--border)", opacity: 0.42 } },
          axisLabel: { color: "var(--text-muted)", formatter: (value: number) => formatCompactCount(value) },
        },
        {
          type: "value",
          name: "USD",
          max: costAxisMax,
          nameTextStyle: { color: "var(--text-muted)", fontSize: 10 },
          splitLine: { show: false },
          axisLabel: { color: "var(--text-muted)", formatter: (value: number) => formatCompactCostAxis(value) },
        },
      ],
      series: [
        {
          name: text("总 Token", "Total Token"),
          type: "line",
          smooth: true,
          symbol: "circle",
          symbolSize: 5,
          itemStyle: { color: USAGE_TREND_COLORS.total },
          lineStyle: { width: 3, color: USAGE_TREND_COLORS.total },
          areaStyle: { color: `color-mix(in srgb, ${USAGE_TREND_COLORS.total} 16%, transparent)` },
          data: items.map((item) =>
            peak?.date === item.date
              ? { value: item.totalTokens, symbolSize: 12, itemStyle: { color: PEAK, borderColor: "var(--bg-secondary)", borderWidth: 2 } }
              : item.totalTokens
          ),
          markPoint: peak
            ? {
                symbol: "pin",
                symbolSize: 56,
                itemStyle: { color: PEAK },
                label: { color: "var(--bg-secondary)", fontSize: 10, lineHeight: 12, fontWeight: 700, formatter: `${text("峰值", "Peak")}\n{c}` },
                data: [{ name: peakLabel, coord: [peak.date, peak.totalTokens], value: formatCompactCount(peak.totalTokens) }],
              }
            : undefined,
          markLine: peak
            ? {
                symbol: "none",
                lineStyle: { color: PEAK, type: "dashed", width: 1.4 },
                label: { color: PEAK, formatter: peakLabel },
                data: [{ xAxis: peak.date }],
              }
            : undefined,
        },
        {
          name: text("输入", "Input"),
          type: "line",
          smooth: true,
          symbol: "none",
          itemStyle: { color: USAGE_SERIES_COLORS.input },
          lineStyle: { width: 1.8, opacity: 0.9, color: USAGE_SERIES_COLORS.input },
          data: items.map((item) => item.inputTokens),
        },
        {
          name: text("输出", "Output"),
          type: "line",
          smooth: true,
          symbol: "none",
          itemStyle: { color: USAGE_SERIES_COLORS.output },
          lineStyle: { width: 1.8, opacity: 0.9, color: USAGE_SERIES_COLORS.output },
          data: items.map((item) => item.outputTokens),
        },
        {
          name: text("缓存写入", "Cache Write"),
          type: "line",
          smooth: true,
          symbol: "none",
          itemStyle: { color: USAGE_SERIES_COLORS.cacheCreation },
          lineStyle: { width: 1.8, opacity: 0.9, color: USAGE_SERIES_COLORS.cacheCreation },
          data: items.map((item) => item.cacheCreationTokens),
        },
        {
          name: text("缓存命中", "Cache Hit"),
          type: "line",
          smooth: true,
          symbol: "none",
          itemStyle: { color: USAGE_SERIES_COLORS.cacheRead },
          lineStyle: { width: 1.8, opacity: 0.9, color: USAGE_SERIES_COLORS.cacheRead },
          data: items.map((item) => item.cacheReadTokens),
        },
        {
          name: costLabel,
          type: "line",
          smooth: true,
          yAxisIndex: 1,
          symbol: "none",
          itemStyle: { color: COST_COLOR },
          lineStyle: { width: 2.2, color: COST_COLOR },
          emphasis: { focus: "series" },
          data: items.map((item) => Number(item.totalCost.toFixed(2))),
        },
      ],
    };
  }, [items, peak, granularity, peakLabel, costLabel, language]);

  return (
    <section className="rounded-2xl border border-border/60 bg-bg-secondary p-4 lg:p-5">
      <SectionHeading
        icon={LineChart}
        title={text(`按${granularity} Token / 费用趋势`, `Token / cost trend by ${displayGranularity}`)}
        right={
          <div className="ml-auto rounded-full bg-bg-tertiary px-3 py-1 text-[11px] font-medium text-text-secondary">
            {peak ? text(`${peakLabel}：${peak.date} · ${formatCount(peak.totalTokens)} Token`, `${peakLabel}: ${peak.date} · ${formatCount(peak.totalTokens)} Token`) : text("暂无逐日数据", "No daily data")}
          </div>
        }
      />

      {!hasItems ? (
        <div className="rounded-xl bg-bg-primary py-8 text-center text-[12px] text-text-muted">
          {text("当前时间窗口没有可绘制的 Token / 费用数据。", "No drawable Token / cost data in the current time window.")}
        </div>
      ) : (
        <EChart option={option} className="h-[380px] w-full" />
      )}
    </section>
  );
}

function heatmapCellColor(value: number, maxValue: number): string {
  if (value <= 0 || maxValue <= 0) return "color-mix(in srgb, var(--text-muted) 12%, transparent)";
  const ratio = value / maxValue;
  if (ratio < 0.05) return `color-mix(in srgb, ${USAGE_TREND_COLORS.total} 18%, transparent)`;
  if (ratio < 0.25) return `color-mix(in srgb, ${USAGE_TREND_COLORS.total} 36%, transparent)`;
  if (ratio < 0.5) return `color-mix(in srgb, ${USAGE_TREND_COLORS.total} 56%, transparent)`;
  if (ratio < 0.75) return `color-mix(in srgb, ${USAGE_TREND_COLORS.total} 78%, transparent)`;
  return USAGE_TREND_COLORS.total;
}

function DailyUsageHeatmap({ items, granularity }: { items: CcusageDailyItem[]; granularity: string }) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => (language === "zh-CN" ? zh : en);
  const peak = useMemo(() => getPeakDay(items), [items]);
  const maxTokens = Math.max(0, ...items.map((item) => item.totalTokens));
  const hasItems = items.length > 0;
  const columns = Math.max(1, Math.min(items.length, granularity === "月" ? 12 : 24));

  return (
    <section className="rounded-2xl border border-border/60 bg-bg-secondary p-4">
      <SectionHeading
        icon={Grid3x3}
        title={text(`按${granularity} Token 热点图`, `Token heatmap by ${granularity === "小时" ? "hour" : granularity === "月" ? "month" : "day"}`)}
        hint={peak ? text(`最高：${peak.date} · ${formatCount(peak.totalTokens)} Token`, `Peak: ${peak.date} · ${formatCount(peak.totalTokens)} Token`) : text("暂无数据", "No data")}
      />

      {!hasItems ? (
        <div className="rounded-xl bg-bg-primary py-8 text-center text-[12px] text-text-muted">
          {text("当前时间窗口没有可绘制的热点数据。", "No drawable heatmap data in the current time window.")}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl bg-bg-primary p-3">
            <div className="grid w-max gap-1" style={{ gridTemplateColumns: `repeat(${columns}, 14px)` }}>
              {items.map((item) => {
                const isPeak = peak?.date === item.date;
                return (
                  <div
                    key={item.date}
                    className="h-[14px] w-[14px] rounded-[3px]"
                    style={{
                      backgroundColor: heatmapCellColor(item.totalTokens, maxTokens),
                      boxShadow: isPeak ? `0 0 0 2px color-mix(in srgb, ${PEAK} 55%, transparent)` : "none",
                    }}
                    title={`${item.date} · ${formatCount(item.totalTokens)} Token · ${formatCost(item.totalCost)}${isPeak ? text(" · 峰值", " · Peak") : ""}`}
                  />
                );
              })}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between text-[10px] text-text-muted">
            <span>{text("低使用", "Low")}</span>
            <span>{text("颜色越深代表 Token 越高", "Darker color means higher Token usage")}</span>
            <span>{text("高使用", "High")}</span>
          </div>
        </>
      )}
    </section>
  );
}

function ModelRankingChart({ summary }: { summary: CcusageSummary }) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => (language === "zh-CN" ? zh : en);
  const models = useMemo(
    () => summary.models.filter((item) => item.totalTokens > 0).slice(0, 8).reverse(),
    [summary.models]
  );
  const option = useMemo<EChartsOption>(() => {
    const tokenAxisMax = niceAxisMax(Math.max(0, ...models.map((item) => item.totalTokens)));
    return {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow", shadowStyle: { color: ECHARTS_AXIS_SHADOW } },
        confine: true,
        ...CHART_TOOLTIP,
        formatter: (params: unknown) => {
          const row = tooltipParamRows(params)[0];
          const model = models[tooltipDataIndex(row)];
          if (!model) return "";
          return `<div style="min-width:220px;color:var(--text-secondary);"><strong style="color:var(--text-primary);">${model.model}</strong><div style="margin-top:6px;color:var(--text-primary);">Token: ${formatCount(model.totalTokens)}</div><div>${text("费用", "Cost")}: ${formatCost(model.totalCost)}</div><div>${text("输入", "Input")}: ${formatCount(model.inputTokens)} · ${text("输出", "Output")}: ${formatCount(model.outputTokens)}</div></div>`;
        },
      },
      grid: { left: 112, right: 54, top: 14, bottom: 24 },
      xAxis: {
        type: "value",
        max: tokenAxisMax,
        splitLine: { lineStyle: { color: "var(--border)", opacity: 0.42 } },
        axisLabel: { color: "var(--text-muted)", formatter: (value: number) => formatCompactCount(value) },
      },
      yAxis: {
        type: "category",
        data: models.map((item) => item.model),
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: {
          color: "var(--text-secondary)",
          width: 104,
          overflow: "truncate",
          formatter: (value: string) => value.replace(/^claude-/, ""),
        },
      },
      series: [
        {
          name: "Token",
          type: "bar",
          barWidth: 14,
          itemStyle: { color: USAGE_TREND_COLORS.total, borderRadius: [0, 7, 7, 0] },
          label: {
            show: true,
            position: "right",
            color: "var(--text-muted)",
            fontSize: 10,
            formatter: (params: unknown) => formatCompactCount(tooltipNumber(asRecord(params) ?? {}, "value")),
          },
          data: models.map((item, index) => ({
            value: item.totalTokens,
            itemStyle: { color: index === models.length - 1 ? PEAK : USAGE_TREND_COLORS.total },
          })),
        },
      ],
    };
  }, [models, language]);

  return (
    <section className="rounded-2xl border border-border/60 bg-bg-secondary p-4">
      <SectionHeading
        icon={BarChart3}
        title={text("模型用量排行", "Model Usage Ranking")}
        hint={summary.hasModelBreakdown ? "Top models by Token" : summary.modelNames.length > 0 ? text("仅识别到模型名", "Only model names detected") : text("暂无模型数据", "No model data")}
      />

      {models.length === 0 ? (
        <div className="rounded-xl bg-bg-primary py-8 text-center text-[12px] text-text-muted">
          {text("ccusage 输出中没有可用于排行的模型 Token 数据。", "ccusage output has no model Token data available for ranking.")}
        </div>
      ) : (
        <EChart option={option} className="h-[300px] w-full" />
      )}
    </section>
  );
}

function PayloadOverviewFooter({ summary }: { summary: CcusageSummary }) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => (language === "zh-CN" ? zh : en);
  return (
    <section className="rounded-xl border border-border/60 bg-bg-secondary px-3 py-2 text-[11px] text-text-muted">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-semibold text-text-secondary">{text("数据结构摘要", "Data Schema Summary")}</span>
        <span>{text(`结构：${summary.schemaLabel}`, `Schema: ${summary.schemaLabel}`)}</span>
        <span>{text(`逐日：${formatCount(summary.daily.length)}`, `Daily: ${formatCount(summary.daily.length)}`)}</span>
        <span>{text(`模型：${formatCount(summary.modelCount)}`, `Models: ${formatCount(summary.modelCount)}`)}</span>
        <span>{text(`模型拆分：${summary.hasModelBreakdown ? "已返回" : "未返回"}`, `Model breakdown: ${summary.hasModelBreakdown ? "returned" : "not returned"}`)}</span>
      </div>
      {summary.payloadFields.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {summary.payloadFields.map((field) => (
            <span key={field.key} className="max-w-[220px] truncate rounded-md bg-bg-primary px-2 py-1" title={`${field.key}: ${field.description}`}>
              <span className="font-medium text-text-secondary">{field.key}</span> · {field.description}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

export function CcusageStatsPanel({ open, onClose }: CcusageStatsPanelProps) {
  const { t } = useI18n();
  const source = useCcusageStore((s) => s.source);
  const toolStatus = useCcusageStore((s) => s.toolStatus);
  const report = useCcusageStore((s) => s.report);
  const checkingStatus = useCcusageStore((s) => s.checkingStatus);
  const installingTools = useCcusageStore((s) => s.installingTools);
  const loadingCache = useCcusageStore((s) => s.loadingCache);
  const refreshing = useCcusageStore((s) => s.refreshing);
  const error = useCcusageStore((s) => s.error);
  const setSource = useCcusageStore((s) => s.setSource);
  const checkStatus = useCcusageStore((s) => s.checkStatus);
  const installTools = useCcusageStore((s) => s.installTools);
  const loadCachedReport = useCcusageStore((s) => s.loadCachedReport);
  const refreshReport = useCcusageStore((s) => s.refreshReport);
  const claudeConfigDir = useSettingsStore((s) => s.claudeHookConfigDir);
  const codexConfigDir = useSettingsStore((s) => s.codexHookConfigDir);
  const [hostInstallConfirmOpen, setHostInstallConfirmOpen] = useState(false);
  const [timeWindow, setTimeWindow] = useState<CcusageTimeWindowState>(DEFAULT_TIME_WINDOW);

  useEffect(() => {
    if (!open) return;
    void checkStatus().catch(() => {});
    void loadCachedReport().catch(() => {});
  }, [open, source, claudeConfigDir, codexConfigDir, checkStatus, loadCachedReport]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  const baseSummary = useMemo(() => summarizeCcusagePayload(report?.payload), [report?.payload]);
  const blockItems = useMemo(() => normalizeBlockItems(report?.payload), [report?.payload]);
  const resolvedTimeWindow = useMemo(
    () => resolveTimeWindow(timeWindow, baseSummary.daily),
    [timeWindow, baseSummary.daily]
  );
  const filteredDaily = useMemo(
    () => filterDailyByTimeWindow(baseSummary.daily, resolvedTimeWindow),
    [baseSummary.daily, resolvedTimeWindow]
  );
  const summary = useMemo(
    () => (resolvedTimeWindow.mode === "all" ? baseSummary : summarizeFilteredDaily(baseSummary, filteredDaily)),
    [baseSummary, filteredDaily, resolvedTimeWindow.mode]
  );
  const chartItems = useMemo(
    () => chartItemsForTimeWindow(summary, blockItems, resolvedTimeWindow),
    [summary, blockItems, resolvedTimeWindow]
  );
  const chartGranularity = chartGranularityLabel(resolvedTimeWindow.mode);
  const selectedDayHasBlocks =
    resolvedTimeWindow.mode !== "day" || blockItems.some((item) => item.day === resolvedTimeWindow.day && item.totalTokens > 0);
  const sourceOption = SOURCE_OPTIONS.find((option) => option.value === source) ?? SOURCE_OPTIONS[0];
  const sourceLabel = sourceOption.labelKey ? t(sourceOption.labelKey) : sourceOption.label;
  const sourceDescription = t(sourceOption.descriptionKey);
  const runtimeScope = useMemo(
    () => resolveCcusageRuntimeScope(source, claudeConfigDir, codexConfigDir),
    [claudeConfigDir, codexConfigDir, source]
  );
  const wslTarget = useMemo(
    () => resolveCcusageWslTarget(claudeConfigDir, codexConfigDir),
    [claudeConfigDir, codexConfigDir]
  );
  const hostReady = toolStatus?.host.bunxAvailable === true;
  const wslReady =
    Boolean(wslTarget.distro) &&
    toolStatus?.wsl?.distro === wslTarget.distro &&
    toolStatus.wsl.bunxAvailable === true;
  const sourceToolReady =
    runtimeScope.kind === "host"
      ? hostReady
      : runtimeScope.kind === "wsl"
        ? toolStatus?.wsl?.distro === runtimeScope.distro && toolStatus.wsl.bunxAvailable === true
        : false;
  const mixedRuntimeMessageKey: TranslationKey | null =
    runtimeScope.kind !== "mixed"
      ? null
      : runtimeScope.reason === "host-wsl"
        ? "ccusage.mixedRuntimeHostWsl"
        : "ccusage.mixedRuntimeMultiWsl";
  const showWslManualHint = !wslReady && (Boolean(wslTarget.distro) || wslTarget.conflicts.length > 0);
  const showPrepareCard = !hostReady || showWslManualHint || Boolean(mixedRuntimeMessageKey);
  const wslStatus = toolStatus?.wsl?.distro === wslTarget.distro ? toolStatus.wsl : null;

  if (!open) return null;

  return (
    <Portal>
      <div
        className="fixed inset-0 flex items-center justify-center p-4"
        style={{ zIndex: 57, backgroundColor: "rgba(0, 0, 0, 0.45)" }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <Card className="ui-stats-panel flex h-[min(86vh,860px)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-bg-primary">
          <div className="ui-stats-panel-header flex items-center justify-between border-b border-border px-3 py-2">
            <div>
              <div className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-text-primary">
                <span className="ui-stats-panel-badge">
                  <BarChart3 size={15} />
                </span>
                {t("ccusage.title")}
              </div>
              <div className="ui-dev-label mt-1 text-[11px] text-text-muted">{t("ccusage.subtitle")}</div>
            </div>
            <Button onClick={onClose} aria-label={t("ccusage.close")} size="icon" variant="ghost" title={t("common.close")}>
              <X size={14} />
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <Select
              value={source}
              onChange={(e) => setSource(e.target.value as CcusageSource)}
              className="h-8 w-auto min-w-[124px] shrink-0 text-xs"
              aria-label={t("ccusage.source")}
            >
              {SOURCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.labelKey ? t(option.labelKey) : option.label}
                </option>
              ))}
            </Select>

            <Button
              onClick={() => {
                if (!sourceToolReady) {
                  void checkStatus().catch(() => {});
                  return;
                }
                void refreshReport().catch(() => {});
              }}
              disabled={checkingStatus || installingTools || refreshing || !sourceToolReady}
              aria-label={t("ccusage.refreshReport")}
              size="sm"
            >
              <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
              {t("ccusage.refresh")}
            </Button>

            {!hostReady && (
              <Button
                onClick={() => setHostInstallConfirmOpen(true)}
                disabled={checkingStatus || installingTools}
                aria-label={t("ccusage.installAria")}
                size="sm"
              >
                <PackageCheck size={12} className={installingTools ? "animate-pulse" : ""} />
                {installingTools ? t("ccusage.installing") : t("ccusage.installTools")}
              </Button>
            )}

            <div className="ml-auto text-[12px] font-medium text-text-secondary">
              {t("ccusage.sourceSummary", { source: sourceLabel, description: sourceDescription })}
            </div>
            <div className="w-full text-[12px] font-medium text-text-secondary">
              {t("ccusage.cacheSummary", {
                time: formatDateTime(report?.updatedAt ?? null),
                source: report ? (report.fromCache ? t("ccusage.source.cache") : t("ccusage.source.refreshed")) : t("ccusage.source.none"),
              })}
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {(checkingStatus || loadingCache) && !report && (
              <Card className="bg-bg-secondary p-3 text-[12px] text-text-secondary">{t("ccusage.loadingStatus")}</Card>
            )}

            {showPrepareCard && (
              <Card className="bg-bg-secondary p-4">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-text-primary">
                  <PackageCheck size={14} />
                  {t("ccusage.prepareTools")}
                </div>
                <div className="mt-2 space-y-1.5 text-[12px] leading-6 text-text-secondary">
                  <div>{t("ccusage.reportExplanation")}</div>
                  <div>{t("ccusage.toolVersions", { bun: toolStatus?.host.bunVersion ?? t("ccusage.notDetected"), bunx: toolStatus?.host.bunxVersion ?? t("ccusage.notDetected") })}</div>
                  {wslTarget.distro && (
                    <div>
                      {t("ccusage.wslToolVersions", {
                        distro: wslTarget.distro,
                        bun: wslStatus?.bunVersion ?? t("ccusage.notDetected"),
                        bunx: wslStatus?.bunxVersion ?? t("ccusage.notDetected"),
                      })}
                    </div>
                  )}
                  {wslTarget.conflicts.length > 0 && (
                    <div>{t("ccusage.installWslConflict", { distros: wslTarget.conflicts.join(", ") })}</div>
                  )}
                  {mixedRuntimeMessageKey && <div>{t(mixedRuntimeMessageKey)}</div>}
                  <div>{t("ccusage.installNote")}</div>
                  {wslTarget.distro && <div>{t("ccusage.installWslNote", { distro: wslTarget.distro })}</div>}
                </div>
              </Card>
            )}

            {error && <Card className="bg-bg-secondary p-3 text-[12px] text-danger">{error}</Card>}

            {!report && sourceToolReady && !loadingCache && (
              <Card className="bg-bg-secondary p-4 text-[12px] leading-6 text-text-secondary">
                {t("ccusage.noCache")}
              </Card>
            )}

            {report && (
              <>
                {refreshing && <div className="text-[12px] font-medium text-text-muted">{t("ccusage.refreshing")}</div>}

                <TimeWindowSelector
                  baseSummary={baseSummary}
                  activeSummary={summary}
                  timeWindow={timeWindow}
                  onChange={setTimeWindow}
                />
                {!selectedDayHasBlocks && (
                  <Card className="bg-bg-secondary px-3 py-2 text-[12px] leading-5 text-text-secondary">
                    {t("ccusage.dayBlocksNote")}
                  </Card>
                )}
                <KpiStrip summary={summary} />
                <ReportContextNote reportKind={report.reportKind} sourceLabel={sourceLabel} schemaLabel={summary.schemaLabel} />
                <PeakDaySummaryCard summary={summary} />
                <TokenCompositionStrip summary={summary} />

                <DailyUsageTrendChart items={chartItems} granularity={chartGranularity} />

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <DailyUsageHeatmap items={chartItems} granularity={chartGranularity} />
                  <ModelRankingChart summary={summary} />
                </div>

                <PayloadOverviewFooter summary={summary} />
              </>
            )}
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={hostInstallConfirmOpen}
        title={t("ccusage.installConfirmTitle")}
        message={t("ccusage.installConfirmMessage", { registry: REGISTRY_MIRROR_TEXT })}
        confirmText={t("ccusage.installTools")}
        cancelText={t("common.cancel")}
        zIndex={60}
        onClose={() => setHostInstallConfirmOpen(false)}
        onConfirm={() => {
          setHostInstallConfirmOpen(false);
          void (async () => {
            try {
              await installTools();
              const targetStatus = useCcusageStore.getState().toolStatus?.host ?? null;
              if (targetStatus?.bunxAvailable) {
                toast.success(
                  t("ccusage.installSuccess", {
                    bun: targetStatus.bunVersion ?? "?",
                    bunx: targetStatus.bunxVersion ?? "?",
                  })
                );
              } else {
                toast.warning(t("ccusage.installWarning"));
              }
            } catch (err) {
              toast.error(t("ccusage.installFailed", { error: String(err) }));
            }
          })();
        }}
      />
    </Portal>
  );
}
