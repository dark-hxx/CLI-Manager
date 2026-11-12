import { memo, useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { HistoryStatsHourlyActivityItem } from "../../../shared/types/index";
import { useI18n, type AppLanguage } from "../../../shared/i18n/index";
import {
  RECHARTS_TOOLTIP_WRAPPER_STYLE,
  STATS_AXIS_TICK,
  STATS_BAR_CURSOR,
  STATS_COLORS,
  STATS_GRID_STROKE,
} from "../api/statsPalette";

interface StatsHourlyActivityChartProps {
  items: HistoryStatsHourlyActivityItem[];
}

function formatCount(value: number, language: AppLanguage): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(language).format(value);
}

function formatHour(hour: number): string {
  return `${hour.toString().padStart(2, "0")}:00`;
}

export const StatsHourlyActivityChart = memo(StatsHourlyActivityChartImpl);

function StatsHourlyActivityChartImpl({ items }: StatsHourlyActivityChartProps) {
  const { language, t } = useI18n();
  const normalized = useMemo(() => {
    const byHour = new Map<number, HistoryStatsHourlyActivityItem>();
    for (const item of items) byHour.set(item.hour, item);
    const full: Array<HistoryStatsHourlyActivityItem & { label: string }> = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const item = byHour.get(hour) ?? {
        hour,
        hour_start_utc: 0,
        sessions: 0,
        messages: 0,
        level: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost_usd: 0,
        unpriced_tokens: 0,
        session_refs: [],
      };
      full.push({ ...item, label: String(hour).padStart(2, "0") });
    }
    return full;
  }, [items]);

  const active = useMemo(
    () =>
      normalized.reduce<HistoryStatsHourlyActivityItem | null>((current, item) => {
        if (!current) return item;
        return item.messages > current.messages ? item : current;
      }, null),
    [normalized]
  );
  const hasData = normalized.some((item) => item.messages > 0 || item.sessions > 0);

  return (
    <section className="ui-stats-card flex h-full min-h-[340px] flex-col p-5">
      <header className="mb-4 flex items-start gap-3">
        <h3 className="text-[15px] font-semibold tracking-tight text-text-primary">{t("stats.hourly.title")}</h3>
        <span className="ui-stats-inset ml-auto truncate px-2.5 py-1 text-[11px] font-medium text-text-secondary">
          {active && active.messages > 0
            ? t("stats.summary.sessionsMessages", {
                bucket: formatHour(active.hour),
                sessions: formatCount(active.sessions, language),
                messages: formatCount(active.messages, language),
              })
            : t("stats.hourly.empty")}
        </span>
      </header>

      <div className="min-h-0 flex-1" aria-label={t("stats.hourly.chartAria")}>
        {!hasData ? (
          <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
            {t("stats.hourly.noData")}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={normalized} margin={{ top: 4, right: 0, bottom: 0, left: -12 }}>
              <CartesianGrid stroke={STATS_GRID_STROKE} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="label" tick={STATS_AXIS_TICK} tickLine={false} axisLine={false} interval={2} dy={6} />
              <YAxis tick={STATS_AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(value) => formatCompactAxis(Number(value), language)} allowDecimals={false} width={44} />
              <Tooltip
                cursor={STATS_BAR_CURSOR}
                wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                content={({ active: tooltipActive, payload }) => {
                  const item = payload?.[0]?.payload as HistoryStatsHourlyActivityItem | undefined;
                  if (!tooltipActive || !item) return null;
                  return (
                    <div className="ui-stats-tooltip">
                      <div className="mb-1.5 text-[12px] font-semibold text-text-primary">{formatHour(item.hour)}</div>
                      <div className="flex items-center justify-between gap-5 text-text-secondary">
                        <span className="inline-flex items-center gap-2">
                          <span className="ui-stats-legend-dot" style={{ backgroundColor: STATS_COLORS.accent }} />
                          {t("stats.hourly.legendMessages")}
                        </span>
                        <span className="font-semibold tabular-nums text-text-primary">{formatCount(item.messages, language)}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-text-muted">{t("stats.unit.sessions", { count: formatCount(item.sessions, language) })}</div>
                    </div>
                  );
                }}
              />
              <Bar dataKey="messages" name={t("stats.hourly.legendMessages")} radius={[4, 4, 4, 4]} maxBarSize={18}>
                {normalized.map((item) => (
                  <Cell
                    key={item.hour}
                    fill={active && item.hour === active.hour && item.messages > 0
                      ? STATS_COLORS.accent
                      : "color-mix(in srgb, var(--stats-blue) 42%, transparent)"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}

function formatCompactAxis(value: number, language: AppLanguage): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatCount(value, language);
}
