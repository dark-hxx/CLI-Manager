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
  type LightThemePalette,
  type SidebarDensity,
  type SidebarToolbarVisibilitySettings,
  type TerminalToolbarVisibilitySettings,
  type ThemeMode,
} from "../../../stores/settingsStore";
import {
  getContrastRatioFromHex,
  MIN_APPLY_CONTRAST_RATIO,
  MIN_READABLE_CONTRAST_RATIO,
} from "../../../lib/contrast";
import { AboutSection } from "../AboutSection";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

const LIGHT_PALETTE_OPTIONS: {
  value: LightThemePalette;
  label: string;
  description: string;
  swatches: [string, string, string];
}[] = [
  {
    value: "warm-paper",
    label: "暖米纸",
    description: "温暖纸感，橙棕强调",
    swatches: ["#f8f4ec", "#2d261d", "#c46a2d"],
  },
  {
    value: "cream-green",
    label: "奶油绿",
    description: "清新中性，绿色强调",
    swatches: ["#f6f7f1", "#1f2a20", "#3f7a4f"],
  },
  {
    value: "ink-red",
    label: "黑白朱砂",
    description: "高对比中性，红色强调",
    swatches: ["#f7f7f5", "#1f1f1c", "#c43d2f"],
  },
  {
    value: "emerald-mist",
    label: "翡翠雾",
    description: "微冷雾白，翡翠绿强调",
    swatches: ["#fbfdfc", "#18211d", "#039d74"],
  },
  {
    value: "saas-analytics-dashboard",
    label: "SaaS Dashboard",
    description: "冷静浅色，适合数据驾驶舱与 Bento 卡片层级",
    swatches: ["#f8fbff", "#1e293b", "#3b82f6"],
  },
  {
    value: "apple-pure",
    label: "Apple Pure",
    description: "纯白基底 + SF System Blue，最贴近 macOS 原生扁平",
    swatches: ["#ffffff", "#1d1d1f", "#007aff"],
  },
  {
    value: "apple-mist",
    label: "Apple Mist",
    description: "微冷雾白，长时间盯屏更柔和",
    swatches: ["#fcfcfd", "#1c1f23", "#0a84ff"],
  },
  {
    value: "apple-warm",
    label: "Apple Warm",
    description: "暖米白纸感，琥珀强调，低对比阅读友好",
    swatches: ["#fdfcf9", "#1f1d1a", "#ff9f0a"],
  },
  {
    value: "apple-mono",
    label: "Apple Mono",
    description: "极简单色，黑色强调，最克制的 Pro 工具气质",
    swatches: ["#ffffff", "#1d1d1f", "#3a3a3c"],
  },
];

const DARK_PALETTE_OPTIONS: {
  value: DarkThemePalette;
  label: string;
  description: string;
  swatches: [string, string, string];
}[] = [
  {
    value: "night-indigo",
    label: "夜靛蓝",
    description: "经典冷色，蓝系强调",
    swatches: ["#1a1b26", "#c0caf5", "#7aa2f7"],
  },
  {
    value: "forest-night",
    label: "森林夜",
    description: "深绿氛围，清爽不刺眼",
    swatches: ["#111714", "#d8e5dc", "#52a36e"],
  },
  {
    value: "graphite-red",
    label: "石墨红",
    description: "中性黑灰，朱红强调",
    swatches: ["#171616", "#e6dfdb", "#c95b4a"],
  },
  {
    value: "investment-platform",
    label: "Investment Platform",
    description: "深海军蓝与琥珀金，克制的专业金融终端气质",
    swatches: ["#0f172a", "#f8fafc", "#f59e0b"],
  },
  {
    value: "github-dark",
    label: "GitHub Dark",
    description: "中性深灰，蓝色强调，适合长时间阅读代码",
    swatches: ["#24292f", "#f0f3f6", "#58a6ff"],
  },
  {
    value: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    description: "柔和紫黑，粉蓝强调，低刺激暗色",
    swatches: ["#1e1e2e", "#cdd6f4", "#89b4fa"],
  },
  {
    value: "terminal-green",
    label: "终端监控绿",
    description: "btop 监控风格碳黑，荧光绿强调，呼应实时统计面板",
    swatches: ["#0a0a0a", "#e2e2e2", "#3dd68c"],
  },
  {
    value: "dracula-purple",
    label: "Dracula Purple",
    description: "经典紫黑，高辨识度，强调色更鲜明",
    swatches: ["#282a36", "#f8f8f2", "#bd93f9"],
  },
  {
    value: "carbon-black",
    label: "Carbon Black",
    description: "近黑碳色，高对比蓝紫强调，适合沉浸工作",
    swatches: ["#161616", "#f2f4f8", "#78a9ff"],
  },
];

const SIDEBAR_DENSITY_OPTIONS: { value: SidebarDensity; label: string; description: string }[] = [
  { value: "comfortable", label: "舒适", description: "默认间距，强调可读性" },
  { value: "compact", label: "紧凑", description: "减少行高与缩进，显示更多条目" },
];

const CLOSE_BEHAVIOR_OPTIONS: { value: CloseBehavior; label: string }[] = [
  { value: "ask", label: "每次询问" },
  { value: "minimize", label: "最小化到托盘" },
  { value: "exit", label: "直接退出" },
];

const TERMINAL_TOOLBAR_OPTIONS: { key: TerminalToolbarOptionKey; label: string }[] = [
  { key: "templates", label: "Templates" },
  { key: "commandHistory", label: "历史命令" },
  { key: "fullscreen", label: "全屏" },
  { key: "sessionHistory", label: "历史会话" },
  { key: "stats", label: "实时统计" },
  { key: "gitChanges", label: "Git 变更" },
];

type TerminalToolbarOptionKey = Exclude<keyof TerminalToolbarVisibilitySettings, "showText">;

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

const UI_FONT_FAMILY_OPTIONS: { value: string; label: string }[] = [
  {
    value:
      "\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
    label: "系统默认（Segoe UI + 中文回退）",
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
  },
  {
    value: "\"Microsoft YaHei\", \"PingFang SC\", sans-serif",
    label: "微软雅黑 Microsoft YaHei",
  },
  {
    value: "\"Source Han Sans SC\", \"Noto Sans CJK SC\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
    label: "思源黑体 / Source Han Sans",
  },
  {
    value: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    label: "纯系统 UI 字体",
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
  swatches,
  onClick,
}: {
  active: boolean;
  label: string;
  description: string;
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
          当前
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
  const debugMode = useSettingsStore((s) => s.debugMode);
  const ccusageAnalyticsEnabled = useSettingsStore((s) => s.ccusageAnalyticsEnabled);
  const terminalToolbarVisibility = useSettingsStore((s) => s.terminalToolbarVisibility);
  const sidebarToolbarVisibility = useSettingsStore((s) => s.sidebarToolbarVisibility);
  const showProjectTreeBadges = useSettingsStore((s) => s.showProjectTreeBadges);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const update = useSettingsStore((s) => s.update);
  const [uiFontSizeDraft, setUiFontSizeDraft] = useState(uiFontSize);
  const [uiTextColorDraft, setUiTextColorDraft] = useState(uiTextColor);

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
  const isCustomUiFontFamily = useMemo(
    () => !UI_FONT_FAMILY_OPTIONS.some((opt) => opt.value === uiFontFamily),
    [uiFontFamily]
  );
  // 对已提交的自定义颜色按当前配色的 --bg-primary（纯映射）计算对比度，
  // 给出可见反馈（消除“静默未应用”）；计算量极小，无需 memo。
  const uiBackgroundColor = getDefaultUiBgColor(resolvedTheme, lightThemePalette, darkThemePalette);
  const uiTextColorContrastRatio = uiTextColor ? getContrastRatioFromHex(uiTextColor, uiBackgroundColor) : null;
  let uiTextColorHint = "仅影响除终端外的应用主文字颜色；留空时跟随当前主题。";
  let uiTextColorHintColor = "var(--text-muted)";
  if (uiTextColorDraftInvalid) {
    uiTextColorHint = "请输入 #RRGGBB 格式，例如 #c0caf5。";
    uiTextColorHintColor = "var(--danger)";
  } else if (uiTextColorContrastRatio !== null && uiTextColorContrastRatio < MIN_APPLY_CONTRAST_RATIO) {
    uiTextColorHint = "颜色与背景过于接近，未应用。";
    uiTextColorHintColor = "var(--danger)";
  } else if (uiTextColorContrastRatio !== null && uiTextColorContrastRatio < MIN_READABLE_CONTRAST_RATIO) {
    uiTextColorHint = "对比度较低，可能影响可读性。";
    uiTextColorHintColor = "var(--warning)";
  }
  const uiFontFamilyOptions = useMemo(
    () => [
      ...(isCustomUiFontFamily ? [{ value: uiFontFamily, label: "当前自定义（保留）" }] : []),
      ...UI_FONT_FAMILY_OPTIONS,
    ],
    [isCustomUiFontFamily, uiFontFamily]
  );
  const updateToolbarVisibility = (key: keyof TerminalToolbarVisibilitySettings, checked: boolean) => {
    void update("terminalToolbarVisibility", { ...terminalToolbarVisibility, [key]: checked });
  };

  const updateSidebarToolbarVisibility = (key: keyof SidebarToolbarVisibilitySettings, checked: boolean) => {
    void update("sidebarToolbarVisibility", { ...sidebarToolbarVisibility, [key]: checked });
  };

  return (
    <Stack gap="md">
      <section>
        <Card className="ui-surface-card" p="md">
          <Stack gap="md">
            <Text size="sm" fw={600} c="var(--on-surface)">
              外观
            </Text>

            <Stack gap={6}>
              <Text size="xs" c="var(--on-surface-variant)">
                应用主题
              </Text>
              <SegmentedControl<ThemeMode>
                value={theme}
                onChange={(value) => void setTheme(value)}
                data={THEME_OPTIONS}
                color="cliPrimary"
                fullWidth
                aria-label="应用主题"
              />
            </Stack>

            <Stack gap="xs">
              <Text size="xs" c="var(--on-surface-variant)">
                浅色配色
              </Text>
              <SimpleGrid cols={{ base: 1, md: 3 }} spacing="xs">
                {LIGHT_PALETTE_OPTIONS.map((option) => (
                  <PaletteCard
                    key={option.value}
                    active={lightThemePalette === option.value}
                    label={option.label}
                    description={option.description}
                    swatches={option.swatches}
                    onClick={() => void update("lightThemePalette", option.value)}
                  />
                ))}
              </SimpleGrid>
            </Stack>

            <Stack gap="xs">
              <Text size="xs" c="var(--on-surface-variant)">
                暗色配色
              </Text>
              <SimpleGrid cols={{ base: 1, md: 3 }} spacing="xs">
                {DARK_PALETTE_OPTIONS.map((option) => (
                  <PaletteCard
                    key={option.value}
                    active={darkThemePalette === option.value}
                    label={option.label}
                    description={option.description}
                    swatches={option.swatches}
                    onClick={() => void update("darkThemePalette", option.value)}
                  />
                ))}
              </SimpleGrid>
            </Stack>

            <Select<string>
              label="应用字体"
              value={uiFontFamily}
              onChange={(value) => {
                if (value) void update("uiFontFamily", value);
              }}
              data={uiFontFamilyOptions}
              allowDeselect={false}
              size="xs"
              aria-label="应用字体"
              description="影响除终端外的应用整体界面字体；终端字体在「终端设置」中单独配置。"
            />

            <Stack gap={6}>
              <Group justify="space-between" align="center">
                <Text size="xs" c="var(--on-surface-variant)">
                  应用字体大小
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
                  aria-label="应用字体大小数值"
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
                aria-label="应用字体大小滑杆"
              />
              <Text size="xs" c="var(--text-muted)">
                影响除内置终端外的应用界面；终端字号仍在「终端设置」中单独配置。
              </Text>
            </Stack>

            <Stack gap={6}>
              <Text size="xs" c="var(--on-surface-variant)">
                应用字体颜色
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
                  aria-label="应用字体颜色选择器"
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
                  aria-label="应用字体颜色十六进制值"
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
                    恢复跟随主题
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
                  {uiTextColor ? `当前自定义 ${uiTextColor}` : `当前跟随主题 ${defaultUiTextColor}`}
                </Text>
              </Group>
              <Text size="xs" c={uiTextColorHintColor}>
                {uiTextColorHint}
              </Text>
            </Stack>
          </Stack>
        </Card>
      </section>

      <section>
        <Card className="ui-surface-card" p="md">
          <Stack gap="md">
            <Text size="sm" fw={600} c="var(--on-surface)">
              侧栏与行为
            </Text>
            <Card className="border border-primary bg-surface-container-low" p="md" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Box>
                  <Text size="sm" fw={600} c="var(--on-surface)">
                    精简模式
                  </Text>
                  <Text mt={4} size="xs" c="var(--text-muted)">
                    隐藏内嵌终端，把项目列表作为启动器。
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  checked={viewMode === "compact"}
                  onChange={(event) =>
                    void update("viewMode", event.currentTarget.checked ? "compact" : "standard")
                  }
                  aria-label={viewMode === "compact" ? "关闭精简模式" : "开启精简模式"}
                />
              </Group>
            </Card>

            <Stack gap="xs">
              <Text size="xs" c="var(--on-surface-variant)">
                侧栏密度
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
                    项目树徽章
                  </Text>
                  <Text mt={4} size="xs" c="var(--text-muted)">
                    显示项目工具、路径异常和分组数量标记。
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  checked={showProjectTreeBadges}
                  onChange={(event) => void update("showProjectTreeBadges", event.currentTarget.checked)}
                  aria-label={showProjectTreeBadges ? "隐藏项目树徽章" : "显示项目树徽章"}
                />
              </Group>
            </Card>

            <Select<CloseBehavior>
              label="关闭按钮行为"
              value={closeBehavior}
              onChange={(value) => {
                if (value) void update("closeBehavior", value);
              }}
              data={CLOSE_BEHAVIOR_OPTIONS}
              allowDeselect={false}
              size="xs"
              aria-label="关闭按钮行为"
              description="控制点击窗口关闭按钮时的动作。"
            />

            <Group justify="space-between" align="center" gap="md" wrap="nowrap">
              <Text size="xs" c="var(--on-surface-variant)">
                调试模式
              </Text>
              <Switch
                color="cliPrimary"
                checked={debugMode}
                onChange={(event) => void update("debugMode", event.currentTarget.checked)}
                aria-label={debugMode ? "关闭调试模式" : "开启调试模式"}
              />
            </Group>
          </Stack>
        </Card>
      </section>


      <section>
        <Card className="ui-surface-card" p="md">
          <Stack gap="sm">
            <Text size="sm" fw={600} c="var(--on-surface)">
              工具栏
            </Text>

            <Text size="xs" fw={600} c="var(--on-surface-variant)" mt="xs">
              终端工具栏
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
              {TERMINAL_TOOLBAR_OPTIONS.map((option) => (
                <Card key={option.key} className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
                  <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                    <Text size="xs" c="var(--on-surface-variant)">
                      {option.label}
                    </Text>
                    <Switch
                      color="cliPrimary"
                      checked={terminalToolbarVisibility[option.key]}
                      onChange={(event) => updateToolbarVisibility(option.key, event.currentTarget.checked)}
                      aria-label={`${terminalToolbarVisibility[option.key] ? "隐藏" : "显示"}${option.label}`}
                    />
                  </Group>
                </Card>
              ))}
            </SimpleGrid>
            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Box>
                  <Text size="xs" c="var(--on-surface-variant)">
                    显示工具栏文字
                  </Text>
                  <Text mt={4} size="xs" c="var(--text-muted)">
                    关闭后除"新建"外只显示图标。
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  checked={terminalToolbarVisibility.showText}
                  onChange={(event) => updateToolbarVisibility("showText", event.currentTarget.checked)}
                  aria-label={terminalToolbarVisibility.showText ? "隐藏工具栏文字" : "显示工具栏文字"}
                />
              </Group>
            </Card>

            <Text size="xs" fw={600} c="var(--on-surface-variant)" mt="md">
              侧边栏工具栏
            </Text>
            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Box>
                  <Text size="xs" c="var(--on-surface-variant)">
                    显示用量分析按钮
                  </Text>
                  <Text mt={4} size="xs" c="var(--text-muted)">
                    在侧边栏底部显示历史用量统计按钮
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  checked={sidebarToolbarVisibility.stats}
                  onChange={(event) => updateSidebarToolbarVisibility("stats", event.currentTarget.checked)}
                  aria-label={sidebarToolbarVisibility.stats ? "隐藏用量分析按钮" : "显示用量分析按钮"}
                />
              </Group>
            </Card>
          </Stack>
        </Card>
      </section>

      <section>
        <Card className="ui-surface-card" p="md">
          <Stack gap="sm">
            <Text size="sm" fw={600} c="var(--on-surface)">
              用量分析
            </Text>
            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Box>
                  <Text size="xs" c="var(--on-surface-variant)">
                    使用 ccusage 看板
                  </Text>
                  <Text mt={4} size="xs" lh={1.55} c="var(--text-muted)">
                    默认关闭。开启后侧栏分析入口切换到独立 ccusage 看板，支持 Claude / Codex /
                    全部来源；缺少 Bun/bunx 时会先二次确认再安装。
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  checked={ccusageAnalyticsEnabled}
                  onChange={(event) => void update("ccusageAnalyticsEnabled", event.currentTarget.checked)}
                  aria-label={ccusageAnalyticsEnabled ? "关闭 ccusage 看板" : "开启 ccusage 看板"}
                />
              </Group>
            </Card>
          </Stack>
        </Card>
      </section>

      <AboutSection />
    </Stack>
  );
}
