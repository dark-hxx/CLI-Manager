import { useMemo, useState } from "react";
import {
  TERMINAL_THEME_PRESETS,
  getTerminalTheme,
  resolveAutoTerminalThemeId,
} from "../../../lib/terminalThemes";
import { useSettingsStore } from "../../../stores/settingsStore";

const SWATCH_KEYS = ["background", "foreground", "red", "green", "blue", "cyan"] as const;

export function ThemeSettingsPage() {
  const terminalThemeMode = useSettingsStore((s) => s.terminalThemeMode);
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const setTerminalThemeMode = useSettingsStore((s) => s.setTerminalThemeMode);
  const update = useSettingsStore((s) => s.update);
  const [query, setQuery] = useState("");
  const autoThemeId = useMemo(
    () => resolveAutoTerminalThemeId(resolvedTheme, lightThemePalette, darkThemePalette),
    [darkThemePalette, lightThemePalette, resolvedTheme]
  );
  const effectiveThemeName = terminalThemeMode === "follow-app" ? "auto" : terminalThemeName;

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
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索主题..."
            className="ui-focus-ring w-52 rounded-lg border border-border bg-surface-container-high px-2 py-1.5 text-xs text-on-surface outline-none"
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
                        backgroundColor: (preset.theme as Record<string, string | undefined>)[key] ?? "var(--surface-container-lowest)",
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
                  backgroundColor: (selectedTheme.theme as Record<string, string | undefined>)[key] ?? "var(--surface-container-lowest)",
                }}
                title={key}
              />
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
