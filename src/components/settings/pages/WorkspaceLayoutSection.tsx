import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, RotateCcw } from "lucide-react";
import { Box, Button, Group, SimpleGrid, Stack, Text, UnstyledButton } from "@mantine/core";
import { useI18n } from "../../../lib/i18n";
import { useSettingsStore } from "../../../stores/settingsStore";
import {
  WORKSPACE_LAYOUT_DEFAULTS,
  type WorkspaceDockSide,
  type WorkspaceLayoutSettings,
  type WorkspanTabBarPosition,
} from "../../../lib/workspaceLayout";

const SIDE_OPTIONS: {
  value: WorkspaceDockSide;
  labelKey: "settings.workspaceLayout.side.left" | "settings.workspaceLayout.side.right";
  descriptionKey: "settings.workspaceLayout.side.leftDescription" | "settings.workspaceLayout.side.rightDescription";
}[] = [
  {
    value: "left",
    labelKey: "settings.workspaceLayout.side.left",
    descriptionKey: "settings.workspaceLayout.side.leftDescription",
  },
  {
    value: "right",
    labelKey: "settings.workspaceLayout.side.right",
    descriptionKey: "settings.workspaceLayout.side.rightDescription",
  },
];

const TAB_POSITION_OPTIONS: {
  value: WorkspanTabBarPosition;
  labelKey: "settings.workspaceLayout.tab.top" | "settings.workspaceLayout.tab.bottom";
  descriptionKey: "settings.workspaceLayout.tab.topDescription" | "settings.workspaceLayout.tab.bottomDescription";
}[] = [
  {
    value: "top",
    labelKey: "settings.workspaceLayout.tab.top",
    descriptionKey: "settings.workspaceLayout.tab.topDescription",
  },
  {
    value: "bottom",
    labelKey: "settings.workspaceLayout.tab.bottom",
    descriptionKey: "settings.workspaceLayout.tab.bottomDescription",
  },
];

export function WorkspaceLayoutSection() {
  const { t } = useI18n();
  const workspaceLayout = useSettingsStore((state) => state.workspaceLayout);
  const update = useSettingsStore((state) => state.update);

  const updateLayout = (patch: Partial<WorkspaceLayoutSettings>) => {
    const next: WorkspaceLayoutSettings = { ...workspaceLayout, ...patch };
    void update("workspaceLayout", next);
  };

  const updateSide = (terminalSidePanelSide: WorkspaceDockSide) => {
    updateLayout({ terminalSidePanelSide });
  };

  const updateTabPosition = (workspanTabBarPosition: WorkspanTabBarPosition) => {
    updateLayout({ workspanTabBarPosition });
  };

  const resetLayout = () => {
    void update("workspaceLayout", { ...WORKSPACE_LAYOUT_DEFAULTS });
  };

  return (
    <section className="ui-surface-card rounded-2xl border border-border p-4">
      <Stack gap="md">
        <Box>
          <Text size="sm" fw={600} c="var(--on-surface)">
            {t("settings.workspaceLayout.title")}
          </Text>
          <Text mt={4} size="xs" c="var(--on-surface-variant)">
            {t("settings.workspaceLayout.description")}
          </Text>
        </Box>

        <Box>
          <Text size="xs" c="var(--on-surface-variant)" mb="xs">
            {t("settings.workspaceLayout.terminalSidePanelSide.label")}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
            {SIDE_OPTIONS.map((option) => {
              const selected = workspaceLayout.terminalSidePanelSide === option.value;
              const Icon = option.value === "left" ? ArrowLeft : ArrowRight;
              return (
                <UnstyledButton
                  key={option.value}
                  type="button"
                  className="ui-interactive ui-focus-ring ui-selection-card rounded-xl border px-4 py-3 text-left"
                  data-selected={selected ? "true" : "false"}
                  aria-pressed={selected}
                  onClick={() => updateSide(option.value)}
                  style={{
                    display: "block",
                    minHeight: 78,
                    minWidth: 0,
                    backgroundColor: selected
                      ? "color-mix(in srgb, var(--primary) 6%, var(--surface-container-lowest))"
                      : "var(--surface-container-lowest)",
                    borderColor: selected
                      ? "color-mix(in srgb, var(--primary) 54%, var(--border))"
                      : "color-mix(in srgb, var(--border) 92%, transparent)",
                  }}
                >
                  <Group gap="sm" wrap="nowrap" align="flex-start">
                    <Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <Box style={{ minWidth: 0 }}>
                      <Text size="sm" fw={600} c={selected ? "var(--on-surface)" : "var(--on-surface-variant)"}>
                        {t(option.labelKey)}
                      </Text>
                      <Text mt={4} size="xs" lh={1.45} c="var(--text-muted)" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                        {t(option.descriptionKey)}
                      </Text>
                    </Box>
                  </Group>
                </UnstyledButton>
              );
            })}
          </SimpleGrid>
        </Box>

        <Box>
          <Text size="xs" c="var(--on-surface-variant)" mb="xs">
            {t("settings.workspaceLayout.workspanTabBarPosition.label")}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
            {TAB_POSITION_OPTIONS.map((option) => {
              const selected = workspaceLayout.workspanTabBarPosition === option.value;
              const Icon = option.value === "top" ? ArrowUp : ArrowDown;
              return (
                <UnstyledButton
                  key={option.value}
                  type="button"
                  className="ui-interactive ui-focus-ring ui-selection-card rounded-xl border px-4 py-3 text-left"
                  data-selected={selected ? "true" : "false"}
                  aria-pressed={selected}
                  onClick={() => updateTabPosition(option.value)}
                  style={{
                    display: "block",
                    minHeight: 78,
                    minWidth: 0,
                    backgroundColor: selected
                      ? "color-mix(in srgb, var(--primary) 6%, var(--surface-container-lowest))"
                      : "var(--surface-container-lowest)",
                    borderColor: selected
                      ? "color-mix(in srgb, var(--primary) 54%, var(--border))"
                      : "color-mix(in srgb, var(--border) 92%, transparent)",
                  }}
                >
                  <Group gap="sm" wrap="nowrap" align="flex-start">
                    <Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <Box style={{ minWidth: 0 }}>
                      <Text size="sm" fw={600} c={selected ? "var(--on-surface)" : "var(--on-surface-variant)"}>
                        {t(option.labelKey)}
                      </Text>
                      <Text mt={4} size="xs" lh={1.45} c="var(--text-muted)" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                        {t(option.descriptionKey)}
                      </Text>
                    </Box>
                  </Group>
                </UnstyledButton>
              );
            })}
          </SimpleGrid>
        </Box>

        <Group justify="flex-end">
          <Button variant="subtle" size="xs" leftSection={<RotateCcw size={13} />} onClick={resetLayout}>
            {t("settings.workspaceLayout.reset")}
          </Button>
        </Group>
      </Stack>
    </section>
  );
}
