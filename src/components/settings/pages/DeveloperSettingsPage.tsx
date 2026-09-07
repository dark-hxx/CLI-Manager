import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Box, Card, Group, Select, Stack, Switch, Text } from "@mantine/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { Bug, Copy, Cpu, EyeOff, GitBranch, HardDrive, History, Link2, MonitorCog } from "lucide-react";
import { toast } from "sonner";
import {
  LINUX_GRAPHICS_MODES,
  useSettingsStore,
  type LinuxGraphicsMode,
} from "../../../stores/settingsStore";
import { getOsPlatform, type OsPlatform } from "../../../lib/shell";
import { useI18n, type TranslationKey } from "../../../lib/i18n";
import {
  formatLinuxGraphicsDiagnostics,
  getLinuxGraphicsDiagnostics,
  type LinuxGraphicsDiagnostics,
} from "../../../lib/linuxGraphics";
import { ConfirmDialog } from "../../ConfirmDialog";

interface SettingSwitchCardProps {
  icon: ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}

function SettingSwitchCard({
  icon,
  title,
  description,
  checked,
  onChange,
  ariaLabel,
}: SettingSwitchCardProps) {
  return (
    <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
      <Group justify="space-between" align="center" gap="md" wrap="nowrap">
        <Group gap="sm" align="flex-start" wrap="nowrap" style={{ minWidth: 0 }}>
          <Box style={{ color: "var(--primary)", marginTop: 2 }}>{icon}</Box>
          <Box style={{ minWidth: 0 }}>
            <Text size="xs" c="var(--on-surface-variant)">
              {title}
            </Text>
            <Text mt={4} size="xs" lh={1.55} c="var(--text-muted)">
              {description}
            </Text>
          </Box>
        </Group>
        <Switch
          color="cliPrimary"
          checked={checked}
          onChange={(event) => onChange(event.currentTarget.checked)}
          aria-label={ariaLabel}
        />
      </Group>
    </Card>
  );
}

export function DeveloperSettingsPage() {
  const { t } = useI18n();
  const windowsConptyCompatibilityFixEnabled = useSettingsStore((s) => s.windowsConptyCompatibilityFixEnabled);
  const hideCodexRuntimeCursor = useSettingsStore((s) => s.hideCodexRuntimeCursor);
  const terminalSessionRestoreEnabled = useSettingsStore((s) => s.terminalSessionRestoreEnabled);
  const projectWorktreeConfigEnabled = useSettingsStore((s) => s.projectWorktreeConfigEnabled);
  const symlinkCompatibilityEnabled = useSettingsStore((s) => s.symlinkCompatibilityEnabled);
  const lowMemoryMode = useSettingsStore((s) => s.lowMemoryMode);
  const disableHardwareAcceleration = useSettingsStore((s) => s.disableHardwareAcceleration);
  const linuxGraphicsMode = useSettingsStore((s) => s.linuxGraphicsMode);
  const debugMode = useSettingsStore((s) => s.debugMode);
  const update = useSettingsStore((s) => s.update);
  const [osPlatform, setOsPlatform] = useState<OsPlatform>("unknown");
  const [graphicsDiagnostics, setGraphicsDiagnostics] = useState<LinuxGraphicsDiagnostics | null>(null);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [restartMessageKey, setRestartMessageKey] = useState<TranslationKey>(
    "settings.developer.restartRequiredMessage"
  );

  useEffect(() => {
    let cancelled = false;
    void getOsPlatform().then(async (platform) => {
      if (cancelled) return;
      setOsPlatform(platform);
      if (platform !== "linux") return;
      try {
        const diagnostics = await getLinuxGraphicsDiagnostics();
        if (!cancelled) setGraphicsDiagnostics(diagnostics);
      } catch {
        if (!cancelled) setGraphicsDiagnostics(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateBooleanSetting = (
    key:
      | "symlinkCompatibilityEnabled"
      | "terminalSessionRestoreEnabled"
      | "projectWorktreeConfigEnabled"
      | "lowMemoryMode"
      | "disableHardwareAcceleration"
      | "debugMode"
      | "hideCodexRuntimeCursor",
    value: boolean
  ) => {
    void update(key, value);
  };

  const toggleWindowsConptyCompatibilityFix = (checked: boolean) => {
    void update("windowsConptyCompatibilityFixEnabled", checked).then(() => {
      setRestartMessageKey("settings.developer.restartRequiredMessage");
      setRestartConfirmOpen(true);
    });
  };

  const updateLinuxGraphicsMode = (value: string | null) => {
    if (!value || !LINUX_GRAPHICS_MODES.includes(value as LinuxGraphicsMode)) return;
    void update("linuxGraphicsMode", value as LinuxGraphicsMode).then(() => {
      setRestartMessageKey("settings.developer.linuxGraphicsRestartMessage");
      setRestartConfirmOpen(true);
    });
  };

  const copyGraphicsDiagnostics = async () => {
    if (!graphicsDiagnostics) return;
    try {
      await navigator.clipboard.writeText(formatLinuxGraphicsDiagnostics(graphicsDiagnostics));
      toast.success(t("settings.developer.graphicsDiagnosticsCopied"));
    } catch (err) {
      toast.error(t("settings.developer.graphicsDiagnosticsCopyFailed"), { description: String(err) });
    }
  };

  const restartNow = async () => {
    try {
      await relaunch();
    } catch (err) {
      toast.error(t("settings.developer.restartFailed"), { description: String(err) });
    }
  };

  const developerCards: {
    key: string;
    icon: ReactNode;
    titleKey: TranslationKey;
    descriptionKey: TranslationKey;
    checked: boolean;
    onChange: (checked: boolean) => void;
    enabledLabelKey: TranslationKey;
    disabledLabelKey: TranslationKey;
  }[] = [
    {
      key: "terminalSessionRestoreEnabled",
      icon: <History size={16} />,
      titleKey: "settings.developer.terminalSessionRestore",
      descriptionKey: "settings.developer.terminalSessionRestoreDescription",
      checked: terminalSessionRestoreEnabled,
      onChange: (checked) => updateBooleanSetting("terminalSessionRestoreEnabled", checked),
      enabledLabelKey: "settings.developer.disableTerminalSessionRestore",
      disabledLabelKey: "settings.developer.enableTerminalSessionRestore",
    },
    {
      key: "projectWorktreeConfigEnabled",
      icon: <GitBranch size={16} />,
      titleKey: "settings.developer.projectWorktreeConfig",
      descriptionKey: "settings.developer.projectWorktreeConfigDescription",
      checked: projectWorktreeConfigEnabled,
      onChange: (checked) => updateBooleanSetting("projectWorktreeConfigEnabled", checked),
      enabledLabelKey: "settings.developer.disableProjectWorktreeConfig",
      disabledLabelKey: "settings.developer.enableProjectWorktreeConfig",
    },
    {
      key: "symlinkCompatibilityEnabled",
      icon: <Link2 size={16} />,
      titleKey: "settings.general.symlinkCompatibility",
      descriptionKey: "settings.general.symlinkCompatibilityDescription",
      checked: symlinkCompatibilityEnabled,
      onChange: (checked) => updateBooleanSetting("symlinkCompatibilityEnabled", checked),
      enabledLabelKey: "settings.general.disableSymlinkCompatibility",
      disabledLabelKey: "settings.general.enableSymlinkCompatibility",
    },
    {
      key: "lowMemoryMode",
      icon: <HardDrive size={16} />,
      titleKey: "settings.general.lowMemoryMode",
      descriptionKey: "settings.general.lowMemoryModeDescription",
      checked: lowMemoryMode,
      onChange: (checked) => updateBooleanSetting("lowMemoryMode", checked),
      enabledLabelKey: "settings.general.disableLowMemoryMode",
      disabledLabelKey: "settings.general.enableLowMemoryMode",
    },
    {
      key: "disableHardwareAcceleration",
      icon: <Cpu size={16} />,
      titleKey: "settings.general.disableHardwareAcceleration",
      descriptionKey: "settings.general.disableHardwareAccelerationDescription",
      checked: disableHardwareAcceleration,
      onChange: (checked) => updateBooleanSetting("disableHardwareAcceleration", checked),
      enabledLabelKey: "settings.general.allowHardwareAcceleration",
      disabledLabelKey: "settings.general.disableHardwareAccelerationAction",
    },
    {
      key: "debugMode",
      icon: <Bug size={16} />,
      titleKey: "settings.general.debugMode",
      descriptionKey: "settings.developer.debugModeDescription",
      checked: debugMode,
      onChange: (checked) => updateBooleanSetting("debugMode", checked),
      enabledLabelKey: "settings.general.disableDebugMode",
      disabledLabelKey: "settings.general.enableDebugMode",
    },
  ];

  return (
    <Stack gap="md">
      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="sm">
          <Box>
            <Text size="sm" fw={600} c="var(--on-surface)">
              {t("settings.developer.compatibility")}
            </Text>
            <Text mt={4} size="xs" c="var(--text-muted)">
              {t("settings.developer.compatibilityDescription")}
            </Text>
          </Box>

          {osPlatform === "windows" && (
            <>
              <SettingSwitchCard
                icon={<MonitorCog size={16} />}
                title={t("settings.developer.windowsConptyCompatibilityFix")}
                description={t("settings.developer.windowsConptyCompatibilityFixDescription")}
                checked={windowsConptyCompatibilityFixEnabled}
                onChange={toggleWindowsConptyCompatibilityFix}
                ariaLabel={
                  windowsConptyCompatibilityFixEnabled
                    ? t("settings.developer.disableWindowsConptyCompatibilityFix")
                    : t("settings.developer.enableWindowsConptyCompatibilityFix")
                }
              />
              <SettingSwitchCard
                icon={<EyeOff size={16} />}
                title={t("settings.developer.hideCodexRuntimeCursor")}
                description={t("settings.developer.hideCodexRuntimeCursorDescription")}
                checked={hideCodexRuntimeCursor}
                onChange={(checked) => updateBooleanSetting("hideCodexRuntimeCursor", checked)}
                ariaLabel={
                  hideCodexRuntimeCursor
                    ? t("settings.developer.disableHideCodexRuntimeCursor")
                    : t("settings.developer.enableHideCodexRuntimeCursor")
                }
              />
            </>
          )}

          {osPlatform === "linux" && (
            <Box className="rounded-lg border border-border bg-surface-container-lowest p-3">
              <Text size="xs" fw={600} c="var(--on-surface)">
                {t("settings.developer.linuxGraphicsMode")}
              </Text>
              <Text mt={4} size="xs" lh={1.55} c="var(--text-muted)">
                {t("settings.developer.linuxGraphicsModeDescription")}
              </Text>
              <Select
                mt="sm"
                size="xs"
                allowDeselect={false}
                value={linuxGraphicsMode}
                onChange={updateLinuxGraphicsMode}
                aria-label={t("settings.developer.linuxGraphicsMode")}
                data={[
                  { value: "auto", label: t("settings.developer.linuxGraphicsModeAuto") },
                  { value: "system", label: t("settings.developer.linuxGraphicsModeSystem") },
                  { value: "disable-dmabuf", label: t("settings.developer.linuxGraphicsModeDisableDmabuf") },
                  { value: "disable-compositing", label: t("settings.developer.linuxGraphicsModeDisableCompositing") },
                ]}
              />

              {graphicsDiagnostics && (
                <Box mt="sm">
                  <Group justify="space-between" gap="sm">
                    <Text size="xs" fw={600} c="var(--on-surface-variant)">
                      {t("settings.developer.graphicsDiagnostics")}
                    </Text>
                    <button
                      type="button"
                      onClick={() => void copyGraphicsDiagnostics()}
                      className="ui-interactive ui-focus-ring inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-on-surface-variant"
                      aria-label={t("settings.developer.copyGraphicsDiagnostics")}
                      title={t("settings.developer.copyGraphicsDiagnostics")}
                    >
                      <Copy size={13} />
                      {t("common.copy")}
                    </button>
                  </Group>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-container-high p-2 text-[11px] leading-5 text-on-surface-variant">
                    {formatLinuxGraphicsDiagnostics(graphicsDiagnostics)}
                  </pre>
                </Box>
              )}
            </Box>
          )}

          {developerCards.map((card) => (
            <SettingSwitchCard
              key={card.key}
              icon={card.icon}
              title={t(card.titleKey)}
              description={t(card.descriptionKey)}
              checked={card.checked}
              onChange={card.onChange}
              ariaLabel={card.checked ? t(card.enabledLabelKey) : t(card.disabledLabelKey)}
            />
          ))}
        </Stack>
      </section>

      <ConfirmDialog
        open={restartConfirmOpen}
        title={t("settings.developer.restartRequiredTitle")}
        message={t(restartMessageKey)}
        confirmText={t("settings.developer.restartNow")}
        cancelText={t("settings.developer.restartLater")}
        onConfirm={() => void restartNow()}
        onClose={() => setRestartConfirmOpen(false)}
      />
    </Stack>
  );
}
