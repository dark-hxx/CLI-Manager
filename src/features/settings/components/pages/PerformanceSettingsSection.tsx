import { Switch } from "@mantine/core";
import { SettingsRow, SettingsSection } from "../SettingsPrimitives";
import { toast } from "sonner";
import { useI18n } from "../../../../shared/i18n/index";
import { useSettingsStore } from "../../../../shared/preferences/settingsStore";

export function PerformanceSettingsSection() {
  const { t } = useI18n();
  const lowMemoryMode = useSettingsStore(state => state.lowMemoryMode);
  const update = useSettingsStore(state => state.update);
  return (
    <SettingsSection title={t("settings.general.performance")}>
      <SettingsRow
        title={t("settings.general.lowMemoryMode")}
        description={<>{t("settings.general.lowMemoryModeDescription")}<p className="mt-2">{t("settings.general.performanceHint")}</p></>}
      >
          <Switch checked={lowMemoryMode} aria-label={t("settings.general.lowMemoryMode")} onChange={event => {
            void update("lowMemoryMode", event.currentTarget.checked).catch(err => toast.error(t("settings.general.performanceSaveFailed"), { description: String(err) }));
          }} />
      </SettingsRow>
    </SettingsSection>
  );
}
