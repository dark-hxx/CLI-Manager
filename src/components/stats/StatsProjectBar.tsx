import { useMemo } from "react";
import { convertChineseForLanguage, getLanguageLocale, useI18n } from "../../lib/i18n";
import type { HistoryStatsProjectItem } from "../../lib/types";

interface StatsProjectBarProps {
  items: HistoryStatsProjectItem[];
  selectedProjectKey: string;
  onSelectProject: (projectKey: string) => void;
  onClearProject: () => void;
}

function formatCount(value: number, language: "zh-CN" | "zh-TW" | "en-US"): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(getLanguageLocale(language)).format(value);
}

export function StatsProjectBar({
  items,
  selectedProjectKey,
  onSelectProject,
  onClearProject,
}: StatsProjectBarProps) {
  const { language } = useI18n();
  const topItems = useMemo(() => items.slice(0, 8), [items]);
  const zh = (text: string) => convertChineseForLanguage(language, text);
  const maxSessions = useMemo(() => {
    if (topItems.length === 0) return 1;
    return Math.max(1, ...topItems.map((item) => item.sessions));
  }, [topItems]);

  return (
    <div className="rounded-md border border-border bg-bg-secondary p-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-xs font-semibold text-text-primary">{zh("项目活跃 TopN（C4）")}</div>
        {selectedProjectKey && (
          <button className="ui-btn ml-auto text-[11px]" onClick={onClearProject}>
            {zh("清除项目过滤")}
          </button>
        )}
      </div>

      {topItems.length === 0 && (
        <div className="py-8 text-center text-[11px] text-text-muted">
          {zh("当前过滤条件下没有项目数据")}
        </div>
      )}

      {topItems.length > 0 && (
        <div className="space-y-1.5">
          {topItems.map((item) => {
            const ratio = Math.max(0, Math.min(1, item.sessions / maxSessions));
            const selected = selectedProjectKey === item.project_key;
            return (
              <button
                key={item.project_key}
                type="button"
                className="ui-list-row w-full rounded-md border border-border px-2 py-1.5 text-left"
                onClick={() => onSelectProject(item.project_key)}
                aria-pressed={selected}
                title={`${zh("按项目过滤")}：${item.project_key}`}
              >
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate text-text-secondary">{item.project_key}</span>
                  <span className="shrink-0 text-text-muted">
                    {formatCount(item.sessions, language)} {zh("会话")} / {formatCount(item.messages, language)} {zh("消息")}
                  </span>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-bg-tertiary">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.max(4, ratio * 100)}%`,
                      backgroundColor: selected ? "var(--accent)" : "color-mix(in srgb, var(--accent) 76%, var(--bg-tertiary))",
                      opacity: selected ? 1 : 0.85,
                    }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-2 text-[10px] text-text-muted">
        点击柱条可按项目过滤全部图表
      </div>
    </div>
  );
}
