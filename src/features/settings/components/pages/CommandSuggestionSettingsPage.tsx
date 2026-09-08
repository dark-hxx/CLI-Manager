import { useEffect, useState } from "react";
import { Badge, Box, Button, Card, Group, SimpleGrid, Stack, Switch, Text } from "@mantine/core";
import { HardDrive, Sparkles, Trash2 } from "lucide-react";
import { useCommandHistoryStore, type CommandHistoryStorageStats } from "../../../terminal/api/commandHistoryStore";
import { useSettingsStore } from "../../../../shared/preferences/settingsStore";
import { useI18n } from "../../../../shared/i18n/index";
import { ConfirmDialog } from "../../../../shared/ui/ConfirmDialog";

const EMPTY_STORAGE_STATS: CommandHistoryStorageStats = {
  commandCount: 0,
  storageBytes: 0,
};

function formatMetricNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString();
}

function formatStorageSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function CommandSuggestionSettingsPage() {
  const { t } = useI18n();
  const terminalInputSuggestionsEnabled = useSettingsStore((s) => s.terminalInputSuggestionsEnabled);
  const updateSetting = useSettingsStore((s) => s.update);
  const getStorageStats = useCommandHistoryStore((s) => s.getStorageStats);
  const cleanupCommandHistory = useCommandHistoryStore((s) => s.cleanup);
  const [storageStats, setStorageStats] = useState<CommandHistoryStorageStats>(EMPTY_STORAGE_STATS);
  const [storageLoading, setStorageLoading] = useState(false);
  const [clearingStorage, setClearingStorage] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const refreshStorageStats = async () => {
    const next = await getStorageStats();
    setStorageStats(next);
  };

  useEffect(() => {
    let cancelled = false;
    setStorageLoading(true);
    void getStorageStats()
      .then((next) => {
        if (!cancelled) setStorageStats(next);
      })
      .finally(() => {
        if (!cancelled) setStorageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [getStorageStats]);

  const clearStorage = async () => {
    if (storageStats.commandCount <= 0) return;
    setClearingStorage(true);
    try {
      await cleanupCommandHistory();
      await refreshStorageStats();
      setClearConfirmOpen(false);
    } finally {
      setClearingStorage(false);
    }
  };

  return (
    <Stack gap="md">
      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" gap="md">
            <Group gap="sm" wrap="nowrap">
              <Box style={{ color: "var(--primary)", marginTop: 2 }}>
                <Sparkles size={18} />
              </Box>
              <Box>
                <Text size="sm" fw={600} c="var(--on-surface)">
                  {t("settings.commandSuggestions.title")}
                </Text>
                <Text mt={4} size="xs" c="var(--on-surface-variant)">
                  {t("settings.commandSuggestions.description")}
                </Text>
              </Box>
            </Group>
            <Badge color="gray" variant="light">
              {t("settings.commandSuggestions.statusLocal")}
            </Badge>
          </Group>

          <Card className="border border-border bg-surface-container-low" p="sm" radius="lg">
            <Group justify="space-between" align="center" gap="md" wrap="nowrap">
              <Box>
                <Text size="xs" fw={600} c="var(--on-surface)">
                  {t("settings.commandSuggestions.enableSuggestions")}
                </Text>
                <Text mt={4} size="xs" c="var(--text-muted)">
                  {t("settings.commandSuggestions.enableSuggestionsDesc")}
                </Text>
              </Box>
              <Switch
                color="cliPrimary"
                checked={terminalInputSuggestionsEnabled}
                onChange={(event) => void updateSetting("terminalInputSuggestionsEnabled", event.currentTarget.checked)}
                aria-label={t("settings.commandSuggestions.enableSuggestions")}
              />
            </Group>
          </Card>

          <Card className="border border-border bg-surface-container-low" p="sm" radius="lg">
            <Stack gap="sm">
              <Group justify="space-between" align="center" gap="md">
                <Group gap="sm" wrap="nowrap">
                  <HardDrive size={16} style={{ color: "var(--primary)" }} />
                  <Box>
                    <Text size="xs" fw={600} c="var(--on-surface)">
                      {t("settings.commandSuggestions.storageTitle")}
                    </Text>
                    <Text size="xs" c="var(--text-muted)">
                      {t("settings.commandSuggestions.storageDescription")}
                    </Text>
                  </Box>
                </Group>
                <Button
                  size="xs"
                  color="red"
                  variant="light"
                  leftSection={<Trash2 size={14} />}
                  loading={clearingStorage}
                  disabled={storageLoading || storageStats.commandCount <= 0}
                  onClick={() => setClearConfirmOpen(true)}
                >
                  {t("settings.commandSuggestions.clearStorage")}
                </Button>
              </Group>

              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                <Card className="border border-border bg-surface" p="sm" radius="md">
                  <Text size="xs" c="var(--text-muted)">{t("settings.commandSuggestions.storageCommandCount")}</Text>
                  <Text size="lg" fw={700} c="var(--on-surface)">
                    {storageLoading ? "..." : formatMetricNumber(storageStats.commandCount)}
                  </Text>
                </Card>
                <Card className="border border-border bg-surface" p="sm" radius="md">
                  <Text size="xs" c="var(--text-muted)">{t("settings.commandSuggestions.storageUsage")}</Text>
                  <Text size="lg" fw={700} c="var(--on-surface)">
                    {storageLoading ? "..." : formatStorageSize(storageStats.storageBytes)}
                  </Text>
                </Card>
              </SimpleGrid>

              <Text size="10px" c="var(--text-muted)">
                {t("settings.commandSuggestions.storageHint")}
              </Text>
            </Stack>
          </Card>
        </Stack>
      </section>
      <ConfirmDialog
        open={clearConfirmOpen}
        title={t("settings.commandSuggestions.clearStorageTitle")}
        message={t("settings.commandSuggestions.clearStorageConfirm")}
        confirmText={t("settings.commandSuggestions.clearStorageConfirmAction")}
        cancelText={t("settings.commandSuggestions.clearStorageCancel")}
        danger
        onConfirm={() => void clearStorage()}
        onClose={() => {
          if (!clearingStorage) setClearConfirmOpen(false);
        }}
      />
    </Stack>
  );
}
