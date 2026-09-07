import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  CalendarDays,
  CircleAlert,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Coins,
  Copy,
  Database,
  ExternalLink,
  FileText,
  Layers3,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import type { RequestLogFilters, RequestLogItem, RequestLogPage, RequestLogSource } from "../../lib/types";
import { syncHistoryRequestLogs } from "../../stores/historyStore";
import { useI18n, type AppLanguage, type TranslationKey } from "../../lib/i18n";
import { getHistoryPathArgs } from "../../lib/historyPathArgs";
import { VendorIcon } from "../VendorIcon";
import { StatsDatePicker } from "./StatsDatePicker";

const PAGE_SIZE = 20;

const REQUEST_LOG_SOURCE_LABEL_KEYS: Record<RequestLogSource, TranslationKey> = {
  claude: "requestLogs.source.claude",
  codex: "requestLogs.source.codex",
  gemini: "requestLogs.source.gemini",
  opencode: "requestLogs.source.opencode",
  grok: "requestLogs.source.grok",
};

const REQUEST_LOG_ERROR_CODE_LABEL_KEYS: Record<string, TranslationKey> = {
  routing_upstream_http_error: "requestLogs.error.upstreamHttp",
  routing_upstream_timeout: "requestLogs.error.upstreamTimeout",
  routing_upstream_request_failed: "requestLogs.error.upstreamRequestFailed",
  routing_upstream_body_failed: "requestLogs.error.upstreamBodyFailed",
  routing_upstream_provider_failed: "requestLogs.error.upstreamProviderFailed",
  routing_upstream_client_error: "requestLogs.error.upstreamClientError",
  routing_upstream_stream_error: "requestLogs.error.upstreamStreamError",
  routing_upstream_stream_timeout: "requestLogs.error.upstreamStreamTimeout",
  routing_client_cancelled: "requestLogs.error.clientCancelled",
  routing_provider_circuit_open: "requestLogs.error.providerCircuitOpen",
  routing_provider_keys_cooling_down: "requestLogs.error.providerKeysCoolingDown",
  routing_provider_keys_unavailable: "requestLogs.error.providerKeysUnavailable",
  routing_provider_key_exhausted: "requestLogs.error.providerKeyExhausted",
  routing_provider_endpoint_invalid: "requestLogs.error.providerEndpointInvalid",
  routing_upstream_rectifier_retry: "requestLogs.error.upstreamRetry",
  routing_upstream_key_retry: "requestLogs.error.upstreamKeyRetry",
};

type Translator = (key: TranslationKey, params?: Record<string, string | number>) => string;

type RequestLogSourceFilter = "all" | RequestLogSource;
type RequestLogDatePreset = "today" | "last7Days" | "last30Days";

interface RequestLogDraftFilters {
  source: RequestLogSourceFilter;
  project: string;
  projectPath: string;
  model: string;
  session: string;
  startDate: string;
  endDate: string;
}

interface RequestLogsViewProps {
  onOpenSession: (sessionKey: string) => Promise<void>;
  globalFilters?: RequestLogFilters;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function defaultFilters(): RequestLogDraftFilters {
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 29);
  return {
    source: "all",
    project: "",
    projectPath: "",
    model: "",
    session: "",
    startDate: toDateInput(start),
    endDate: toDateInput(end),
  };
}

function datePresetRange(preset: RequestLogDatePreset): Pick<RequestLogDraftFilters, "startDate" | "endDate"> {
  const end = new Date();
  const days = preset === "today" ? 1 : preset === "last7Days" ? 7 : 30;
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - days + 1);
  return { startDate: toDateInput(start), endDate: toDateInput(end) };
}

function matchesDatePreset(filters: RequestLogDraftFilters, preset: RequestLogDatePreset): boolean {
  const range = datePresetRange(preset);
  return filters.startDate === range.startDate && filters.endDate === range.endDate;
}

function parseDate(value: string, endOfDay: boolean): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date.getTime()
    : null;
}

function normalizeFilters(filters: RequestLogDraftFilters): RequestLogFilters {
  return {
    source: filters.source === "all" ? null : filters.source,
    project_key: filters.project.trim() || null,
    project_path: filters.projectPath.trim() || null,
    model: filters.model.trim() || null,
    session_query: filters.session.trim() || null,
    start_at: parseDate(filters.startDate, false),
    end_at: parseDate(filters.endDate, true),
  };
}

function requestLogDraftFromGlobalFilters(filters: RequestLogFilters): RequestLogDraftFilters {
  const defaults = defaultFilters();
  return {
    ...defaults,
    source: filters.source ?? "all",
    project: filters.project_key ?? "",
    projectPath: filters.project_path ?? "",
    model: filters.model ?? "",
    startDate: typeof filters.start_at === "number" ? toDateInput(new Date(filters.start_at)) : defaults.startDate,
    endDate: typeof filters.end_at === "number" ? toDateInput(new Date(filters.end_at)) : defaults.endDate,
  };
}

function hasInvalidDateRange(filters: RequestLogFilters): boolean {
  const startAt = filters.start_at;
  const endAt = filters.end_at;
  return typeof startAt !== "number" || typeof endAt !== "number" || endAt < startAt;
}

function formatCount(value: number, language: AppLanguage): string {
  return new Intl.NumberFormat(language).format(Math.max(0, Math.round(value || 0)));
}

function formatCompact(value: number, language: AppLanguage): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatCount(value, language);
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  return `${(value * 100).toFixed(1)}%`;
}

function formatDateTime(value: number, language: AppLanguage): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function sessionKey(source: string, sessionId: string, filePath: string): string {
  return `${source}:${sessionId}:${filePath}`;
}

function outlierThreshold(values: number[]): number {
  if (values.length < 4) return Number.POSITIVE_INFINITY;
  const positiveValues = values.filter((value) => Number.isFinite(value) && value > 0);
  if (positiveValues.length < 4) return Number.POSITIVE_INFINITY;
  const average = positiveValues.reduce((sum, value) => sum + value, 0) / positiveValues.length;
  return average * 2;
}

function isRouteError(item: RequestLogItem): boolean {
  return item.data_source === "route" && (
    item.outcome === "error" ||
    item.outcome === "skipped" ||
    Boolean(item.error_code) ||
    Boolean(item.error_detail)
  );
}

function requestLogErrorSummary(item: RequestLogItem, t: Translator): string {
  const safeDetail = item.error_detail?.trim();
  if (safeDetail) return safeDetail;
  const codeLabel = item.error_code ? REQUEST_LOG_ERROR_CODE_LABEL_KEYS[item.error_code] : undefined;
  if (codeLabel) return t(codeLabel);
  if (typeof item.status_code === "number") {
    return t("requestLogs.error.httpStatusSummary", { status: item.status_code });
  }
  return t("requestLogs.error.unknown");
}

export function RequestLogsView({ onOpenSession, globalFilters }: RequestLogsViewProps) {
  const { language, t } = useI18n();
  const [draft, setDraft] = useState<RequestLogDraftFilters>(() => defaultFilters());
  const [applied, setApplied] = useState<RequestLogDraftFilters>(() => defaultFilters());
  const [page, setPage] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedError, setSelectedError] = useState<RequestLogItem | null>(null);
  const globalFiltersKey = JSON.stringify(globalFilters ?? null);
  const filters = useMemo(() => normalizeFilters(applied), [applied]);
  const draftFilters = useMemo(() => normalizeFilters(draft), [draft]);
  const invalidRange = hasInvalidDateRange(draftFilters);
  const invalidAppliedRange = hasInvalidDateRange(filters);

  useEffect(() => {
    if (!globalFilters) return;
    const next = requestLogDraftFromGlobalFilters(globalFilters);
    setDraft(next);
    setApplied(next);
    setPage(0);
  }, [globalFiltersKey]);

  const query = useQuery({
    queryKey: ["historyRequestLogs", filters, page, refreshNonce],
    queryFn: async () => invoke<RequestLogPage>("history_list_request_logs", {
        filters,
        page,
        pageSize: PAGE_SIZE,
        ...(await getHistoryPathArgs()),
      }),
    enabled: !invalidAppliedRange,
  });

  const result = query.data;
  const pageCount = Math.max(1, Math.ceil((result?.total ?? 0) / PAGE_SIZE));
  const tokenOutlierThreshold = useMemo(
    () => outlierThreshold(result?.data.map((item) => item.total_tokens) ?? []),
    [result?.data],
  );
  const costOutlierThreshold = useMemo(
    () => outlierThreshold(result?.data.map((item) => item.total_cost_usd) ?? []),
    [result?.data],
  );
  const advancedFilterCount = Number(Boolean(draft.model.trim())) + Number(Boolean(draft.session.trim()));
  const selectedErrorSummary = selectedError ? requestLogErrorSummary(selectedError, t) : "";

  const applyFilters = () => {
    const next = normalizeFilters(draft);
    if (hasInvalidDateRange(next)) return;
    setPage(0);
    setApplied({ ...draft });
  };

  const resetFilters = () => {
    const next = defaultFilters();
    setDraft(next);
    setApplied(next);
    setPage(0);
  };

  const applyQuickFilter = (patch: Partial<RequestLogDraftFilters>) => {
    const nextPatch = patch.project === undefined ? patch : { ...patch, projectPath: "" };
    setDraft((current) => ({ ...current, ...nextPatch }));
    setApplied((current) => ({ ...current, ...nextPatch }));
    setPage(0);
  };

  const selectDatePreset = (preset: RequestLogDatePreset) => {
    setDraft((current) => ({ ...current, ...datePresetRange(preset) }));
  };

  const copySessionId = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("requestLogs.copySessionIdSuccess"));
    } catch (error) {
      toast.error(t("requestLogs.copySessionIdFailed"), { description: String(error) });
    }
  };

  const openSession = (source: string, sessionId: string, filePath: string) => {
    void onOpenSession(sessionKey(source, sessionId, filePath));
  };

  const syncAndRefresh = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    try {
      await syncHistoryRequestLogs(true);
      setPage(0);
      setRefreshNonce(Date.now());
    } catch (error) {
      setSyncError(String(error));
    } finally {
      setSyncing(false);
    }
  };

  const controlClass = "h-8 rounded-md border border-border bg-bg-secondary px-2 text-xs text-text-primary";

  return (
    <div className="space-y-3">
      <Card className="border-border/70 bg-bg-secondary p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full shrink-0 sm:w-[120px]">
            <Select
              value={draft.source}
              onChange={(event) => setDraft((current) => ({ ...current, source: event.target.value as RequestLogSourceFilter }))}
              className={controlClass}
              aria-label={t("requestLogs.filter.source")}
            >
              <option value="all">{t("common.allSources")}</option>
              <option value="claude">{t("requestLogs.source.claude")}</option>
              <option value="codex">{t("requestLogs.source.codex")}</option>
              <option value="gemini">{t("requestLogs.source.gemini")}</option>
              <option value="opencode">{t("requestLogs.source.opencode")}</option>
              <option value="grok">{t("requestLogs.source.grok")}</option>
            </Select>
          </div>
          <input
            value={draft.project}
            onChange={(event) => setDraft((current) => ({ ...current, project: event.target.value, projectPath: "" }))}
            className={`${controlClass} min-w-[220px] flex-[1_1_300px] xl:max-w-[520px]`}
            placeholder={t("requestLogs.filter.project")}
            aria-label={t("requestLogs.filter.project")}
          />
          <div className="flex w-full min-w-[280px] items-center gap-1.5 sm:w-auto sm:flex-[0_0_310px]">
            <StatsDatePicker
              mode="date"
              value={draft.startDate}
              onChange={(value) => setDraft((current) => ({ ...current, startDate: value }))}
              className={`${controlClass} min-w-0 flex-1`}
              ariaLabel={t("requestLogs.filter.startDate")}
            />
            <span className="shrink-0 text-[11px] text-text-muted">{t("common.to")}</span>
            <StatsDatePicker
              mode="date"
              value={draft.endDate}
              onChange={(value) => setDraft((current) => ({ ...current, endDate: value }))}
              className={`${controlClass} min-w-0 flex-1`}
              ariaLabel={t("requestLogs.filter.endDate")}
            />
          </div>
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border/60 bg-bg-tertiary/45 p-0.5" role="group" aria-label={t("requestLogs.datePreset.label")}>
            <CalendarDays size={13} className="mx-1 text-text-muted" aria-hidden="true" />
            {(["today", "last7Days", "last30Days"] as RequestLogDatePreset[]).map((preset) => {
              const selected = matchesDatePreset(draft, preset);
              return (
                <Button
                  key={preset}
                  onClick={() => selectDatePreset(preset)}
                  variant="ghost"
                  size="sm"
                  className={selected ? "h-7 bg-primary/10 px-2 text-primary" : "h-7 px-2 text-text-muted"}
                  aria-pressed={selected}
                >
                  {t(`requestLogs.datePreset.${preset}`)}
                </Button>
              );
            })}
          </div>
          <Button
            onClick={() => setAdvancedOpen((current) => !current)}
            variant="outline"
            size="sm"
            className="h-8 shrink-0 text-text-secondary"
            aria-expanded={advancedOpen}
          >
            <SlidersHorizontal size={13} />
            {advancedOpen ? t("requestLogs.filter.hideAdvanced") : t("requestLogs.filter.showAdvanced")}
            {advancedFilterCount > 0 && (
              <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-primary/10 px-1 text-[10px] text-primary">
                {advancedFilterCount}
              </span>
            )}
            <ChevronDown size={12} className={`transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
          </Button>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            <Button onClick={applyFilters} disabled={invalidRange} variant="default" size="sm">
              <Search size={13} />
              {t("requestLogs.query")}
            </Button>
            <Button onClick={resetFilters} variant="ghost" size="sm">
              <RotateCcw size={13} />
              {t("requestLogs.reset")}
            </Button>
            <Button onClick={() => void syncAndRefresh()} disabled={syncing} variant="outline" size="sm">
              <RefreshCw size={13} className={syncing ? "animate-spin" : ""} />
              {syncing ? t("requestLogs.syncing") : t("requestLogs.refresh")}
            </Button>
          </div>
        </div>
        {advancedOpen && (
          <div className="mt-2 grid grid-cols-1 gap-2 border-t border-border/60 pt-2 md:grid-cols-2">
            <input
              value={draft.model}
              onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
              className={controlClass}
              placeholder={t("requestLogs.filter.model")}
              aria-label={t("requestLogs.filter.model")}
            />
            <input
              value={draft.session}
              onChange={(event) => setDraft((current) => ({ ...current, session: event.target.value }))}
              className={controlClass}
              placeholder={t("requestLogs.filter.session")}
              aria-label={t("requestLogs.filter.session")}
            />
          </div>
        )}
        {invalidRange && <div className="mt-2 text-[12px] text-danger" role="alert">{t("requestLogs.invalidRange")}</div>}
        {syncError && <div className="mt-2 text-[12px] text-danger" role="alert">{t("requestLogs.syncFailed", { error: syncError })}</div>}
      </Card>

      <div className="grid grid-cols-5 gap-2">
        {[
          { icon: FileText, label: t("requestLogs.summary.records"), value: formatCount(result?.summary.total ?? 0, language) },
          { icon: Layers3, label: t("requestLogs.summary.tokens"), value: formatCompact(result?.summary.total_tokens ?? 0, language) },
          { icon: Database, label: t("requestLogs.summary.cacheHitRate"), value: formatRate(result?.summary.cache_hit_rate ?? 0) },
          { icon: Coins, label: t("requestLogs.summary.cost"), value: formatCost(result?.summary.total_cost_usd ?? 0) },
          { icon: Database, label: t("requestLogs.summary.unpriced"), value: formatCompact(result?.summary.unpriced_tokens ?? 0, language) },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <Card
              key={item.label}
              className="flex min-w-0 items-center gap-2.5 border-border/70 bg-bg-secondary px-3 py-2.5 shadow-sm"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon size={14} />
              </span>
              <div className="min-w-0">
                <div className="truncate text-[10px] font-medium text-text-muted">{item.label}</div>
                <div className="mt-0.5 truncate text-[17px] font-semibold tabular-nums tracking-tight text-text-primary">{item.value}</div>
              </div>
            </Card>
          );
        })}
      </div>

      <Card className="overflow-hidden border-border/70 bg-bg-secondary">
        {query.isPending && <div className="p-6 text-center text-[12px] text-text-muted" role="status">{t("requestLogs.loading")}</div>}
        {query.error && <div className="p-4 text-[12px] text-danger" role="alert">{t("requestLogs.loadFailed", { error: String(query.error) })}</div>}
        {!query.isPending && !query.error && result?.data.length === 0 && (
          <div className="p-8 text-center text-[12px] text-text-muted">{t("requestLogs.empty")}</div>
        )}
        {result && result.data.length > 0 && (
          <div className="max-h-[calc(100vh-280px)] overflow-auto">
            <table className="w-full min-w-[1120px] border-collapse text-center text-[12px]">
              <thead className="sticky top-0 z-10 border-b border-border bg-bg-tertiary text-[11px] font-semibold text-text-muted">
                <tr>
                  <th className="px-3 py-2.5">{t("requestLogs.column.time")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.source")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.model")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.projectSession")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.input")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.output")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.cost")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.status")}</th>
                  <th className="sticky right-0 z-20 bg-bg-tertiary px-3 py-2.5 text-center">{t("requestLogs.column.action")}</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((item, rowIndex) => {
                  const tokenOutlier = item.total_tokens > tokenOutlierThreshold;
                  const costOutlier = item.total_cost_usd > costOutlierThreshold;
                  const sourceLabel = t(REQUEST_LOG_SOURCE_LABEL_KEYS[item.source]);
                  const sourceVendor = item.source === "claude"
                    ? "claude"
                    : item.source === "codex"
                      ? "openai"
                      : item.source === "gemini"
                        ? "gemini"
                        : item.source === "grok"
                          ? "grok"
                          : null;
                  const hasRouteError = isRouteError(item);
                  const errorSummary = hasRouteError ? requestLogErrorSummary(item, t) : null;
                  return (
                    <tr
                      key={item.request_id}
                      className={`group border-t border-border/70 odd:bg-bg-tertiary/20 transition-colors hover:bg-bg-tertiary/60 ${item.session_available ? "cursor-default" : ""}`}
                      onDoubleClick={() => {
                        if (item.session_available) openSession(item.source, item.session_id, item.file_path);
                      }}
                      title={item.session_available ? t("requestLogs.rowOpenHint") : undefined}
                    >
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px] tabular-nums text-text-secondary">
                        {formatDateTime(item.timestamp_ms, language)}
                      </td>
                      <td className="px-3 py-2.5">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            applyQuickFilter({ source: item.source });
                          }}
                          onDoubleClick={(event) => event.stopPropagation()}
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-bg-primary px-2 py-0.5 font-medium text-text-secondary transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                          title={t("requestLogs.applyQuickFilter", { value: sourceLabel })}
                        >
                          <VendorIcon vendor={sourceVendor} fallback={Database} size={13} />
                          {sourceLabel}
                        </button>
                        <div className="mt-1 text-[10px] text-text-muted">
                          {item.data_source === "route" ? t("requestLogs.dataSource.route") : t("requestLogs.dataSource.session")}
                          {item.provider_name ? ` · ${item.provider_name}` : ""}
                        </div>
                      </td>
                      <td className="max-w-[180px] px-3 py-2.5">
                        {item.model ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              applyQuickFilter({ model: item.model ?? "" });
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}
                            className="mx-auto block max-w-full cursor-pointer truncate font-medium text-text-primary transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            title={t("requestLogs.applyQuickFilter", { value: item.model })}
                          >
                            {item.outbound_model && item.requested_model && item.outbound_model !== item.requested_model
                              ? `${item.requested_model} → ${item.outbound_model}`
                              : item.model}
                          </button>
                        ) : "—"}
                      </td>
                      <td className="max-w-[280px] px-3 py-2.5">
                        {item.project_key ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              applyQuickFilter({ project: item.project_key });
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}
                            className="mx-auto block max-w-full cursor-pointer truncate font-medium text-text-primary transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            title={t("requestLogs.applyQuickFilter", { value: item.project_key })}
                          >
                            {item.project_key}
                          </button>
                        ) : (
                          <div className="truncate font-medium text-text-primary">{t("requestLogs.unknownProject")}</div>
                        )}
                        <div className="mt-0.5 truncate font-mono text-[10px] text-text-muted" title={item.session_id}>{item.session_id}</div>
                      </td>
                      <td
                        className={`px-3 py-2.5 font-medium tabular-nums ${tokenOutlier ? "bg-warning/5 text-warning" : "text-text-primary"}`}
                        title={tokenOutlier ? t("requestLogs.tokenOutlier") : undefined}
                      >
                        <div>{formatCompact(item.input_tokens, language)}</div>
                        <div className="mt-0.5 whitespace-nowrap text-[10px] font-normal text-text-muted">
                          {t("requestLogs.cacheDetail", {
                            read: formatCompact(item.cache_read_tokens, language),
                            write: formatCompact(item.cache_creation_tokens, language),
                          })}
                        </div>
                      </td>
                      <td
                        className={`px-3 py-2.5 font-medium tabular-nums ${tokenOutlier ? "text-warning" : "text-text-primary"}`}
                        title={tokenOutlier ? t("requestLogs.tokenOutlier") : undefined}
                      >
                        {formatCompact(item.output_tokens, language)}
                      </td>
                      <td
                        className={`px-3 py-2.5 font-medium tabular-nums ${costOutlier || item.unpriced_tokens > 0 ? "bg-warning/5 text-warning" : "text-text-primary"}`}
                        title={costOutlier ? t("requestLogs.costOutlier") : undefined}
                      >
                        <div>{formatCost(item.total_cost_usd)}</div>
                        {item.unpriced_tokens > 0 && (
                          <div className="mt-0.5 whitespace-nowrap text-[10px] font-normal">
                            {t("requestLogs.unpricedWithTokens", { count: formatCompact(item.unpriced_tokens, language) })}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-text-muted">
                        {hasRouteError && errorSummary ? (
                          <div className="flex min-w-[180px] flex-col items-center gap-1">
                            <span className="inline-flex max-w-full items-center gap-1.5 text-danger" title={errorSummary}>
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" aria-hidden="true" />
                              <span className="truncate">{errorSummary}</span>
                            </span>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedError(item);
                              }}
                              onDoubleClick={(event) => event.stopPropagation()}
                              className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                              title={t("requestLogs.error.viewDetails")}
                              aria-label={t("requestLogs.error.viewDetails")}
                            >
                              <CircleAlert size={12} aria-hidden="true" />
                              {t("requestLogs.error.viewDetails")}
                            </button>
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            <span className={`h-1.5 w-1.5 rounded-full ${item.usage_status === "complete" ? "bg-primary/55" : "bg-warning"}`} aria-hidden="true" />
                            {item.usage_status === "complete"
                              ? t(item.data_source === "route" ? "requestLogs.dataSource.route" : "requestLogs.status.recorded")
                              : t(`requestLogs.usageStatus.${item.usage_status ?? "missing"}`)}
                          </span>
                        )}
                        {item.degraded && <div className="mt-1 text-[10px] text-warning">{t("requestLogs.status.degraded", { count: item.attempt_count ?? 1 })}</div>}
                      </td>
                      <td className={`sticky right-0 px-3 py-2.5 text-center transition-colors group-hover:bg-bg-tertiary ${rowIndex % 2 === 0 ? "bg-bg-tertiary/20" : "bg-bg-secondary"}`}>
                        <div className="flex items-center justify-center gap-1">
                          <Button
                            onClick={(event) => {
                              event.stopPropagation();
                              void copySessionId(item.session_id);
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}
                            variant="ghost"
                            size="icon"
                            title={t("requestLogs.copySessionId")}
                            aria-label={t("requestLogs.copySessionId")}
                          >
                            <Copy size={13} />
                          </Button>
                          {item.session_available && (
                            <Button
                              onClick={(event) => {
                                event.stopPropagation();
                                openSession(item.source, item.session_id, item.file_path);
                              }}
                              onDoubleClick={(event) => event.stopPropagation()}
                              variant="ghost"
                              size="icon"
                              title={t("requestLogs.openSession")}
                              aria-label={t("requestLogs.openSession")}
                            >
                              <ExternalLink size={13} />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[11px] text-text-muted">
          <span>{t("requestLogs.pagination.total", { count: result?.total ?? 0 })}</span>
          <div className="flex items-center gap-2">
            <Button onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page <= 0} variant="ghost" size="icon" aria-label={t("requestLogs.pagination.previous")}>
              <ChevronLeft size={14} />
            </Button>
            <span>{t("requestLogs.pagination.page", { current: page + 1, total: pageCount })}</span>
            <Button onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} disabled={page + 1 >= pageCount} variant="ghost" size="icon" aria-label={t("requestLogs.pagination.next")}>
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </Card>

      <Dialog
        open={selectedError !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedError(null);
        }}
      >
        {selectedError && (
          <DialogContent className="flex max-h-[80vh] w-[min(680px,calc(100vw-2rem))] max-w-[680px] flex-col overflow-hidden p-0" showCloseButton={false}>
            <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
              <DialogTitle className="flex items-center gap-2 text-base text-text-primary">
                <CircleAlert size={16} className="text-danger" aria-hidden="true" />
                {t("requestLogs.error.dialogTitle")}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t("requestLogs.error.dialogDescription", { summary: selectedErrorSummary })}
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <section>
                <h3 className="text-xs font-semibold text-text-secondary">{t("requestLogs.error.summary")}</h3>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-text-primary">{selectedErrorSummary}</p>
              </section>
              <dl className="grid grid-cols-[minmax(92px,auto)_1fr] gap-x-3 gap-y-2 text-xs">
                <dt className="text-text-muted">{t("requestLogs.error.provider")}</dt>
                <dd className="min-w-0 break-words text-text-primary">{selectedError.provider_name ?? selectedError.provider_id ?? "—"}</dd>
                <dt className="text-text-muted">{t("requestLogs.error.httpStatus")}</dt>
                <dd className="text-text-primary">{selectedError.status_code ?? "—"}</dd>
                <dt className="text-text-muted">{t("requestLogs.error.code")}</dt>
                <dd className="min-w-0 break-all font-mono text-[11px] text-text-primary">{selectedError.error_code ?? "—"}</dd>
              </dl>
              <section>
                <h3 className="text-xs font-semibold text-text-secondary">{t("requestLogs.error.detail")}</h3>
                {selectedError.error_detail ? (
                  <pre className="mt-1 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-danger/25 bg-danger/5 p-3 font-mono text-[11px] leading-relaxed text-text-primary">{selectedError.error_detail}</pre>
                ) : (
                  <p className="mt-1 rounded-md border border-border bg-bg-tertiary/40 px-3 py-2 text-xs leading-relaxed text-text-muted">{t("requestLogs.error.noDetail")}</p>
                )}
              </section>
            </div>
            <DialogFooter className="shrink-0 border-t border-border bg-bg-secondary px-5 py-3">
              <DialogClose asChild>
                <Button variant="outline" size="sm">{t("common.close")}</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
