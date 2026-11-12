import { memo, useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import type { HistoryStatsHeatmapDay } from "../../../shared/types/index";
import { useI18n, type AppLanguage } from "../../../shared/i18n/index";
import {
  RECHARTS_TOOLTIP_WRAPPER_STYLE,
  STATS_AXIS_TICK,
  STATS_BAR_CURSOR,
  STATS_GRID_STROKE,
  statsHeatColor,
} from "../api/statsPalette";

interface TimelineHeatmapProps {
  days: HistoryStatsHeatmapDay[];
  selectedDayStart: number | null;
  onSelectDay: (day: HistoryStatsHeatmapDay) => void;
  granularity?: "day" | "hour";
}

interface HeatmapPoint {
  x: number;
  y: number;
  label: string;
  day: HistoryStatsHeatmapDay;
}

const BAR_MODE_MAX_DAYS = 14;

const SELECTED_STROKE = "var(--primary)";

function formatDay(dayStartUtc: number, language: AppLanguage): string {
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

function formatBucket(dayStartUtc: number, granularity: "day" | "hour", language: AppLanguage): string {
  return granularity === "hour" ? formatHour(dayStartUtc) : formatDay(dayStartUtc, language);
}

function formatCount(value: number, language: AppLanguage): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(language).format(value);
}

function cellColor(level: number): string {
  return statsHeatColor(level);
}

function HeatmapTooltip({ title, sessions, messages }: { title: string; sessions: string; messages: string }) {
  return (
    <div className="ui-stats-tooltip">
      <div className="mb-1 text-[12px] font-semibold text-text-primary">{title}</div>
      <div className="text-text-secondary">{sessions} · {messages}</div>
    </div>
  );
}

export const TimelineHeatmap = memo(TimelineHeatmapImpl);

function TimelineHeatmapImpl({
  days,
  selectedDayStart,
  onSelectDay,
  granularity = "day",
}: TimelineHeatmapProps) {
  const { language, t } = useI18n();
  const barMode = granularity === "day" && days.length > 0 && days.length <= BAR_MODE_MAX_DAYS;
  const activeDay = useMemo(
    () => days.find((day) => day.day_start_utc === selectedDayStart) ?? days.find((day) => day.messages > 0 || day.sessions > 0) ?? days[days.length - 1] ?? null,
    [days, selectedDayStart]
  );
  const chartData = useMemo(
    () =>
      days.map((day) => ({
        ...day,
        label: formatBucket(day.day_start_utc, granularity, language),
      })),
    [days, granularity, language]
  );
  const points = useMemo<HeatmapPoint[]>(() => {
    if (granularity === "hour") {
      return days.map((day, index) => ({
        x: index % 12,
        y: Math.floor(index / 12),
        label: formatBucket(day.day_start_utc, granularity, language),
        day,
      }));
    }
    if (days.length === 0) return [];
    const first = new Date(days[0].day_start_utc);
    const mondayBasedWeekday = (first.getDay() + 6) % 7;
    return days.map((day, index) => {
      const cellIndex = mondayBasedWeekday + index;
      return {
        x: Math.floor(cellIndex / 7),
        y: cellIndex % 7,
        label: formatBucket(day.day_start_utc, granularity, language),
        day,
      };
    });
  }, [days, granularity, language]);
  const xDomainMax = Math.max(1, ...points.map((point) => point.x));
  const yDomainMax = granularity === "hour" ? 1 : 6;

  if (days.length === 0) {
    return (
      <div className="py-8 text-center text-[11px] text-text-muted">
        {t("stats.heatmap.empty")}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center">
        <span className="ui-stats-inset truncate px-2.5 py-1 text-[11px] font-medium text-text-secondary">
          {activeDay
            ? t("stats.summary.sessionsMessages", {
                bucket: formatBucket(activeDay.day_start_utc, granularity, language),
                sessions: formatCount(activeDay.sessions, language),
                messages: formatCount(activeDay.messages, language),
              })
            : "-"}
        </span>
      </div>

      <div className="h-[230px]">
        {barMode ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={STATS_GRID_STROKE} strokeDasharray="3 4" horizontal={false} />
              <XAxis type="number" tick={STATS_AXIS_TICK} tickFormatter={(value) => formatCount(Number(value), language)} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="label" width={76} tick={STATS_AXIS_TICK} axisLine={false} tickLine={false} />
              <Tooltip
                cursor={STATS_BAR_CURSOR}
                wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                content={({ active, payload }) => {
                  const day = payload?.[0]?.payload as (HistoryStatsHeatmapDay & { label: string }) | undefined;
                  if (!active || !day) return null;
                  return (
                    <HeatmapTooltip
                      title={day.label}
                      sessions={t("stats.unit.sessions", { count: formatCount(day.sessions, language) })}
                      messages={t("stats.unit.messages", { count: formatCount(day.messages, language) })}
                    />
                  );
                }}
              />
              <Bar dataKey="messages" radius={[0, 5, 5, 0]} maxBarSize={14} cursor="pointer" onClick={(entry) => {
                const payload = (entry as { payload?: HistoryStatsHeatmapDay }).payload;
                if (payload) onSelectDay(payload);
              }}>
                {chartData.map((day) => (
                  <Cell
                    key={day.day_start_utc}
                    fill={cellColor(Math.max(day.level, day.messages > 0 ? 1 : 0))}
                    stroke={day.day_start_utc === selectedDayStart ? SELECTED_STROKE : "transparent"}
                    strokeWidth={1.5}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 12, right: 12, bottom: 12, left: 12 }}>
              <XAxis type="number" dataKey="x" domain={[-0.5, xDomainMax + 0.5]} hide />
              <YAxis type="number" dataKey="y" domain={[-0.5, yDomainMax + 0.5]} reversed hide />
              <ZAxis range={[140, 140]} />
              <Tooltip
                cursor={false}
                wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                content={({ active, payload }) => {
                  const point = payload?.[0]?.payload as HeatmapPoint | undefined;
                  if (!active || !point) return null;
                  return (
                    <HeatmapTooltip
                      title={point.label}
                      sessions={t("stats.unit.sessions", { count: formatCount(point.day.sessions, language) })}
                      messages={t("stats.unit.messages", { count: formatCount(point.day.messages, language) })}
                    />
                  );
                }}
              />
              <Scatter
                data={points}
                shape={(props) => {
                  const point = (props as { payload?: HeatmapPoint }).payload;
                  const cx = Number((props as { cx?: number }).cx);
                  const cy = Number((props as { cy?: number }).cy);
                  if (!point || !Number.isFinite(cx) || !Number.isFinite(cy)) return <g />;
                  const selected = point.day.day_start_utc === selectedDayStart;
                  return (
                    <rect
                      x={cx - 8}
                      y={cy - 8}
                      width={16}
                      height={16}
                      rx={4.5}
                      fill={cellColor(point.day.level)}
                      stroke={selected ? SELECTED_STROKE : "none"}
                      strokeWidth={selected ? 2 : 0}
                      style={{ cursor: "pointer" }}
                      onClick={() => onSelectDay(point.day)}
                    />
                  );
                }}
              />
            </ScatterChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 pt-3 text-[11px] text-text-muted">
        <span className="tabular-nums">{formatBucket(days[0]?.day_start_utc ?? 0, granularity, language)}</span>
        <div className="flex items-center gap-1">
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              key={level}
              className="inline-block h-[10px] w-[10px] rounded-[3px]"
              style={{ backgroundColor: cellColor(level) }}
              title={level === 0 ? t("stats.heatmap.noActivity") : t("stats.heatmap.level", { level })}
            />
          ))}
        </div>
        <span className="tabular-nums">{formatBucket(days[days.length - 1]?.day_start_utc ?? 0, granularity, language)}</span>
      </div>
      <div className="mt-1.5 text-[10px] text-text-muted">{t("stats.heatmap.hint")}</div>
    </div>
  );
}
