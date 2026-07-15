import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight, Coins, Database, ExternalLink, FileText, Layers3, RefreshCw, RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import type { RequestLogFilters, RequestLogPage, RequestLogSyncResult } from "../../lib/types";
import { useSettingsStore } from "../../stores/settingsStore";
import { useI18n, type AppLanguage } from "../../lib/i18n";
import { StatsDatePicker } from "./StatsDatePicker";

const PAGE_SIZE = 20;

type RequestLogSourceFilter = "all" | "claude" | "codex";

interface RequestLogDraftFilters {
  source: RequestLogSourceFilter;
  project: string;
  model: string;
  session: string;
  startDate: string;
  endDate: string;
}

interface RequestLogsViewProps {
  onOpenSession: (sessionKey: string) => Promise<void>;
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
    model: "",
    session: "",
    startDate: toDateInput(start),
    endDate: toDateInput(end),
  };
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
    model: filters.model.trim() || null,
    session_query: filters.session.trim() || null,
    start_at: parseDate(filters.startDate, false),
    end_at: parseDate(filters.endDate, true),
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

export function RequestLogsView({ onOpenSession }: RequestLogsViewProps) {
  const { language, t } = useI18n();
  const claudeConfigDir = useSettingsStore((state) => state.claudeHookConfigDir);
  const codexConfigDir = useSettingsStore((state) => state.codexHookConfigDir);
  const [draft, setDraft] = useState<RequestLogDraftFilters>(() => defaultFilters());
  const [applied, setApplied] = useState<RequestLogDraftFilters>(() => defaultFilters());
  const [page, setPage] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const filters = useMemo(() => normalizeFilters(applied), [applied]);
  const draftFilters = useMemo(() => normalizeFilters(draft), [draft]);
  const invalidRange = hasInvalidDateRange(draftFilters);
  const invalidAppliedRange = hasInvalidDateRange(filters);

  const query = useQuery({
    queryKey: ["historyRequestLogs", filters, page, refreshNonce],
    queryFn: () =>
      invoke<RequestLogPage>("history_list_request_logs", {
        filters,
        page,
        pageSize: PAGE_SIZE,
      }),
    enabled: !invalidAppliedRange,
  });

  const result = query.data;
  const pageCount = Math.max(1, Math.ceil((result?.total ?? 0) / PAGE_SIZE));

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

  const syncAndRefresh = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    try {
      await invoke<RequestLogSyncResult>("history_sync_request_logs", {
        claudeConfigDir: claudeConfigDir?.trim() || null,
        codexConfigDir: codexConfigDir?.trim() || null,
        force: true,
      });
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
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-[120px_minmax(120px,1fr)_minmax(120px,1fr)_minmax(140px,1fr)_132px_auto_132px_auto_auto_auto]">
          <Select
            value={draft.source}
            onChange={(event) => setDraft((current) => ({ ...current, source: event.target.value as RequestLogSourceFilter }))}
            className={controlClass}
            aria-label={t("requestLogs.filter.source")}
          >
            <option value="all">{t("common.allSources")}</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </Select>
          <input
            value={draft.project}
            onChange={(event) => setDraft((current) => ({ ...current, project: event.target.value }))}
            className={controlClass}
            placeholder={t("requestLogs.filter.project")}
            aria-label={t("requestLogs.filter.project")}
          />
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
          <StatsDatePicker
            mode="date"
            value={draft.startDate}
            onChange={(value) => setDraft((current) => ({ ...current, startDate: value }))}
            className={controlClass}
            ariaLabel={t("requestLogs.filter.startDate")}
          />
          <span className="flex items-center justify-center text-[11px] text-text-muted">{t("common.to")}</span>
          <StatsDatePicker
            mode="date"
            value={draft.endDate}
            onChange={(value) => setDraft((current) => ({ ...current, endDate: value }))}
            className={controlClass}
            ariaLabel={t("requestLogs.filter.endDate")}
          />
          <Button onClick={applyFilters} disabled={invalidRange} size="sm">
            <Search size={13} />
            {t("requestLogs.query")}
          </Button>
          <Button onClick={resetFilters} variant="outline" size="sm">
            <RotateCcw size={13} />
            {t("requestLogs.reset")}
          </Button>
          <Button onClick={() => void syncAndRefresh()} disabled={syncing} size="sm">
            <RefreshCw size={13} className={syncing ? "animate-spin" : ""} />
            {syncing ? t("requestLogs.syncing") : t("requestLogs.refresh")}
          </Button>
        </div>
        {invalidRange && <div className="mt-2 text-[12px] text-danger" role="alert">{t("requestLogs.invalidRange")}</div>}
        {syncError && <div className="mt-2 text-[12px] text-danger" role="alert">{t("requestLogs.syncFailed", { error: syncError })}</div>}
      </Card>

      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        {[
          { icon: FileText, label: t("requestLogs.summary.records"), value: formatCount(result?.summary.total ?? 0, language) },
          { icon: Layers3, label: t("requestLogs.summary.tokens"), value: formatCompact(result?.summary.total_tokens ?? 0, language) },
          { icon: Coins, label: t("requestLogs.summary.cost"), value: formatCost(result?.summary.total_cost_usd ?? 0) },
          { icon: Database, label: t("requestLogs.summary.unpriced"), value: formatCompact(result?.summary.unpriced_tokens ?? 0, language) },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <Card key={item.label} className="border-border bg-bg-secondary p-3 text-center shadow-sm">
              <div className="flex items-center justify-center gap-2 text-[11px] font-medium text-text-muted"><Icon size={13} />{item.label}</div>
              <div className="mt-1 text-[20px] font-semibold tracking-tight text-text-primary">{item.value}</div>
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
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] border-collapse text-center text-[12px]">
              <thead className="bg-bg-tertiary text-[11px] font-semibold text-text-muted">
                <tr>
                  <th className="px-3 py-2.5">{t("requestLogs.column.time")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.source")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.model")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.projectSession")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.input")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.output")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.cost")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.status")}</th>
                  <th className="px-3 py-2.5">{t("requestLogs.column.action")}</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((item) => (
                  <tr key={item.request_id} className="border-t border-border/70 hover:bg-bg-tertiary/60">
                    <td className="whitespace-nowrap px-3 py-2.5 text-text-secondary">{formatDateTime(item.timestamp_ms, language)}</td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex rounded-full border border-border bg-bg-primary px-2 py-0.5 font-medium text-text-secondary">
                        {item.source === "codex" ? t("requestLogs.source.codex") : t("requestLogs.source.claude")}
                      </span>
                    </td>
                    <td className="max-w-[180px] truncate px-3 py-2.5 font-medium text-text-primary" title={item.model ?? undefined}>{item.model || "—"}</td>
                    <td className="max-w-[260px] px-3 py-2.5">
                      <div className="truncate font-medium text-text-primary" title={item.project_key}>{item.project_key || t("requestLogs.unknownProject")}</div>
                      <div className="mt-0.5 truncate text-[10px] text-text-muted" title={item.session_id}>{item.session_id}</div>
                    </td>
                    <td className="px-3 py-2.5 font-medium text-text-primary">
                      <div>{formatCompact(item.input_tokens, language)}</div>
                      {(item.cache_read_tokens > 0 || item.cache_creation_tokens > 0) && (
                        <div className="mt-0.5 text-[10px] font-normal text-text-muted">
                          {t("requestLogs.cacheDetail", {
                            read: formatCompact(item.cache_read_tokens, language),
                            write: formatCompact(item.cache_creation_tokens, language),
                          })}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-medium text-text-primary">{formatCompact(item.output_tokens, language)}</td>
                    <td className="px-3 py-2.5 font-medium text-text-primary">
                      {item.unpriced_tokens > 0 ? <span className="text-warning">{t("requestLogs.unpriced")}</span> : formatCost(item.total_cost_usd)}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">{t("requestLogs.status.recorded")}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      {item.session_available ? (
                        <Button
                          onClick={() => void onOpenSession(sessionKey(item.source, item.session_id, item.file_path))}
                          variant="ghost"
                          size="sm"
                          title={t("requestLogs.openSession")}
                        >
                          <ExternalLink size={12} />
                          {t("requestLogs.openSession")}
                        </Button>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
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
    </div>
  );
}
