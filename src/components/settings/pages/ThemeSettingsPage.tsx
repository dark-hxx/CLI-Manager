import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Badge,
  Box,
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
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { CircleHelp } from "lucide-react";
import {
  TERMINAL_THEME_GROUPS,
  TERMINAL_THEME_PRESETS,
  getTerminalTheme,
  resolveTerminalThemeId,
  type TerminalThemeGroupId,
} from "../../../lib/terminalThemes";
import { debugConsoleWarn } from "../../../lib/debugConsole";
import { normalizeTerminalFontFamily } from "../../../lib/terminalFontFamily";
import { normalizeShellKey, getOsPlatform } from "../../../lib/shell";
import type { OsPlatform } from "../../../lib/shell";
import { getShellOptions } from "../../../lib/types";
import {
  TERMINAL_SCROLLBACK_ROWS_DEFAULT,
  TERMINAL_SCROLLBACK_ROWS_MAX,
  TERMINAL_SCROLLBACK_ROWS_MIN,
  useSettingsStore,
  type BatchLaunchPaneDirection,
  type CloseBehavior,
  type UnsplitBehavior,
} from "../../../stores/settingsStore";
import { TerminalBackgroundSection } from "./TerminalBackgroundSection";
import {
  listSystemFonts,
  mergeFontFamilyOptions,
  type SystemFontFamily,
} from "../../../lib/systemFonts";
import { FontFamilySelect } from "../FontFamilySelect";
import { useI18n } from "../../../lib/i18n";

const SWATCH_KEYS = ["background", "foreground", "red", "green", "blue", "cyan"] as const;
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 24;
const TERMINAL_FONT_FALLBACK = "monospace";

const FONT_FAMILY_OPTIONS: { value: string; label: string; labelEn?: string }[] = [
  { value: "Cascadia Code, Consolas, monospace", label: "Cascadia Code（推荐）", labelEn: "Cascadia Code (Recommended)" },
  { value: "\"JetBrains Mono\", \"Cascadia Code\", Consolas, monospace", label: "JetBrains Mono" },
  { value: "\"Fira Code\", \"Cascadia Code\", Consolas, monospace", label: "Fira Code" },
  { value: "\"Microsoft YaHei\", \"Cascadia Code\", Consolas, monospace", label: "微软雅黑" },
  { value: "Consolas, monospace", label: "Consolas" },
  { value: "\"Courier New\", monospace", label: "Courier New" },
];

const UNSPLIT_OPTIONS: { value: UnsplitBehavior; label: string; labelEn: string }[] = [
  { value: "merge", label: "合并到相邻 Pane", labelEn: "Merge into adjacent Pane" },
  { value: "close", label: "关闭当前 Pane 内终端", labelEn: "Close terminals in current Pane" },
];

const TERMINAL_THEME_GROUP_LABEL_KEYS: Record<TerminalThemeGroupId, {
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

function clampFontSize(value: number) {
  if (!Number.isFinite(value)) return FONT_SIZE_MIN;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, value));
}

function clampTerminalScrollbackRows(value: number) {
  if (!Number.isFinite(value)) return TERMINAL_SCROLLBACK_ROWS_DEFAULT;
  return Math.min(TERMINAL_SCROLLBACK_ROWS_MAX, Math.max(TERMINAL_SCROLLBACK_ROWS_MIN, Math.round(value)));
}

export function ThemeSettingsPage() {
  const { language, t } = useI18n();
  const text = (zh: string, en: string) => (language === "zh-CN" ? zh : en);
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const terminalScrollbackRows = useSettingsStore((s) => s.terminalScrollbackRows);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const normalizedFontFamily = normalizeTerminalFontFamily(fontFamily);
  const defaultShell = useSettingsStore((s) => s.defaultShell);
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const unsplitBehavior = useSettingsStore((s) => s.unsplitBehavior);
  const closeBehavior = useSettingsStore((s) => s.closeBehavior);
  const confirmBeforeClosingTerminalTab = useSettingsStore((s) => s.confirmBeforeClosingTerminalTab);
  const terminalTabHoverInfoEnabled = useSettingsStore((s) => s.terminalTabHoverInfoEnabled);
  const shellRuntimeMonitoringEnabled = useSettingsStore((s) => s.shellRuntimeMonitoringEnabled);
  const batchLaunchGroupInPane = useSettingsStore((s) => s.batchLaunchGroupInPane);
  const batchLaunchPaneDirection = useSettingsStore((s) => s.batchLaunchPaneDirection);
  const projectScopedTerminalViewEnabled = useSettingsStore((s) => s.projectScopedTerminalViewEnabled);
  const update = useSettingsStore((s) => s.update);
  const [query, setQuery] = useState("");
  const [fontSizeDraft, setFontSizeDraft] = useState(fontSize);
  const [terminalScrollbackRowsDraft, setTerminalScrollbackRowsDraft] = useState(terminalScrollbackRows);
  const [osPlatform, setOsPlatform] = useState<OsPlatform>("windows");
  const [systemFonts, setSystemFonts] = useState<SystemFontFamily[]>([]);
  const [systemFontsLoading, setSystemFontsLoading] = useState(false);
  const [systemFontsError, setSystemFontsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSystemFontsLoading(true);
    setSystemFontsError(null);

    void listSystemFonts()
      .then((fonts) => {
        if (!cancelled) setSystemFonts(fonts);
      })
      .catch((err) => {
        debugConsoleWarn("Failed to list system fonts:", err);
        if (!cancelled) setSystemFontsError(text("系统字体读取失败，已使用内置字体选项。", "Failed to read system fonts. Built-in font options are used."));
      })
      .finally(() => {
        if (!cancelled) setSystemFontsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [language]);

  useEffect(() => {
    void getOsPlatform().then(setOsPlatform);
  }, []);

  useEffect(() => {
    setFontSizeDraft(fontSize);
  }, [fontSize]);

  useEffect(() => {
    setTerminalScrollbackRowsDraft(terminalScrollbackRows);
  }, [terminalScrollbackRows]);

  const effectiveThemeName = terminalThemeName;

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return TERMINAL_THEME_PRESETS;
    return TERMINAL_THEME_PRESETS.filter((preset) => preset.name.toLowerCase().includes(keyword));
  }, [query]);

  const groupedThemes = useMemo(
    () =>
      TERMINAL_THEME_GROUPS.map((group) => ({
        ...group,
        presets: filtered.filter((preset) => preset.group === group.id),
      })).filter((group) => group.presets.length > 0),
    [filtered]
  );

  const selectedTheme = useMemo(() => {
    const effective = getTerminalTheme(effectiveThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
    const resolvedThemeId = resolveTerminalThemeId(effectiveThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
    const selectedPreset =
      TERMINAL_THEME_PRESETS.find((item) => item.id === resolvedThemeId) ??
      null;
    return {
      label:
        selectedPreset?.name ?? text("独立终端主题", "Independent terminal theme"),
      theme: effective,
    };
  }, [darkThemePalette, effectiveThemeName, language, lightThemePalette, resolvedTheme]);

  const fontFamilyOptions = useMemo(
    () =>
      mergeFontFamilyOptions(
        normalizedFontFamily,
        FONT_FAMILY_OPTIONS.map((option) => ({
          value: normalizeTerminalFontFamily(option.value),
          label: language === "zh-CN" ? option.label : option.labelEn ?? option.label,
        })),
        systemFonts,
        TERMINAL_FONT_FALLBACK
      ),
    [language, normalizedFontFamily, systemFonts]
  );
  const unsplitOptions = useMemo(
    () => UNSPLIT_OPTIONS.map((option) => ({
      value: option.value,
      label: language === "zh-CN" ? option.label : option.labelEn,
    })),
    [language]
  );
  const closeBehaviorOptions: { value: CloseBehavior; label: string }[] = [
    { value: "ask", label: t("settings.options.close.ask") },
    { value: "minimize", label: t("settings.options.close.minimize") },
    { value: "exit", label: t("settings.options.close.exit") },
  ];
  const normalizedDefaultShell = normalizeShellKey(defaultShell);
  const shellSelectValue = normalizedDefaultShell ?? defaultShell;
  const isCustomShellValue = !normalizedDefaultShell;
  const shellOptions = useMemo(
    () => [
      ...(isCustomShellValue ? [{ value: defaultShell, label: text("当前自定义（保留）", "Current custom (keep)") }] : []),
      ...getShellOptions(osPlatform),
    ],
    [defaultShell, isCustomShellValue, language, osPlatform]
  );
  const commitFontSize = (value = fontSizeDraft) => {
    const next = clampFontSize(value);
    setFontSizeDraft(next);
    if (next !== fontSize) {
      void update("fontSize", next);
    }
  };
  const commitTerminalScrollbackRows = (value = terminalScrollbackRowsDraft) => {
    const next = clampTerminalScrollbackRows(value);
    setTerminalScrollbackRowsDraft(next);
    if (next !== terminalScrollbackRows) {
      void update("terminalScrollbackRows", next);
    }
  };

  // 注意：sticky 必须放在普通 div wrapper 上。Mantine Card（.m_e615b15f）自带
  // `position: relative`，且项目引入的是无 cascade layer 的 @mantine/core/styles.css，
  // 其优先级高于 Tailwind v4 @layer utilities 中的 `sticky`，导致直接写在 Card 上失效。
  const terminalPreview = (
    <div className="self-start xl:sticky xl:top-5 xl:z-10 xl:col-start-2 xl:row-span-3 xl:row-start-1">
      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="sm">
          <Box>
            <Text size="sm" fw={600} c="var(--on-surface)">
              {text("终端预览", "Terminal Preview")}
            </Text>
            <Text mt={4} size="xs" c="var(--on-surface-variant)">
              {selectedTheme.label}
            </Text>
          </Box>
          <Box
            className="rounded-xl border p-3 font-mono text-xs"
            style={{
              borderColor: "var(--border)",
              backgroundColor: selectedTheme.theme.background ?? "var(--surface-container-lowest)",
              color: selectedTheme.theme.foreground ?? "var(--on-surface)",
            }}
          >
            <div>$ echo "hello cli-manager"</div>
            <div className="mt-1 opacity-80">hello cli-manager</div>
            <Group mt="md" gap={6}>
              {SWATCH_KEYS.map((key) => (
                <Box
                  key={key}
                  component="span"
                  w={16}
                  h={16}
                  style={{
                    backgroundColor:
                      (selectedTheme.theme as Record<string, string | undefined>)[key] ?? "var(--surface-container-lowest)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 4,
                  }}
                  title={key}
                />
              ))}
            </Group>
          </Box>

          <Text size="xs" fw={600} c="var(--on-surface-variant)">
            {text("实时字体预览", "Live Font Preview")}
          </Text>
          <Box
            className="rounded-xl border border-border p-4 font-mono"
            style={{ backgroundColor: "var(--surface-container-lowest)", color: "var(--on-surface)" }}
          >
            <Box style={{ fontFamily: normalizedFontFamily, fontSize: `${fontSize}px` }}>
              <div>$ cli-manager --doctor</div>
              <div className="opacity-80">Environment ready. Launching workspace...</div>
              <div className="mt-1 text-success">Terminal initialized</div>
            </Box>
          </Box>
        </Stack>
      </section>
    </div>
  );

  return (
    <Stack gap="md">
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="ui-surface-card rounded-2xl border border-border p-4 xl:col-start-1 xl:row-start-1">
          <Stack gap="md">
            <Text size="sm" fw={600} c="var(--on-surface)">
              {text("终端行为", "Terminal Behavior")}
            </Text>

            <Stack gap={6}>
              <Group justify="space-between" align="center">
                <Text size="xs" c="var(--on-surface-variant)">
                  {text("终端字体大小", "Terminal Font Size")}
                </Text>
                <NumberInput
                  min={FONT_SIZE_MIN}
                  max={FONT_SIZE_MAX}
                  value={fontSizeDraft}
                  onChange={(value) => setFontSizeDraft(typeof value === "number" ? value : Number(value))}
                  onBlur={() => commitFontSize()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitFontSize();
                  }}
                  size="xs"
                  w={84}
                  aria-label={text("终端字体大小数值", "Terminal font size value")}
                />
              </Group>
              <Slider
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={1}
                value={fontSizeDraft}
                onChange={setFontSizeDraft}
                onChangeEnd={(value) => commitFontSize(value)}
                color="cliPrimary"
                aria-label={text("终端字体大小滑杆", "Terminal font size slider")}
              />
              <Text size="xs" c="var(--text-muted)">
                {text("仅影响内置终端，不改变应用界面字体。", "Affects the built-in terminal only, not the app UI font.")}
              </Text>
            </Stack>

            <Stack gap={6}>
              <Group justify="space-between" align="center">
                <Group gap={6}>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {text("终端回滚行数", "Terminal Scrollback Rows")}
                  </Text>
                  <Tooltip
                    multiline
                    w={320}
                    label={
                      <Stack gap={4}>
                        <Text size="xs" c="inherit">{text("内存占用：行数越大，每个终端占用越高。", "Memory: more rows consume more memory per terminal.")}</Text>
                        <Text size="xs" c="inherit">{text("多终端影响：同时开很多 Codex/Claude 会话时更明显。", "Multi-terminal impact is more obvious when many Codex/Claude sessions are open.")}</Text>
                        <Text size="xs" c="inherit">
                          {text("Codex TUI 限制：Codex 主动清屏/重绘的内容不保证全部进 scrollback，但能明显改善普通回滚长度。", "Codex TUI limitation: content cleared/redrawn by Codex may not fully enter scrollback, but normal scrollback length improves.")}
                        </Text>
                      </Stack>
                    }
                  >
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="xs"
                      radius="xl"
                      aria-label={text("终端回滚行数说明", "Terminal scrollback help")}
                    >
                      <CircleHelp size={14} strokeWidth={1.8} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
                <NumberInput
                  min={TERMINAL_SCROLLBACK_ROWS_MIN}
                  max={TERMINAL_SCROLLBACK_ROWS_MAX}
                  step={1000}
                  value={terminalScrollbackRowsDraft}
                  onChange={(value) => setTerminalScrollbackRowsDraft(typeof value === "number" ? value : Number(value))}
                  onBlur={() => commitTerminalScrollbackRows()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitTerminalScrollbackRows();
                  }}
                  size="xs"
                  w={104}
                  aria-label={text("终端回滚行数数值", "Terminal scrollback rows value")}
                />
              </Group>
              <Slider
                min={TERMINAL_SCROLLBACK_ROWS_MIN}
                max={TERMINAL_SCROLLBACK_ROWS_MAX}
                step={1000}
                value={terminalScrollbackRowsDraft}
                onChange={setTerminalScrollbackRowsDraft}
                onChangeEnd={(value) => commitTerminalScrollbackRows(value)}
                color="cliPrimary"
                aria-label={text("终端回滚行数滑杆", "Terminal scrollback rows slider")}
              />
              <Text size="xs" c="var(--text-muted)">
                {text("控制内置终端可向上回看的历史行数。", "Controls how many history rows the built-in terminal can scroll back.")}
              </Text>
            </Stack>

            <FontFamilySelect
              label={text("终端字体族", "Terminal Font Family")}
              value={normalizedFontFamily}
              onChange={(value) => {
                if (value) void update("fontFamily", normalizeTerminalFontFamily(value));
              }}
              data={fontFamilyOptions}
              maxDropdownHeight={320}
              nothingFoundMessage={systemFontsLoading ? text("正在读取系统字体...", "Reading system fonts...") : text("未找到匹配字体", "No matching font found")}
              size="xs"
              aria-label={text("终端字体族", "Terminal Font Family")}
              description={
                systemFontsError ??
                text(
                  `影响内置终端字体；已读取 ${systemFonts.length} 个系统字体。建议选择等宽字体。`,
                  `Affects built-in terminal font. ${systemFonts.length} system fonts loaded. Monospace fonts are recommended.`
                )
              }
            />

            <Select<string>
              label={text("默认 Shell", "Default Shell")}
              value={shellSelectValue}
              onChange={(value) => {
                if (value) void update("defaultShell", value);
              }}
              data={shellOptions}
              allowDeselect={false}
              size="xs"
              aria-label={text("默认 Shell", "Default Shell")}
            />

            <Select<UnsplitBehavior>
              label={text("取消分屏行为", "Unsplit Behavior")}
              value={unsplitBehavior}
              onChange={(value) => {
                if (value) void update("unsplitBehavior", value);
              }}
              data={unsplitOptions}
              allowDeselect={false}
              size="xs"
              aria-label={text("取消分屏行为", "Unsplit Behavior")}
              description={text("影响 Unsplit 时当前 Pane 内终端的处理方式。", "Controls how terminals in the current Pane are handled when unsplitting.")}
            />

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
                <Box>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {text("外部终端", "External terminal")}
                  </Text>
                  <Text mt={4} size="xs" c="var(--text-muted)">
                    {text("启动项目时使用系统外部终端窗口。", "Use the system external terminal when launching projects.")}
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  checked={useExternalTerminal}
                  onChange={(event) => void update("useExternalTerminal", event.currentTarget.checked)}
                  aria-label={useExternalTerminal ? text("关闭外部终端", "Disable external terminal") : text("开启外部终端", "Enable external terminal")}
                />
              </Group>
            </Card>

            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Box>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {text("通用 Shell 运行监控", "Generic Shell Runtime Monitoring")}
                  </Text>
                  <Text mt={4} size="xs" c="var(--text-muted)">
                    {text("默认关闭；如需标签运行状态，可在此开启。开启后仅影响新建 PowerShell / pwsh 终端，并可能略微增加启动耗时。", "Off by default. Enable for tab runtime status. Only affects new PowerShell / pwsh terminals and may slightly increase startup time.")}
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  checked={shellRuntimeMonitoringEnabled}
                  onChange={(event) => void update("shellRuntimeMonitoringEnabled", event.currentTarget.checked)}
                  aria-label={shellRuntimeMonitoringEnabled ? text("关闭通用 Shell 运行监控", "Disable generic Shell runtime monitoring") : text("开启通用 Shell 运行监控", "Enable generic Shell runtime monitoring")}
                />
              </Group>
            </Card>

            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Box>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {text("批量启动分组 Pane", "Batch Launch Group Panes")}
                  </Text>
                  <Text mt={4} size="xs" c="var(--text-muted)">
                    {text("启用后，点击分组启动按钮时，同一分组的终端将放在同个 Pane 中（多标签），不同分组会创建到不同 Pane。嵌套分组按根目录区分。", "When enabled, group launch puts terminals from the same group in one Pane as tabs; different groups open in separate Panes. Nested groups are split by root directory.")}
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  checked={batchLaunchGroupInPane}
                  onChange={(event) => void update("batchLaunchGroupInPane", event.currentTarget.checked)}
                  aria-label={batchLaunchGroupInPane ? text("关闭批量启动分组 Pane", "Disable batch group Panes") : text("开启批量启动分组 Pane", "Enable batch group Panes")}
                />
              </Group>
              {batchLaunchGroupInPane && (
                <Group mt="sm" justify="space-between" align="center">
                  <Text size="xs" c="var(--on-surface-variant)">
                    {text("分屏方向", "Split Direction")}
                  </Text>
                  <SegmentedControl<BatchLaunchPaneDirection>
                    value={batchLaunchPaneDirection}
                    onChange={(value) => void update("batchLaunchPaneDirection", value)}
                    data={[
                      { value: "vertical", label: text("上下", "Vertical") },
                      { value: "horizontal", label: text("左右", "Horizontal") },
                    ]}
                    color="cliPrimary"
                    size="xs"
                    aria-label={text("批量启动分屏方向", "Batch launch split direction")}
                  />
                </Group>
              )}
            </Card>
            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Box>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {t("settings.general.projectScopedTerminalView")}
                  </Text>
                  <Text mt={4} size="xs" c="var(--text-muted)">
                    {t("settings.general.projectScopedTerminalViewDescription")}
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  checked={projectScopedTerminalViewEnabled}
                  onChange={(event) => void update("projectScopedTerminalViewEnabled", event.currentTarget.checked)}
                  aria-label={
                    projectScopedTerminalViewEnabled
                      ? t("settings.general.disableProjectScopedTerminalView")
                      : t("settings.general.enableProjectScopedTerminalView")
                  }
                />
              </Group>
            </Card>
          </Stack>
        </section>

        {terminalPreview}

        <section className="ui-surface-card rounded-2xl border border-border p-4 xl:col-start-1 xl:row-start-2">
          <Stack gap="md">
            <Group align="flex-end" justify="space-between" gap="md">
              <Text size="sm" fw={600} c="var(--on-surface)">
                {text("终端主题库", "Terminal Theme Library")}
              </Text>
              <TextInput
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={text("搜索主题...", "Search themes...")}
                size="xs"
                w={220}
                aria-label={text("终端主题搜索", "Terminal theme search")}
              />
            </Group>

            <Stack gap="md">
            {groupedThemes.map((group) => (
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
                    const active = terminalThemeName === preset.id;
                    return (
                      <UnstyledButton
                        key={preset.id}
                        onClick={() => {
                          void update("terminalThemeName", preset.id);
                        }}
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
            {filtered.length === 0 && (
              <Card className="border border-dashed border-border bg-surface-container-lowest text-center" p="lg" radius="lg">
                <Text size="xs" c="var(--on-surface-variant)">
                  {text("未找到匹配主题", "No matching themes")}
                </Text>
              </Card>
            )}
            </Stack>
          </Stack>
        </section>

        <div className="min-w-0 xl:col-start-1 xl:row-start-3">
          <TerminalBackgroundSection />
        </div>
      </section>
    </Stack>
  );
}
