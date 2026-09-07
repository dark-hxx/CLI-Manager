import { memo, useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { HistoryStatsHourlyActivityItem } from "../../../shared/types/index";
import { useI18n, type AppLanguage } from "../../../shared/i18n/index";
import {
  HISTORY_SERIES_COLORS,
  RECHARTS_BAR_CURSOR,
  RECHARTS_TOOLTIP_ITEM_STYLE,
  RECHARTS_TOOLTIP_LABEL_STYLE,
  RECHARTS_TOOLTIP_WRAPPER_STYLE,
} from "../api/statsPalette";

interface StatsHourlyActivityChartProps {
  items: HistoryStatsHourlyActivityItem[];
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
    <div className="flex h-[320px] flex-col rounded-2xl border border-border/60 bg-bg-secondary p-4">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-xs font-semibold text-text-primary">{t("stats.hourly.title")}</div>
        <div className="ml-auto text-[11px] text-text-secondary">
          {active
            ? t("stats.summary.sessionsMessages", {
                bucket: formatHour(active.hour),
                sessions: formatCount(active.sessions, language),
                messages: formatCount(active.messages, language),
              })
            : t("stats.hourly.empty")}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {!hasData ? (
          <div className="py-8 text-center text-[11px] text-text-muted">
            {t("stats.hourly.noData")}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={normalized} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeOpacity={0.42} vertical={false} />
              <XAxis dataKey="label" tick={RECHARTS_AXIS_STYLE} tickLine={false} axisLine={{ stroke: "var(--border)" }} interval={2} />
              <YAxis tick={RECHARTS_AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={(value) => formatCompactAxis(Number(value), language)} allowDecimals={false} />
              <Tooltip
                cursor={RECHARTS_BAR_CURSOR}
                contentStyle={RECHARTS_TOOLTIP_STYLE}
                itemStyle={RECHARTS_TOOLTIP_ITEM_STYLE}
                labelStyle={RECHARTS_TOOLTIP_LABEL_STYLE}
                wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                labelFormatter={(label) => `${label}:00`}
                formatter={(value, name, payload) => {
                  const item = payload?.payload as HistoryStatsHourlyActivityItem | undefined;
                  if (String(name) === t("stats.hourly.legendMessages")) {
                    return [t("stats.unit.messages", { count: formatCount(Number(value), language) }), String(name)];
                  }
                  return [
                    item
                      ? t("stats.summary.sessionsMessages", {
                          bucket: formatHour(item.hour),
                          sessions: formatCount(item.sessions, language),
                          messages: formatCount(item.messages, language),
                        })
                      : String(value),
                    String(name),
                  ];
                }}
              />
              <Bar dataKey="messages" name={t("stats.hourly.legendMessages")} fill={HISTORY_SERIES_COLORS.input} radius={[5, 5, 0, 0]} maxBarSize={16} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function formatCompactAxis(value: number, language: AppLanguage): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatCount(value, language);
}
