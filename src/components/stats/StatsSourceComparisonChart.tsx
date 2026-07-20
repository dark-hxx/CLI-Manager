import { useMemo, useState } from "react";
import { convertChineseForLanguage, getLanguageLocale, useI18n } from "../../lib/i18n";
import type { HistoryStatsSourceItem } from "../../lib/types";

interface StatsSourceComparisonChartProps {
  items: HistoryStatsSourceItem[];
}

function formatCount(value: number, language: "zh-CN" | "zh-TW" | "en-US"): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(getLanguageLocale(language)).format(value);
}

export function StatsSourceComparisonChart({ items }: StatsSourceComparisonChartProps) {
  const { language } = useI18n();
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const zh = (text: string) => convertChineseForLanguage(language, text);

  const maxValue = useMemo(() => {
    if (items.length === 0) return 1;
    return Math.max(
      1,
      ...items.flatMap((item) => [item.sessions, item.messages])
    );
  }, [items]);

  const active = useMemo(() => {
    if (activeSource) {
      const found = items.find((item) => item.source === activeSource);
      if (found) return found;
    }
    return items[0] ?? null;
  }, [activeSource, items]);

  return (
    <div className="rounded-md border border-border bg-bg-secondary p-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-xs font-semibold text-text-primary">{zh("来源对比（C8）")}</div>
        <div className="ml-auto text-[11px] text-text-secondary">
          {active
            ? `${active.source} · ${zh("输入")} ${formatCount(active.input_tokens, language)} · ${zh("输出")} ${formatCount(active.output_tokens, language)}`
            : zh("暂无来源数据")}
        </div>
      </div>

      {items.length === 0 && (
        <div className="py-8 text-center text-[11px] text-text-muted">
          {zh("当前过滤条件下没有来源分布数据")}
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="mb-1 flex items-center gap-3 text-[10px] text-text-muted">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "var(--accent)" }} />
              {zh("会话")}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "#4F8DFF" }} />
              {zh("消息")}
            </span>
          </div>

          <div className="space-y-1.5">
            {items.map((item) => {
              const sessionsRatio = Math.max(0, Math.min(1, item.sessions / maxValue));
              const messagesRatio = Math.max(0, Math.min(1, item.messages / maxValue));
              const activeRow = activeSource === item.source;
              return (
                <button
                  key={item.source}
                  type="button"
                  className="ui-list-row w-full rounded-md border border-border px-2 py-1.5 text-left"
                  onMouseEnter={() => setActiveSource(item.source)}
                  onMouseLeave={() => setActiveSource(null)}
                  onFocus={() => setActiveSource(item.source)}
                  onBlur={() => setActiveSource(null)}
                >
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-text-secondary">{item.source}</span>
                    <span className="text-text-muted">
                      {formatCount(item.sessions, language)} {zh("会话")} / {formatCount(item.messages, language)} {zh("消息")}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <div className="h-2 rounded-full bg-bg-tertiary">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.max(4, sessionsRatio * 100)}%`,
                          backgroundColor: "var(--accent)",
                          opacity: activeRow ? 1 : 0.86,
                        }}
                      />
                    </div>
                    <div className="h-2 rounded-full bg-bg-tertiary">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.max(4, messagesRatio * 100)}%`,
                          backgroundColor: "#4F8DFF",
                          opacity: activeRow ? 1 : 0.86,
                        }}
                      />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
