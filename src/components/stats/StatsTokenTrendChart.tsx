import { memo, useMemo, useState } from "react";
import { convertChineseForLanguage, getLanguageLocale, useI18n, type AppLanguage } from "../../lib/i18n";
import type { HistoryStatsDailySeriesItem } from "../../lib/types";

interface StatsTokenTrendChartProps {
  items: HistoryStatsDailySeriesItem[];
}

interface TrendPoint {
  item: HistoryStatsDailySeriesItem;
  index: number;
  x: number;
  inputY: number;
  outputY: number;
}

function formatCount(value: number, language: AppLanguage): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(getLanguageLocale(language)).format(value);
}

function formatDay(dayStartUtc: number, language: AppLanguage): string {
  if (!Number.isFinite(dayStartUtc) || dayStartUtc <= 0) return "-";
  return new Intl.DateTimeFormat(getLanguageLocale(language), {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(new Date(dayStartUtc));
}

function linePath(points: TrendPoint[], key: "inputY" | "outputY"): string {
  if (points.length === 0) return "";
  return points
    .map((point, idx) => `${idx === 0 ? "M" : "L"} ${point.x} ${point[key]}`)
    .join(" ");
}

export const StatsTokenTrendChart = memo(StatsTokenTrendChartImpl);

function StatsTokenTrendChartImpl({ items }: StatsTokenTrendChartProps) {
  const { language } = useI18n();
  const [hoverDayStart, setHoverDayStart] = useState<number | null>(null);
  const zh = (text: string) => convertChineseForLanguage(language, text);
  const chartHeight = 220;
  const paddingX = 18;
  const paddingTop = 14;
  const paddingBottom = 22;
  const innerHeight = chartHeight - paddingTop - paddingBottom;
  const pointGap = 18;

  const chart = useMemo(() => {
    const maxValue = Math.max(
      1,
      ...items.map((item) => Math.max(item.input_tokens, item.output_tokens))
    );
    const width = Math.max(340, paddingX * 2 + Math.max(0, items.length - 1) * pointGap);
    const points: TrendPoint[] = items.map((item, index) => ({
      item,
      index,
      x: paddingX + index * pointGap,
      inputY: paddingTop + innerHeight - (item.input_tokens / maxValue) * innerHeight,
      outputY: paddingTop + innerHeight - (item.output_tokens / maxValue) * innerHeight,
    }));
    return {
      width,
      maxValue,
      points,
      inputPath: linePath(points, "inputY"),
      outputPath: linePath(points, "outputY"),
    };
  }, [innerHeight, items]);

  const active = useMemo(() => {
    if (hoverDayStart !== null) {
      const found = items.find((item) => item.day_start_utc === hoverDayStart);
      if (found) return found;
    }
    return items[items.length - 1] ?? null;
  }, [hoverDayStart, items]);

  return (
    <div className="rounded-md border border-border bg-bg-secondary p-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-xs font-semibold text-text-primary">{zh("Token 日趋势（C7）")}</div>
        <div className="ml-auto text-[11px] text-text-secondary">
          {active
            ? `${formatDay(active.day_start_utc, language)} · ${zh("输入")} ${formatCount(active.input_tokens, language)} · ${zh("输出")} ${formatCount(active.output_tokens, language)}`
            : zh("暂无数据")}
        </div>
      </div>

      {items.length === 0 && (
        <div className="py-8 text-center text-[11px] text-text-muted">
          {zh("当前过滤条件下没有 Token 趋势数据")}
        </div>
      )}

      {items.length > 0 && (
        <>
          <div
            className="overflow-x-auto rounded border border-border bg-bg-primary"
            onMouseLeave={() => setHoverDayStart(null)}
          >
            <svg
              width={chart.width}
              height={chartHeight}
              viewBox={`0 0 ${chart.width} ${chartHeight}`}
              role="img"
              aria-label={zh("按天输入输出 Token 双折线图")}
              className="block"
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

              {chart.inputPath && (
                <path
                  d={chart.inputPath}
                  fill="none"
                  stroke="#2F8F62"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              {chart.outputPath && (
                <path
                  d={chart.outputPath}
                  fill="none"
                  stroke="#C46A2D"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {chart.points.map((point) => (
                <g key={point.item.day_start_utc}>
                  <circle
                    cx={point.x}
                    cy={point.inputY}
                    r={2.3}
                    fill="#2F8F62"
                    stroke="var(--bg-primary)"
                    strokeWidth="1"
                  />
                  <circle
                    cx={point.x}
                    cy={point.outputY}
                    r={2.3}
                    fill="#C46A2D"
                    stroke="var(--bg-primary)"
                    strokeWidth="1"
                  />
                  <rect
                    x={point.x - Math.max(10, pointGap / 2)}
                    y={paddingTop}
                    width={Math.max(14, pointGap)}
                    height={innerHeight}
                    fill="transparent"
                    onMouseEnter={() => setHoverDayStart(point.item.day_start_utc)}
                    onFocus={() => setHoverDayStart(point.item.day_start_utc)}
                    onBlur={() => setHoverDayStart(null)}
                    tabIndex={0}
                    aria-label={`${formatDay(point.item.day_start_utc, language)}，${zh("输入")} ${point.item.input_tokens}，${zh("输出")} ${point.item.output_tokens}`}
                    data-token-day-index={point.index}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                      event.preventDefault();
                      const nextIndex =
                        event.key === "ArrowRight"
                          ? Math.min(chart.points.length - 1, point.index + 1)
                          : Math.max(0, point.index - 1);
                      const root = event.currentTarget.ownerSVGElement;
                      const next = root?.querySelector<SVGRectElement>(
                        `rect[data-token-day-index='${nextIndex}']`
                      );
                      next?.focus();
                    }}
                  />
                </g>
              ))}
            </svg>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[10px] text-text-muted">
            <span>{formatDay(items[0]?.day_start_utc ?? 0, language)}</span>
            <span>{formatDay(items[items.length - 1]?.day_start_utc ?? 0, language)}</span>
          </div>
          <div className="mt-1 flex items-center gap-3 text-[10px] text-text-muted">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "#2F8F62" }} />
              {zh("输入 Token")}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "#C46A2D" }} />
              {zh("输出 Token")}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
