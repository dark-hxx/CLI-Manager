import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
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
import { Button } from "../../../shared/ui/button";
import { Select } from "../../../shared/ui/select";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../shared/ui/dialog";
import type { RequestLogFilters, RequestLogItem, RequestLogPage, RequestLogSource } from "../../../shared/types/index";
import { syncHistoryRequestLogs } from "../../history/index";
import { useI18n, type AppLanguage, type TranslationKey } from "../../../shared/i18n/index";
import { getHistoryPathArgs } from "../../history/api/historyPathArgs";
import { VendorIcon } from "../../../shared/ui/VendorIcon";
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

  const controlClass = "ui-stats-control ui-focus-ring outline-none";
  const unpricedTokens = result?.summary.unpriced_tokens ?? 0;
  const summaryItems = [
    { icon: FileText, label: t("requestLogs.summary.records"), value: formatCount(result?.summary.total ?? 0, language), tint: "var(--stats-blue)" },
    { icon: Layers3, label: t("requestLogs.summary.tokens"), value: formatCompact(result?.summary.total_tokens ?? 0, language), tint: "var(--stats-teal)" },
    { icon: Database, label: t("requestLogs.summary.cacheHitRate"), value: formatRate(result?.summary.cache_hit_rate ?? 0), tint: "var(--stats-green)" },
    { icon: Coins, label: t("requestLogs.summary.cost"), value: formatCost(result?.summary.total_cost_usd ?? 0), tint: "var(--stats-pink)" },
    { icon: CircleAlert, label: t("requestLogs.summary.unpriced"), value: formatCompact(unpricedTokens, language), tint: unpricedTokens > 0 ? "var(--stats-orange)" : "var(--stats-muted)" },
  ];

  return (
    <div className="space-y-4">
      <section className="ui-stats-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full shrink-0 sm:w-[128px]">
            <Select
              value={draft.source}
              onChange={(event) => setDraft((current) => ({ ...current, source: event.target.value as RequestLogSourceFilter }))}
              className={`${controlClass} w-full`}
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
          <label className="ui-stats-control min-w-[220px] flex-[1_1_300px] text-text-secondary xl:max-w-[480px]">
            <Search size={13} className="shrink-0" />
            <input
              value={draft.project}
              onChange={(event) => setDraft((current) => ({ ...current, project: event.target.value, projectPath: "" }))}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyFilters();
              }}
              className="min-w-0 flex-1 bg-transparent text-text-primary outline-none placeholder:text-text-muted"
              placeholder={t("requestLogs.filter.project")}
              aria-label={t("requestLogs.filter.project")}
            />
          </label>
          <div className="flex w-full min-w-[280px] items-center gap-1.5 sm:w-auto sm:flex-[0_0_300px]">
            <StatsDatePicker
              mode="date"
              value={draft.startDate}
              onChange={(value) => setDraft((current) => ({ ...current, startDate: value }))}
              className={`${controlClass} min-w-0 flex-1`}
              ariaLabel={t("requestLogs.filter.startDate")}
            />
            <span className="shrink-0 text-[12px] text-text-muted">{t("common.to")}</span>
            <StatsDatePicker
              mode="date"
              value={draft.endDate}
              onChange={(value) => setDraft((current) => ({ ...current, endDate: value }))}
              className={`${controlClass} min-w-0 flex-1`}
              ariaLabel={t("requestLogs.filter.endDate")}
            />
          </div>
          <div className="ui-stats-segmented shrink-0" role="group" aria-label={t("requestLogs.datePreset.label")}>
            {(["today", "last7Days", "last30Days"] as RequestLogDatePreset[]).map((preset) => {
              const selected = matchesDatePreset(draft, preset);
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => selectDatePreset(preset)}
                  className="ui-stats-segment ui-focus-ring"
                  data-selected={selected ? "true" : "false"}
                  aria-pressed={selected}
                >
                  {t(`requestLogs.datePreset.${preset}`)}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((current) => !current)}
            className={`${controlClass} shrink-0 text-text-secondary`}
            aria-expanded={advancedOpen}
          >
            <SlidersHorizontal size={13} />
            {advancedOpen ? t("requestLogs.filter.hideAdvanced") : t("requestLogs.filter.showAdvanced")}
            {advancedFilterCount > 0 && (
              <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-on-primary">
                {advancedFilterCount}
              </span>
            )}
            <ChevronDown size={12} className={`transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
          </button>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={resetFilters}
              className={`${controlClass} text-text-secondary`}
              title={t("requestLogs.reset")}
            >
              <RotateCcw size={13} />
              {t("requestLogs.reset")}
            </button>
            <button
              type="button"
              onClick={() => void syncAndRefresh()}
              disabled={syncing}
              className={`${controlClass} text-text-secondary disabled:cursor-not-allowed disabled:opacity-45`}
            >
              <RefreshCw size={13} className={syncing ? "animate-spin" : ""} />
              {syncing ? t("requestLogs.syncing") : t("requestLogs.refresh")}
            </button>
            <Button onClick={applyFilters} disabled={invalidRange} variant="default" size="sm" className="h-[30px] rounded-lg px-4">
              <Search size={13} />
              {t("requestLogs.query")}
            </Button>
          </div>
        </div>
        {advancedOpen && (
          <div className="mt-3 grid grid-cols-1 gap-2 border-t border-[color:var(--stats-divider)] pt-3 md:grid-cols-2">
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
      </section>

      <section className="ui-stats-card grid grid-cols-2 gap-y-4 px-5 py-4 sm:grid-cols-3 xl:grid-cols-5">
        {summaryItems.map((item, index) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className={`min-w-0 px-4 ${index === 0 ? "pl-0" : ""} xl:border-l xl:border-[color:var(--stats-divider)] xl:first:border-l-0`}
            >
              <div className="inline-flex max-w-full items-center gap-1.5 text-[12px] font-semibold" style={{ color: item.tint }}>
                <Icon size={13} strokeWidth={2.2} />
                <span className="truncate">{item.label}</span>
              </div>
              <div className="ui-stats-value mt-1.5 truncate text-[22px] leading-tight">{item.value}</div>
            </div>
          );
        })}
      </section>

      <section className="ui-stats-card overflow-hidden">
        {query.isPending && <div className="p-8 text-center text-[12px] text-text-muted" role="status">{t("requestLogs.loading")}</div>}
        {query.error && <div className="p-5 text-[12px] text-danger" role="alert">{t("requestLogs.loadFailed", { error: String(query.error) })}</div>}
        {!query.isPending && !query.error && result?.data.length === 0 && (
          <div className="p-10 text-center text-[12px] text-text-muted">{t("requestLogs.empty")}</div>
        )}
        {result && result.data.length > 0 && (
          <div className="ui-thin-scroll max-h-[calc(100vh-300px)] overflow-auto">
            <table className="ui-stats-table min-w-[1120px]">
              <thead>
                <tr>
                  <th>{t("requestLogs.column.time")}</th>
                  <th>{t("requestLogs.column.source")}</th>
                  <th>{t("requestLogs.column.model")}</th>
                  <th>{t("requestLogs.column.projectSession")}</th>
                  <th className="is-num">{t("requestLogs.column.input")}</th>
                  <th className="is-num">{t("requestLogs.column.output")}</th>
                  <th className="is-num">{t("requestLogs.column.cost")}</th>
                  <th>{t("requestLogs.column.status")}</th>
                  <th className="is-sticky-end text-center">{t("requestLogs.column.action")}</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((item) => {
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
                      onDoubleClick={() => {
                        if (item.session_available) openSession(item.source, item.session_id, item.file_path);
                      }}
                      title={item.session_available ? t("requestLogs.rowOpenHint") : undefined}
                    >
                      <td className="whitespace-nowrap text-[11px] tabular-nums text-text-secondary">
                        {formatDateTime(item.timestamp_ms, language)}
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            applyQuickFilter({ source: item.source });
                          }}
                          onDoubleClick={(event) => event.stopPropagation()}
                          className="ui-stats-chip ui-focus-ring cursor-pointer"
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
                      <td className="max-w-[200px]">
                        {item.model ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              applyQuickFilter({ model: item.model ?? "" });
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}
                            className="ui-stats-link ui-focus-ring block max-w-full cursor-pointer truncate text-left font-medium text-text-primary"
                            title={t("requestLogs.applyQuickFilter", { value: item.model })}
                          >
                            {item.outbound_model && item.requested_model && item.outbound_model !== item.requested_model
                              ? `${item.requested_model} → ${item.outbound_model}`
                              : item.model}
                          </button>
                        ) : <span className="text-text-muted">—</span>}
                      </td>
                      <td className="max-w-[280px]">
                        {item.project_key ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              applyQuickFilter({ project: item.project_key });
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}
                            className="ui-stats-link ui-focus-ring block max-w-full cursor-pointer truncate text-left font-medium text-text-primary"
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
                        className={`is-num font-medium ${tokenOutlier ? "is-outlier" : "text-text-primary"}`}
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
                        className={`is-num font-medium ${tokenOutlier ? "is-outlier" : "text-text-primary"}`}
                        title={tokenOutlier ? t("requestLogs.tokenOutlier") : undefined}
                      >
                        {formatCompact(item.output_tokens, language)}
                      </td>
                      <td
                        className={`is-num font-medium ${costOutlier || item.unpriced_tokens > 0 ? "is-outlier" : "text-text-primary"}`}
                        title={costOutlier ? t("requestLogs.costOutlier") : undefined}
                      >
                        <div>{formatCost(item.total_cost_usd)}</div>
                        {item.unpriced_tokens > 0 && (
                          <div className="mt-0.5 whitespace-nowrap text-[10px] font-normal">
                            {t("requestLogs.unpricedWithTokens", { count: formatCompact(item.unpriced_tokens, language) })}
                          </div>
                        )}
                      </td>
                      <td className="text-text-secondary">
                        {hasRouteError && errorSummary ? (
                          <div className="flex min-w-[180px] flex-col items-start gap-1">
                            <span className="inline-flex max-w-full items-center gap-1.5" style={{ color: "var(--stats-red)" }} title={errorSummary}>
                              <span className="ui-stats-legend-dot" style={{ backgroundColor: "var(--stats-red)" }} aria-hidden="true" />
                              <span className="truncate">{errorSummary}</span>
                            </span>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedError(item);
                              }}
                              onDoubleClick={(event) => event.stopPropagation()}
                              className="ui-focus-ring -ml-1 inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
                              title={t("requestLogs.error.viewDetails")}
                              aria-label={t("requestLogs.error.viewDetails")}
                            >
                              <CircleAlert size={12} aria-hidden="true" />
                              {t("requestLogs.error.viewDetails")}
                            </button>
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            <span
                              className="ui-stats-legend-dot"
                              style={{ backgroundColor: item.usage_status === "complete" ? "var(--stats-green)" : "var(--stats-orange)" }}
                              aria-hidden="true"
                            />
                            {item.usage_status === "complete"
                              ? t(item.data_source === "route" ? "requestLogs.dataSource.route" : "requestLogs.status.recorded")
                              : t(`requestLogs.usageStatus.${item.usage_status ?? "missing"}`)}
                          </span>
                        )}
                        {item.degraded && <div className="mt-1 text-[10px]" style={{ color: "var(--stats-orange)" }}>{t("requestLogs.status.degraded", { count: item.attempt_count ?? 1 })}</div>}
                      </td>
                      <td className="is-sticky-end text-center">
                        <div className="flex items-center justify-center gap-0.5">
                          <Button
                            onClick={(event) => {
                              event.stopPropagation();
                              void copySessionId(item.session_id);
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}
                            variant="ghost"
                            size="icon"
                            className="rounded-lg text-text-muted hover:text-text-primary"
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
                              className="rounded-lg text-text-muted hover:text-primary"
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
        <div className="flex items-center justify-between border-t border-[color:var(--stats-divider)] px-4 py-2.5 text-[12px] text-text-muted">
          <span>{t("requestLogs.pagination.total", { count: result?.total ?? 0 })}</span>
          <div className="flex items-center gap-1">
            <Button onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page <= 0} variant="ghost" size="icon" className="rounded-lg" aria-label={t("requestLogs.pagination.previous")}>
              <ChevronLeft size={14} />
            </Button>
            <span className="min-w-[88px] text-center tabular-nums">{t("requestLogs.pagination.page", { current: page + 1, total: pageCount })}</span>
            <Button onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} disabled={page + 1 >= pageCount} variant="ghost" size="icon" className="rounded-lg" aria-label={t("requestLogs.pagination.next")}>
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </section>

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
