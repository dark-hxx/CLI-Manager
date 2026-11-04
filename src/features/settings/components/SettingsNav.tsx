import { useI18n } from "../../../shared/i18n/index";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import type { SettingsIconComponent } from "./SettingsIcons";

export interface SettingsNavTab<T extends string> {
  id: T;
  label: string;
  icon: SettingsIconComponent;
}

interface SettingsNavProps<T extends string> {
  tabs: SettingsNavTab<T>[];
  activeTab: T;
  onChange: (tab: T) => void;
}

export function SettingsNav<T extends string>({ tabs, activeTab, onChange }: SettingsNavProps<T>) {
  const { t } = useI18n();
  const iconStyle = useSettingsStore((s) => s.settingsIconStyle);
  const refined = iconStyle === "refined";

  return (
    <aside className="ui-settings-nav settings-nav">
      <span className="settings-nav-title">
        {t("settings.navTitle")}
      </span>
      <nav className="settings-nav-list" aria-label={t("settings.navTitle")}>
        {tabs.map((tab) => {
          const active = tab.id === activeTab;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className="settings-nav-item"
              data-selected={active}
              data-icon-style={iconStyle}
              aria-pressed={active}
            >
              {refined ? (
                <Icon size={18} className="shrink-0" aria-hidden="true" />
              ) : (
                <Icon size={17} strokeWidth={1.65} className="shrink-0" aria-hidden="true" />
              )}
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
