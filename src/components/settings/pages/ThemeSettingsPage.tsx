import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ActionIcon,
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
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, ChevronDown, CircleHelp, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  TERMINAL_THEME_GROUPS,
  TERMINAL_THEME_PRESETS,
  getTerminalTheme,
  resolveTerminalThemeId,
} from "../../../lib/terminalThemes";
import { debugConsoleWarn } from "../../../lib/debugConsole";
import { FOLLOW_TERMINAL_PREVIEW_THEME } from "../../../lib/terminalPreviewTheme";
import { normalizeTerminalFontFamily } from "../../../lib/terminalFontFamily";
import { normalizeShellKey, getOsPlatform } from "../../../lib/shell";
import type { OsPlatform } from "../../../lib/shell";
import {
  getEnabledTerminalShellOptions,
  makeCustomTerminalShellProfile,
  mergeTerminalShellProfiles,
  type TerminalShellProfile,
} from "../../../lib/terminalShellProfiles";
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_SCROLLBACK_ROWS_DEFAULT,
  TERMINAL_SCROLLBACK_ROWS_MAX,
  TERMINAL_SCROLLBACK_ROWS_MIN,
  useSettingsStore,
  type BatchLaunchPaneDirection,
  type CloseBehavior,
  type ExitWithRunningTasksBehavior,
  type TerminalSessionRestoreMode,
  type TerminalSettingsSectionKey,
  type UnsplitBehavior,
} from "../../../stores/settingsStore";
import { useTerminalStore } from "../../../stores/terminalStore";
import { TerminalBackgroundSection } from "./TerminalBackgroundSection";
import { SWATCH_KEYS, TerminalThemePresetGrid } from "./TerminalThemePresetGrid";
import {
  listSystemFonts,
  mergeFontFamilyOptions,
  type SystemFontFamily,
} from "../../../lib/systemFonts";
import { FontFamilySelect } from "../FontFamilySelect";
import { pickByLanguage, useI18n } from "../../../lib/i18n";
import {
  type TerminalPaneMarkerSettings,
  type TerminalPaneMarkerStyle,
} from "../../../lib/terminalPaneMarker";

const TERMINAL_FONT_FALLBACK = "monospace";
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
type TerminalThemeLibraryMode = "light" | "dark" | "system";
type TerminalPreviewThemeMode = "follow" | "independent";
type PaneMarkerPreviewColorKey = "doneColor" | "failedColor" | "attentionColor";

const PANE_MARKER_PREVIEW_COLOR_OPTIONS = [
  ["doneColor", "settings.terminal.paneMarker.color.done"],
  ["failedColor", "settings.terminal.paneMarker.color.failed"],
  ["attentionColor", "settings.terminal.paneMarker.color.attention"],
] as const satisfies ReadonlyArray<readonly [PaneMarkerPreviewColorKey, string]>;

const FONT_FAMILY_OPTIONS: { value: string; label: string; labelEn?: string }[] = [
  { value: "Cascadia Code, Consolas, monospace", label: "Cascadia Code（推荐）", labelEn: "Cascadia Code (Recommended)" },
  { value: "\"JetBrains Mono\", \"Cascadia Code\", Consolas, monospace", label: "JetBrains Mono" },
  { value: "\"Fira Code\", \"Cascadia Code\", Consolas, monospace", label: "Fira Code" },
  { value: "\"Microsoft YaHei\", \"Cascadia Code\", Consolas, monospace", label: "微软雅黑" },
  { value: "Consolas, monospace", label: "Consolas" },
  { value: "\"Courier New\", monospace", label: "Courier New" },
];

interface TerminalColorSettingProps {
  value: string;
  fallbackColor: string;
  label: string;
  pickerAriaLabel: string;
  hexAriaLabel: string;
  description?: string;
  invalidDescription: string;
  restoreLabel: string;
  onCommit: (value: string) => void;
}

function TerminalColorSetting({
  value,
  fallbackColor,
  label,
  pickerAriaLabel,
  hexAriaLabel,
  description,
  invalidDescription,
  restoreLabel,
  onCommit,
}: TerminalColorSettingProps) {
  const [draft, setDraft] = useState(value);
  const commitTimerRef = useRef<number | null>(null);

  const clearCommitTimer = () => {
    if (commitTimerRef.current === null) return;
    window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
  };

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => clearCommitTimer, []);

  const normalizedDraft = draft.trim();
  const invalid = normalizedDraft !== "" && !HEX_COLOR_PATTERN.test(normalizedDraft);
  const pickerValue = HEX_COLOR_PATTERN.test(normalizedDraft) ? normalizedDraft : fallbackColor;

  const commit = (candidate = draft) => {
    clearCommitTimer();
    const next = candidate.trim();
    if (next !== "" && !HEX_COLOR_PATTERN.test(next)) return;
    if (next !== value) onCommit(next);
  };

  const scheduleCommit = (candidate: string) => {
    clearCommitTimer();
    const next = candidate.trim();
    if (next !== "" && !HEX_COLOR_PATTERN.test(next)) return;
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = null;
      if (next !== value) onCommit(next);
    }, 180);
  };

  return (
    <Box className="border-b border-border px-3 py-3 last:border-b-0">
      <Box className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Box className="min-w-0 flex-1">
          <Text size="xs" fw={600} c="var(--on-surface)">
            {label}
          </Text>
          {(invalid || description) && (
            <Text mt={4} size="xs" lh={1.45} c={invalid ? "var(--danger)" : "var(--text-muted)"}>
              {invalid ? invalidDescription : description}
            </Text>
          )}
        </Box>
        <Box className="grid w-full max-w-[324px] shrink-0 grid-cols-[44px_116px_minmax(0,1fr)] items-center gap-2 sm:w-[324px]">
          <TextInput
            type="color"
            value={pickerValue}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setDraft(next);
              scheduleCommit(next);
            }}
            onBlur={() => commit()}
            w={44}
            size="xs"
            aria-label={pickerAriaLabel}
            styles={{ input: { cursor: "pointer", height: 30, padding: 3 } }}
          />
          <TextInput
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value.trim())}
            onBlur={() => commit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
            }}
            placeholder={fallbackColor}
            size="xs"
            w={116}
            aria-label={hexAriaLabel}
            aria-invalid={invalid}
            styles={{ input: { fontFamily: "var(--font-ui-mono)", fontSize: 12 } }}
          />
          {value && (
            <Button
              type="button"
              size="xs"
              variant="subtle"
              color="cliPrimary"
              onClick={() => {
                clearCommitTimer();
                setDraft("");
                onCommit("");
              }}
              className="min-w-0 justify-self-start whitespace-nowrap"
            >
              {restoreLabel}
            </Button>
          )}
        </Box>
      </Box>
    </Box>
  );
}

const UNSPLIT_OPTIONS: { value: UnsplitBehavior; label: string; labelEn: string }[] = [
  { value: "merge", label: "合并到相邻 Pane", labelEn: "Merge into adjacent Pane" },
  { value: "close", label: "关闭当前 Pane 内终端", labelEn: "Close terminals in current Pane" },
];

function clampFontSize(value: number) {
  if (!Number.isFinite(value)) return TERMINAL_FONT_SIZE_MIN;
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, value));
}

function clampTerminalScrollbackRows(value: number) {
  if (!Number.isFinite(value)) return TERMINAL_SCROLLBACK_ROWS_DEFAULT;
  return Math.min(TERMINAL_SCROLLBACK_ROWS_MAX, Math.max(TERMINAL_SCROLLBACK_ROWS_MIN, Math.round(value)));
}

function getFirstTerminalThemeIdByTone(tone: "light" | "dark") {
  return TERMINAL_THEME_PRESETS.find((preset) => preset.tone === tone)?.id ?? TERMINAL_THEME_PRESETS[0]?.id;
}

function CollapsibleSettingsSection({
  title,
  description,
  open = true,
  onToggle,
  children,
  className = "",
  collapsible = true,
}: {
  title: string;
  description?: string;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
  className?: string;
  collapsible?: boolean;
}) {
  const headerContent = (
    <>
      <Box>
        <Text size="sm" fw={600} c="var(--on-surface)">
          {title}
        </Text>
        {description && (
          <Text mt={4} size="xs" c="var(--on-surface-variant)">
            {description}
          </Text>
        )}
      </Box>
      {collapsible && (
        <ChevronDown
          size={18}
          strokeWidth={1.8}
          className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      )}
    </>
  );

  return (
    <section className={`ui-surface-card rounded-2xl border border-border overflow-hidden ${className}`}>
      {collapsible ? (
        <button
          type="button"
          onClick={onToggle}
          className="ui-focus-ring flex w-full items-center justify-between gap-3 p-4 text-left outline-none transition-colors hover:bg-surface-container-highest/50"
          aria-expanded={open}
        >
          {headerContent}
        </button>
      ) : (
        <div className="p-4">{headerContent}</div>
      )}
      {collapsible ? (
        open === true && <Box px="md" pt="sm" pb="md">{children}</Box>
      ) : (
        <Box px="md" pb="md">{children}</Box>
      )}
    </section>
  );
}

function PaneMarkerStylePreview({
  style,
  label,
  markerColor,
  selected,
  onSelect,
}: {
  style: TerminalPaneMarkerStyle;
  label: string;
  markerColor: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const previewBorder = "color-mix(in srgb, var(--terminal-theme-muted, #64748b) 34%, transparent)";
  const previewChrome =
    "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 84%, var(--terminal-theme-foreground, #f8fafc) 16%)";
  const markerStyle = {
    "--terminal-pane-marker-color": markerColor,
    "--terminal-pane-marker-width": "2px",
    "--terminal-pane-marker-opacity": 1,
    "--terminal-pane-marker-side-height": "8px",
  } as CSSProperties;

  return (
    <UnstyledButton
      type="button"
      className="ui-focus-ring ui-selection-card cursor-pointer rounded-xl border p-3 transition-colors"
      style={{
        borderColor: "var(--border)",
        background: selected
          ? "color-mix(in srgb, var(--primary) 8%, var(--surface-container-low))"
          : "transparent",
      }}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={label}
    >
      <Box
        aria-hidden="true"
        className="grid h-24 grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] overflow-hidden rounded-lg border font-mono text-[9px] leading-[1.45]"
        style={{
          borderColor: previewBorder,
          backgroundColor: "var(--terminal-theme-background, #0c0e10)",
          color: "var(--terminal-theme-foreground, #f8fafc)",
        }}
      >
        <div className="flex min-w-0 flex-col border-r" style={{ borderColor: previewBorder }}>
          <div
            className="flex h-6 shrink-0 items-center gap-1.5 border-b px-2"
            style={{ borderColor: previewBorder, background: previewChrome }}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: "var(--terminal-theme-muted, #64748b)" }}
            />
            <span className="truncate opacity-75">PowerShell</span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden px-2 py-1.5">
            <div>PS&gt; npm run dev</div>
            <div className="mt-1" style={{ color: "var(--terminal-theme-accent, #60a5fa)" }}>VITE v7.0.0</div>
            <div className="truncate opacity-55">localhost:5173</div>
          </div>
        </div>

        <div className="flex min-w-0 flex-col">
          <div
            className="flex h-6 shrink-0 items-center gap-1.5 border-b px-2"
            style={{ borderColor: previewBorder, background: previewChrome }}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: "var(--terminal-theme-accent, #60a5fa)" }}
            />
            <span className="truncate">Codex</span>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden px-2 py-1.5">
            <div>&gt; git diff --stat</div>
            <div className="mt-1 truncate opacity-65">src/App.tsx</div>
            <div style={{ color: "var(--terminal-theme-accent, #60a5fa)" }}>3 files +24 -7</div>
            <div
              className="ui-terminal-pane-marker"
              data-marker-style={style}
              data-marker-status="focus"
              style={markerStyle}
            >
              <span className="ui-terminal-pane-marker__top" />
              <span className="ui-terminal-pane-marker__right" />
              <span className="ui-terminal-pane-marker__bottom" />
              <span className="ui-terminal-pane-marker__left" />
            </div>
          </div>
        </div>
      </Box>
      <Group mt={8} justify="center" gap={5} wrap="nowrap">
        {selected && <Check size={13} strokeWidth={2.5} aria-hidden="true" />}
        <Text size="xs" ta="center" fw={selected ? 600 : 400} c={selected ? "var(--primary)" : undefined}>
          {label}
        </Text>
      </Group>
    </UnstyledButton>
  );
}

export function ThemeSettingsPage() {
  const { language, t } = useI18n();
  const text = (zh: string, en: string) => pickByLanguage(language, zh, en);
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const terminalPreviewThemeName = useSettingsStore((s) => s.terminalPreviewThemeName);
  const terminalThemeMode = useSettingsStore((s) => s.terminalThemeMode);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const terminalScrollbackCustomEnabled = useSettingsStore((s) => s.terminalScrollbackCustomEnabled);
  const terminalScrollbackRows = useSettingsStore((s) => s.terminalScrollbackRows);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const terminalTextColor = useSettingsStore((s) => s.terminalTextColor);
  const terminalTuiUserColor = useSettingsStore((s) => s.terminalTuiUserColor);
  const terminalTuiAssistantColor = useSettingsStore((s) => s.terminalTuiAssistantColor);
  const normalizedFontFamily = normalizeTerminalFontFamily(fontFamily);
  const defaultShell = useSettingsStore((s) => s.defaultShell);
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const unsplitBehavior = useSettingsStore((s) => s.unsplitBehavior);
  const closeBehavior = useSettingsStore((s) => s.closeBehavior);
  const exitWithRunningTasksBehavior = useSettingsStore((s) => s.exitWithRunningTasksBehavior);
  const terminalSessionRestoreEnabled = useSettingsStore((s) => s.terminalSessionRestoreEnabled);
  const terminalSessionRestoreMode = useSettingsStore((s) => s.terminalSessionRestoreMode);
  const backgroundIncludeFinishedTasks = useSettingsStore((s) => s.backgroundIncludeFinishedTasks);
  const confirmBeforeClosingTerminalTab = useSettingsStore((s) => s.confirmBeforeClosingTerminalTab);
  const terminalTabHoverInfoEnabled = useSettingsStore((s) => s.terminalTabHoverInfoEnabled);
  const shellRuntimeMonitoringEnabled = useSettingsStore((s) => s.shellRuntimeMonitoringEnabled);
  const batchLaunchGroupInPane = useSettingsStore((s) => s.batchLaunchGroupInPane);
  const batchLaunchPaneDirection = useSettingsStore((s) => s.batchLaunchPaneDirection);
  const projectScopedTerminalViewEnabled = useSettingsStore((s) => s.projectScopedTerminalViewEnabled);
  const workspanEnabled = useSettingsStore((s) => s.workspanEnabled);
  const setWorkspanModeEnabled = useTerminalStore((s) => s.setWorkspanModeEnabled);
  const terminalShellProfiles = useSettingsStore((s) => s.terminalShellProfiles);
  const terminalSettingsSectionsExpanded = useSettingsStore((s) => s.terminalSettingsSectionsExpanded);
  const terminalPaneMarker = useSettingsStore((s) => s.terminalPaneMarker);
  const update = useSettingsStore((s) => s.update);
  const setTerminalThemeMode = useSettingsStore((s) => s.setTerminalThemeMode);
  const [query, setQuery] = useState("");
  const [previewThemeQuery, setPreviewThemeQuery] = useState("");
  const [fontSizeDraft, setFontSizeDraft] = useState(fontSize);
  const [terminalScrollbackRowsDraft, setTerminalScrollbackRowsDraft] = useState(terminalScrollbackRows);
  const [paneMarkerPreviewColorKey, setPaneMarkerPreviewColorKey] =
    useState<PaneMarkerPreviewColorKey>("doneColor");
  const paneMarkerPreviewColor = terminalPaneMarker[paneMarkerPreviewColorKey];
  const displayedTerminalScrollbackRows = terminalScrollbackCustomEnabled
    ? terminalScrollbackRowsDraft
    : TERMINAL_SCROLLBACK_ROWS_DEFAULT;
  const [osPlatform, setOsPlatform] = useState<OsPlatform>("windows");
  const [systemFonts, setSystemFonts] = useState<SystemFontFamily[]>([]);
  const [systemFontsLoading, setSystemFontsLoading] = useState(false);
  const [systemFontsError, setSystemFontsError] = useState<string | null>(null);
  const [shellScanLoading, setShellScanLoading] = useState(false);
  const [shellScanError, setShellScanError] = useState<string | null>(null);
  const [customShellName, setCustomShellName] = useState("");
  const [customShellPath, setCustomShellPath] = useState("");

  const toggleSection = (key: TerminalSettingsSectionKey) => {
    const nextExpanded = { ...terminalSettingsSectionsExpanded, [key]: !terminalSettingsSectionsExpanded[key] };
    void update("terminalSettingsSectionsExpanded", nextExpanded);
  };

  const updatePaneMarker = <K extends keyof TerminalPaneMarkerSettings>(key: K, value: TerminalPaneMarkerSettings[K]) => {
    void update("terminalPaneMarker", { ...terminalPaneMarker, [key]: value });
  };

  const scanTerminalShellProfiles = async (platform = osPlatform) => {
    if (platform === "unknown") return;
    setShellScanLoading(true);
    setShellScanError(null);
    try {
      const scanned = await invoke<TerminalShellProfile[]>("terminal_shell_scan");
      const currentProfiles = useSettingsStore.getState().terminalShellProfiles;
      const nextProfiles = mergeTerminalShellProfiles(currentProfiles, scanned, platform);
      await update("terminalShellProfiles", nextProfiles);
    } catch (err) {
      debugConsoleWarn("Failed to scan terminal shell profiles:", err);
      setShellScanError(String(err));
    } finally {
      setShellScanLoading(false);
    }
  };

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
    void getOsPlatform().then((platform) => {
      setOsPlatform(platform);
      void scanTerminalShellProfiles(platform);
    });
  }, []);

  useEffect(() => {
    setFontSizeDraft(fontSize);
  }, [fontSize]);

  useEffect(() => {
    setTerminalScrollbackRowsDraft(terminalScrollbackRows);
  }, [terminalScrollbackRows]);

  const effectiveThemeName = terminalThemeMode === "system" ? "auto" : terminalThemeName;

  const autoThemeId = useMemo(
    () => resolveTerminalThemeId("auto", resolvedTheme, lightThemePalette, darkThemePalette),
    [darkThemePalette, lightThemePalette, resolvedTheme]
  );
  const selectedResolvedThemeId = useMemo(
    () => resolveTerminalThemeId(effectiveThemeName, resolvedTheme, lightThemePalette, darkThemePalette),
    [darkThemePalette, effectiveThemeName, lightThemePalette, resolvedTheme]
  );
  const selectedPreset = useMemo(
    () => TERMINAL_THEME_PRESETS.find((item) => item.id === selectedResolvedThemeId) ?? null,
    [selectedResolvedThemeId]
  );
  const themeLibraryMode: TerminalThemeLibraryMode =
    terminalThemeMode === "system" || terminalThemeName === "auto"
      ? "system"
      : selectedPreset?.tone === "light"
        ? "light"
        : "dark";

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const scoped =
      themeLibraryMode === "system"
        ? TERMINAL_THEME_PRESETS.filter((preset) => preset.id === autoThemeId)
        : TERMINAL_THEME_PRESETS.filter((preset) => preset.tone === themeLibraryMode);
    if (!keyword) return scoped;
    return scoped.filter((preset) => preset.name.toLowerCase().includes(keyword));
  }, [autoThemeId, query, themeLibraryMode]);

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
    return {
      label:
        selectedPreset?.name ?? text("独立终端主题", "Independent terminal theme"),
      theme: effective,
    };
  }, [darkThemePalette, effectiveThemeName, language, lightThemePalette, resolvedTheme, selectedPreset]);

  const defaultTerminalTextColor = selectedTheme.theme.foreground ?? "#d8dee9";
  const previewTerminalTextColor = terminalTextColor || defaultTerminalTextColor;

  const themeLibraryOptions = useMemo(
    () => [
      { value: "light" as const, label: t("settings.options.theme.light") },
      { value: "dark" as const, label: t("settings.options.theme.dark") },
      { value: "system" as const, label: t("settings.options.theme.system") },
    ],
    [t]
  );

  const selectIndependentTerminalTheme = async (themeName: string) => {
    await update("terminalThemeName", themeName);
    await setTerminalThemeMode("independent");
  };

  const handleThemeLibraryModeChange = (value: TerminalThemeLibraryMode) => {
    if (value === "system") {
      void setTerminalThemeMode("system");
      return;
    }
    const nextThemeName =
      terminalThemeMode !== "system" && terminalThemeName !== "auto" && selectedPreset?.tone === value
        ? selectedPreset.id
        : getFirstTerminalThemeIdByTone(value);
    if (nextThemeName) void selectIndependentTerminalTheme(nextThemeName);
  };

  const previewThemeMode: TerminalPreviewThemeMode =
    terminalPreviewThemeName === FOLLOW_TERMINAL_PREVIEW_THEME ? "follow" : "independent";

  const previewThemeModeOptions = useMemo(
    () => [
      { value: "follow" as const, label: text("跟随终端", "Follow terminal") },
      { value: "independent" as const, label: text("独立主题", "Independent theme") },
    ],
    [language]
  );

  const previewThemeGroups = useMemo(() => {
    const keyword = previewThemeQuery.trim().toLowerCase();
    const scoped = keyword
      ? TERMINAL_THEME_PRESETS.filter((preset) => preset.name.toLowerCase().includes(keyword))
      : TERMINAL_THEME_PRESETS;
    return TERMINAL_THEME_GROUPS.map((group) => ({
      ...group,
      presets: scoped.filter((preset) => preset.group === group.id),
    })).filter((group) => group.presets.length > 0);
  }, [previewThemeQuery]);

  const handlePreviewThemeModeChange = (value: TerminalPreviewThemeMode) => {
    if (value === "follow") {
      void update("terminalPreviewThemeName", FOLLOW_TERMINAL_PREVIEW_THEME);
      return;
    }
    // Seed the independent choice with what previews already show, so switching modes
    // never makes the panels jump to an unrelated theme.
    void update("terminalPreviewThemeName", selectedResolvedThemeId);
  };

  const fontFamilyOptions = useMemo(
    () =>
      mergeFontFamilyOptions(
        normalizedFontFamily,
        FONT_FAMILY_OPTIONS.map((option) => ({
          value: normalizeTerminalFontFamily(option.value),
          label: pickByLanguage(language, option.label, option.labelEn ?? option.label),
        })),
        systemFonts,
        TERMINAL_FONT_FALLBACK,
        normalizeTerminalFontFamily,
      ),
    [language, normalizedFontFamily, systemFonts]
  );
  const unsplitOptions = useMemo(
    () => UNSPLIT_OPTIONS.map((option) => ({
      value: option.value,
      label: pickByLanguage(language, option.label, option.labelEn),
    })),
    [language]
  );
  const closeBehaviorOptions: { value: CloseBehavior; label: string }[] = [
    { value: "ask", label: t("settings.options.close.ask") },
    { value: "minimize", label: t("settings.options.close.minimize") },
    { value: "exit", label: t("settings.options.close.exit") },
  ];
  const exitWithRunningTasksOptions: { value: ExitWithRunningTasksBehavior; label: string }[] = [
    { value: "ask", label: t("settings.options.exitTasks.ask") },
    { value: "background", label: t("settings.options.exitTasks.background") },
    { value: "minimize", label: t("settings.options.exitTasks.minimize") },
    { value: "discard", label: t("settings.options.exitTasks.discard") },
  ];
  const terminalSessionRestoreModeOptions: { value: TerminalSessionRestoreMode; label: string }[] = [
    { value: "ask", label: t("settings.options.sessionRestore.ask") },
    { value: "auto", label: t("settings.options.sessionRestore.auto") },
  ];
  const normalizedDefaultShell = normalizeShellKey(defaultShell);
  const shellSelectValue = normalizedDefaultShell ?? defaultShell;
  const enabledShellOptions = useMemo(
    () => getEnabledTerminalShellOptions(osPlatform, terminalShellProfiles),
    [osPlatform, terminalShellProfiles]
  );
  const shellOptions = useMemo(
    () => [
      ...(shellSelectValue && !enabledShellOptions.some((option) => option.value === shellSelectValue)
        ? [{ value: shellSelectValue, label: text("当前自定义（保留）", "Current custom (keep)") }]
        : []),
      ...enabledShellOptions,
    ],
    [enabledShellOptions, language, shellSelectValue]
  );
  const shellProfilesForPlatform = useMemo(
    () => terminalShellProfiles.filter((profile) => profile.platform === osPlatform),
    [osPlatform, terminalShellProfiles]
  );
  const enabledShellCount = shellProfilesForPlatform.filter(
    (profile) => profile.enabled && (profile.detected || profile.kind === "custom")
  ).length;

  const updateShellProfile = (id: string, patch: Partial<TerminalShellProfile>) => {
    const nextProfiles = terminalShellProfiles.map((profile) => (
      profile.id === id ? { ...profile, ...patch } : profile
    ));
    void update("terminalShellProfiles", nextProfiles);
  };

  const removeShellProfile = (id: string) => {
    void update("terminalShellProfiles", terminalShellProfiles.filter((profile) => profile.id !== id));
  };

  const handlePickCustomShell = async () => {
    const selected = await openDialog({
      directory: false,
      multiple: false,
      title: text("选择终端可执行文件", "Choose shell executable"),
    });
    if (typeof selected === "string") {
      setCustomShellPath(selected);
      if (!customShellName.trim()) {
        setCustomShellName(selected.replace(/\\/g, "/").split("/").pop() ?? "");
      }
    }
  };

  const handleAddCustomShell = () => {
    const command = customShellPath.trim();
    if (!command) return;
    const profile = makeCustomTerminalShellProfile(osPlatform, customShellName, command);
    const nextProfiles = [
      ...terminalShellProfiles.filter((item) => item.command !== profile.command),
      profile,
    ];
    void update("terminalShellProfiles", nextProfiles);
    setCustomShellName("");
    setCustomShellPath("");
  };
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

  const shellProfileSection = (
    <Stack gap="md">
      <Group justify="space-between" align="center" gap="md">
        <Box>
          <Text size="xs" c="var(--on-surface-variant)">
            {text(
              `当前平台：${osPlatform}，已启用 ${enabledShellCount} 个终端类型。`,
              `Current platform: ${osPlatform}. ${enabledShellCount} terminal types enabled.`
            )}
          </Text>
          {shellScanError && (
            <Text mt={4} size="xs" c="var(--danger)">
              {text("扫描失败：", "Scan failed: ")}{shellScanError}
            </Text>
          )}
        </Box>
        <Button
          variant="light"
          color="cliPrimary"
          size="xs"
          leftSection={<RefreshCw size={14} />}
          loading={shellScanLoading}
          onClick={() => void scanTerminalShellProfiles()}
        >
          {text("重新扫描", "Rescan")}
        </Button>
      </Group>

      <Stack gap="xs">
        {shellProfilesForPlatform.length === 0 && (
          <Card className="border border-dashed border-border bg-surface-container-lowest" p="sm" radius="lg">
            <Text size="xs" c="var(--on-surface-variant)">
              {shellScanLoading
                ? text("正在扫描终端类型...", "Scanning terminal types...")
                : text("尚无扫描结果，可点击重新扫描。", "No scan results yet. Click Rescan.")}
            </Text>
          </Card>
        )}
        {shellProfilesForPlatform.map((profile) => (
          <Card key={profile.id} className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
            <Group justify="space-between" align="center" gap="md" wrap="nowrap">
              <Box style={{ minWidth: 0 }}>
                <Group gap="xs" wrap="nowrap">
                  <Text size="xs" fw={600} c="var(--on-surface)" truncate>
                    {profile.label}
                  </Text>
                  <Badge size="xs" variant="light" color={profile.detected || profile.kind === "custom" ? "green" : "gray"}>
                    {profile.detected || profile.kind === "custom" ? text("可用", "Available") : text("未检测到", "Missing")}
                  </Badge>
                  {profile.kind === "custom" && (
                    <Badge size="xs" variant="light" color="blue">
                      {text("自定义", "Custom")}
                    </Badge>
                  )}
                </Group>
                <Text mt={4} size="xs" c="var(--text-muted)" className="font-mono" style={{ overflowWrap: "anywhere" }}>
                  {profile.command}
                </Text>
              </Box>
              <Group gap="xs" wrap="nowrap">
                {profile.kind === "custom" && (
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    aria-label={text("删除自定义终端", "Delete custom shell")}
                    onClick={() => removeShellProfile(profile.id)}
                  >
                    <Trash2 size={14} strokeWidth={1.8} />
                  </ActionIcon>
                )}
                <Switch
                  color="cliPrimary"
                  checked={profile.enabled}
                  disabled={!profile.detected && profile.kind !== "custom"}
                  onChange={(event) => updateShellProfile(profile.id, { enabled: event.currentTarget.checked })}
                  aria-label={profile.enabled ? text("禁用终端类型", "Disable terminal type") : text("启用终端类型", "Enable terminal type")}
                />
              </Group>
            </Group>
          </Card>
        ))}
      </Stack>

      <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
        <Stack gap="sm">
          <Text size="xs" fw={600} c="var(--on-surface)">
            {text("添加自定义终端", "Add Custom Shell")}
          </Text>
          <Group align="flex-end" gap="xs" wrap="wrap">
            <TextInput
              label={text("名称", "Name")}
              value={customShellName}
              onChange={(event) => setCustomShellName(event.currentTarget.value)}
              size="xs"
              style={{ flex: "1 1 160px" }}
            />
            <TextInput
              label={text("可执行文件", "Executable")}
              value={customShellPath}
              onChange={(event) => setCustomShellPath(event.currentTarget.value)}
              size="xs"
              style={{ flex: "2 1 260px" }}
            />
            <Button variant="light" color="cliPrimary" size="xs" onClick={() => void handlePickCustomShell()}>
              {text("选择地址", "Choose Path")}
            </Button>
            <Button
              variant="filled"
              color="cliPrimary"
              size="xs"
              leftSection={<Plus size={14} />}
              disabled={!customShellPath.trim()}
              onClick={handleAddCustomShell}
            >
              {text("添加", "Add")}
            </Button>
          </Group>
          <Text size="xs" c="var(--text-muted)">
            {text("仅保存名称和可执行文件路径；自定义启动参数仍请放在项目启动命令中。", "Only name and executable path are saved. Put custom startup arguments in the project startup command.")}
          </Text>
        </Stack>
      </Card>
    </Stack>
  );

  const terminalPreview = (
    <Stack gap="sm">
      <Text size="xs" c="var(--on-surface-variant)">
        {selectedTheme.label}
      </Text>
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
        style={{ backgroundColor: "var(--surface-container-lowest)", color: previewTerminalTextColor }}
      >
        <Box style={{ fontFamily: normalizedFontFamily, fontSize: `${fontSize}px` }}>
          <div>$ cli-manager --doctor</div>
          <div className="opacity-80">Environment ready. Launching workspace...</div>
          <div className="mt-1 text-success">Terminal initialized</div>
        </Box>
      </Box>
    </Stack>
  );

  return (
    <Stack gap="md">
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start">
        <Stack gap="md" className="min-w-0 xl:col-start-1 xl:row-start-1">
        <CollapsibleSettingsSection
          title={text("终端行为", "Terminal Behavior")}
          open={terminalSettingsSectionsExpanded.behavior}
          onToggle={() => toggleSection("behavior")}
        >
          <Stack gap="md">
            <Stack gap={6}>
              <Group justify="space-between" align="center">
                <Text size="xs" c="var(--on-surface-variant)">
                  {text("终端字体大小", "Terminal Font Size")}
                </Text>
                <NumberInput
                  min={TERMINAL_FONT_SIZE_MIN}
                  max={TERMINAL_FONT_SIZE_MAX}
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
                min={TERMINAL_FONT_SIZE_MIN}
                max={TERMINAL_FONT_SIZE_MAX}
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
                        <Text size="xs" c="inherit">{text("默认使用 9000 行；开启自定义后可设置 1000–50000 行。", "Defaults to 9000 rows; enable Custom to choose 1000–50000 rows.")}</Text>
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
                <Group gap="sm" wrap="nowrap">
                  <Switch
                    size="sm"
                    color="cliPrimary"
                    label={text("自定义", "Custom")}
                    checked={terminalScrollbackCustomEnabled}
                    onChange={(event) => void update("terminalScrollbackCustomEnabled", event.currentTarget.checked)}
                    aria-label={text("自定义终端回滚行数", "Customize terminal scrollback rows")}
                  />
                  <NumberInput
                    min={TERMINAL_SCROLLBACK_ROWS_MIN}
                    max={TERMINAL_SCROLLBACK_ROWS_MAX}
                    step={1000}
                    value={displayedTerminalScrollbackRows}
                    onChange={(value) => setTerminalScrollbackRowsDraft(typeof value === "number" ? value : Number(value))}
                    onBlur={() => commitTerminalScrollbackRows()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitTerminalScrollbackRows();
                    }}
                    disabled={!terminalScrollbackCustomEnabled}
                    size="xs"
                    w={104}
                    aria-label={text("终端回滚行数数值", "Terminal scrollback rows value")}
                  />
                </Group>
              </Group>
              <Slider
                min={TERMINAL_SCROLLBACK_ROWS_MIN}
                max={TERMINAL_SCROLLBACK_ROWS_MAX}
                step={1000}
                value={displayedTerminalScrollbackRows}
                onChange={setTerminalScrollbackRowsDraft}
                onChangeEnd={(value) => commitTerminalScrollbackRows(value)}
                disabled={!terminalScrollbackCustomEnabled}
                color="cliPrimary"
                aria-label={text("终端回滚行数滑杆", "Terminal scrollback rows slider")}
              />
              <Text size="xs" c="var(--text-muted)">
                {terminalScrollbackCustomEnabled
                  ? text("控制内置终端可向上回看的历史行数。", "Controls how many history rows the built-in terminal can scroll back.")
                  : text("当前使用默认 9000 行；开启自定义后可调整。", "Using the default 9000 rows; enable Custom to adjust it.")}
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

            <Box className="overflow-hidden rounded-xl border border-border bg-surface-container-lowest">
              <Box className="border-b border-border bg-surface-container-low px-3 py-2.5">
                <Text size="sm" fw={600} c="var(--on-surface)">
                  {t("settings.terminal.colorGroupTitle")}
                </Text>
                <Text mt={3} size="xs" c="var(--on-surface-variant)">
                  {t("settings.terminal.colorGroupDescription")}
                </Text>
              </Box>
              <Stack gap={0}>
                <TerminalColorSetting
                  value={terminalTextColor}
                  fallbackColor={defaultTerminalTextColor}
                  label={t("settings.terminal.textColor")}
                  pickerAriaLabel={t("settings.terminal.textColorPicker")}
                  hexAriaLabel={t("settings.terminal.textColorHex")}
                  description={t("settings.terminal.textColorDefaultHint")}
                  invalidDescription={t("settings.terminal.textColorInvalid")}
                  restoreLabel={t("settings.terminal.restoreThemeColor")}
                  onCommit={(value) => void update("terminalTextColor", value)}
                />

                <TerminalColorSetting
                  value={terminalTuiUserColor}
                  fallbackColor={defaultTerminalTextColor}
                  label={t("settings.terminal.tuiUserColor")}
                  pickerAriaLabel={t("settings.terminal.tuiUserColorPicker")}
                  hexAriaLabel={t("settings.terminal.tuiUserColorHex")}
                  invalidDescription={t("settings.terminal.textColorInvalid")}
                  restoreLabel={t("settings.terminal.restoreNativeColor")}
                  onCommit={(value) => void update("terminalTuiUserColor", value)}
                />

                <TerminalColorSetting
                  value={terminalTuiAssistantColor}
                  fallbackColor={defaultTerminalTextColor}
                  label={t("settings.terminal.tuiAssistantColor")}
                  pickerAriaLabel={t("settings.terminal.tuiAssistantColorPicker")}
                  hexAriaLabel={t("settings.terminal.tuiAssistantColorHex")}
                  invalidDescription={t("settings.terminal.textColorInvalid")}
                  restoreLabel={t("settings.terminal.restoreNativeColor")}
                  onCommit={(value) => void update("terminalTuiAssistantColor", value)}
                />
              </Stack>
            </Box>

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

            <Select<ExitWithRunningTasksBehavior>
              label={t("settings.general.exitWithRunningTasks")}
              value={exitWithRunningTasksBehavior}
              onChange={(value) => {
                if (value) void update("exitWithRunningTasksBehavior", value);
              }}
              data={exitWithRunningTasksOptions}
              allowDeselect={false}
              size="xs"
              aria-label={t("settings.general.exitWithRunningTasks")}
              description={t("settings.general.exitWithRunningTasksDescription")}
            />

            <Select<TerminalSessionRestoreMode>
              label={t("settings.general.terminalSessionRestoreMode")}
              value={terminalSessionRestoreMode}
              onChange={(value) => {
                if (value) void update("terminalSessionRestoreMode", value);
              }}
              data={terminalSessionRestoreModeOptions}
              allowDeselect={false}
              disabled={!terminalSessionRestoreEnabled}
              size="xs"
              aria-label={t("settings.general.terminalSessionRestoreMode")}
              description={
                terminalSessionRestoreEnabled
                  ? t("settings.general.terminalSessionRestoreModeDescription")
                  : t("settings.general.terminalSessionRestoreModeDisabledHint")
              }
            />

            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Box>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {t("settings.general.backgroundIncludeFinished")}
                  </Text>
                  <Text mt={4} size="xs" lh={1.55} c="var(--text-muted)">
                    {t("settings.general.backgroundIncludeFinishedDescription")}
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  checked={backgroundIncludeFinishedTasks}
                  onChange={(event) => void update("backgroundIncludeFinishedTasks", event.currentTarget.checked)}
                  aria-label={t("settings.general.backgroundIncludeFinished")}
                />
              </Group>
            </Card>

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
            <Card className="border border-border bg-surface-container-lowest" p="sm" radius="lg">
              <Group justify="space-between" align="center" gap="md" wrap="nowrap">
                <Box>
                  <Text size="xs" c="var(--on-surface-variant)">
                    {t("settings.general.workspanDevelopment")}
                  </Text>
                  <Text mt={4} size="xs" c="var(--text-muted)">
                    {t("settings.general.workspanDevelopmentDescription")}
                  </Text>
                </Box>
                <Switch
                  color="cliPrimary"
                  checked={workspanEnabled}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked;
                    void update("workspanEnabled", enabled).then(() => setWorkspanModeEnabled(enabled));
                  }}
                  aria-label={
                    workspanEnabled
                      ? t("settings.general.disableWorkspanDevelopment")
                      : t("settings.general.enableWorkspanDevelopment")
                  }
                />
              </Group>
            </Card>
          </Stack>
        </CollapsibleSettingsSection>

        <CollapsibleSettingsSection
          title={t("settings.terminal.paneMarker.title")}
          description={t("settings.terminal.paneMarker.description")}
          open={terminalSettingsSectionsExpanded.paneMarker}
          onToggle={() => toggleSection("paneMarker")}
        >
          <Stack gap="md">
            <Group justify="space-between" align="center" gap="md" wrap="nowrap">
              <Text size="xs" c="var(--on-surface-variant)">
                {t("settings.terminal.paneMarker.enabled")}
              </Text>
              <Switch
                color="cliPrimary"
                checked={terminalPaneMarker.enabled}
                onChange={(event) => updatePaneMarker("enabled", event.currentTarget.checked)}
                aria-label={t(
                  terminalPaneMarker.enabled
                    ? "settings.terminal.paneMarker.disableAria"
                    : "settings.terminal.paneMarker.enableAria"
                )}
              />
            </Group>

            <fieldset
              disabled={!terminalPaneMarker.enabled}
              aria-disabled={!terminalPaneMarker.enabled}
              className="m-0 min-w-0 border-0 p-0"
            >
              <Stack gap="md" style={!terminalPaneMarker.enabled ? { opacity: 0.55 } : undefined}>
                <SimpleGrid
                  cols={{ base: 1, sm: 2 }}
                  role="group"
                  aria-label={t("settings.terminal.paneMarker.styleAria")}
                >
                  {([
                    ["full", "settings.terminal.paneMarker.style.full"],
                    ["tab-top", "settings.terminal.paneMarker.style.tabTop"],
                  ] as const).map(([style, labelKey]) => (
                    <PaneMarkerStylePreview
                      key={style}
                      style={style}
                      label={t(labelKey)}
                      markerColor={paneMarkerPreviewColor}
                      selected={terminalPaneMarker.style === style}
                      onSelect={() => updatePaneMarker("style", style)}
                    />
                  ))}
                </SimpleGrid>

                <SimpleGrid cols={{ base: 1, sm: 3 }}>
                  {PANE_MARKER_PREVIEW_COLOR_OPTIONS.map(([key, labelKey]) => {
                    const selected = paneMarkerPreviewColorKey === key;
                    return (
                      <Stack
                        key={key}
                        gap={6}
                        className="rounded-lg border p-2 transition-colors"
                        style={{
                          borderColor: selected ? "var(--primary)" : "var(--border)",
                          background: selected
                            ? "color-mix(in srgb, var(--primary) 8%, var(--surface-container-low))"
                            : "transparent",
                        }}
                      >
                        <UnstyledButton
                          type="button"
                          className="ui-focus-ring flex w-full items-center justify-between gap-2 rounded-md text-left"
                          onClick={() => setPaneMarkerPreviewColorKey(key)}
                          aria-pressed={selected}
                        >
                          <Text
                            size="xs"
                            fw={selected ? 600 : 400}
                            c={selected ? "var(--primary)" : "var(--on-surface-variant)"}
                          >
                            {t(labelKey)}
                          </Text>
                          {selected && <Check size={13} strokeWidth={2.5} aria-hidden="true" />}
                        </UnstyledButton>
                        <Group gap="xs" wrap="nowrap">
                          <TextInput
                            type="color"
                            value={terminalPaneMarker[key]}
                            onPointerDown={() => setPaneMarkerPreviewColorKey(key)}
                            onFocus={() => setPaneMarkerPreviewColorKey(key)}
                            onChange={(event) => updatePaneMarker(key, event.currentTarget.value.toUpperCase())}
                            w={52}
                            size="xs"
                            aria-label={t(`${labelKey}Aria`)}
                            styles={{ input: { cursor: "pointer", padding: 4 } }}
                          />
                          <Text size="xs" ff="monospace">{terminalPaneMarker[key]}</Text>
                        </Group>
                      </Stack>
                    );
                  })}
                </SimpleGrid>
              </Stack>
            </fieldset>
          </Stack>
        </CollapsibleSettingsSection>

        <CollapsibleSettingsSection
          title={text("Shell / 终端类型", "Shell / Terminal Types")}
          description={text("扫描并启用可在新建项目中选择的终端。", "Scan and enable terminal types shown when creating projects.")}
          open={terminalSettingsSectionsExpanded.shells}
          onToggle={() => toggleSection("shells")}
        >
          {shellProfileSection}
        </CollapsibleSettingsSection>

        <CollapsibleSettingsSection
          title={text("终端主题库", "Terminal Theme Library")}
          open={terminalSettingsSectionsExpanded.themes}
          onToggle={() => toggleSection("themes")}
        >
          <Stack gap="md">
            <SegmentedControl<TerminalThemeLibraryMode>
              value={themeLibraryMode}
              onChange={handleThemeLibraryModeChange}
              data={themeLibraryOptions}
              color="cliPrimary"
              fullWidth
              aria-label={text("终端主题分组", "Terminal theme group")}
            />
            <Group align="flex-end" justify="space-between" gap="md">
              <TextInput
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={text("搜索主题...", "Search themes...")}
                size="xs"
                w={220}
                aria-label={text("终端主题搜索", "Terminal theme search")}
              />
            </Group>

            <Box className="xl:hidden">
              {terminalPreview}
            </Box>

            <TerminalThemePresetGrid
              groups={groupedThemes}
              isSelected={(preset) => (
                terminalThemeMode === "system" || terminalThemeName === "auto"
                  ? selectedResolvedThemeId === preset.id
                  : terminalThemeName === preset.id
              )}
              onSelect={(preset) => {
                void selectIndependentTerminalTheme(preset.id);
              }}
            />
          </Stack>
        </CollapsibleSettingsSection>

        <CollapsibleSettingsSection
          title={text("预览主题", "Preview Theme")}
          description={text(
            "作用于终端右侧的 Markdown 预览、子代理转录、会话回放与终端内 Git diff；默认跟随终端主题。",
            "Applies to the Markdown preview, subagent transcript, session replay, and in-terminal Git diff. Follows the terminal theme by default.",
          )}
          open={terminalSettingsSectionsExpanded.previewTheme}
          onToggle={() => toggleSection("previewTheme")}
        >
          <Stack gap="md">
            <SegmentedControl<TerminalPreviewThemeMode>
              value={previewThemeMode}
              onChange={handlePreviewThemeModeChange}
              data={previewThemeModeOptions}
              color="cliPrimary"
              fullWidth
              aria-label={text("预览主题模式", "Preview theme mode")}
            />
            {previewThemeMode === "follow" ? (
              <Text size="xs" c="var(--text-muted)">
                {text(
                  `预览面板当前跟随终端主题：${selectedTheme.label}`,
                  `Preview panels currently follow the terminal theme: ${selectedTheme.label}`,
                )}
              </Text>
            ) : (
              <>
                <Group align="flex-end" justify="space-between" gap="md">
                  <TextInput
                    value={previewThemeQuery}
                    onChange={(event) => setPreviewThemeQuery(event.currentTarget.value)}
                    placeholder={text("搜索主题...", "Search themes...")}
                    size="xs"
                    w={220}
                    aria-label={text("预览主题搜索", "Preview theme search")}
                  />
                </Group>
                <TerminalThemePresetGrid
                  groups={previewThemeGroups}
                  isSelected={(preset) => preset.id === terminalPreviewThemeName}
                  onSelect={(preset) => {
                    void update("terminalPreviewThemeName", preset.id);
                  }}
                />
              </>
            )}
          </Stack>
        </CollapsibleSettingsSection>

        <div className="min-w-0">
          <CollapsibleSettingsSection
            title={text("终端背景", "Terminal Background")}
            open={terminalSettingsSectionsExpanded.background}
            onToggle={() => toggleSection("background")}
          >
          <TerminalBackgroundSection embedded />
          </CollapsibleSettingsSection>
        </div>
        </Stack>

        <CollapsibleSettingsSection
          title={text("终端预览", "Terminal Preview")}
          collapsible={false}
          className="hidden self-start xl:sticky xl:top-5 xl:z-10 xl:col-start-2 xl:row-start-1 xl:block"
        >
          {terminalPreview}
        </CollapsibleSettingsSection>
      </section>
    </Stack>
  );
}
