import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  TERMINAL_THEME_PRESETS,
  getTerminalTheme,
  resolveAutoTerminalThemeId,
} from "../../../lib/terminalThemes";
import { useSettingsStore } from "../../../stores/settingsStore";
import { SHELL_OPTIONS } from "../../../lib/types";
import { normalizeShellKey } from "../../../lib/shell";
import { TerminalBackgroundSection } from "./TerminalBackgroundSection";

const SWATCH_KEYS = ["background", "foreground", "red", "green", "blue", "cyan"] as const;
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 24;

const FONT_FAMILY_OPTIONS: { value: string; label: string }[] = [
  { value: "Cascadia Code, Consolas, monospace", label: "Cascadia Code（推荐）" },
  { value: "\"JetBrains Mono\", \"Cascadia Code\", Consolas, monospace", label: "JetBrains Mono" },
  { value: "\"Fira Code\", \"Cascadia Code\", Consolas, monospace", label: "Fira Code" },
  { value: "Consolas, monospace", label: "Consolas" },
  { value: "\"Courier New\", monospace", label: "Courier New" },
];

function clampFontSize(value: number) {
  if (!Number.isFinite(value)) return FONT_SIZE_MIN;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, value));
}

export function ThemeSettingsPage() {
  const terminalThemeMode = useSettingsStore((s) => s.terminalThemeMode);
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const defaultShell = useSettingsStore((s) => s.defaultShell);
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const setTerminalThemeMode = useSettingsStore((s) => s.setTerminalThemeMode);
  const update = useSettingsStore((s) => s.update);
  const [query, setQuery] = useState("");
  const [fontSizeDraft, setFontSizeDraft] = useState(fontSize);
  const autoThemeId = useMemo(
    () => resolveAutoTerminalThemeId(resolvedTheme, lightThemePalette, darkThemePalette),
    [darkThemePalette, lightThemePalette, resolvedTheme]
  );
  const effectiveThemeName = terminalThemeMode === "follow-app" ? "auto" : terminalThemeName;

  useEffect(() => {
    setFontSizeDraft(fontSize);
  }, [fontSize]);

  const normalizedDefaultShell = normalizeShellKey(defaultShell);
  const shellSelectValue = normalizedDefaultShell ?? defaultShell;
  const isCustomShellValue = !normalizedDefaultShell;
  const isCustomFontFamily = useMemo(
    () => !FONT_FAMILY_OPTIONS.some((opt) => opt.value === fontFamily),
    [fontFamily]
  );
  const commitFontSize = (value = fontSizeDraft) => {
    const next = clampFontSize(value);
    setFontSizeDraft(next);
    if (next !== fontSize) {
      void update("fontSize", next);
    }
  };

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return TERMINAL_THEME_PRESETS;
    return TERMINAL_THEME_PRESETS.filter((preset) => preset.name.toLowerCase().includes(keyword));
  }, [query]);

  const selectedTheme = useMemo(() => {
    const effective = getTerminalTheme(effectiveThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
    const selectedPreset =
      TERMINAL_THEME_PRESETS.find((item) =>
        item.id === (effectiveThemeName === "auto" ? autoThemeId : effectiveThemeName)
      ) ?? null;
    return {
      label:
        terminalThemeMode === "follow-app"
          ? `跟随应用主题（当前：${selectedPreset?.name ?? "Auto"}）`
          : selectedPreset?.name ?? "独立终端主题",
      theme: effective,
    };
  }, [
    autoThemeId,
    darkThemePalette,
    effectiveThemeName,
    lightThemePalette,
    resolvedTheme,
    terminalThemeMode,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <div className="text-sm font-semibold text-on-surface">基础终端</div>
        <div className="mt-3 grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-on-surface-variant">默认 Shell</label>
            <Select
              value={shellSelectValue}
              onChange={(e) => update("defaultShell", e.target.value)}
              aria-label="默认 Shell"
            >
              {isCustomShellValue && <option value={defaultShell}>当前自定义（保留）</option>}
              {SHELL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-surface-container-lowest px-3 py-2">
            <div>
              <div className="text-xs text-on-surface-variant">外部 PowerShell</div>
              <div className="mt-1 text-[11px] text-text-muted">启动项目时使用外部 PowerShell 窗口。</div>
            </div>
            <Switch
              className="shrink-0"
              checked={useExternalTerminal}
              onCheckedChange={() => update("useExternalTerminal", !useExternalTerminal)}
              aria-label={useExternalTerminal ? "关闭外部 PowerShell" : "开启外部 PowerShell"}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-on-surface-variant">终端字体大小</label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={1}
                value={fontSizeDraft}
                onChange={(e) => setFontSizeDraft(Number(e.target.value))}
                onPointerUp={() => commitFontSize()}
                onKeyUp={() => commitFontSize()}
                onBlur={() => commitFontSize()}
                className="w-full accent-accent"
                aria-label="终端字体大小滑杆"
              />
              <Input
                type="number"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                value={fontSizeDraft}
                onChange={(e) => setFontSizeDraft(Number(e.target.value))}
                onBlur={() => commitFontSize()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitFontSize();
                  }
                }}
                className="w-16 text-xs"
              />
            </div>
            <div className="mt-1 text-[11px] text-text-muted">仅影响内置终端，不改变应用界面字体。</div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-on-surface-variant">终端字体族</label>
            <Select
              value={fontFamily}
              onChange={(e) => update("fontFamily", e.target.value)}
              aria-label="终端字体族"
            >
              {isCustomFontFamily && <option value={fontFamily}>当前自定义（保留）</option>}
              {FONT_FAMILY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="mt-4">
          <div className="mb-2 text-sm font-semibold text-on-surface">终端实时预览</div>
          <div
            className="rounded-xl border border-border p-4 font-mono"
            style={{ backgroundColor: "var(--surface-container-lowest)", color: "var(--on-surface)" }}
          >
            <div style={{ fontFamily, fontSize: `${fontSize}px` }}>
              <div>$ cli-manager --doctor</div>
              <div className="opacity-80">Environment ready. Launching workspace...</div>
              <div className="mt-1 text-success">✓ Terminal initialized</div>
            </div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
        <section className="ui-surface-card rounded-2xl border border-border p-4">
          <div className="mb-4">
            <div className="mb-2 text-sm font-semibold text-on-surface">终端主题模式</div>
            <div className="ui-segmented" role="group" aria-label="终端主题模式切换">
              <button
                onClick={() => {
                  void setTerminalThemeMode("follow-app");
                }}
                className="ui-focus-ring ui-segmented-btn"
                data-active={terminalThemeMode === "follow-app" ? "true" : "false"}
                aria-pressed={terminalThemeMode === "follow-app"}
              >
                跟随应用
              </button>
              <button
                onClick={() => {
                  void setTerminalThemeMode("independent");
                }}
                className="ui-focus-ring ui-segmented-btn"
                data-active={terminalThemeMode === "independent" ? "true" : "false"}
                aria-pressed={terminalThemeMode === "independent"}
              >
                独立设置
              </button>
            </div>
            <div className="mt-2 text-xs text-on-surface-variant">
              {terminalThemeMode === "follow-app"
                ? "终端会自动跟随应用浅/深主题与配色方案。"
                : "终端主题独立于应用主题，切换应用主题时保持不变。"}
            </div>
          </div>

          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-on-surface">独立主题库</div>
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索主题..."
              className="w-52 text-xs"
              aria-label="终端主题搜索"
              disabled={terminalThemeMode !== "independent"}
            />
          </div>

          <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
            {filtered.map((preset) => {
              const active = terminalThemeMode === "independent" && terminalThemeName === preset.id;
              return (
                <button
                  key={preset.id}
                  onClick={() => {
                    void update("terminalThemeName", preset.id);
                  }}
                  className="ui-interactive ui-focus-ring ui-selection-card rounded-xl border p-2 text-left"
                  data-selected={active ? "true" : "false"}
                  disabled={terminalThemeMode !== "independent"}
                  aria-pressed={active}
                >
                  <div className="truncate text-xs font-semibold text-on-surface">{preset.name}</div>
                  <div className="mt-2 flex gap-1">
                    {SWATCH_KEYS.map((key) => (
                      <span
                        key={key}
                        className="h-3.5 w-3.5 rounded-[4px] border"
                        style={{
                          backgroundColor:
                            (preset.theme as Record<string, string | undefined>)[key] ??
                            "var(--surface-container-lowest)",
                          borderColor: "var(--border)",
                        }}
                      />
                    ))}
                  </div>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="col-span-full rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-on-surface-variant">
                未找到匹配主题
              </div>
            )}
          </div>
          {terminalThemeMode !== "independent" && (
            <div className="mt-3 rounded-xl border border-border bg-surface-container-low px-3 py-2 text-xs text-on-surface-variant">
              当前为“跟随应用”模式，切换到“独立设置”后可选择固定终端主题。
            </div>
          )}
        </section>

        <aside className="ui-surface-card rounded-2xl border border-border p-4">
          <div className="text-sm font-semibold text-on-surface">主题详情</div>
          <div className="mt-2 text-xs text-on-surface-variant">{selectedTheme.label}</div>
          <div
            className="mt-3 rounded-xl border p-3 font-mono text-xs"
            style={{
              borderColor: "var(--border)",
              backgroundColor: selectedTheme.theme.background ?? "var(--surface-container-lowest)",
              color: selectedTheme.theme.foreground ?? "var(--on-surface)",
            }}
          >
            <div>$ echo \"hello cli-manager\"</div>
            <div className="mt-1 opacity-80">hello cli-manager</div>
            <div className="mt-3 flex gap-1">
              {SWATCH_KEYS.map((key) => (
                <span
                  key={key}
                  className="h-4 w-4 rounded-[4px] border border-white/15"
                  style={{
                    backgroundColor:
                      (selectedTheme.theme as Record<string, string | undefined>)[key] ??
                      "var(--surface-container-lowest)",
                  }}
                  title={key}
                />
              ))}
            </div>
          </div>
        </aside>
      </div>

      <TerminalBackgroundSection />
    </div>
  );
}
