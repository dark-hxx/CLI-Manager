import { TextInput } from "@mantine/core";
import { Search } from "../icons";
import { useI18n } from "../../lib/i18n";

interface SettingsTopBarProps {
  title: string;
  description: string;
  searchValue: string;
  searchPlaceholder?: string;
  onSearchChange: (nextValue: string) => void;
  onClose: () => void;
}

export function SettingsTopBar({
  title,
  description,
  searchValue,
  searchPlaceholder,
  onSearchChange,
  onClose,
}: SettingsTopBarProps) {
  const { t } = useI18n();

  return (
    <header className="ui-settings-topbar ui-surface-base ui-glass z-10 border-b border-border px-4 py-3 min-[1280px]:px-6 min-[1280px]:py-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-medium text-on-surface min-[1280px]:text-lg">{title}</h2>
          <p className="mt-1 line-clamp-2 text-xs text-on-surface-variant min-[1280px]:text-sm">{description}</p>
        </div>
        <button
          onClick={onClose}
          className="ui-interactive shrink-0 rounded-xl border px-2.5 py-1.5 text-xs font-medium"
          style={{
            borderColor: "color-mix(in srgb, var(--primary) 38%, transparent)",
            backgroundColor: "color-mix(in srgb, var(--primary) 8%, transparent)",
            color: "var(--primary)",
          }}
          aria-label={t("settings.closeLabel")}
        >
          {t("common.close")}
        </button>
        {searchPlaceholder && (
          <TextInput
            value={searchValue}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder={searchPlaceholder}
            size="xs"
            leftSection={<Search size={14} strokeWidth={1.75} />}
            aria-label={t("settings.searchLabel")}
            className="col-span-2 min-w-0 min-[1280px]:ml-auto min-[1280px]:w-56"
          />
        )}
      </div>
    </header>
  );
}
