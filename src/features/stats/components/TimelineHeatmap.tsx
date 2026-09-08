import { memo, useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import type { HistoryStatsHeatmapDay } from "../../../shared/types/index";
import { useI18n, type AppLanguage } from "../../../shared/i18n/index";
import {
  ACCENT,
  HISTORY_HEATMAP_COLORS,
  RECHARTS_BAR_CURSOR,
  RECHARTS_TOOLTIP_ITEM_STYLE,
  RECHARTS_TOOLTIP_LABEL_STYLE,
  RECHARTS_TOOLTIP_WRAPPER_STYLE,
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
  if (level <= 0) return HISTORY_HEATMAP_COLORS.empty;
  if (level === 1) return HISTORY_HEATMAP_COLORS.level1;
  if (level === 2) return HISTORY_HEATMAP_COLORS.level2;
  if (level === 3) return HISTORY_HEATMAP_COLORS.level3;
  return HISTORY_HEATMAP_COLORS.level4;
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
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
        <div className="text-[11px] text-text-secondary">
          {activeDay
            ? t("stats.summary.sessionsMessages", {
                bucket: formatBucket(activeDay.day_start_utc, granularity, language),
                sessions: formatCount(activeDay.sessions, language),
                messages: formatCount(activeDay.messages, language),
              })
            : "-"}
        </div>
      </div>

      <div className="h-[240px] rounded border border-border bg-bg-primary p-2">
        {barMode ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical" margin={{ top: 6, right: 20, bottom: 6, left: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeOpacity={0.42} horizontal={false} />
              <XAxis type="number" tick={RECHARTS_AXIS_STYLE} tickFormatter={(value) => formatCount(Number(value), language)} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="label" width={72} tick={RECHARTS_AXIS_STYLE} axisLine={false} tickLine={false} />
              <Tooltip
                cursor={RECHARTS_BAR_CURSOR}
                contentStyle={RECHARTS_TOOLTIP_STYLE}
                itemStyle={RECHARTS_TOOLTIP_ITEM_STYLE}
                labelStyle={RECHARTS_TOOLTIP_LABEL_STYLE}
                wrapperStyle={RECHARTS_TOOLTIP_WRAPPER_STYLE}
                formatter={(value) => [t("stats.unit.messages", { count: formatCount(Number(value), language) }), t("stats.hourly.legendMessages")]}
                labelFormatter={(label) => String(label)}
              />
              <Bar dataKey="messages" radius={[0, 6, 6, 0]} cursor="pointer" onClick={(entry) => {
                const payload = (entry as { payload?: HistoryStatsHeatmapDay }).payload;
                if (payload) onSelectDay(payload);
              }}>
                {chartData.map((day) => (
                  <Cell
                    key={day.day_start_utc}
                    fill={cellColor(Math.max(day.level, day.messages > 0 ? 1 : 0))}
                    stroke={day.day_start_utc === selectedDayStart ? ACCENT : "transparent"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 18, right: 18, bottom: 18, left: 18 }}>
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
                    <div style={{ ...RECHARTS_TOOLTIP_STYLE, padding: "8px 10px" }}>
                      <div style={RECHARTS_TOOLTIP_ITEM_STYLE}>
                        {t("stats.summary.sessionsMessages", {
                          bucket: point.label,
                          sessions: formatCount(point.day.sessions, language),
                          messages: formatCount(point.day.messages, language),
                        })}
                      </div>
                    </div>
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
                      rx={4}
                      fill={cellColor(point.day.level)}
                      stroke={selected ? ACCENT : "var(--border)"}
                      strokeOpacity={selected ? 1 : 0.28}
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

      <div className="mt-2 flex items-center justify-between">
        <div className="text-[10px] text-text-muted">
          {t("stats.heatmap.hint")}
        </div>
        <div className="flex items-center gap-1">
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              key={level}
              className="inline-block h-[10px] w-[10px] rounded-[2px]"
              style={{ backgroundColor: cellColor(level) }}
              title={level === 0 ? t("stats.heatmap.noActivity") : t("stats.heatmap.level", { level })}
            />
          ))}
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-text-muted">
        <span>{formatBucket(days[0]?.day_start_utc ?? 0, granularity, language)}</span>
        <span>{formatBucket(days[days.length - 1]?.day_start_utc ?? 0, granularity, language)}</span>
      </div>
    </div>
  );
}
