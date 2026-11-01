import { Card, Group, Stack, Switch, Text } from "@mantine/core";
import { toast } from "sonner";
import { useI18n } from "../../../../shared/i18n/index";
import { useSettingsStore } from "../../../../shared/preferences/settingsStore";

export function PerformanceSettingsSection() {
  const { t } = useI18n();
  const lowMemoryMode = useSettingsStore(state => state.lowMemoryMode);
  const update = useSettingsStore(state => state.update);
  return (
    <Stack gap="sm">
      <Text fw={600}>{t("settings.general.performance")}</Text>
      <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
        <Group justify="space-between" wrap="nowrap">
          <div>
            <Text size="sm" fw={500}>{t("settings.general.lowMemoryMode")}</Text>
            <Text size="xs" c="var(--text-muted)">{t("settings.general.lowMemoryModeDescription")}</Text>
            <Text size="xs" mt="xs" c="var(--text-muted)">{t("settings.general.performanceHint")}</Text>
          </div>
          <Switch checked={lowMemoryMode} aria-label={t("settings.general.lowMemoryMode")} onChange={event => {
            void update("lowMemoryMode", event.currentTarget.checked).catch(err => toast.error(t("settings.general.performanceSaveFailed"), { description: String(err) }));
          }} />
        </Group>
      </Card>
    </Stack>
  );
}
