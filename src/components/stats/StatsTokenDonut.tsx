import { useMemo, useState } from "react";
import { convertChineseForLanguage, getLanguageLocale, useI18n } from "../../lib/i18n";

interface StatsTokenDonutProps {
  inputTokens: number;
  outputTokens: number;
}

type SegmentKey = "input" | "output";

function formatCount(value: number, language: "zh-CN" | "zh-TW" | "en-US"): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(getLanguageLocale(language)).format(value);
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  return `${(value * 100).toFixed(1)}%`;
}

export function StatsTokenDonut({ inputTokens, outputTokens }: StatsTokenDonutProps) {
  const { language } = useI18n();
  const [activeKey, setActiveKey] = useState<SegmentKey | null>(null);
  const zh = (text: string) => convertChineseForLanguage(language, text);

  const total = Math.max(0, inputTokens) + Math.max(0, outputTokens);
  const inputRatio = total > 0 ? Math.max(0, inputTokens) / total : 0;
  const outputRatio = total > 0 ? Math.max(0, outputTokens) / total : 0;

  const centerLabel = useMemo(() => {
    if (!activeKey) return zh("Token 总量");
    return activeKey === "input" ? zh("输入 Token") : zh("输出 Token");
  }, [activeKey, language]);

  const centerValue = useMemo(() => {
    if (!activeKey) return formatCount(total, language);
    return activeKey === "input" ? formatCount(inputTokens, language) : formatCount(outputTokens, language);
  }, [activeKey, inputTokens, language, outputTokens, total]);

  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  const inputDash = circumference * inputRatio;
  const outputDash = circumference * outputRatio;

  return (
    <div className="rounded-md border border-border bg-bg-secondary p-3">
      <div className="mb-2 text-xs font-semibold text-text-primary">{zh("Token 构成（C3）")}</div>
      <div className="flex flex-col items-center gap-2">
        <svg
          width={184}
          height={184}
          viewBox="0 0 184 184"
          role="img"
          aria-label={zh("输入与输出 Token 占比环形图")}
        >
          <g transform="translate(92,92) rotate(-90)">
            <circle
              cx="0"
              cy="0"
              r={radius}
              fill="none"
              stroke="var(--bg-tertiary)"
              strokeWidth="20"
            />

            {total > 0 && inputDash > 0 && (
              <circle
                cx="0"
                cy="0"
                r={radius}
                fill="none"
                stroke="#2F8F62"
                strokeWidth="20"
                strokeLinecap="round"
                strokeDasharray={`${inputDash} ${Math.max(0, circumference - inputDash)}`}
                strokeOpacity={activeKey && activeKey !== "input" ? "0.35" : "1"}
              />
            )}

            {total > 0 && outputDash > 0 && (
              <circle
                cx="0"
                cy="0"
                r={radius}
                fill="none"
                stroke="#C46A2D"
                strokeWidth="20"
                strokeLinecap="round"
                strokeDasharray={`${outputDash} ${Math.max(0, circumference - outputDash)}`}
                strokeDashoffset={-inputDash}
                strokeOpacity={activeKey && activeKey !== "output" ? "0.35" : "1"}
              />
            )}
          </g>

          <text
            x="92"
            y="84"
            textAnchor="middle"
            fill="var(--text-muted)"
            fontSize="11"
          >
            {centerLabel}
          </text>
          <text
            x="92"
            y="104"
            textAnchor="middle"
            fill="var(--text-primary)"
            fontSize="16"
            fontWeight="700"
          >
            {centerValue}
          </text>
        </svg>

        <div className="w-full space-y-1.5">
          <button
            type="button"
            className="ui-list-row flex w-full items-center justify-between rounded-md border border-border px-2 py-1.5 text-left text-xs"
            onMouseEnter={() => setActiveKey("input")}
            onMouseLeave={() => setActiveKey(null)}
            onFocus={() => setActiveKey("input")}
            onBlur={() => setActiveKey(null)}
          >
            <span className="inline-flex items-center gap-1.5 text-text-secondary">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: "#2F8F62" }} />
              输入 Token
            </span>
            <span className="text-text-primary">
              {formatCount(inputTokens, language)} · {formatPercent(inputRatio)}
            </span>
          </button>
          <button
            type="button"
            className="ui-list-row flex w-full items-center justify-between rounded-md border border-border px-2 py-1.5 text-left text-xs"
            onMouseEnter={() => setActiveKey("output")}
            onMouseLeave={() => setActiveKey(null)}
            onFocus={() => setActiveKey("output")}
            onBlur={() => setActiveKey(null)}
          >
            <span className="inline-flex items-center gap-1.5 text-text-secondary">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: "#C46A2D" }} />
              输出 Token
            </span>
            <span className="text-text-primary">
              {formatCount(outputTokens, language)} · {formatPercent(outputRatio)}
            </span>
          </button>
        </div>

        {total <= 0 && (
          <div className="text-[11px] text-text-muted">
            当前过滤条件下暂无 Token 数据
          </div>
        )}
      </div>
    </div>
  );
}
