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
import {
  useSettingsStore,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  type CloseBehavior,
  type DarkThemePalette,
  type LanguagePreference,
  type LightThemePalette,
  type SidebarDensity,
  type SidebarToolbarVisibilitySettings,
  type TerminalToolbarVisibilitySettings,
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
import { FontFamilySelect } from "../FontFamilySelect";

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

const TERMINAL_TOOLBAR_OPTIONS: { key: TerminalToolbarOptionKey; labelKey: TranslationKey }[] = [
  { key: "templates", labelKey: "settings.general.toolbar.templates" },
  { key: "commandHistory", labelKey: "settings.general.toolbar.commandHistory" },
  { key: "fullscreen", labelKey: "settings.general.toolbar.fullscreen" },
  { key: "sessionHistory", labelKey: "settings.general.toolbar.sessionHistory" },
  { key: "stats", labelKey: "settings.general.toolbar.stats" },
  { key: "gitChanges", labelKey: "settings.general.toolbar.gitChanges" },
];

type TerminalToolbarOptionKey = keyof TerminalToolbarVisibilitySettings;

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
  const sidebarDensity = useSettingsStore((s) => s.sidebarDensity);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const closeBehavior = useSettingsStore((s) => s.closeBehavior);
  const confirmBeforeClosingTerminalTab = useSettingsStore((s) => s.confirmBeforeClosingTerminalTab);
  const terminalTabHoverInfoEnabled = useSettingsStore((s) => s.terminalTabHoverInfoEnabled);
  const debugMode = useSettingsStore((s) => s.debugMode);
  const ccusageAnalyticsEnabled = useSettingsStore((s) => s.ccusageAnalyticsEnabled);
  const terminalToolbarVisibility = useSettingsStore((s) => s.terminalToolbarVisibility);
  const sidebarToolbarVisibility = useSettingsStore((s) => s.sidebarToolbarVisibility);
  const terminalSidePanelMerged = useSettingsStore((s) => s.terminalSidePanelMerged);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const update = useSettingsStore((s) => s.update);
  const [uiFontSizeDraft, setUiFontSizeDraft] = useState(uiFontSize);
  const [uiTextColorDraft, setUiTextColorDraft] = useState(uiTextColor);
  const [systemFonts, setSystemFonts] = useState<SystemFontFamily[]>([]);
  const [systemFontsLoading, setSystemFontsLoading] = useState(false);
  const [systemFontsError, setSystemFontsError] = useState<string | null>(null);
  const themeOptions = useMemo<{ value: ThemeMode; label: string }[]>(
    () => [
      { value: "light", label: t("settings.options.theme.light") },
      { value: "dark", label: t("settings.options.theme.dark") },
      { value: "system", label: t("settings.options.theme.system") },
    ],
    [t]
  );
  const sidebarDensityOptions = useMemo<{ value: SidebarDensity; label: string; description: string }[]>(
    () => [
      {
        value: "comfortable",
        label: t("settings.options.sidebarDensity.comfortable"),
        description: t("settings.options.sidebarDensity.comfortableDescription"),
      },
      {
        value: "compact",
        label: t("settings.options.sidebarDensity.compact"),
        description: t("settings.options.sidebarDensity.compactDescription"),
      },
    ],
    [t]
  );
  const closeBehaviorOptions = useMemo<{ value: CloseBehavior; label: string }[]>(
    () => [
      { value: "ask", label: t("settings.options.close.ask") },
      { value: "minimize", label: t("settings.options.close.minimize") },
      { value: "exit", label: t("settings.options.close.exit") },
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
  const updateToolbarVisibility = (key: keyof TerminalToolbarVisibilitySettings, checked: boolean) => {
    void update("terminalToolbarVisibility", { ...terminalToolbarVisibility, [key]: checked });
  };

  const updateSidebarToolbarVisibility = (key: keyof SidebarToolbarVisibilitySettings, checked: boolean) => {
    void update("sidebarToolbarVisibility", { ...sidebarToolbarVisibility, [key]: checked });
  };

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
        <Stack gap="md">
            <Text size="sm" fw={600} c="var(--on-surface)">
              {t("settings.general.sidebarBehavior")}
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
                  onChange={(event) =>
                    void update("viewMode", event.currentTarget.checked ? "compact" : "standard")
                  }
                  aria-label={viewMode === "compact" ? t("settings.general.closeCompactMode") : t("settings.general.openCompactMode")}
                />
              </Group>
            </Card>

            <Stack gap="xs">
              <Text size="xs" c="var(--on-surface-variant)">
                {t("settings.general.sidebarDensity")}
              </Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                {sidebarDensityOptions.map((opt) => {
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
                        boxShadow: active
                          ? "0 2px 8px color-mix(in srgb, var(--primary) 8%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--primary) 20%, transparent)"
                          : "0 1px 4px color-mix(in srgb, var(--on-surface) 5%, transparent)",
                      }}
                    >
                      <Stack gap={4} style={{ minWidth: 0, padding: "6px 10px 4px" }}>
                        <Text size="sm" fw={600} c={active ? "var(--on-surface)" : "var(--on-surface-variant)"}>
                          {opt.label}
                        </Text>
                        <Text
                          size="xs"
                          lh={1.45}
                          c="var(--text-muted)"
                          style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}
                        >
                          {opt.description}
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

            <Select<CloseBehavior>
              label={t("settings.general.closeBehavior")}
              value={closeBehavior}
              onChange={(value) => {
                if (value) void update("closeBehavior", value);
              }}
              data={closeBehaviorOptions}
              allowDeselect={false}
              size="xs"
              aria-label={t("settings.general.closeBehavior")}
              description={t("settings.general.closeBehaviorDescription")}
            />

            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Box>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {t("settings.general.confirmCloseTab")}
                  </Text>
                  <Text mt={4} size="xs" lh={1.55} c="var(--text-muted)">
                    {t("settings.general.confirmCloseTabDescription")}
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  checked={confirmBeforeClosingTerminalTab}
                  onChange={(event) => void update("confirmBeforeClosingTerminalTab", event.currentTarget.checked)}
                  aria-label={
                    confirmBeforeClosingTerminalTab
                      ? t("settings.general.disableCloseTabConfirm")
                      : t("settings.general.enableCloseTabConfirm")
                  }
                />
              </Group>
            </Card>

            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Box>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {t("settings.general.tabHoverInfo")}
                  </Text>
                  <Text mt={4} size="xs" lh={1.55} c="var(--text-muted)">
                    {t("settings.general.tabHoverInfoDescription")}
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  checked={terminalTabHoverInfoEnabled}
                  onChange={(event) => void update("terminalTabHoverInfoEnabled", event.currentTarget.checked)}
                  aria-label={
                    terminalTabHoverInfoEnabled
                      ? t("settings.general.disableTabHoverInfo")
                      : t("settings.general.enableTabHoverInfo")
                  }
                />
              </Group>
            </Card>

            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Text size="xs" c="var(--on-surface-variant)">
                  {t("settings.general.debugMode")}
                </Text>
                <Switch
                  color="cliPrimary"
                  checked={debugMode}
                  onChange={(event) => void update("debugMode", event.currentTarget.checked)}
                  aria-label={debugMode ? t("settings.general.disableDebugMode") : t("settings.general.enableDebugMode")}
                />
              </Group>
            </Card>
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
            <Text size="xs" fw={600} c="var(--on-surface-variant)" mt="md">
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
                  onChange={(event) => updateSidebarToolbarVisibility("stats", event.currentTarget.checked)}
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
        </Stack>
      </section>
    </Stack>
  );
}
