import { useMemo, useState } from "react";
import { convertChineseForLanguage, getLanguageLocale, useI18n } from "../../lib/i18n";
import type { HistoryStatsModelItem } from "../../lib/types";
import { VendorIcon, inferVendor } from "../VendorIcon";

interface ModelSegment {
  key: string;
  label: string;
  ratio: number;
  sessions: number;
}

interface StatsModelCompositionProps {
  items: HistoryStatsModelItem[];
}

const MODEL_COLORS = [
  "var(--accent)",
  "#4F8DFF",
  "#52A36E",
  "#E0AF68",
  "#F7768E",
  "#6A5B4D",
];

function formatCount(value: number, language: "zh-CN" | "zh-TW" | "en-US"): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(getLanguageLocale(language)).format(value);
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  return `${(value * 100).toFixed(1)}%`;
}

export function StatsModelComposition({ items }: StatsModelCompositionProps) {
  const { language } = useI18n();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const zh = (text: string) => convertChineseForLanguage(language, text);

  const segments = useMemo<ModelSegment[]>(() => {
    const top = items.slice(0, 5).map((item) => ({
      key: item.model,
      label: item.model,
      ratio: Math.max(0, item.ratio),
      sessions: Math.max(0, item.sessions),
    }));
    if (items.length <= 5) return top;

    let otherRatio = 0;
    let otherSessions = 0;
    for (const item of items.slice(5)) {
      otherRatio += Math.max(0, item.ratio);
      otherSessions += Math.max(0, item.sessions);
    }
    if (otherRatio > 0 || otherSessions > 0) {
      top.push({
        key: "__other__",
        label: zh("其他"),
        ratio: otherRatio,
        sessions: otherSessions,
      });
    }
    return top;
  }, [items, language]);

  const normalized = useMemo(() => {
    const ratioSum = segments.reduce((sum, item) => sum + Math.max(0, item.ratio), 0);
    if (ratioSum <= 0) return segments.map((item) => ({ ...item, normalizedRatio: 0 }));
    return segments.map((item) => ({
      ...item,
      normalizedRatio: Math.max(0, item.ratio) / ratioSum,
    }));
  }, [segments]);

  return (
    <div className="rounded-md border border-border bg-bg-secondary p-3">
      <div className="mb-2 text-xs font-semibold text-text-primary">{zh("模型占比（C5）")}</div>

      {normalized.length === 0 && (
        <div className="py-8 text-center text-[11px] text-text-muted">
          {zh("当前过滤条件下没有模型数据")}
        </div>
      )}

      {normalized.length > 0 && (
        <>
          <div
            className="h-3 overflow-hidden rounded-full border border-border bg-bg-tertiary"
            role="img"
            aria-label="模型占比分段条形图"
          >
            <div className="flex h-full w-full">
              {normalized.map((segment, idx) => (
                <div
                  key={segment.key}
                  className="h-full transition-opacity"
                  style={{
                    width: `${Math.max(3, segment.normalizedRatio * 100)}%`,
                    backgroundColor: MODEL_COLORS[idx % MODEL_COLORS.length],
                    opacity: activeKey && activeKey !== segment.key ? 0.35 : 1,
                  }}
                  title={`${segment.label} · ${formatPercent(segment.ratio)} · ${formatCount(segment.sessions, language)} ${zh("会话")}`}
                />
              ))}
            </div>
          </div>

          <div className="mt-2 space-y-1.5">
            {normalized.map((segment, idx) => {
              const vendor = segment.key === "__other__" ? null : inferVendor(segment.label);
              return (
              <button
                key={segment.key}
                type="button"
                className="ui-list-row flex w-full items-center justify-between rounded-md border border-border px-2 py-1.5 text-left text-[11px]"
                onMouseEnter={() => setActiveKey(segment.key)}
                onMouseLeave={() => setActiveKey(null)}
                onFocus={() => setActiveKey(segment.key)}
                onBlur={() => setActiveKey(null)}
                title={`${segment.label} · ${formatPercent(segment.ratio)} · ${formatCount(segment.sessions, language)} ${zh("会话")}`}
              >
                <span className="inline-flex min-w-0 items-center gap-1.5 text-text-secondary">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: MODEL_COLORS[idx % MODEL_COLORS.length] }}
                  />
                  {vendor && <VendorIcon vendor={vendor} size={13} />}
                  <span className="truncate">{segment.label}</span>
                </span>
                <span className="shrink-0 text-text-muted">
                  {formatPercent(segment.ratio)} · {formatCount(segment.sessions, language)}
                </span>
              </button>
              );
            })}
          </div>
        </>
      )}

      <div className="mt-2 text-[10px] text-text-muted">
        展示前 5 模型，剩余合并为“其他”
      </div>
    </div>
  );
}
