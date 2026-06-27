import {
  Badge,
  Box,
  Button,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  UnstyledButton,
} from "@mantine/core";
import {
  TERMINAL_STATS_CARD_KEYS,
  useSettingsStore,
  type SidebarDensity,
  type TerminalSidePanelSkin,
  type TerminalStatsCardKey,
} from "../../../stores/settingsStore";
import { useI18n, type TranslationKey } from "../../../lib/i18n";

const SIDEBAR_DENSITY_OPTIONS: { value: SidebarDensity; labelKey: TranslationKey; descriptionKey: TranslationKey }[] = [
  {
    value: "comfortable",
    labelKey: "settings.options.sidebarDensity.comfortable",
    descriptionKey: "settings.options.sidebarDensity.comfortableDescription",
  },
  {
    value: "compact",
    labelKey: "settings.options.sidebarDensity.compact",
    descriptionKey: "settings.options.sidebarDensity.compactDescription",
  },
];

const SIDE_PANEL_SKIN_OPTIONS: {
  value: TerminalSidePanelSkin;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  swatches: [string, string, string];
}[] = [
  {
    value: "terminal",
    labelKey: "settings.sidebar.skin.terminal.label",
    descriptionKey: "settings.sidebar.skin.terminal.description",
    swatches: ["#0a0a0a", "#ececec", "#5ac8e0"],
  },
  {
    value: "classic-terminal",
    labelKey: "settings.sidebar.skin.classicTerminal.label",
    descriptionKey: "settings.sidebar.skin.classicTerminal.description",
    swatches: ["#0a0a0a", "#ececec", "#3dd68c"],
  },
  {
    value: "warm-paper",
    labelKey: "settings.sidebar.skin.warmPaper.label",
    descriptionKey: "settings.sidebar.skin.warmPaper.description",
    swatches: ["#fbf4e8", "#2e2418", "#2f8797"],
  },
  {
    value: "sunrise",
    labelKey: "settings.sidebar.skin.sunrise.label",
    descriptionKey: "settings.sidebar.skin.sunrise.description",
    swatches: ["#fff2e4", "#331d12", "#c77a1d"],
  },
  {
    value: "linen",
    labelKey: "settings.sidebar.skin.linen.label",
    descriptionKey: "settings.sidebar.skin.linen.description",
    swatches: ["#f8efe1", "#2b251d", "#4f8790"],
  },
  {
    value: "latte",
    labelKey: "settings.sidebar.skin.latte.label",
    descriptionKey: "settings.sidebar.skin.latte.description",
    swatches: ["#f6eadc", "#30251c", "#596f9c"],
  },
];

const STATS_CARD_OPTIONS: { key: TerminalStatsCardKey; labelKey: TranslationKey }[] = [
  { key: "session", labelKey: "termStats.session" },
  { key: "tokenUsage", labelKey: "termStats.tokenUsage" },
  { key: "tokenTrend", labelKey: "termStats.tokenTrend" },
  { key: "modelContext", labelKey: "termStats.modelContext" },
  { key: "tools", labelKey: "termStats.tools" },
  { key: "latestChanges", labelKey: "termStats.latestChanges" },
  { key: "todayUsage", labelKey: "termStats.todayUsage" },
];

export function SidebarSettingsPage() {
  const { t } = useI18n();
  const viewMode = useSettingsStore((s) => s.viewMode);
  const sidebarDensity = useSettingsStore((s) => s.sidebarDensity);
  const terminalSidePanelMerged = useSettingsStore((s) => s.terminalSidePanelMerged);
  const terminalSidePanelSkin = useSettingsStore((s) => s.terminalSidePanelSkin);
  const terminalStatsCardVisibility = useSettingsStore((s) => s.terminalStatsCardVisibility);
  const sidebarToolbarVisibility = useSettingsStore((s) => s.sidebarToolbarVisibility);
  const update = useSettingsStore((s) => s.update);

  const visibleCardCount = TERMINAL_STATS_CARD_KEYS.filter((key) => terminalStatsCardVisibility[key]).length;

  const updateStatsCardVisibility = (key: TerminalStatsCardKey, checked: boolean) => {
    void update("terminalStatsCardVisibility", { ...terminalStatsCardVisibility, [key]: checked });
  };

  return (
    <Stack gap="md">
      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="md">
          <Text size="sm" fw={600} c="var(--on-surface)">
            {t("settings.sidebar.behavior")}
          </Text>
          <Card className="border border-primary bg-surface-container-low" p="md" radius="lg">
            <Group justify="space-between" align="center" gap="md" wrap="nowrap">
              <Box>
                <Text size="sm" fw={600} c="var(--on-surface)">
                  {t("settings.general.compactMode")}
                </Text>
                <Text mt={4} size="xs" c="var(--text-muted)">
                  {t("settings.general.compactModeDescription")}
                </Text>
              </Box>
              <Switch
                color="cliPrimary"
                checked={viewMode === "compact"}
                onChange={(event) => void update("viewMode", event.currentTarget.checked ? "compact" : "standard")}
                aria-label={viewMode === "compact" ? t("settings.general.closeCompactMode") : t("settings.general.openCompactMode")}
              />
            </Group>
          </Card>

          <Stack gap="xs">
            <Text size="xs" c="var(--on-surface-variant)">
              {t("settings.general.sidebarDensity")}
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
              {SIDEBAR_DENSITY_OPTIONS.map((opt) => {
                const active = sidebarDensity === opt.value;
                return (
                  <UnstyledButton
                    key={opt.value}
                    type="button"
                    onClick={() => void update("sidebarDensity", opt.value)}
                    className="ui-interactive ui-focus-ring ui-selection-card rounded-xl border px-4 py-3 text-left"
                    data-selected={active ? "true" : "false"}
                    aria-pressed={active}
                    w="100%"
                    style={{
                      display: "block",
                      minHeight: 76,
                      minWidth: 0,
                      backgroundColor: active
                        ? "color-mix(in srgb, var(--primary) 6%, var(--surface-container-lowest))"
                        : "var(--surface-container-lowest)",
                      borderColor: active
                        ? "color-mix(in srgb, var(--primary) 54%, var(--border))"
                        : "color-mix(in srgb, var(--border) 92%, transparent)",
                    }}
                  >
                    <Stack gap={4} style={{ minWidth: 0, padding: "6px 10px 4px" }}>
                      <Text size="sm" fw={600} c={active ? "var(--on-surface)" : "var(--on-surface-variant)"}>
                        {t(opt.labelKey)}
                      </Text>
                      <Text size="xs" lh={1.45} c="var(--text-muted)" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                        {t(opt.descriptionKey)}
                      </Text>
                    </Stack>
                  </UnstyledButton>
                );
              })}
            </SimpleGrid>
          </Stack>

          <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
            <Group justify="space-between" align="center" gap="md" wrap="nowrap">
              <Box>
                <Text size="xs" c="var(--on-surface-variant)">
                  {t("settings.general.mergePanels")}
                </Text>
                <Text mt={4} size="xs" lh={1.55} c="var(--text-muted)">
                  {t("settings.general.mergePanelsDescription")}
                </Text>
              </Box>
              <Switch
                color="cliPrimary"
                checked={terminalSidePanelMerged}
                onChange={(event) => void update("terminalSidePanelMerged", event.currentTarget.checked)}
                aria-label={terminalSidePanelMerged ? t("settings.general.disableMergePanels") : t("settings.general.enableMergePanels")}
              />
            </Group>
          </Card>
        </Stack>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="md">
          <Text size="sm" fw={600} c="var(--on-surface)">
            {t("settings.sidebar.panelSkin")}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
            {SIDE_PANEL_SKIN_OPTIONS.map((option) => {
              const active = terminalSidePanelSkin === option.value;
              return (
                <UnstyledButton
                  key={option.value}
                  type="button"
                  onClick={() => void update("terminalSidePanelSkin", option.value)}
                  className="ui-interactive ui-focus-ring ui-selection-card relative rounded-xl border px-4 py-3 text-left transition-[transform,box-shadow,border-color,background-color]"
                  data-selected={active ? "true" : "false"}
                  aria-pressed={active}
                  w="100%"
                  style={{
                    display: "block",
                    minHeight: 76,
                    minWidth: 0,
                    overflow: "hidden",
                    whiteSpace: "normal",
                    backgroundColor: active
                      ? "color-mix(in srgb, var(--primary) 6%, var(--surface-container-lowest))"
                      : "var(--surface-container-lowest)",
                    borderColor: active
                      ? "color-mix(in srgb, var(--primary) 56%, var(--border))"
                      : "color-mix(in srgb, var(--border) 88%, transparent)",
                    boxShadow: active
                      ? "0 2px 8px color-mix(in srgb, var(--primary) 8%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--primary) 24%, transparent)"
                      : "0 2px 8px color-mix(in srgb, var(--on-surface) 6%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 12%, transparent)",
                  }}
                >
                  <Group
                    justify="space-between"
                    align="flex-start"
                    gap="sm"
                    wrap="nowrap"
                    style={{ minWidth: 0, padding: "2px 6px 1px" }}
                  >
                    <Box style={{ minWidth: 0 }}>
                      <Text
                        size="sm"
                        fw={600}
                        c={active ? "var(--on-surface)" : "var(--on-surface-variant)"}
                        style={{ whiteSpace: "normal", overflowWrap: "anywhere", lineHeight: 1.25 }}
                      >
                        {t(option.labelKey)}
                      </Text>
                      <Text
                        mt={4}
                        size="xs"
                        lh={1.55}
                        c={active ? "var(--on-surface-variant)" : "var(--text-muted)"}
                        style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}
                      >
                        {t(option.descriptionKey)}
                      </Text>
                    </Box>
                    <Group gap={3} wrap="nowrap" aria-hidden="true">
                      {option.swatches.map((color) => (
                        <span
                          key={color}
                          className="h-4 w-4 rounded-full border border-border"
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </Group>
                  </Group>
                </UnstyledButton>
              );
            })}
          </SimpleGrid>
        </Stack>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="sm">
          <Group justify="space-between" align="center">
            <Text size="sm" fw={600} c="var(--on-surface)">
              {t("settings.sidebar.statsCards")}
            </Text>
            <Badge variant="light" color="cliPrimary">
              {t("settings.sidebar.visibleCardsCount", {
                visible: visibleCardCount,
                total: TERMINAL_STATS_CARD_KEYS.length,
              })}
            </Badge>
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
            {STATS_CARD_OPTIONS.map((option) => (
              <Card key={option.key} className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
                <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                  <Text size="xs" c="var(--on-surface-variant)">
                    {t(option.labelKey)}
                  </Text>
                  <Switch
                    color="cliPrimary"
                    checked={terminalStatsCardVisibility[option.key]}
                    onChange={(event) => updateStatsCardVisibility(option.key, event.currentTarget.checked)}
                    aria-label={
                      terminalStatsCardVisibility[option.key]
                        ? t("settings.sidebar.hideStatsCard", { item: t(option.labelKey) })
                        : t("settings.sidebar.showStatsCard", { item: t(option.labelKey) })
                    }
                  />
                </Group>
              </Card>
            ))}
          </SimpleGrid>
          <Group justify="flex-end">
            <Button
              variant="subtle"
              size="xs"
              onClick={() => void update("terminalStatsCardVisibility", {
                session: true,
                tokenUsage: true,
                tokenTrend: true,
                modelContext: true,
                tools: true,
                latestChanges: true,
                todayUsage: true,
              })}
            >
              {t("settings.sidebar.showAllStatsCards")}
            </Button>
          </Group>
        </Stack>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="sm">
          <Text size="sm" fw={600} c="var(--on-surface)">
            {t("settings.general.sidebarToolbar")}
          </Text>
          <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
            <Group justify="space-between" align="center" gap="md" wrap="nowrap">
              <Box>
                <Text size="xs" c="var(--on-surface-variant)">
                  {t("settings.general.showStatsButton")}
                </Text>
                <Text mt={4} size="xs" c="var(--text-muted)">
                  {t("settings.general.showStatsButtonDescription")}
                </Text>
              </Box>
              <Switch
                color="cliPrimary"
                checked={sidebarToolbarVisibility.stats}
                onChange={(event) => void update("sidebarToolbarVisibility", {
                  ...sidebarToolbarVisibility,
                  stats: event.currentTarget.checked,
                })}
                aria-label={
                  sidebarToolbarVisibility.stats
                    ? t("settings.general.hideStatsButton")
                    : t("settings.general.showStatsButtonAria")
                }
              />
            </Group>
          </Card>
        </Stack>
      </section>
    </Stack>
  );
}
