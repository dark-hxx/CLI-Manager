import { Badge, Box, Card, Group, SimpleGrid, Stack, Text, UnstyledButton } from "@mantine/core";
import type { TerminalThemeGroupId, TerminalThemePreset } from "../../../lib/terminalThemes";
import { pickByLanguage, useI18n } from "../../../lib/i18n";

export const SWATCH_KEYS = ["background", "foreground", "red", "green", "blue", "cyan"] as const;

export const TERMINAL_THEME_GROUP_LABEL_KEYS: Record<TerminalThemeGroupId, {
  label: Parameters<ReturnType<typeof useI18n>["t"]>[0];
  description: Parameters<ReturnType<typeof useI18n>["t"]>[0];
}> = {
  cool: {
    label: "settings.terminalTheme.group.cool.label",
    description: "settings.terminalTheme.group.cool.description",
  },
  warm: {
    label: "settings.terminalTheme.group.warm.label",
    description: "settings.terminalTheme.group.warm.description",
  },
  nature: {
    label: "settings.terminalTheme.group.nature.label",
    description: "settings.terminalTheme.group.nature.description",
  },
  "pink-purple": {
    label: "settings.terminalTheme.group.pinkPurple.label",
    description: "settings.terminalTheme.group.pinkPurple.description",
  },
  "high-contrast": {
    label: "settings.terminalTheme.group.highContrast.label",
    description: "settings.terminalTheme.group.highContrast.description",
  },
  "light-office": {
    label: "settings.terminalTheme.group.lightOffice.label",
    description: "settings.terminalTheme.group.lightOffice.description",
  },
};

export interface TerminalThemePresetGridGroup {
  id: TerminalThemeGroupId;
  presets: TerminalThemePreset[];
}

interface TerminalThemePresetGridProps {
  groups: TerminalThemePresetGridGroup[];
  isSelected: (preset: TerminalThemePreset) => boolean;
  onSelect: (preset: TerminalThemePreset) => void;
}

/**
 * Shared preset picker for every terminal theme library surface (terminal theme and
 * preview theme). Filtering, search, and mode special cases stay with the host section;
 * this component only renders groups, cards, and the selected state.
 */
export function TerminalThemePresetGrid({ groups, isSelected, onSelect }: TerminalThemePresetGridProps) {
  const { language, t } = useI18n();
  const text = (zh: string, en: string) => pickByLanguage(language, zh, en);

  return (
    <Stack gap="md">
      {groups.map((group) => (
        <section key={group.id}>
          <Group mb="xs" gap="xs" align="baseline">
            <Text size="xs" fw={600} c="var(--on-surface)">
              {t(TERMINAL_THEME_GROUP_LABEL_KEYS[group.id].label)}
            </Text>
            <Text size="xs" c="var(--text-muted)">
              {t(TERMINAL_THEME_GROUP_LABEL_KEYS[group.id].description)}
            </Text>
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="xs">
            {group.presets.map((preset) => {
              const active = isSelected(preset);
              return (
                <UnstyledButton
                  key={preset.id}
                  onClick={() => onSelect(preset)}
                  className="ui-interactive ui-focus-ring ui-selection-card relative rounded-xl border p-4 text-left transition-[transform,box-shadow,border-color,background-color]"
                  data-selected={active ? "true" : "false"}
                  aria-pressed={active}
                  w="100%"
                  style={{
                    display: "block",
                    minHeight: 108,
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
                  {active && (
                    <Badge
                      className="absolute right-3 top-3"
                      size="xs"
                      variant="light"
                      style={{
                        backgroundColor: "color-mix(in srgb, var(--primary) 10%, transparent)",
                        border: "1px solid color-mix(in srgb, var(--primary) 22%, transparent)",
                        color: "var(--primary)",
                      }}
                    >
                      {text("当前", "Current")}
                    </Badge>
                  )}
                  <Stack gap={8} pr={active ? 48 : 0} style={{ minWidth: 0, padding: "4px 8px 2px" }}>
                    <Stack gap={2}>
                      <Text
                        size="sm"
                        fw={600}
                        c={active ? "var(--on-surface)" : "var(--on-surface-variant)"}
                        style={{ whiteSpace: "normal", overflowWrap: "anywhere", lineHeight: 1.25 }}
                      >
                        {preset.name}
                      </Text>
                      <Text
                        size="xs"
                        lh={1.55}
                        c={active ? "var(--on-surface-variant)" : "var(--text-muted)"}
                        style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}
                      >
                        {preset.tone === "light" ? text("浅色", "Light") : text("深色", "Dark")}{preset.family ? ` · ${preset.family}` : ""}
                      </Text>
                    </Stack>
                    <Group gap={6}>
                      {SWATCH_KEYS.map((key) => (
                        <Box
                          key={key}
                          component="span"
                          w={16}
                          h={16}
                          className="h-4 w-4 rounded-[4px] border"
                          style={{
                            backgroundColor:
                              (preset.theme as Record<string, string | undefined>)[key] ??
                              "var(--surface-container-lowest)",
                            borderColor: active ? "color-mix(in srgb, var(--primary) 48%, var(--border))" : "var(--border)",
                            boxShadow: "none",
                          }}
                        />
                      ))}
                    </Group>
                  </Stack>
                </UnstyledButton>
              );
            })}
          </SimpleGrid>
        </section>
      ))}
      {groups.length === 0 && (
        <Card className="border border-dashed border-border bg-surface-container-lowest text-center" p="lg" radius="lg">
          <Text size="xs" c="var(--on-surface-variant)">
            {text("未找到匹配主题", "No matching themes")}
          </Text>
        </Card>
      )}
    </Stack>
  );
}
