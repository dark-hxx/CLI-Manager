import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Slider,
  Stack,
  Switch,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { toast } from "sonner";
import {
  useSettingsStore,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  type DarkThemePalette,
  type LanguagePreference,
  type LightThemePalette,
  type ThemeMode,
} from "../../../stores/settingsStore";
import { LANGUAGE_OPTIONS, useI18n, type TranslationKey } from "../../../lib/i18n";
import {
  getContrastRatioFromHex,
  MIN_APPLY_CONTRAST_RATIO,
  MIN_READABLE_CONTRAST_RATIO,
} from "../../../lib/contrast";
import {
  listSystemFonts,
  mergeFontFamilyOptions,
  type SystemFontFamily,
} from "../../../lib/systemFonts";
import { resolveCcusageWslTarget, useCcusageStore } from "../../../stores/ccusageStore";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { FontFamilySelect } from "../FontFamilySelect";

const WSL_BUN_INSTALL_COMMAND = "curl -fsSL https://bun.net.cn/install | bash";
const WSL_CCUSAGE_INSTALL_COMMAND = "~/.bun/bin/bun install -g ccusage";
const WSL_VERIFY_COMMAND = "~/.bun/bin/bun --version && ~/.bun/bin/bunx ccusage --help";

const LIGHT_PALETTE_OPTIONS: {
  value: LightThemePalette;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  swatches: [string, string, string];
}[] = [
  {
    value: "warm-paper",
    labelKey: "settings.palette.light.warmPaper.label",
    descriptionKey: "settings.palette.light.warmPaper.description",
    swatches: ["#f8f4ec", "#2d261d", "#c46a2d"],
  },
  {
    value: "cream-green",
    labelKey: "settings.palette.light.creamGreen.label",
    descriptionKey: "settings.palette.light.creamGreen.description",
    swatches: ["#f6f7f1", "#1f2a20", "#3f7a4f"],
  },
  {
    value: "ink-red",
    labelKey: "settings.palette.light.inkRed.label",
    descriptionKey: "settings.palette.light.inkRed.description",
    swatches: ["#f7f7f5", "#1f1f1c", "#c43d2f"],
  },
  {
    value: "emerald-mist",
    labelKey: "settings.palette.light.emeraldMist.label",
    descriptionKey: "settings.palette.light.emeraldMist.description",
    swatches: ["#fbfdfc", "#18211d", "#039d74"],
  },
  {
    value: "saas-analytics-dashboard",
    labelKey: "settings.palette.light.saasAnalyticsDashboard.label",
    descriptionKey: "settings.palette.light.saasAnalyticsDashboard.description",
    swatches: ["#f8fbff", "#1e293b", "#3b82f6"],
  },
  {
    value: "apple-pure",
    labelKey: "settings.palette.light.applePure.label",
    descriptionKey: "settings.palette.light.applePure.description",
    swatches: ["#ffffff", "#1d1d1f", "#007aff"],
  },
  {
    value: "apple-mist",
    labelKey: "settings.palette.light.appleMist.label",
    descriptionKey: "settings.palette.light.appleMist.description",
    swatches: ["#fcfcfd", "#1c1f23", "#0a84ff"],
  },
  {
    value: "apple-warm",
    labelKey: "settings.palette.light.appleWarm.label",
    descriptionKey: "settings.palette.light.appleWarm.description",
    swatches: ["#fdfcf9", "#1f1d1a", "#ff9f0a"],
  },
  {
    value: "apple-mono",
    labelKey: "settings.palette.light.appleMono.label",
    descriptionKey: "settings.palette.light.appleMono.description",
    swatches: ["#ffffff", "#1d1d1f", "#3a3a3c"],
  },
];

const DARK_PALETTE_OPTIONS: {
  value: DarkThemePalette;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  swatches: [string, string, string];
}[] = [
  {
    value: "night-indigo",
    labelKey: "settings.palette.dark.nightIndigo.label",
    descriptionKey: "settings.palette.dark.nightIndigo.description",
    swatches: ["#1a1b26", "#c0caf5", "#7aa2f7"],
  },
  {
    value: "forest-night",
    labelKey: "settings.palette.dark.forestNight.label",
    descriptionKey: "settings.palette.dark.forestNight.description",
    swatches: ["#111714", "#d8e5dc", "#52a36e"],
  },
  {
    value: "graphite-red",
    labelKey: "settings.palette.dark.graphiteRed.label",
    descriptionKey: "settings.palette.dark.graphiteRed.description",
    swatches: ["#171616", "#e6dfdb", "#c95b4a"],
  },
  {
    value: "investment-platform",
    labelKey: "settings.palette.dark.investmentPlatform.label",
    descriptionKey: "settings.palette.dark.investmentPlatform.description",
    swatches: ["#0f172a", "#f8fafc", "#f59e0b"],
  },
  {
    value: "github-dark",
    labelKey: "settings.palette.dark.githubDark.label",
    descriptionKey: "settings.palette.dark.githubDark.description",
    swatches: ["#24292f", "#f0f3f6", "#58a6ff"],
  },
  {
    value: "catppuccin-mocha",
    labelKey: "settings.palette.dark.catppuccinMocha.label",
    descriptionKey: "settings.palette.dark.catppuccinMocha.description",
    swatches: ["#1e1e2e", "#cdd6f4", "#89b4fa"],
  },
  {
    value: "terminal-green",
    labelKey: "settings.palette.dark.terminalGreen.label",
    descriptionKey: "settings.palette.dark.terminalGreen.description",
    swatches: ["#0a0a0a", "#e2e2e2", "#3dd68c"],
  },
  {
    value: "dracula-purple",
    labelKey: "settings.palette.dark.draculaPurple.label",
    descriptionKey: "settings.palette.dark.draculaPurple.description",
    swatches: ["#282a36", "#f8f8f2", "#bd93f9"],
  },
  {
    value: "carbon-black",
    labelKey: "settings.palette.dark.carbonBlack.label",
    descriptionKey: "settings.palette.dark.carbonBlack.description",
    swatches: ["#161616", "#f2f4f8", "#78a9ff"],
  },
];

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function clampUiFontSize(value: number) {
  if (!Number.isFinite(value)) return UI_FONT_SIZE_MIN;
  return Math.min(UI_FONT_SIZE_MAX, Math.max(UI_FONT_SIZE_MIN, value));
}

const LIGHT_TEXT_COLORS: Record<LightThemePalette, string> = {
  "warm-paper": "#2e3336",
  "cream-green": "#25302a",
  "ink-red": "#1f1f1c",
  "emerald-mist": "#18211d",
  "saas-analytics-dashboard": "#1e293b",
  "apple-pure": "#1d1d1f",
  "apple-mist": "#1c1f23",
  "apple-warm": "#1f1d1a",
  "apple-mono": "#0f0f10",
};

const DARK_TEXT_COLORS: Record<DarkThemePalette, string> = {
  "night-indigo": "#c0caf5",
  "forest-night": "#d8e5dc",
  "graphite-red": "#e6dfdb",
  "investment-platform": "#f8fafc",
  "github-dark": "#f0f3f6",
  "catppuccin-mocha": "#cdd6f4",
  "terminal-green": "#e2e2e2",
  "dracula-purple": "#f8f8f2",
  "carbon-black": "#f2f4f8",
};

function getDefaultUiTextColor(
  resolvedTheme: "dark" | "light",
  lightPalette: LightThemePalette,
  darkPalette: DarkThemePalette
) {
  return resolvedTheme === "dark" ? DARK_TEXT_COLORS[darkPalette] : LIGHT_TEXT_COLORS[lightPalette];
}

// 与 App.css 各配色块的 --bg-primary 保持一致（同 LIGHT_TEXT_COLORS 的维护方式）。
// 用纯映射而非 getComputedStyle：data-theme/data-*-palette 由 App.tsx 的 effect 在
// render 之后才更新，render 期间读 computed style 会在切换主题/配色时拿到旧背景色。
const LIGHT_BG_COLORS: Record<LightThemePalette, string> = {
  "warm-paper": "#f9f9fb",
  "cream-green": "#f7faf7",
  "ink-red": "#f7f6f4",
  "emerald-mist": "#fbfdfc",
  "saas-analytics-dashboard": "#f8fafc",
  "apple-pure": "#ffffff",
  "apple-mist": "#fcfcfd",
  "apple-warm": "#fdfcf9",
  "apple-mono": "#ffffff",
};

const DARK_BG_COLORS: Record<DarkThemePalette, string> = {
  "night-indigo": "#1a1b26",
  "forest-night": "#111714",
  "graphite-red": "#171616",
  "investment-platform": "#0f172a",
  "github-dark": "#24292f",
  "catppuccin-mocha": "#1e1e2e",
  "terminal-green": "#0a0a0a",
  "dracula-purple": "#282a36",
  "carbon-black": "#161616",
};

function getDefaultUiBgColor(
  resolvedTheme: "dark" | "light",
  lightPalette: LightThemePalette,
  darkPalette: DarkThemePalette
) {
  return resolvedTheme === "dark" ? DARK_BG_COLORS[darkPalette] : LIGHT_BG_COLORS[lightPalette];
}

const UI_FONT_FALLBACK = "\"PingFang SC\", \"Microsoft YaHei\", sans-serif";

const UI_FONT_FAMILY_OPTIONS: { value: string; label: string; labelKey?: TranslationKey }[] = [
  {
    value:
      "\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
    label: "System Default (Segoe UI + CJK fallback)",
    labelKey: "settings.uiFont.systemDefault",
  },
  {
    value: "Inter, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
    label: "Inter",
  },
  {
    value: "\"HarmonyOS Sans\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
    label: "HarmonyOS Sans",
  },
  {
    value: "\"PingFang SC\", \"Microsoft YaHei\", sans-serif",
    label: "苹方 PingFang SC",
    labelKey: "settings.uiFont.pingFang",
  },
  {
    value: "\"Microsoft YaHei\", \"PingFang SC\", sans-serif",
    label: "微软雅黑 Microsoft YaHei",
    labelKey: "settings.uiFont.microsoftYaHei",
  },
  {
    value: "\"Source Han Sans SC\", \"Noto Sans CJK SC\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
    label: "思源黑体 / Source Han Sans",
    labelKey: "settings.uiFont.sourceHanSans",
  },
  {
    value: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    label: "纯系统 UI 字体",
    labelKey: "settings.uiFont.systemUi",
  },
  {
    value: "\"Cascadia Code\", \"PingFang SC\", \"Microsoft YaHei\", monospace",
    label: "Cascadia Code",
  },
  {
    value: "\"JetBrains Mono\", \"PingFang SC\", \"Microsoft YaHei\", monospace",
    label: "JetBrains Mono",
  },
  {
    value: "\"Fira Code\", \"PingFang SC\", \"Microsoft YaHei\", monospace",
    label: "Fira Code",
  },
  {
    value: "Consolas, \"PingFang SC\", \"Microsoft YaHei\", monospace",
    label: "Consolas",
  },
  {
    value: "\"Courier New\", \"PingFang SC\", \"Microsoft YaHei\", monospace",
    label: "Courier New",
  },
];

function PaletteCard({
  active,
  label,
  description,
  activeLabel,
  swatches,
  onClick,
}: {
  active: boolean;
  label: string;
  description: string;
  activeLabel: string;
  swatches: [string, string, string];
  onClick: () => void;
}) {
  return (
    <UnstyledButton
      type="button"
      onClick={onClick}
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
          {activeLabel}
        </Badge>
      )}
      <Stack gap={8} pr={active ? 48 : 0} style={{ minWidth: 0, padding: "4px 8px 2px" }}>
        <Group gap={8}>
          {swatches.map((color, index) => (
            <Box
              key={`${color}-${index}`}
              component="span"
              w={16}
              h={16}
              style={{
                backgroundColor: color,
                border: "1px solid var(--border)",
                borderColor: active ? "color-mix(in srgb, var(--primary) 48%, var(--border))" : "var(--border)",
                borderRadius: 4,
                boxShadow: "none",
              }}
            />
          ))}
        </Group>
        <Stack gap={2}>
          <Text
            size="sm"
            fw={600}
            c={active ? "var(--on-surface)" : "var(--on-surface-variant)"}
            style={{ whiteSpace: "normal", overflowWrap: "anywhere", lineHeight: 1.25 }}
          >
            {label}
          </Text>
          <Text
            size="xs"
            lh={1.55}
            c={active ? "var(--on-surface-variant)" : "var(--text-muted)"}
            style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}
          >
            {description}
          </Text>
        </Stack>
      </Stack>
    </UnstyledButton>
  );
}

export function GeneralSettingsPage() {
  const { t } = useI18n();
  const language = useSettingsStore((s) => s.language);
  const theme = useSettingsStore((s) => s.theme);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
  const uiFontSize = useSettingsStore((s) => s.uiFontSize);
  const uiTextColor = useSettingsStore((s) => s.uiTextColor);
  const ccusageAnalyticsEnabled = useSettingsStore((s) => s.ccusageAnalyticsEnabled);
  const ccusageUseWsl = useSettingsStore((s) => s.ccusageUseWsl);
  const claudeHookConfigDir = useSettingsStore((s) => s.claudeHookConfigDir);
  const codexHookConfigDir = useSettingsStore((s) => s.codexHookConfigDir);
  const sidebarToolbarVisibility = useSettingsStore((s) => s.sidebarToolbarVisibility);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const update = useSettingsStore((s) => s.update);
  const ccusageToolStatus = useCcusageStore((s) => s.toolStatus);
  const ccusageCheckingStatus = useCcusageStore((s) => s.checkingStatus);
  const ccusageError = useCcusageStore((s) => s.error);
  const checkCcusageStatus = useCcusageStore((s) => s.checkStatus);
  const [uiFontSizeDraft, setUiFontSizeDraft] = useState(uiFontSize);
  const [uiTextColorDraft, setUiTextColorDraft] = useState(uiTextColor);
  const [systemFonts, setSystemFonts] = useState<SystemFontFamily[]>([]);
  const [systemFontsLoading, setSystemFontsLoading] = useState(false);
  const [systemFontsError, setSystemFontsError] = useState<string | null>(null);
  const [ccusageWslDialogOpen, setCcusageWslDialogOpen] = useState(false);
  const themeOptions = useMemo<{ value: ThemeMode; label: string }[]>(
    () => [
      { value: "light", label: t("settings.options.theme.light") },
      { value: "dark", label: t("settings.options.theme.dark") },
      { value: "system", label: t("settings.options.theme.system") },
    ],
    [t]
  );
  useEffect(() => {
    let cancelled = false;
    setSystemFontsLoading(true);
    setSystemFontsError(null);

    void listSystemFonts()
      .then((fonts) => {
        if (!cancelled) setSystemFonts(fonts);
      })
      .catch((err) => {
        console.warn("Failed to list system fonts:", err);
        if (!cancelled) setSystemFontsError(t("settings.general.uiFontError"));
      })
      .finally(() => {
        if (!cancelled) setSystemFontsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    setUiFontSizeDraft(uiFontSize);
  }, [uiFontSize]);

  useEffect(() => {
    setUiTextColorDraft(uiTextColor);
  }, [uiTextColor]);

  const wslTarget = useMemo(
    () => resolveCcusageWslTarget(claudeHookConfigDir, codexHookConfigDir),
    [claudeHookConfigDir, codexHookConfigDir]
  );
  const hasWslSignal = Boolean(wslTarget.distro) || wslTarget.conflicts.length > 0;
  const matchedWslStatus =
    wslTarget.distro && ccusageToolStatus?.wsl?.distro === wslTarget.distro ? ccusageToolStatus.wsl : null;
  const wslStatusMeta = useMemo(() => {
    if (wslTarget.conflicts.length > 0) {
      return {
        color: "red",
        labelKey: "settings.general.ccusageWslStatusConflict" as const,
        descriptionKey: "settings.general.ccusageWslStatusConflictDescription" as const,
      };
    }
    if (!wslTarget.distro) {
      return {
        color: "gray",
        labelKey: "settings.general.ccusageWslStatusUnavailable" as const,
        descriptionKey: "settings.general.ccusageWslStatusUnavailableDescription" as const,
      };
    }
    if (ccusageCheckingStatus && !matchedWslStatus) {
      return {
        color: "blue",
        labelKey: "settings.general.ccusageWslStatusChecking" as const,
        descriptionKey: "settings.general.ccusageWslStatusCheckingDescription" as const,
      };
    }
    if (matchedWslStatus?.bunxAvailable) {
      return {
        color: "green",
        labelKey: "settings.general.ccusageWslStatusReady" as const,
        descriptionKey: "settings.general.ccusageWslStatusReadyDescription" as const,
      };
    }
    return {
      color: "yellow",
      labelKey: "settings.general.ccusageWslStatusManual" as const,
      descriptionKey: "settings.general.ccusageWslStatusManualDescription" as const,
    };
  }, [ccusageCheckingStatus, matchedWslStatus, wslTarget.conflicts.length, wslTarget.distro]);

  useEffect(() => {
    if (!hasWslSignal) return;
    void checkCcusageStatus().catch(() => {});
  }, [checkCcusageStatus, hasWslSignal, claudeHookConfigDir, codexHookConfigDir]);

  const refreshCcusageWslStatus = () => {
    void checkCcusageStatus().catch(() => {});
  };

  const copyWslCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success(t("settings.general.ccusageWslCopied"));
    } catch (err) {
      toast.error(t("settings.general.ccusageWslCopyFailed"), { description: String(err) });
    }
  };

  const defaultUiTextColor = getDefaultUiTextColor(resolvedTheme, lightThemePalette, darkThemePalette);
  const normalizedUiTextColorDraft = uiTextColorDraft.trim();
  const uiTextColorDraftInvalid = normalizedUiTextColorDraft !== "" && !HEX_COLOR_PATTERN.test(normalizedUiTextColorDraft);
  const colorPickerValue = HEX_COLOR_PATTERN.test(normalizedUiTextColorDraft) ? normalizedUiTextColorDraft : defaultUiTextColor;
  const commitUiTextColor = (value = uiTextColorDraft) => {
    const next = value.trim();
    if (next !== "" && !HEX_COLOR_PATTERN.test(next)) return;
    if (next !== uiTextColor) {
      void update("uiTextColor", next);
    }
  };
  const commitUiFontSize = (value = uiFontSizeDraft) => {
    const next = clampUiFontSize(value);
    setUiFontSizeDraft(next);
    if (next !== uiFontSize) {
      void update("uiFontSize", next);
    }
  };
  // 对已提交的自定义颜色按当前配色的 --bg-primary（纯映射）计算对比度，
  // 给出可见反馈（消除“静默未应用”）；计算量极小，无需 memo。
  const uiBackgroundColor = getDefaultUiBgColor(resolvedTheme, lightThemePalette, darkThemePalette);
  const uiTextColorContrastRatio = uiTextColor ? getContrastRatioFromHex(uiTextColor, uiBackgroundColor) : null;
  let uiTextColorHint = t("settings.general.uiTextColorDefaultHint");
  let uiTextColorHintColor = "var(--text-muted)";
  if (uiTextColorDraftInvalid) {
    uiTextColorHint = t("settings.general.uiTextColorInvalid");
    uiTextColorHintColor = "var(--danger)";
  } else if (uiTextColorContrastRatio !== null && uiTextColorContrastRatio < MIN_APPLY_CONTRAST_RATIO) {
    uiTextColorHint = t("settings.general.uiTextColorTooClose");
    uiTextColorHintColor = "var(--danger)";
  } else if (uiTextColorContrastRatio !== null && uiTextColorContrastRatio < MIN_READABLE_CONTRAST_RATIO) {
    uiTextColorHint = t("settings.general.uiTextColorLowContrast");
    uiTextColorHintColor = "var(--warning)";
  }
  const uiFontFamilyOptions = useMemo(
    () =>
      mergeFontFamilyOptions(
        uiFontFamily,
        UI_FONT_FAMILY_OPTIONS.map((option) => ({
          value: option.value,
          label: option.labelKey ? t(option.labelKey) : option.label,
        })),
        systemFonts,
        UI_FONT_FALLBACK
      ),
    [systemFonts, t, uiFontFamily]
  );
  const showLightPalettes = theme === "light" || theme === "system";
  const showDarkPalettes = theme === "dark" || theme === "system";
  return (
    <Stack gap="md">
      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="md">
            <Text size="sm" fw={600} c="var(--on-surface)">
              {t("settings.general.appearance")}
            </Text>

            <Select<LanguagePreference>
              label={t("settings.general.language")}
              value={language}
              onChange={(value) => {
                if (value) void update("language", value);
              }}
              data={LANGUAGE_OPTIONS}
              allowDeselect={false}
              size="xs"
              aria-label={t("settings.general.language")}
              description={t("settings.general.languageDescription")}
            />

            <Stack gap={6}>
              <Text size="xs" c="var(--on-surface-variant)">
                {t("settings.general.theme")}
              </Text>
              <SegmentedControl<ThemeMode>
                value={theme}
                onChange={(value) => void setTheme(value)}
                data={themeOptions}
                color="cliPrimary"
                fullWidth
                aria-label={t("settings.general.theme")}
              />
            </Stack>

            {showLightPalettes && (
              <Stack gap="xs">
                <Text size="xs" c="var(--on-surface-variant)">
                  {t("settings.general.lightTheme")}
                </Text>
                <SimpleGrid cols={{ base: 1, md: 3 }} spacing="xs">
                  {LIGHT_PALETTE_OPTIONS.map((option) => (
                    <PaletteCard
                      key={option.value}
                      active={lightThemePalette === option.value}
                      label={t(option.labelKey)}
                      description={t(option.descriptionKey)}
                      activeLabel={t("common.current")}
                      swatches={option.swatches}
                      onClick={() => void update("lightThemePalette", option.value)}
                    />
                  ))}
                </SimpleGrid>
              </Stack>
            )}

            {showDarkPalettes && (
              <Stack gap="xs">
                <Text size="xs" c="var(--on-surface-variant)">
                  {t("settings.general.darkTheme")}
                </Text>
                <SimpleGrid cols={{ base: 1, md: 3 }} spacing="xs">
                  {DARK_PALETTE_OPTIONS.map((option) => (
                    <PaletteCard
                      key={option.value}
                      active={darkThemePalette === option.value}
                      label={t(option.labelKey)}
                      description={t(option.descriptionKey)}
                      activeLabel={t("common.current")}
                      swatches={option.swatches}
                      onClick={() => void update("darkThemePalette", option.value)}
                    />
                  ))}
                </SimpleGrid>
              </Stack>
            )}

            <FontFamilySelect
              label={t("settings.general.uiFont")}
              value={uiFontFamily}
              onChange={(value) => {
                if (value) void update("uiFontFamily", value);
              }}
              data={uiFontFamilyOptions}
              maxDropdownHeight={320}
              nothingFoundMessage={systemFontsLoading ? t("settings.general.uiFontLoading") : t("settings.general.uiFontEmpty")}
              size="xs"
              aria-label={t("settings.general.uiFont")}
              description={
                systemFontsError ??
                t("settings.general.uiFontDescription", { count: systemFonts.length })
              }
            />

            <Stack gap={6}>
              <Group justify="space-between" align="center">
                <Text size="xs" c="var(--on-surface-variant)">
                  {t("settings.general.uiFontSize")}
                </Text>
                <NumberInput
                  min={UI_FONT_SIZE_MIN}
                  max={UI_FONT_SIZE_MAX}
                  value={uiFontSizeDraft}
                  onChange={(value) => setUiFontSizeDraft(typeof value === "number" ? value : Number(value))}
                  onBlur={() => commitUiFontSize()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitUiFontSize();
                  }}
                  size="xs"
                  w={84}
                  aria-label={t("settings.general.uiFontSizeValue")}
                />
              </Group>
              <Slider
                min={UI_FONT_SIZE_MIN}
                max={UI_FONT_SIZE_MAX}
                step={1}
                value={uiFontSizeDraft}
                onChange={setUiFontSizeDraft}
                onChangeEnd={(value) => commitUiFontSize(value)}
                color="cliPrimary"
                aria-label={t("settings.general.uiFontSizeSlider")}
              />
              <Text size="xs" c="var(--text-muted)">
                {t("settings.general.uiFontSizeDescription")}
              </Text>
            </Stack>

            <Stack gap={6}>
              <Text size="xs" c="var(--on-surface-variant)">
                {t("settings.general.uiTextColor")}
              </Text>
              <Group gap="xs" align="flex-start" wrap="nowrap">
                <TextInput
                  type="color"
                  value={colorPickerValue}
                  onChange={(event) => {
                    // 原生取色器产出的总是合法 #rrggbb，onChange 直接提交实现实时生效；
                    // onBlur 保留作兜底（如浏览器实现差异导致 change 未触发）。
                    const value = event.currentTarget.value;
                    setUiTextColorDraft(value);
                    commitUiTextColor(value);
                  }}
                  onBlur={() => commitUiTextColor()}
                  w={52}
                  size="xs"
                  aria-label={t("settings.general.uiTextColorPicker")}
                  styles={{ input: { cursor: "pointer", padding: 4 } }}
                />
                <TextInput
                  value={uiTextColorDraft}
                  onChange={(event) => {
                    setUiTextColorDraft(event.currentTarget.value.trim());
                  }}
                  onBlur={() => commitUiTextColor()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      commitUiTextColor();
                    }
                  }}
                  placeholder={defaultUiTextColor}
                  size="xs"
                  w={120}
                  aria-label={t("settings.general.uiTextColorHex")}
                  aria-invalid={uiTextColorDraftInvalid}
                  styles={{ input: { fontFamily: "var(--font-ui-mono)", fontSize: 12 } }}
                />
                {uiTextColor && (
                  <Button
                    type="button"
                    size="xs"
                    variant="light"
                    color="cliPrimary"
                    onClick={() => {
                      setUiTextColorDraft("");
                      void update("uiTextColor", "");
                    }}
                    className="shrink-0"
                    style={{
                      backgroundColor: "color-mix(in srgb, var(--primary) 10%, transparent)",
                      border: "1px solid color-mix(in srgb, var(--primary) 22%, transparent)",
                      color: "var(--primary)",
                  }}
                >
                    {t("settings.general.restoreThemeColor")}
                  </Button>
                )}
              </Group>
              <Group gap="xs" c="var(--text-muted)">
                <Box
                  w={16}
                  h={16}
                  style={{
                    backgroundColor: uiTextColor || defaultUiTextColor,
                    border: "1px solid var(--border)",
                    borderRadius: 999,
                  }}
                />
                <Text size="xs">
                  {uiTextColor
                    ? t("settings.general.currentCustomColor", { color: uiTextColor })
                    : t("settings.general.currentThemeColor", { color: defaultUiTextColor })}
                </Text>
              </Group>
              <Text size="xs" c={uiTextColorHintColor}>
                {uiTextColorHint}
              </Text>
            </Stack>
        </Stack>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="sm">
            <Text size="sm" fw={600} c="var(--on-surface)">
              {t("settings.general.usageAnalysis")}
            </Text>
            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Box>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {t("settings.general.ccusageDashboard")}
                  </Text>
                  <Text mt={4} size="xs" lh={1.55} c="var(--text-muted)">
                    {t("settings.general.ccusageDashboardDescription")}
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  checked={ccusageAnalyticsEnabled}
                  onChange={(event) => void update("ccusageAnalyticsEnabled", event.currentTarget.checked)}
                  aria-label={
                    ccusageAnalyticsEnabled
                      ? t("settings.general.disableCcusageDashboard")
                      : t("settings.general.enableCcusageDashboard")
                  }
                />
              </Group>
            </Card>
            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Box>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {t("settings.general.ccusageUseWsl")}
                  </Text>
                  <Text mt={4} size="xs" lh={1.55} c="var(--text-muted)">
                    {t("settings.general.ccusageUseWslDescription")}
                  </Text>
                </Box>
                <Group gap="xs" align="center" wrap="nowrap">
                  <Button
                    variant="light"
                    color={wslStatusMeta.color}
                    size="compact-sm"
                    onClick={() => {
                      setCcusageWslDialogOpen(true);
                      refreshCcusageWslStatus();
                    }}
                    aria-label={t("settings.general.ccusageWslButton")}
                  >
                    <Group gap={6} wrap="nowrap">
                      <Text span size="11px" fw={700}>
                        {t("settings.general.ccusageWslButton")}
                      </Text>
                      <Badge variant="light" color={wslStatusMeta.color} size="xs">
                        {t(wslStatusMeta.labelKey)}
                      </Badge>
                    </Group>
                  </Button>
                  <Switch
                    color="cliPrimary"
                    checked={ccusageUseWsl}
                    onChange={(event) => void update("ccusageUseWsl", event.currentTarget.checked)}
                    aria-label={
                      ccusageUseWsl
                        ? t("settings.general.disableCcusageUseWsl")
                        : t("settings.general.enableCcusageUseWsl")
                    }
                  />
                </Group>
              </Group>
            </Card>
            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Box>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {t("settings.general.showStatsButton")}
                  </Text>
                  <Text mt={4} size="xs" lh={1.55} c="var(--text-muted)">
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
      <Dialog open={ccusageWslDialogOpen} onOpenChange={setCcusageWslDialogOpen}>
        <DialogContent className="max-w-[680px]">
          <DialogHeader>
            <DialogTitle>{t("settings.general.ccusageWslDialogTitle")}</DialogTitle>
            <DialogDescription>{t("settings.general.ccusageWslDialogDescription")}</DialogDescription>
          </DialogHeader>

          <Stack gap="sm">
            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="flex-start" gap="sm">
                <Box>
                  <Text size="xs" fw={600} c="var(--on-surface)">
                    {t("settings.general.ccusageWslDetectedTarget")}
                  </Text>
                  <Text mt={4} size="xs" c="var(--text-muted)">
                    {wslTarget.distro ?? t("settings.general.ccusageWslTargetUnavailable")}
                  </Text>
                </Box>
                <Badge variant="light" color={wslStatusMeta.color}>
                  {t(wslStatusMeta.labelKey)}
                </Badge>
              </Group>
              <Text mt="sm" size="xs" lh={1.6} c="var(--text-muted)">
                {t(
                  wslStatusMeta.descriptionKey,
                  wslTarget.conflicts.length > 0
                    ? { distros: wslTarget.conflicts.join(", ") }
                    : wslTarget.distro
                      ? { distro: wslTarget.distro }
                      : undefined
                )}
              </Text>
              {matchedWslStatus && (
                <Text mt="sm" size="xs" c="var(--text-muted)">
                  {t("ccusage.wslToolVersions", {
                    distro: matchedWslStatus.distro,
                    bun: matchedWslStatus.bunVersion ?? t("ccusage.notDetected"),
                    bunx: matchedWslStatus.bunxVersion ?? t("ccusage.notDetected"),
                  })}
                </Text>
              )}
              {ccusageError && hasWslSignal && (
                <Text mt="sm" size="xs" c="var(--danger)">
                  {ccusageError}
                </Text>
              )}
            </Card>

            <Text size="xs" lh={1.6} c="var(--text-muted)">
              {t("settings.general.ccusageWslConfigHint")}
            </Text>

            {[
              { title: t("settings.general.ccusageWslCommandBun"), command: WSL_BUN_INSTALL_COMMAND },
              { title: t("settings.general.ccusageWslCommandCcusage"), command: WSL_CCUSAGE_INSTALL_COMMAND },
              { title: t("settings.general.ccusageWslCommandVerify"), command: WSL_VERIFY_COMMAND },
            ].map((item) => (
              <Card key={item.title} className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
                <Group justify="space-between" align="center" gap="sm">
                  <Text size="xs" fw={600} c="var(--on-surface)">
                    {item.title}
                  </Text>
                  <Button size="compact-xs" variant="light" onClick={() => void copyWslCommand(item.command)}>
                    {t("settings.general.ccusageWslCopy")}
                  </Button>
                </Group>
                <Box
                  component="pre"
                  mt="sm"
                  className="overflow-x-auto rounded-md border border-border bg-bg-primary px-3 py-2 text-[12px] leading-6 text-text-secondary"
                >
                  {item.command}
                </Box>
              </Card>
            ))}
          </Stack>

          <DialogFooter>
            <Button variant="default" onClick={refreshCcusageWslStatus} loading={ccusageCheckingStatus}>
              {t("settings.general.ccusageWslRefreshStatus")}
            </Button>
            <Button onClick={() => setCcusageWslDialogOpen(false)}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
