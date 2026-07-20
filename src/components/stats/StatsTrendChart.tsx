import { memo, useMemo, useState } from "react";
import { convertChineseForLanguage, getLanguageLocale, useI18n, type AppLanguage } from "../../lib/i18n";
import type { HistoryStatsHeatmapDay } from "../../lib/types";

type TrendMetric = "sessions" | "messages";
type PointKey = "sessionsY" | "messagesY";

interface StatsTrendChartProps {
  days: HistoryStatsHeatmapDay[];
  selectedDayStart: number | null;
  onSelectDay: (day: HistoryStatsHeatmapDay) => void;
}

interface ChartPoint {
  day: HistoryStatsHeatmapDay;
  index: number;
  x: number;
  sessionsY: number;
  messagesY: number;
}

function formatCount(value: number, language: AppLanguage): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(getLanguageLocale(language)).format(value);
}

function formatDayLabel(dayStartUtc: number, language: AppLanguage): string {
  if (!Number.isFinite(dayStartUtc) || dayStartUtc <= 0) return "-";
  return new Intl.DateTimeFormat(getLanguageLocale(language), {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(new Date(dayStartUtc));
}

function linePath(points: ChartPoint[], key: PointKey): string {
  if (points.length === 0) return "";
  return points
    .map((point, idx) => `${idx === 0 ? "M" : "L"} ${point.x} ${point[key]}`)
    .join(" ");
}

function areaPath(points: ChartPoint[], baselineY: number, key: PointKey): string {
  if (points.length === 0) return "";
  const start = `M ${points[0].x} ${baselineY}`;
  const middle = points.map((point) => `L ${point.x} ${point[key]}`).join(" ");
  const end = `L ${points[points.length - 1].x} ${baselineY} Z`;
  return `${start} ${middle} ${end}`;
}

export const StatsTrendChart = memo(StatsTrendChartImpl);

function StatsTrendChartImpl({ days, selectedDayStart, onSelectDay }: StatsTrendChartProps) {
  const { language } = useI18n();
  const [hoverDayStart, setHoverDayStart] = useState<number | null>(null);
  const [visible, setVisible] = useState({ sessions: true, messages: true });
  const zh = (text: string) => convertChineseForLanguage(language, text);
  const chartHeight = 228;
  const paddingX = 18;
  const paddingTop = 14;
  const paddingBottom = 22;
  const innerHeight = chartHeight - paddingTop - paddingBottom;
  const pointGap = 22;

  const chart = useMemo(() => {
    const maxSessions = Math.max(1, ...days.map((day) => day.sessions));
    const maxMessages = Math.max(1, ...days.map((day) => day.messages));
    const maxValue = Math.max(
      1,
      visible.sessions ? maxSessions : 0,
      visible.messages ? maxMessages : 0
    );
    const width = Math.max(340, paddingX * 2 + Math.max(0, days.length - 1) * pointGap);
    const points: ChartPoint[] = days.map((day, index) => {
      const x = paddingX + index * pointGap;
      const sessionsY = paddingTop + innerHeight - (day.sessions / maxValue) * innerHeight;
      const messagesY = paddingTop + innerHeight - (day.messages / maxValue) * innerHeight;
      return {
        day,
        index,
        x,
        sessionsY,
        messagesY,
      };
    });
    return {
      width,
      maxValue,
      points,
      sessionsLine: linePath(points, "sessionsY"),
      messagesLine: linePath(points, "messagesY"),
      sessionsArea: areaPath(points, paddingTop + innerHeight, "sessionsY"),
    };
  }, [days, innerHeight, paddingTop, paddingX, pointGap, visible.messages, visible.sessions]);

  const activeDay = useMemo(() => {
    const activeKey = hoverDayStart ?? selectedDayStart;
    if (activeKey !== null) {
      const found = days.find((day) => day.day_start_utc === activeKey);
      if (found) return found;
    }
    return days[days.length - 1] ?? null;
  }, [days, hoverDayStart, selectedDayStart]);

  const toggleMetric = (metric: TrendMetric) => {
    setVisible((prev) => {
      const next = { ...prev, [metric]: !prev[metric] };
      if (!next.sessions && !next.messages) {
        return prev;
      }
      return next;
    });
  };

  if (days.length === 0) {
    return (
      <div className="rounded-md border border-border bg-bg-secondary p-3">
        <div className="mb-2 text-xs font-semibold text-text-primary">{zh("日趋势（会话 / 消息）")}</div>
        <div className="py-9 text-center text-[11px] text-text-muted">
          {zh("当前过滤条件下暂无趋势数据")}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-bg-secondary p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="text-xs font-semibold text-text-primary">{zh("日趋势（C1/C2）")}</div>
        <button
          type="button"
          className="ui-btn px-2 py-0.5 text-[11px]"
          style={{
            borderColor: visible.sessions ? "var(--accent)" : "var(--border)",
            color: visible.sessions ? "var(--text-primary)" : "var(--text-secondary)",
          }}
          onClick={() => toggleMetric("sessions")}
        >
          {zh("会话")}
        </button>
        <button
          type="button"
          className="ui-btn px-2 py-0.5 text-[11px]"
          style={{
            borderColor: visible.messages ? "#4F8DFF" : "var(--border)",
            color: visible.messages ? "var(--text-primary)" : "var(--text-secondary)",
          }}
          onClick={() => toggleMetric("messages")}
        >
          {zh("消息")}
        </button>
        <div className="ml-auto text-[11px] text-text-secondary">
          {activeDay ? `${formatDayLabel(activeDay.day_start_utc, language)} · ${formatCount(activeDay.sessions, language)} ${zh("会话")} · ${formatCount(activeDay.messages, language)} ${zh("消息")}` : "-"}
        </div>
      </div>

      <div
        className="overflow-x-auto rounded border border-border"
        style={{ backgroundColor: "var(--bg-primary)" }}
        onMouseLeave={() => setHoverDayStart(null)}
      >
        <svg
          width={chart.width}
          height={chartHeight}
          viewBox={`0 0 ${chart.width} ${chartHeight}`}
          className="block"
          aria-label={zh("日会话与消息趋势图")}
          role="img"
        >
          {[0, 1, 2, 3].map((step) => {
            const y = paddingTop + (innerHeight * step) / 3;
            const value = Math.round(((3 - step) * chart.maxValue) / 3);
            return (
              <g key={step}>
                <line
                  x1={paddingX}
                  x2={chart.width - paddingX}
                  y1={y}
                  y2={y}
                  stroke="var(--border)"
                  strokeOpacity="0.45"
                  strokeWidth="1"
                />
                <text x={paddingX + 2} y={y - 2} fill="var(--text-muted)" fontSize="10">
                  {formatCount(value, language)}
                </text>
              </g>
            );
          })}

          {visible.sessions && chart.sessionsArea && (
            <path d={chart.sessionsArea} fill="var(--accent)" fillOpacity="0.18" />
          )}

          {visible.sessions && chart.sessionsLine && (
            <path
              d={chart.sessionsLine}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {visible.messages && chart.messagesLine && (
            <path
              d={chart.messagesLine}
              fill="none"
              stroke="#4F8DFF"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {chart.points.map((point) => {
            const selected = point.day.day_start_utc === selectedDayStart;
            return (
              <g key={point.day.day_start_utc}>
                <title>
                  {`${formatDayLabel(point.day.day_start_utc, language)} · ${formatCount(point.day.sessions, language)} ${zh("会话")} · ${formatCount(point.day.messages, language)} ${zh("消息")}`}
                </title>
                {visible.sessions && (
                  <circle
                    cx={point.x}
                    cy={point.sessionsY}
                    r={selected ? 3.4 : 2.4}
                    fill="var(--accent)"
                    stroke="var(--bg-primary)"
                    strokeWidth="1"
                  />
                )}
                {visible.messages && (
                  <circle
                    cx={point.x}
                    cy={point.messagesY}
                    r={selected ? 3.4 : 2.4}
                    fill="#4F8DFF"
                    stroke="var(--bg-primary)"
                    strokeWidth="1"
                  />
                )}
                <rect
                  x={point.x - Math.max(12, pointGap / 2)}
                  y={paddingTop}
                  width={Math.max(16, pointGap)}
                  height={innerHeight}
                  fill="transparent"
                  role="button"
                  tabIndex={0}
                  style={{ cursor: "pointer" }}
                  aria-label={`${formatDayLabel(point.day.day_start_utc, language)}，${formatCount(point.day.sessions, language)} ${zh("会话")}，${formatCount(point.day.messages, language)} ${zh("消息")}`}
                  data-day-index={point.index}
                  onMouseEnter={() => setHoverDayStart(point.day.day_start_utc)}
                  onFocus={() => setHoverDayStart(point.day.day_start_utc)}
                  onBlur={() => setHoverDayStart(null)}
                  onClick={() => onSelectDay(point.day)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectDay(point.day);
                      return;
                    }
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    const nextIndex =
                      event.key === "ArrowRight"
                        ? Math.min(chart.points.length - 1, point.index + 1)
                        : Math.max(0, point.index - 1);
                    const root = event.currentTarget.ownerSVGElement;
                    if (!root) return;
                    const next = root.querySelector<SVGRectElement>(`rect[data-day-index='${nextIndex}']`);
                    next?.focus();
                  }}
                />
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-1.5 flex items-center justify-between text-[10px] text-text-muted">
        <span>{formatDayLabel(days[0]?.day_start_utc ?? 0, language)}</span>
        <span>{formatDayLabel(days[days.length - 1]?.day_start_utc ?? 0, language)}</span>
      </div>
      <div className="mt-1 text-[10px] text-text-muted">
        鼠标悬停查看详情，点击或回车下钻到当天会话
      </div>
    </div>
  );
}
