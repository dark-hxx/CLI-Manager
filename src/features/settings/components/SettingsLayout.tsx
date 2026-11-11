import { type ReactNode } from "react";
import { SettingsNav, type SettingsNavTab } from "./SettingsNav";
import { SettingsTopBar } from "./SettingsTopBar";
import { Select } from "@mantine/core";
import { useI18n } from "../../../shared/i18n/index";

interface SettingsLayoutProps<T extends string> {
  tabs: SettingsNavTab<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  title: string;
  description: string;
  searchValue: string;
  searchPlaceholder?: string;
  onSearchChange: (nextValue: string) => void;
  onClose: () => void;
  children: ReactNode;
  searchReplacement?: ReactNode;
  contentWidth?: "standard" | "wide";
}

export function SettingsLayout<T extends string>({
  tabs,
  activeTab,
  onTabChange,
  title,
  description,
  searchValue,
  searchPlaceholder,
  onSearchChange,
  onClose,
  children,
  searchReplacement,
  contentWidth = "standard",
}: SettingsLayoutProps<T>) {
  const { t } = useI18n();
  return (
    <div className="ui-settings-layout flex h-full min-h-0 w-full flex-1 flex-row">
      <SettingsNav tabs={tabs} activeTab={activeTab} onChange={onTabChange} />
      <section className="ui-settings-content ui-surface-base flex min-w-0 flex-1 flex-col">
        <div className="settings-mobile-nav">
          <Select
            value={activeTab}
            data={tabs.map(({ id, label }) => ({ value: id, label }))}
            aria-label={t("settings.navTitle")}
            allowDeselect={false}
            onChange={(value) => {
              // 仍由外壳执行离开拦截；不能绕过 MCP 未保存确认。
              const tab = tabs.find((item) => item.id === value);
              if (tab) onTabChange(tab.id);
            }}
          />
        </div>
        <SettingsTopBar
          title={title}
          description={description}
          searchValue={searchValue}
          searchPlaceholder={searchPlaceholder}
          onSearchChange={onSearchChange}
          onClose={onClose}
          searchReplacement={searchReplacement}
          contentWidth={contentWidth}
        />
        <div className="min-h-0 flex-1 overflow-y-auto settings-scroll">
          <div className="settings-page" data-width={contentWidth}>
            {children}
          </div>
        </div>
      </section>
    </div>
  );
}
