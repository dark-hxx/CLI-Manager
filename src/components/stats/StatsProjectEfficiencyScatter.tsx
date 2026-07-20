import { useMemo, useState } from "react";
import { convertChineseForLanguage, getLanguageLocale, useI18n } from "../../lib/i18n";
import type { HistoryStatsProjectEfficiencyItem } from "../../lib/types";

interface StatsProjectEfficiencyScatterProps {
  items: HistoryStatsProjectEfficiencyItem[];
}

function formatCount(value: number, language: "zh-CN" | "zh-TW" | "en-US"): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(getLanguageLocale(language)).format(value);
}

function formatFloat(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(2);
}

export function StatsProjectEfficiencyScatter({ items }: StatsProjectEfficiencyScatterProps) {
  const { language } = useI18n();
  const [activeProjectKey, setActiveProjectKey] = useState<string | null>(null);
  const data = useMemo(() => items.slice(0, 30), [items]);
  const zh = (text: string) => convertChineseForLanguage(language, text);

  const chart = useMemo(() => {
    const width = 460;
    const height = 250;
    const paddingLeft = 38;
    const paddingRight = 16;
    const paddingTop = 16;
    const paddingBottom = 28;
    const innerWidth = width - paddingLeft - paddingRight;
    const innerHeight = height - paddingTop - paddingBottom;
    const maxSessions = Math.max(1, ...data.map((item) => item.sessions));
    const maxAvg = Math.max(1, ...data.map((item) => item.avg_messages_per_session));
    const maxTokens = Math.max(1, ...data.map((item) => item.input_tokens + item.output_tokens));
    const points = data.map((item) => {
      const x = paddingLeft + (item.sessions / maxSessions) * innerWidth;
      const y = paddingTop + innerHeight - (item.avg_messages_per_session / maxAvg) * innerHeight;
      const r = 4 + ((item.input_tokens + item.output_tokens) / maxTokens) * 8;
      return { item, x, y, r };
    });
    return {
      width,
      height,
      paddingLeft,
      paddingTop,
      innerWidth,
      innerHeight,
      maxSessions,
      maxAvg,
      points,
    };
  }, [data]);

  const active = useMemo(() => {
    if (activeProjectKey) {
      const found = data.find((item) => item.project_key === activeProjectKey);
      if (found) return found;
    }
    return data[0] ?? null;
  }, [activeProjectKey, data]);

  return (
    <div className="rounded-md border border-border bg-bg-secondary p-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-xs font-semibold text-text-primary">{zh("项目效率散点（C9）")}</div>
        <div className="ml-auto text-[11px] text-text-secondary">
          {active
            ? `${active.project_key} · ${formatCount(active.sessions, language)} ${zh("会话")} · ${zh("均值")} ${formatFloat(active.avg_messages_per_session)}`
            : zh("暂无效率数据")}
        </div>
      </div>

      {data.length === 0 && (
        <div className="py-8 text-center text-[11px] text-text-muted">
          {zh("当前过滤条件下没有项目效率数据")}
        </div>
      )}

      {data.length > 0 && (
        <>
          <div className="overflow-x-auto rounded border border-border bg-bg-primary">
            <svg
              width={chart.width}
              height={chart.height}
              viewBox={`0 0 ${chart.width} ${chart.height}`}
              role="img"
              aria-label={zh("项目效率散点图，X 轴会话数，Y 轴平均每会话消息数")}
            >
              {[0, 1, 2, 3].map((step) => {
                const y = chart.paddingTop + (chart.innerHeight * step) / 3;
                const value = ((3 - step) * chart.maxAvg) / 3;
                return (
                  <g key={step}>
                    <line
                      x1={chart.paddingLeft}
                      x2={chart.paddingLeft + chart.innerWidth}
                      y1={y}
                      y2={y}
                      stroke="var(--border)"
                      strokeOpacity="0.45"
                      strokeWidth="1"
                    />
                    <text x={8} y={y + 3} fill="var(--text-muted)" fontSize="10">
                      {formatFloat(value)}
                    </text>
                  </g>
                );
              })}

              {chart.points.map((point) => {
                const selected = point.item.project_key === activeProjectKey;
                return (
                  <circle
                    key={point.item.project_key}
                    cx={point.x}
                    cy={point.y}
                    r={selected ? point.r + 1.6 : point.r}
                    fill="var(--accent)"
                    fillOpacity={selected ? 0.95 : 0.72}
                    stroke="var(--bg-primary)"
                    strokeWidth="1"
                    tabIndex={0}
                    aria-label={`${point.item.project_key}，${point.item.sessions} 会话，平均 ${formatFloat(point.item.avg_messages_per_session)} 消息`}
                    onMouseEnter={() => setActiveProjectKey(point.item.project_key)}
                    onMouseLeave={() => setActiveProjectKey(null)}
                    onFocus={() => setActiveProjectKey(point.item.project_key)}
                    onBlur={() => setActiveProjectKey(null)}
                  />
                );
              })}
            </svg>
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-text-muted">
            <span>X：会话数（最大 {formatCount(chart.maxSessions, language)}）</span>
            <span>Y：平均每会话消息数（最大 {formatFloat(chart.maxAvg)}）</span>
          </div>
          <div className="mt-1 text-[10px] text-text-muted">
            点越大表示 Token 总量越高；最多展示 30 个项目
          </div>
        </>
      )}
    </div>
  );
}
