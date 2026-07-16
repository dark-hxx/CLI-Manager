import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import {
  SYSTEM_RESOURCE_CARD_KEYS,
  TERMINAL_STATS_CARD_KEYS,
  useSettingsStore,
  type SidebarDensity,
  type SystemResourceCardKey,
  type TerminalSidePanelSkin,
  type TerminalStatsCardKey,
  type TerminalToolbarVisibilitySettings,
} from "../../../stores/settingsStore";
import { useI18n, type TranslationKey } from "../../../lib/i18n";
import { DND_ACTIVATION_CONSTRAINT, DND_SORTABLE_TRANSITION } from "../../../lib/dragInteraction";

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

const STATS_CARD_OPTION_MAP = new Map<TerminalStatsCardKey, (typeof STATS_CARD_OPTIONS)[number]>(
  STATS_CARD_OPTIONS.map((option) => [option.key, option])
);

const RESOURCE_CARD_OPTIONS: { key: SystemResourceCardKey; labelKey: TranslationKey }[] = [
  { key: "system", labelKey: "systemResources.system" },
  { key: "cpu", labelKey: "systemResources.cpu" },
  { key: "memory", labelKey: "systemResources.memory" },
  { key: "network", labelKey: "systemResources.network" },
  { key: "disk", labelKey: "systemResources.disk" },
  { key: "gpu", labelKey: "systemResources.gpu" },
  { key: "processes", labelKey: "systemResources.topProcesses" },
];

const RESOURCE_CARD_OPTION_MAP = new Map<SystemResourceCardKey, (typeof RESOURCE_CARD_OPTIONS)[number]>(
  RESOURCE_CARD_OPTIONS.map((option) => [option.key, option])
);

const TERMINAL_TOOLBAR_OPTIONS: { key: TerminalToolbarOptionKey; labelKey: TranslationKey }[] = [
  { key: "templates", labelKey: "settings.general.toolbar.templates" },
  { key: "fullscreen", labelKey: "settings.general.toolbar.fullscreen" },
  { key: "sessionHistory", labelKey: "settings.general.toolbar.sessionHistory" },
  { key: "replay", labelKey: "settings.general.toolbar.replay" },
  { key: "files", labelKey: "settings.general.toolbar.files" },
  { key: "stats", labelKey: "settings.general.toolbar.stats" },
  { key: "gitChanges", labelKey: "settings.general.toolbar.gitChanges" },
  { key: "systemResources", labelKey: "settings.general.toolbar.systemResources" },
  { key: "backgroundTasks", labelKey: "settings.general.toolbar.backgroundTasks" },
];

type TerminalToolbarOptionKey = keyof TerminalToolbarVisibilitySettings;

function SortableStatsCardRow({
  id,
  dragLabel,
  title,
  actions,
}: {
  id: TerminalStatsCardKey | SystemResourceCardKey;
  dragLabel: string;
  title: ReactNode;
  actions: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    transition: DND_SORTABLE_TRANSITION,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0.55 : 1,
    position: "relative",
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
        <Group justify="space-between" align="center" gap="md" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <Tooltip label={dragLabel} withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={dragLabel}
                style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
                {...attributes}
                {...listeners}
              >
                <GripVertical size={14} />
              </ActionIcon>
            </Tooltip>
            {title}
          </Group>
          {actions}
        </Group>
      </Card>
    </div>
  );
}

export function SidebarSettingsPage() {
  const { t } = useI18n();
  const viewMode = useSettingsStore((s) => s.viewMode);
  const sidebarDensity = useSettingsStore((s) => s.sidebarDensity);
  const terminalSidePanelMerged = useSettingsStore((s) => s.terminalSidePanelMerged);
  const terminalSidePanelSingleOpen = useSettingsStore((s) => s.terminalSidePanelSingleOpen);
  const terminalSidePanelSkin = useSettingsStore((s) => s.terminalSidePanelSkin);
  const terminalStatsCardVisibility = useSettingsStore((s) => s.terminalStatsCardVisibility);
  const terminalStatsCardOrder = useSettingsStore((s) => s.terminalStatsCardOrder);
  const systemResourceCardVisibility = useSettingsStore((s) => s.systemResourceCardVisibility);
  const systemResourceCardOrder = useSettingsStore((s) => s.systemResourceCardOrder);
  const terminalToolbarVisibility = useSettingsStore((s) => s.terminalToolbarVisibility);
  const systemResourceMonitoringEnabled = useSettingsStore((s) => s.systemResourceMonitoringEnabled);
  const update = useSettingsStore((s) => s.update);

  const visibleCardCount = TERMINAL_STATS_CARD_KEYS.filter((key) => terminalStatsCardVisibility[key]).length;
  const visibleResourceCardCount = SYSTEM_RESOURCE_CARD_KEYS.filter((key) => systemResourceCardVisibility[key]).length;
  const orderedStatsCardOptions = terminalStatsCardOrder
    .map((key) => STATS_CARD_OPTION_MAP.get(key))
    .filter((option): option is (typeof STATS_CARD_OPTIONS)[number] => Boolean(option));
  const orderedResourceCardOptions = systemResourceCardOrder
    .map((key) => RESOURCE_CARD_OPTION_MAP.get(key))
    .filter((option): option is (typeof RESOURCE_CARD_OPTIONS)[number] => Boolean(option));
  const statsCardSensors = useSensors(useSensor(PointerSensor, { activationConstraint: DND_ACTIVATION_CONSTRAINT }));

  const updateStatsCardVisibility = (key: TerminalStatsCardKey, checked: boolean) => {
    void update("terminalStatsCardVisibility", { ...terminalStatsCardVisibility, [key]: checked });
  };

  const handleStatsCardDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = terminalStatsCardOrder.indexOf(String(active.id) as TerminalStatsCardKey);
    const newIndex = terminalStatsCardOrder.indexOf(String(over.id) as TerminalStatsCardKey);
    if (oldIndex === -1 || newIndex === -1) return;

    void update("terminalStatsCardOrder", arrayMove(terminalStatsCardOrder, oldIndex, newIndex));
  };

  const moveStatsCard = (key: TerminalStatsCardKey, offset: -1 | 1) => {
    const index = terminalStatsCardOrder.indexOf(key);
    const targetIndex = index + offset;
    if (index < 0 || targetIndex < 0 || targetIndex >= terminalStatsCardOrder.length) return;

    const nextOrder = [...terminalStatsCardOrder];
    [nextOrder[index], nextOrder[targetIndex]] = [nextOrder[targetIndex], nextOrder[index]];
    void update("terminalStatsCardOrder", nextOrder);
  };

  const resetStatsCardOrder = () => {
    void update("terminalStatsCardOrder", [...TERMINAL_STATS_CARD_KEYS]);
  };

  const updateResourceCardVisibility = (key: SystemResourceCardKey, checked: boolean) => {
    void update("systemResourceCardVisibility", { ...systemResourceCardVisibility, [key]: checked });
  };

  const handleResourceCardDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = systemResourceCardOrder.indexOf(String(active.id) as SystemResourceCardKey);
    const newIndex = systemResourceCardOrder.indexOf(String(over.id) as SystemResourceCardKey);
    if (oldIndex === -1 || newIndex === -1) return;

    void update("systemResourceCardOrder", arrayMove(systemResourceCardOrder, oldIndex, newIndex));
  };

  const moveResourceCard = (key: SystemResourceCardKey, offset: -1 | 1) => {
    const index = systemResourceCardOrder.indexOf(key);
    const targetIndex = index + offset;
    if (index < 0 || targetIndex < 0 || targetIndex >= systemResourceCardOrder.length) return;

    const nextOrder = [...systemResourceCardOrder];
    [nextOrder[index], nextOrder[targetIndex]] = [nextOrder[targetIndex], nextOrder[index]];
    void update("systemResourceCardOrder", nextOrder);
  };

  const resetResourceCardOrder = () => {
    void update("systemResourceCardOrder", [...SYSTEM_RESOURCE_CARD_KEYS]);
  };

  const updateToolbarVisibility = (key: TerminalToolbarOptionKey, checked: boolean) => {
    void update("terminalToolbarVisibility", { ...terminalToolbarVisibility, [key]: checked });
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

          <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
            <Group justify="space-between" align="center" gap="md" wrap="nowrap">
              <Box>
                <Text size="xs" c="var(--on-surface-variant)">
                  {t("settings.general.singleSidePanel")}
                </Text>
                <Text mt={4} size="xs" lh={1.55} c="var(--text-muted)">
                  {t("settings.general.singleSidePanelDescription")}
                </Text>
              </Box>
              <Switch
                color="cliPrimary"
                checked={terminalSidePanelSingleOpen}
                onChange={(event) => void update("terminalSidePanelSingleOpen", event.currentTarget.checked)}
                aria-label={
                  terminalSidePanelSingleOpen
                    ? t("settings.general.disableSingleSidePanel")
                    : t("settings.general.enableSingleSidePanel")
                }
              />
            </Group>
          </Card>

          <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
            <Group justify="space-between" align="center" gap="md" wrap="nowrap">
              <Box>
                <Text size="xs" c="var(--on-surface-variant)">
                  {t("settings.sidebar.systemResources")}
                </Text>
                <Text mt={4} size="xs" lh={1.55} c="var(--text-muted)">
                  {t("settings.sidebar.systemResourcesDescription")}
                </Text>
              </Box>
              <Switch
                color="cliPrimary"
                checked={systemResourceMonitoringEnabled}
                onChange={(event) => void update("systemResourceMonitoringEnabled", event.currentTarget.checked)}
                aria-label={
                  systemResourceMonitoringEnabled
                    ? t("settings.sidebar.disableSystemResources")
                    : t("settings.sidebar.enableSystemResources")
                }
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
          <DndContext
            sensors={statsCardSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleStatsCardDragEnd}
          >
            <SortableContext items={orderedStatsCardOptions.map((option) => option.key)} strategy={verticalListSortingStrategy}>
              <Stack gap="xs">
                {orderedStatsCardOptions.map((option, index) => {
                  const label = t(option.labelKey);
                  const isFirst = index === 0;
                  const isLast = index === orderedStatsCardOptions.length - 1;
                  return (
                    <SortableStatsCardRow
                      key={option.key}
                      id={option.key}
                      dragLabel={t("settings.sidebar.dragStatsCard", { item: label })}
                      title={
                        <Text size="xs" c="var(--on-surface-variant)" style={{ minWidth: 0 }}>
                          {label}
                        </Text>
                      }
                      actions={
                        <Group gap="xs" wrap="nowrap">
                          <Group gap={4} wrap="nowrap">
                            <Tooltip label={t("settings.sidebar.moveStatsCardUp", { item: label })} withArrow>
                              <ActionIcon
                                variant="subtle"
                                color="cliPrimary"
                                size="sm"
                                disabled={isFirst}
                                onClick={() => moveStatsCard(option.key, -1)}
                                aria-label={t("settings.sidebar.moveStatsCardUp", { item: label })}
                              >
                                <ArrowUp size={14} />
                              </ActionIcon>
                            </Tooltip>
                            <Tooltip label={t("settings.sidebar.moveStatsCardDown", { item: label })} withArrow>
                              <ActionIcon
                                variant="subtle"
                                color="cliPrimary"
                                size="sm"
                                disabled={isLast}
                                onClick={() => moveStatsCard(option.key, 1)}
                                aria-label={t("settings.sidebar.moveStatsCardDown", { item: label })}
                              >
                                <ArrowDown size={14} />
                              </ActionIcon>
                            </Tooltip>
                          </Group>
                          <Switch
                            color="cliPrimary"
                            checked={terminalStatsCardVisibility[option.key]}
                            onChange={(event) => updateStatsCardVisibility(option.key, event.currentTarget.checked)}
                            aria-label={
                              terminalStatsCardVisibility[option.key]
                                ? t("settings.sidebar.hideStatsCard", { item: label })
                                : t("settings.sidebar.showStatsCard", { item: label })
                            }
                          />
                        </Group>
                      }
                    />
                  );
                })}
              </Stack>
            </SortableContext>
          </DndContext>
          <Group justify="flex-end">
            <Button
              variant="subtle"
              size="xs"
              onClick={resetStatsCardOrder}
            >
              {t("settings.sidebar.resetStatsCardOrder")}
            </Button>
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
          <Group justify="space-between" align="center">
            <Text size="sm" fw={600} c="var(--on-surface)">
              {t("settings.sidebar.resourceCards")}
            </Text>
            <Badge variant="light" color="cliPrimary">
              {t("settings.sidebar.visibleCardsCount", {
                visible: visibleResourceCardCount,
                total: SYSTEM_RESOURCE_CARD_KEYS.length,
              })}
            </Badge>
          </Group>
          <DndContext
            sensors={statsCardSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleResourceCardDragEnd}
          >
            <SortableContext items={orderedResourceCardOptions.map((option) => option.key)} strategy={verticalListSortingStrategy}>
              <Stack gap="xs">
                {orderedResourceCardOptions.map((option, index) => {
                  const label = t(option.labelKey);
                  const isFirst = index === 0;
                  const isLast = index === orderedResourceCardOptions.length - 1;
                  return (
                    <SortableStatsCardRow
                      key={option.key}
                      id={option.key}
                      dragLabel={t("settings.sidebar.dragResourceCard", { item: label })}
                      title={
                        <Text size="xs" c="var(--on-surface-variant)" style={{ minWidth: 0 }}>
                          {label}
                        </Text>
                      }
                      actions={
                        <Group gap="xs" wrap="nowrap">
                          <Group gap={4} wrap="nowrap">
                            <Tooltip label={t("settings.sidebar.moveResourceCardUp", { item: label })} withArrow>
                              <ActionIcon
                                variant="subtle"
                                color="cliPrimary"
                                size="sm"
                                disabled={isFirst}
                                onClick={() => moveResourceCard(option.key, -1)}
                                aria-label={t("settings.sidebar.moveResourceCardUp", { item: label })}
                              >
                                <ArrowUp size={14} />
                              </ActionIcon>
                            </Tooltip>
                            <Tooltip label={t("settings.sidebar.moveResourceCardDown", { item: label })} withArrow>
                              <ActionIcon
                                variant="subtle"
                                color="cliPrimary"
                                size="sm"
                                disabled={isLast}
                                onClick={() => moveResourceCard(option.key, 1)}
                                aria-label={t("settings.sidebar.moveResourceCardDown", { item: label })}
                              >
                                <ArrowDown size={14} />
                              </ActionIcon>
                            </Tooltip>
                          </Group>
                          <Switch
                            color="cliPrimary"
                            checked={systemResourceCardVisibility[option.key]}
                            onChange={(event) => updateResourceCardVisibility(option.key, event.currentTarget.checked)}
                            aria-label={
                              systemResourceCardVisibility[option.key]
                                ? t("settings.sidebar.hideResourceCard", { item: label })
                                : t("settings.sidebar.showResourceCard", { item: label })
                            }
                          />
                        </Group>
                      }
                    />
                  );
                })}
              </Stack>
            </SortableContext>
          </DndContext>
          <Group justify="flex-end">
            <Button
              variant="subtle"
              size="xs"
              onClick={resetResourceCardOrder}
            >
              {t("settings.sidebar.resetResourceCardOrder")}
            </Button>
            <Button
              variant="subtle"
              size="xs"
              onClick={() => void update("systemResourceCardVisibility", {
                system: true,
                cpu: true,
                memory: true,
                network: true,
                disk: true,
                gpu: true,
                processes: true,
              })}
            >
              {t("settings.sidebar.showAllResourceCards")}
            </Button>
          </Group>
        </Stack>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="sm">
          <Text size="sm" fw={600} c="var(--on-surface)">
            {t("settings.general.toolbar")}
          </Text>
          <Text size="xs" fw={600} c="var(--on-surface-variant)" mt="xs">
            {t("settings.general.terminalToolbar")}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
            {TERMINAL_TOOLBAR_OPTIONS.map((option) => (
              <Card key={option.key} className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
                <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                  <Text size="xs" c="var(--on-surface-variant)">
                    {t(option.labelKey)}
                  </Text>
                  <Switch
                    color="cliPrimary"
                    checked={terminalToolbarVisibility[option.key]}
                    onChange={(event) => updateToolbarVisibility(option.key, event.currentTarget.checked)}
                    aria-label={
                      terminalToolbarVisibility[option.key]
                        ? t("settings.general.toolbar.hide", { item: t(option.labelKey) })
                        : t("settings.general.toolbar.show", { item: t(option.labelKey) })
                    }
                  />
                </Group>
              </Card>
            ))}
          </SimpleGrid>
        </Stack>
      </section>
    </Stack>
  );
}
