import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { EChartsOption } from "echarts";
import { BarChart3, CalendarClock, Coins, Database, Flame, Grid3x3, Layers, LineChart, PackageCheck, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "../ConfirmDialog";
import { Portal } from "../ui/Portal";
import type { CcusageSource } from "../../lib/types";
import { useCcusageStore } from "../../stores/ccusageStore";
import { EChart } from "./EChart";
import { ACCENT, CHART_TOOLTIP, COST_FILL, PEAK, SERIES_COLORS } from "./statsPalette";

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

const TIME_WINDOW_OPTIONS: { value: CcusageTimeWindowMode; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "year", label: "年" },
  { value: "month", label: "月" },
  { value: "day", label: "日" },
  { value: "custom", label: "自定义" },
];

const SOURCE_OPTIONS: { value: CcusageSource; label: string; description: string }[] = [
  { value: "all", label: "全部", description: "ccusage 统一报告" },
  { value: "claude", label: "Claude", description: "Claude Code 聚焦报告" },
  { value: "codex", label: "Codex", description: "Codex CLI 聚焦报告" },
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

function firstDateKey(items: CcusageDailyItem[]): string {
  return items.length > 0 ? dateKey(items[0].date) : "";
}

function latestDateKey(items: CcusageDailyItem[]): string {
  return items.length > 0 ? dateKey(items[items.length - 1].date) : "";
}

function availableYears(items: CcusageDailyItem[]): string[] {
  return Array.from(new Set(items.map((item) => dateKey(item.date).slice(0, 4)).filter(Boolean))).sort((a, b) => b.localeCompare(a));
}

function timeWindowLabel(window: CcusageTimeWindowState): string {
  if (window.mode === "year") return window.year ? `${window.year} 年` : "选择年份";
  if (window.mode === "month") return window.month ? `${window.month} 月` : "选择月份";
  if (window.mode === "day") return window.day || "选择日期";
  if (window.mode === "custom") {
    if (window.customStart && window.customEnd) return `${window.customStart} 至 ${window.customEnd}`;
    if (window.customStart) return `${window.customStart} 起`;
    if (window.customEnd) return `截至 ${window.customEnd}`;
    return "自定义范围";
  }
  return "全部时间";
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

function normalizeModelItem(value: unknown, fallbackModel = "未知模型"): CcusageModelItem | null {
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
  if (Array.isArray(value)) return `数组 · ${value.length} 项`;
  const record = asRecord(value);
  if (record) return `对象 · ${Object.keys(record).length} 个字段`;
  if (typeof value === "number") return `数字 · ${formatCount(value)}`;
  if (typeof value === "string") return value.length > 36 ? `文本 · ${value.slice(0, 36)}...` : `文本 · ${value}`;
  if (typeof value === "boolean") return `布尔 · ${value ? "true" : "false"}`;
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
  if (/^\d{4}-\d{2}$/.test(value)) return `${value.slice(5)}月`;
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
  const peak = getPeakDay(summary.daily);
  const peakShare = peak && summary.totalTokens > 0 ? (peak.totalTokens / summary.totalTokens) * 100 : 0;
  const items: { label: string; value: string; hint: string; icon: typeof Coins; accent: string }[] = [
    {
      label: "总 Token",
      value: formatCompactCount(summary.totalTokens),
      hint: `完整值 ${formatCount(summary.totalTokens)} · 输入 / 输出 / 缓存合计`,
      icon: Layers,
      accent: "var(--accent)",
    },
    {
      label: "估算费用",
      value: formatCost(summary.totalCost),
      hint: "ccusage 本地估算",
      icon: Coins,
      accent: "var(--warning)",
    },
    {
      label: "最高使用日",
      value: peak ? formatDayFromStart(peak.dayStart) : "-",
      hint: peak ? `${formatCompactCount(peak.totalTokens)} Token · ${formatPercent(peakShare)}` : "暂无逐日数据",
      icon: Flame,
      accent: peakShare >= 40 ? "var(--danger)" : "var(--accent)",
    },
    {
      label: "模型 / 天数",
      value: `${formatCount(summary.modelCount)} / ${formatCount(summary.daily.length)}`,
      hint: "识别模型数 / 日报天数",
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
  const peak = getPeakDay(summary.daily);
  const peakShare = peak && summary.totalTokens > 0 ? (peak.totalTokens / summary.totalTokens) * 100 : 0;
  const metrics = peak
    ? [
        { label: "Token", value: formatCompactCount(peak.totalTokens), detail: formatCount(peak.totalTokens) },
        { label: "费用", value: formatCost(peak.totalCost), detail: "本地估算" },
        { label: "输入", value: formatCompactCount(peak.inputTokens), detail: formatCount(peak.inputTokens) },
        { label: "输出", value: formatCompactCount(peak.outputTokens), detail: formatCount(peak.outputTokens) },
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
            峰值日摘要
          </div>
          <div className="mt-1 text-[12px] text-text-muted">
            {peak ? `${peak.date} · 占当前窗口 ${formatPercent(peakShare)}` : "当前时间窗口暂无峰值日数据。"}
          </div>
        </div>
        {peak && (
          <div className="rounded-full bg-bg-tertiary px-3 py-1 text-[11px] font-medium text-text-secondary">
            {peak.models.length > 0 ? `模型 ${formatCount(peak.models.length)}` : "模型未拆分"}
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
  const parts = [
    { key: "input", label: "输入", value: summary.inputTokens, color: SERIES_COLORS.input },
    { key: "output", label: "输出", value: summary.outputTokens, color: SERIES_COLORS.output },
    { key: "cacheCreation", label: "缓存写入", value: summary.cacheCreationTokens, color: SERIES_COLORS.cacheCreation },
    { key: "cacheRead", label: "缓存命中", value: summary.cacheReadTokens, color: SERIES_COLORS.cacheRead },
  ];
  const total = Math.max(1, parts.reduce((sum, item) => sum + item.value, 0));

  return (
    <section className="rounded-2xl border border-border/60 bg-bg-secondary px-4 py-3.5">
      <SectionHeading icon={Layers} title="Token 构成" hint="输入 / 输出 / 缓存" />
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
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border/60 bg-bg-secondary px-3 py-2 text-[11px] text-text-secondary">
      <span className="inline-flex items-center gap-1 font-semibold text-text-primary">
        <Database size={13} />
        统计口径
      </span>
      <span>来源：{sourceLabel}</span>
      <span>报告：{reportKind}</span>
      <span>结构：{schemaLabel}</span>
      <span className="text-text-muted">费用和 Token 来自本机日志估算，不等同官方账单。</span>
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
        <div className="text-[12px] font-semibold text-text-primary">时间窗口</div>
        <Select
          value={timeWindow.mode}
          onChange={(e) => onChange(nextTimeWindowForMode(e.target.value as CcusageTimeWindowMode, timeWindow, baseSummary.daily))}
          className={`${controlClass} w-auto min-w-[104px]`}
          aria-label="ccusage 时间窗口类型"
        >
          {TIME_WINDOW_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>

        {timeWindow.mode === "year" && (
          <Select
            value={resolved.year}
            onChange={(e) => onChange({ ...timeWindow, year: e.target.value })}
            className={`${controlClass} w-auto min-w-[96px]`}
            aria-label="ccusage 年份"
            disabled={disabled || years.length === 0}
          >
            {years.map((year) => (
              <option key={year} value={year}>
                {year} 年
              </option>
            ))}
          </Select>
        )}

        {timeWindow.mode === "month" && (
          <input
            type="month"
            value={resolved.month}
            min={first.slice(0, 7)}
            max={latest.slice(0, 7)}
            onChange={(e) => onChange({ ...timeWindow, month: e.target.value })}
            className={inputClass}
            aria-label="ccusage 月份"
            disabled={disabled}
          />
        )}

        {timeWindow.mode === "day" && (
          <input
            type="date"
            value={resolved.day}
            min={first}
            max={latest}
            onChange={(e) => onChange({ ...timeWindow, day: e.target.value })}
            className={inputClass}
            aria-label="ccusage 日期"
            disabled={disabled}
          />
        )}

        {timeWindow.mode === "custom" && (
          <>
            <input
              type="date"
              value={resolved.customStart}
              min={first}
              max={latest}
              onChange={(e) => onChange({ ...timeWindow, customStart: e.target.value })}
              className={inputClass}
              aria-label="ccusage 自定义开始日期"
              disabled={disabled}
            />
            <span className="text-[11px] text-text-muted">至</span>
            <input
              type="date"
              value={resolved.customEnd}
              min={first}
              max={latest}
              onChange={(e) => onChange({ ...timeWindow, customEnd: e.target.value })}
              className={inputClass}
              aria-label="ccusage 自定义结束日期"
              disabled={disabled}
            />
          </>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary">
          <span>当前：{timeWindowLabel(resolved)}</span>
          <span>记录：{formatCount(activeSummary.daily.length)} / {formatCount(baseSummary.daily.length)}</span>
        </div>
      </div>
    </section>
  );
}

function DailyUsageTrendChart({ items, granularity }: { items: CcusageDailyItem[]; granularity: string }) {
  const peak = useMemo(() => getPeakDay(items), [items]);
  const hasItems = items.length > 0;
  const peakLabel = granularity === "小时" ? "峰值小时" : granularity === "月" ? "峰值月份" : "最高使用日";
  const option = useMemo<EChartsOption>(() => {
    const dates = items.map((item) => item.date);
    const tokenAxisMax = niceAxisMax(Math.max(0, ...items.flatMap((item) => [item.totalTokens, item.inputTokens, item.outputTokens])));
    const costAxisMax = niceAxisMax(Math.max(0, ...items.map((item) => item.totalCost)));
    const denseDailyLabels = granularity === "天" && dates.length > 18;
    const xAxisLabelInterval = denseDailyLabels ? Math.ceil(dates.length / 8) : 0;
    return {
      backgroundColor: "transparent",
      animationDuration: 700,
      color: [ACCENT, SERIES_COLORS.input, SERIES_COLORS.output, SERIES_COLORS.cacheCreation],
      tooltip: {
        trigger: "axis",
        confine: true,
        ...CHART_TOOLTIP,
        formatter: (params: unknown) => {
          const rows = tooltipParamRows(params);
          const day = items[tooltipDataIndex(rows[0])];
          if (!day) return "";
          const seriesRows = rows
            .map((row) => {
              const name = tooltipString(row, "seriesName");
              const marker = tooltipString(row, "marker");
              const value = tooltipNumber(row, "value");
              const display = name === "费用" ? formatCost(value) : `${formatCount(value)} Token`;
              return `<div style="display:flex;align-items:center;justify-content:space-between;gap:18px;line-height:22px;"><span style="display:inline-flex;align-items:center;gap:6px;text-align:left;">${marker}<span>${name}</span></span><strong style="min-width:88px;text-align:right;">${display}</strong></div>`;
            })
            .join("");
          return `<div style="min-width:190px;"><div style="font-weight:700;margin-bottom:6px;">${day.date}${peak?.date === day.date ? ` · ${peakLabel}` : ""}</div>${seriesRows}<div style="margin-top:6px;color:var(--text-muted);">模型：${day.models.length || "-"}</div></div>`;
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
          name: "总 Token",
          type: "line",
          smooth: true,
          symbol: "circle",
          symbolSize: 5,
          lineStyle: { width: 3 },
          areaStyle: { color: `color-mix(in srgb, ${ACCENT} 16%, transparent)` },
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
                label: { color: "var(--bg-secondary)", fontSize: 10, lineHeight: 12, fontWeight: 700, formatter: "峰值\n{c}" },
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
          name: "输入",
          type: "line",
          smooth: true,
          symbol: "none",
          lineStyle: { width: 1.8, opacity: 0.9 },
          data: items.map((item) => item.inputTokens),
        },
        {
          name: "输出",
          type: "line",
          smooth: true,
          symbol: "none",
          lineStyle: { width: 1.8, opacity: 0.9 },
          data: items.map((item) => item.outputTokens),
        },
        {
          name: "费用",
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 12,
          itemStyle: { color: COST_FILL, borderRadius: [5, 5, 0, 0] },
          data: items.map((item) => Number(item.totalCost.toFixed(2))),
        },
      ],
    };
  }, [items, peak, granularity, peakLabel]);

  return (
    <section className="rounded-2xl border border-border/60 bg-bg-secondary p-4 lg:p-5">
      <SectionHeading
        icon={LineChart}
        title={`按${granularity} Token / 费用趋势`}
        right={
          <div className="ml-auto rounded-full bg-bg-tertiary px-3 py-1 text-[11px] font-medium text-text-secondary">
            {peak ? `${peakLabel}：${peak.date} · ${formatCount(peak.totalTokens)} Token` : "暂无逐日数据"}
          </div>
        }
      />

      {!hasItems ? (
        <div className="rounded-xl bg-bg-primary py-8 text-center text-[12px] text-text-muted">
          当前时间窗口没有可绘制的 Token / 费用数据。
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
  if (ratio < 0.05) return "color-mix(in srgb, var(--accent) 18%, transparent)";
  if (ratio < 0.25) return "color-mix(in srgb, var(--accent) 36%, transparent)";
  if (ratio < 0.5) return "color-mix(in srgb, var(--accent) 56%, transparent)";
  if (ratio < 0.75) return "color-mix(in srgb, var(--accent) 78%, transparent)";
  return "var(--accent)";
}

function DailyUsageHeatmap({ items, granularity }: { items: CcusageDailyItem[]; granularity: string }) {
  const peak = useMemo(() => getPeakDay(items), [items]);
  const maxTokens = Math.max(0, ...items.map((item) => item.totalTokens));
  const hasItems = items.length > 0;
  const columns = Math.max(1, Math.min(items.length, granularity === "月" ? 12 : 24));

  return (
    <section className="rounded-2xl border border-border/60 bg-bg-secondary p-4">
      <SectionHeading
        icon={Grid3x3}
        title={`按${granularity} Token 热点图`}
        hint={peak ? `最高：${peak.date} · ${formatCount(peak.totalTokens)} Token` : "暂无数据"}
      />

      {!hasItems ? (
        <div className="rounded-xl bg-bg-primary py-8 text-center text-[12px] text-text-muted">
          当前时间窗口没有可绘制的热点数据。
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
                    title={`${item.date} · ${formatCount(item.totalTokens)} Token · ${formatCost(item.totalCost)}${isPeak ? " · 峰值" : ""}`}
                  />
                );
              })}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between text-[10px] text-text-muted">
            <span>低使用</span>
            <span>颜色越深代表 Token 越高</span>
            <span>高使用</span>
          </div>
        </>
      )}
    </section>
  );
}

function ModelRankingChart({ summary }: { summary: CcusageSummary }) {
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
        axisPointer: { type: "shadow" },
        confine: true,
        ...CHART_TOOLTIP,
        formatter: (params: unknown) => {
          const row = tooltipParamRows(params)[0];
          const model = models[tooltipDataIndex(row)];
          if (!model) return "";
          return `<div style="min-width:220px;"><strong>${model.model}</strong><div style="margin-top:6px;">Token：${formatCount(model.totalTokens)}</div><div>费用：${formatCost(model.totalCost)}</div><div>输入：${formatCount(model.inputTokens)} · 输出：${formatCount(model.outputTokens)}</div></div>`;
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
          itemStyle: { color: ACCENT, borderRadius: [0, 7, 7, 0] },
          label: {
            show: true,
            position: "right",
            color: "var(--text-muted)",
            fontSize: 10,
            formatter: (params: unknown) => formatCompactCount(tooltipNumber(asRecord(params) ?? {}, "value")),
          },
          data: models.map((item, index) => ({
            value: item.totalTokens,
            itemStyle: { color: index === models.length - 1 ? PEAK : ACCENT },
          })),
        },
      ],
    };
  }, [models]);

  return (
    <section className="rounded-2xl border border-border/60 bg-bg-secondary p-4">
      <SectionHeading
        icon={BarChart3}
        title="模型用量排行"
        hint={summary.hasModelBreakdown ? "Top models by Token" : summary.modelNames.length > 0 ? "仅识别到模型名" : "暂无模型数据"}
      />

      {models.length === 0 ? (
        <div className="rounded-xl bg-bg-primary py-8 text-center text-[12px] text-text-muted">
          ccusage 输出中没有可用于排行的模型 Token 数据。
        </div>
      ) : (
        <EChart option={option} className="h-[300px] w-full" />
      )}
    </section>
  );
}

function PayloadOverviewFooter({ summary }: { summary: CcusageSummary }) {
  return (
    <section className="rounded-xl border border-border/60 bg-bg-secondary px-3 py-2 text-[11px] text-text-muted">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-semibold text-text-secondary">数据结构摘要</span>
        <span>结构：{summary.schemaLabel}</span>
        <span>逐日：{formatCount(summary.daily.length)}</span>
        <span>模型：{formatCount(summary.modelCount)}</span>
        <span>模型拆分：{summary.hasModelBreakdown ? "已返回" : "未返回"}</span>
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
  const [installConfirmOpen, setInstallConfirmOpen] = useState(false);
  const [timeWindow, setTimeWindow] = useState<CcusageTimeWindowState>(DEFAULT_TIME_WINDOW);

  useEffect(() => {
    if (!open) return;
    void checkStatus().catch(() => {});
    void loadCachedReport().catch(() => {});
  }, [open, source, checkStatus, loadCachedReport]);

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
  const toolReady = toolStatus?.bunxAvailable === true;

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
                ccusage 用量分析
              </div>
              <div className="ui-dev-label mt-1 text-[11px] text-text-muted">Claude / Codex 本地用量估算</div>
            </div>
            <Button onClick={onClose} aria-label="关闭 ccusage 用量分析" size="icon" variant="ghost" title="关闭">
              <X size={14} />
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <Select
              value={source}
              onChange={(e) => setSource(e.target.value as CcusageSource)}
              className="h-8 w-auto min-w-[124px] shrink-0 text-xs"
              aria-label="ccusage 来源"
            >
              {SOURCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>

            <Button
              onClick={() => {
                if (!toolReady) {
                  void checkStatus().catch(() => {});
                  return;
                }
                void refreshReport().catch(() => {});
              }}
              disabled={checkingStatus || installingTools || refreshing || !toolReady}
              aria-label="刷新 ccusage 报告"
              size="sm"
            >
              <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
              刷新
            </Button>

            {!toolReady && (
              <Button
                onClick={() => setInstallConfirmOpen(true)}
                disabled={checkingStatus || installingTools}
                aria-label="安装 Bun 和 bunx"
                size="sm"
              >
                <PackageCheck size={12} className={installingTools ? "animate-pulse" : ""} />
                {installingTools ? "安装中" : "安装 Bun/bunx"}
              </Button>
            )}

            <div className="ml-auto text-[12px] font-medium text-text-secondary">
              来源：{sourceOption.label} ｜ 口径：{sourceOption.description}
            </div>
            <div className="w-full text-[12px] font-medium text-text-secondary">
              缓存更新时间：{formatDateTime(report?.updatedAt ?? null)} ｜ 数据来源：{report ? (report.fromCache ? "SQLite 缓存" : "刚刚刷新") : "暂无缓存"}
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {(checkingStatus || loadingCache) && !report && (
              <Card className="bg-bg-secondary p-3 text-[12px] text-text-secondary">正在读取工具状态和本地缓存...</Card>
            )}

            {!toolReady && (
              <Card className="bg-bg-secondary p-4">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-text-primary">
                  <PackageCheck size={14} />
                  需要准备 Bun/bunx
                </div>
                <div className="mt-2 space-y-1.5 text-[12px] leading-6 text-text-secondary">
                  <div>ccusage 会读取 daily 和 blocks 本地统计；daily 用于年/月/自定义，blocks 用于日视图小时聚合。</div>
                  <div>Bun：{toolStatus?.bunVersion ?? "未检测到"}；bunx：{toolStatus?.bunxVersion ?? "未检测到"}。</div>
                  <div>点击安装前会再次确认；安装命令使用 npm 国内镜像源，不会把 ccusage 写入本项目依赖。</div>
                </div>
              </Card>
            )}

            {error && <Card className="bg-bg-secondary p-3 text-[12px] text-danger">{error}</Card>}

            {!report && toolReady && !loadingCache && (
              <Card className="bg-bg-secondary p-4 text-[12px] leading-6 text-text-secondary">
                当前来源暂无 SQLite 缓存。点击“刷新”后会运行 ccusage，并把成功结果写入本地缓存。
              </Card>
            )}

            {report && (
              <>
                {refreshing && <div className="text-[12px] font-medium text-text-muted">正在后台刷新 ccusage 报告...</div>}

                <TimeWindowSelector
                  baseSummary={baseSummary}
                  activeSummary={summary}
                  timeWindow={timeWindow}
                  onChange={setTimeWindow}
                />
                {!selectedDayHasBlocks && (
                  <Card className="bg-bg-secondary px-3 py-2 text-[12px] leading-5 text-text-secondary">
                    日视图小时数据来自 ccusage blocks（startTime/blockStart）。如果刷新后仍为 0，说明当前来源或该日期没有可拆分到小时的 blocks 记录；daily 报告本身只提供逐日汇总。
                  </Card>
                )}
                <KpiStrip summary={summary} />
                <ReportContextNote reportKind={report.reportKind} sourceLabel={sourceOption.label} schemaLabel={summary.schemaLabel} />
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
        open={installConfirmOpen}
        title="安装 Bun/bunx？"
        message={`将执行固定命令 npm install -g bun --registry ${REGISTRY_MIRROR_TEXT}，这会修改当前用户的全局开发环境。`}
        confirmText="安装"
        cancelText="取消"
        zIndex={60}
        onClose={() => setInstallConfirmOpen(false)}
        onConfirm={() => {
          setInstallConfirmOpen(false);
          void (async () => {
            try {
              await installTools();
              const status = useCcusageStore.getState().toolStatus;
              if (status?.bunxAvailable) {
                toast.success(
                  `Bun/bunx 安装成功（Bun ${status.bunVersion ?? "?"} / bunx ${status.bunxVersion ?? "?"}）`
                );
              } else {
                toast.warning("安装命令已执行，但仍未检测到 bunx，请重启应用或检查 PATH");
              }
            } catch (err) {
              toast.error(`Bun/bunx 安装失败：${String(err)}`);
            }
          })();
        }}
      />
    </Portal>
  );
}
