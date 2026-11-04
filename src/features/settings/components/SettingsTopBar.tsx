import { TextInput } from "@mantine/core";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Search } from "../../../shared/ui/icons";
import { useI18n } from "../../../shared/i18n/index";

interface SettingsTopBarProps {
  title: string;
  description: string;
  searchValue: string;
  searchPlaceholder?: string;
  onSearchChange: (nextValue: string) => void;
  onClose: () => void;
  searchReplacement?: ReactNode;
  contentWidth?: "standard" | "wide";
}

export function SettingsTopBar({
  title,
  description,
  searchValue,
  searchPlaceholder,
  onSearchChange,
  onClose,
  searchReplacement,
  contentWidth = "standard",
}: SettingsTopBarProps) {
  const { t } = useI18n();

  return (
    <header className="ui-settings-topbar shrink-0 settings-topbar">
      <div className="settings-topbar-inner" data-width={contentWidth}>
        <div className="min-w-0">
          <h2 className="settings-page-title">{title}</h2>
          <p className="settings-page-description">{description}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="settings-close"
          aria-label={t("settings.closeLabel")}
          title={t("common.close")}
        >
          <X size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {searchReplacement ? <div className="settings-header-tools">{searchReplacement}</div> : searchPlaceholder && (
          <TextInput
            value={searchValue}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder={searchPlaceholder}
            size="xs"
            leftSection={<Search size={14} strokeWidth={1.75} />}
            aria-label={t("settings.searchLabel")}
            className="settings-page-search"
          />
        )}
      </div>
    </header>
  );
}
