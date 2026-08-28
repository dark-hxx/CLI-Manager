import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Box, Button, Card, Group, Kbd, Stack, Text } from "@mantine/core";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  useSettingsStore,
  type ShortcutAction,
  type KeyboardShortcutMap,
  type TabSwitchShortcutModifier,
  type TerminalNewlineShortcut,
} from "../../../stores/settingsStore";
import { eventToCombo } from "../../../hooks/useKeyboardShortcuts";
import { useI18n, type TranslationKey } from "../../../lib/i18n";

const SHORTCUT_LABELS: Record<ShortcutAction, TranslationKey> = {
  newTerminal: "settings.shortcuts.action.newTerminal",
  closeTerminal: "settings.shortcuts.action.closeTerminal",
  nextTab: "settings.shortcuts.action.nextTab",
  prevTab: "settings.shortcuts.action.prevTab",
  commandPalette: "settings.shortcuts.action.commandPalette",
  sessionHistory: "settings.shortcuts.action.sessionHistory",
  copyAi: "settings.shortcuts.action.copyAi",
  copyTerminalSelection: "settings.shortcuts.action.copyTerminalSelection",
  toggleSidebar: "settings.shortcuts.action.toggleSidebar",
  toggleTerminalFullscreen: "settings.shortcuts.action.toggleTerminalFullscreen",
};

const TERMINAL_NEWLINE_OPTIONS: { value: TerminalNewlineShortcut; label: string }[] = [
  { value: "Shift+Enter", label: "Shift + Enter" },
  { value: "Ctrl+Enter", label: "Ctrl + Enter" },
  { value: "Alt+Enter", label: "Alt + Enter" },
];

const TAB_SWITCH_OPTIONS: { value: TabSwitchShortcutModifier; labelKey: TranslationKey }[] = [
  { value: "Alt", labelKey: "settings.shortcuts.tabModifier.alt" },
  { value: "Ctrl", labelKey: "settings.shortcuts.tabModifier.ctrl" },
  { value: "Shift", labelKey: "settings.shortcuts.tabModifier.shift" },
];

interface ShortcutSettingsPageProps {
  searchValue: string;
}

export function ShortcutSettingsPage({ searchValue }: ShortcutSettingsPageProps) {
  const { t } = useI18n();
  const shortcuts = useSettingsStore((s) => s.keyboardShortcuts);
  const terminalNewlineShortcut = useSettingsStore((s) => s.terminalNewlineShortcut);
  const osc52ClipboardEnabled = useSettingsStore((s) => s.osc52ClipboardEnabled);
  const osc52ClipboardQueryEnabled = useSettingsStore((s) => s.osc52ClipboardQueryEnabled);
  const update = useSettingsStore((s) => s.update);
  const [recording, setRecording] = useState<ShortcutAction | null>(null);

  const currentTabSwitchModifier = useMemo<TabSwitchShortcutModifier | null>(() => {
    const option = TAB_SWITCH_OPTIONS.find(
      (opt) => shortcuts.prevTab === `${opt.value}+ArrowLeft` && shortcuts.nextTab === `${opt.value}+ArrowRight`
    );
    return option?.value ?? null;
  }, [shortcuts.prevTab, shortcuts.nextTab]);

  const updateTabSwitchModifier = useCallback(
    (modifier: TabSwitchShortcutModifier) => {
      void update("keyboardShortcuts", {
        ...shortcuts,
        prevTab: `${modifier}+ArrowLeft`,
        nextTab: `${modifier}+ArrowRight`,
      });
      setRecording(null);
    },
    [shortcuts, update]
  );

  const handleRecord = useCallback(
    (event: KeyboardEvent) => {
      if (!recording) return;
      event.preventDefault();
      event.stopPropagation();
      const combo = eventToCombo(event);
      if (!combo) return;
      const next: KeyboardShortcutMap = { ...shortcuts, [recording]: combo };
      void update("keyboardShortcuts", next);
      setRecording(null);
    },
    [recording, shortcuts, update]
  );

  useEffect(() => {
    if (!recording) return;
    window.addEventListener("keydown", handleRecord, true);
    return () => window.removeEventListener("keydown", handleRecord, true);
  }, [recording, handleRecord]);

  const resetDefaults = () => {
    void update("keyboardShortcuts", DEFAULT_KEYBOARD_SHORTCUTS);
    setRecording(null);
  };

  const clearShortcut = useCallback(
    (action: ShortcutAction) => {
      void update("keyboardShortcuts", { ...shortcuts, [action]: "" });
      setRecording(null);
    },
    [shortcuts, update]
  );

  const keyword = searchValue.trim().toLowerCase();
  const visibleActions = useMemo(() => {
    const all = Object.keys(SHORTCUT_LABELS) as ShortcutAction[];
    if (!keyword) return all;
    return all.filter((action) => t(SHORTCUT_LABELS[action]).toLowerCase().includes(keyword));
  }, [keyword, t]);

  const conflictMap = useMemo(() => {
    const comboToActions = new Map<string, ShortcutAction[]>();
    (Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).forEach((action) => {
      const key = shortcuts[action].trim().toLowerCase();
      if (!key) return;
      const group = comboToActions.get(key) ?? [];
      group.push(action);
      comboToActions.set(key, group);
    });
    const conflictByAction = new Map<ShortcutAction, string>();
    comboToActions.forEach((actions) => {
      if (actions.length <= 1) return;
      actions.forEach((action) => {
        const peer = actions.find((candidate) => candidate !== action);
        if (peer) {
          conflictByAction.set(action, t("settings.shortcuts.conflictWith", { action: t(SHORTCUT_LABELS[peer]) }));
        }
      });
    });
    return conflictByAction;
  }, [shortcuts, t]);

  return (
    <Stack gap="md">
      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="sm">
          <Box>
            <Text size="sm" fw={600} c="var(--on-surface)">
              {t("settings.shortcuts.terminalKeys")}
            </Text>
            <Text mt={4} size="xs" c="var(--on-surface-variant)">
              {t("settings.shortcuts.terminalKeysDescription")}
            </Text>
          </Box>
          <Group gap="xs" aria-label={t("settings.shortcuts.terminalNewlineAria")}>
            {TERMINAL_NEWLINE_OPTIONS.map((opt) => {
              const active = terminalNewlineShortcut === opt.value;
              return (
                <Button
                  key={opt.value}
                  type="button"
                  size="xs"
                  variant={active ? "light" : "default"}
                  color={active ? "cliPrimary" : "gray"}
                  onClick={() => {
                    if (!active) void update("terminalNewlineShortcut", opt.value);
                  }}
                  aria-pressed={active}
                >
                  {opt.label}
                </Button>
              );
            })}
          </Group>
        </Stack>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="sm">
          <Box>
            <Text size="sm" fw={600} c="var(--on-surface)">
              {t("settings.shortcuts.osc52ClipboardQuery")}
            </Text>
            <Text mt={4} size="xs" c="var(--on-surface-variant)">
              {t("settings.shortcuts.osc52ClipboardQueryDescription")}
            </Text>
          </Box>
          <Group gap="xs" aria-label={t("settings.shortcuts.osc52ClipboardQueryAria")}>
            <Button
              type="button"
              size="xs"
              variant={osc52ClipboardQueryEnabled ? "light" : "default"}
              color={osc52ClipboardQueryEnabled ? "cliPrimary" : "gray"}
              onClick={() => {
                if (!osc52ClipboardQueryEnabled) void update("osc52ClipboardQueryEnabled", true);
              }}
              aria-pressed={osc52ClipboardQueryEnabled}
            >
              {t("settings.shortcuts.osc52ClipboardOn")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant={!osc52ClipboardQueryEnabled ? "light" : "default"}
              color={!osc52ClipboardQueryEnabled ? "cliPrimary" : "gray"}
              onClick={() => {
                if (osc52ClipboardQueryEnabled) void update("osc52ClipboardQueryEnabled", false);
              }}
              aria-pressed={!osc52ClipboardQueryEnabled}
            >
              {t("settings.shortcuts.osc52ClipboardOff")}
            </Button>
          </Group>
        </Stack>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="sm">
          <Box>
            <Text size="sm" fw={600} c="var(--on-surface)">
              {t("settings.shortcuts.osc52Clipboard")}
            </Text>
            <Text mt={4} size="xs" c="var(--on-surface-variant)">
              {t("settings.shortcuts.osc52ClipboardDescription")}
            </Text>
          </Box>
          <Group gap="xs" aria-label={t("settings.shortcuts.osc52ClipboardAria")}>
            <Button
              type="button"
              size="xs"
              variant={osc52ClipboardEnabled ? "light" : "default"}
              color={osc52ClipboardEnabled ? "cliPrimary" : "gray"}
              onClick={() => {
                if (!osc52ClipboardEnabled) void update("osc52ClipboardEnabled", true);
              }}
              aria-pressed={osc52ClipboardEnabled}
            >
              {t("settings.shortcuts.osc52ClipboardOn")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant={!osc52ClipboardEnabled ? "light" : "default"}
              color={!osc52ClipboardEnabled ? "cliPrimary" : "gray"}
              onClick={() => {
                if (osc52ClipboardEnabled) void update("osc52ClipboardEnabled", false);
              }}
              aria-pressed={!osc52ClipboardEnabled}
            >
              {t("settings.shortcuts.osc52ClipboardOff")}
            </Button>
          </Group>
        </Stack>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="sm">
          <Box>
            <Text size="sm" fw={600} c="var(--on-surface)">
              {t("settings.shortcuts.tabSwitch")}
            </Text>
            <Text mt={4} size="xs" c="var(--on-surface-variant)">
              {t("settings.shortcuts.tabSwitchDescription")}
            </Text>
          </Box>
          <Group gap="xs">
            {TAB_SWITCH_OPTIONS.map((opt) => {
              const active = currentTabSwitchModifier === opt.value;
              return (
                <Button
                  key={opt.value}
                  type="button"
                  size="xs"
                  variant={active ? "light" : "default"}
                  color={active ? "cliPrimary" : "gray"}
                  onClick={() => {
                    if (!active) updateTabSwitchModifier(opt.value);
                  }}
                  aria-pressed={active}
                >
                  {t(opt.labelKey)}
                </Button>
              );
            })}
          </Group>
          {currentTabSwitchModifier === null && (
            <Text size="xs" c="var(--on-surface-variant)">
              {t("settings.shortcuts.customTabSwitch")}
            </Text>
          )}
        </Stack>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="sm">
          <Group justify="space-between" align="center" gap="md">
            <Text size="sm" fw={600} c="var(--on-surface)">
              {t("settings.shortcuts.bindings")}
            </Text>
            <Button type="button" size="xs" variant="default" color="gray" onClick={resetDefaults}>
              {t("settings.shortcuts.resetDefault")}
            </Button>
          </Group>

          <Stack gap="xs">
          {visibleActions.map((action) => {
            const conflict = conflictMap.get(action);
            const isRecording = recording === action;
            return (
              <Card
                key={action}
                className={`border ${conflict ? "border-warning/60" : "border-border"}`}
                p="sm"
                radius="lg"
                style={{
                  backgroundColor: conflict
                    ? "color-mix(in srgb, var(--warning) 10%, var(--surface-container-high) 90%)"
                    : "var(--surface-container-high)",
                }}
              >
                <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                  <Box className="min-w-0">
                    <Text size="sm" fw={500} c="var(--on-surface)">
                      {t(SHORTCUT_LABELS[action])}
                    </Text>
                    {conflict && (
                      <Text mt={2} size="xs" c="var(--warning)">
                        {conflict}
                      </Text>
                    )}
                  </Box>
                  <Group gap="xs" className="shrink-0">
                    {isRecording ? (
                      <>
                        <Badge color="cliPrimary" variant="filled" className="animate-pulse">
                          {t("settings.shortcuts.recording")}
                        </Badge>
                        <Button
                          type="button"
                          size="xs"
                          variant="default"
                          color="gray"
                          onClick={() => clearShortcut(action)}
                        >
                          {t("settings.shortcuts.clear")}
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="subtle"
                          color="cliPrimary"
                          onClick={() => setRecording(null)}
                        >
                          {t("common.cancel")}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Kbd
                          className="min-w-[108px] text-center"
                          style={{ color: shortcuts[action].trim() ? "var(--on-surface)" : "var(--on-surface-variant)" }}
                        >
                          {shortcuts[action].trim() || t("settings.shortcuts.notSet")}
                        </Kbd>
                        <Button
                          type="button"
                          size="xs"
                          variant="subtle"
                          color="cliPrimary"
                          onClick={() => setRecording(action)}
                        >
                          {t("settings.shortcuts.change")}
                        </Button>
                      </>
                    )}
                  </Group>
                </Group>
              </Card>
            );
          })}
          {visibleActions.length === 0 && (
            <Card className="border border-dashed border-border bg-surface-container-lowest text-center" p="lg" radius="lg">
              <Text size="xs" c="var(--on-surface-variant)">
                {t("settings.shortcuts.noMatches")}
              </Text>
            </Card>
          )}
          </Stack>
        </Stack>
      </section>
    </Stack>
  );
}
