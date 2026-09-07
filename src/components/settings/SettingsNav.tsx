import type { LucideIcon } from "lucide-react";
import { useI18n } from "../../lib/i18n";

export interface SettingsNavTab<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
}

interface SettingsNavProps<T extends string> {
  tabs: SettingsNavTab<T>[];
  activeTab: T;
  onChange: (tab: T) => void;
}

export function SettingsNav<T extends string>({ tabs, activeTab, onChange }: SettingsNavProps<T>) {
  const { t } = useI18n();

  return (
    <aside className="ui-settings-nav ui-surface-low flex min-h-0 w-[220px] shrink-0 flex-col border-r border-border p-3">
      <span className="px-2 pb-3 text-[12px] font-semibold tracking-[0.04em] text-on-surface-variant">
        {t("settings.navTitle")}
      </span>
      <nav className="ui-no-divider-list min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
        {tabs.map((tab) => {
          const active = tab.id === activeTab;
          const Icon = tab.icon;
          const iconClass = active ? "text-primary" : "text-text-muted";
          return (
            <button
              key={tab.id}
              onClick={() => onChange(tab.id)}
              className={`ui-interactive flex w-full items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-left text-sm ${
                active ? "font-[800] text-on-surface" : "font-[700] text-on-surface-variant"
              }`}
              style={
                active
                  ? {
                      backgroundColor: "var(--interactive-selected-bg)",
                      boxShadow: "inset 0 0 0 1px var(--interactive-selected-border)",
                    }
                  : undefined
              }
              aria-pressed={active}
            >
              <Icon className={`h-4 w-4 shrink-0 ${iconClass}`} aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
