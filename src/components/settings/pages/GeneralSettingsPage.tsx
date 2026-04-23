import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  useSettingsStore,
  type DarkThemePalette,
  type LightThemePalette,
  type SidebarDensity,
  type ThemeMode,
} from "../../../stores/settingsStore";
import { SHELL_OPTIONS } from "../../../lib/types";
import { normalizeShellKey } from "../../../lib/shell";
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
    value: "saas-analytics-dashboard",
    label: "SaaS Dashboard",
    description: "冷静浅色，适合数据驾驶舱与 Bento 卡片层级",
    swatches: ["#f8fbff", "#1e293b", "#3b82f6"],
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
];

const FONT_FAMILY_OPTIONS: { value: string; label: string }[] = [
  { value: "Cascadia Code, Consolas, monospace", label: "Cascadia Code（推荐）" },
  { value: "\"JetBrains Mono\", \"Cascadia Code\", Consolas, monospace", label: "JetBrains Mono" },
  { value: "\"Fira Code\", \"Cascadia Code\", Consolas, monospace", label: "Fira Code" },
  { value: "Consolas, monospace", label: "Consolas" },
  { value: "\"Courier New\", monospace", label: "Courier New" },
];

const SIDEBAR_DENSITY_OPTIONS: { value: SidebarDensity; label: string; description: string }[] = [
  { value: "comfortable", label: "舒适", description: "默认间距，强调可读性" },
  { value: "compact", label: "紧凑", description: "减少行高与缩进，显示更多条目" },
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
    <button
      onClick={onClick}
      className="ui-interactive ui-focus-ring ui-selection-card relative overflow-hidden rounded-xl border p-3 text-left transition-[transform,box-shadow,border-color,background-color]"
      data-selected={active ? "true" : "false"}
      aria-pressed={active}
    >
      {active && (
        <span className="ui-primary-gradient absolute right-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold">
          当前
        </span>
      )}
      <div className="flex items-center gap-1.5">
        {swatches.map((color, index) => (
          <span
            key={`${color}-${index}`}
            className="h-4 w-4 rounded-full border"
            style={{
              backgroundColor: color,
              borderColor: active ? "color-mix(in srgb, var(--primary) 65%, var(--border))" : "var(--border)",
              boxShadow:
                active && index === swatches.length - 1
                  ? "0 0 0 2px color-mix(in srgb, var(--primary) 30%, transparent)"
                  : "none",
            }}
          />
        ))}
      </div>
      <div className={`mt-2 text-sm font-semibold ${active ? "text-on-surface" : "text-on-surface-variant"}`}>
        {label}
      </div>
      <div className={`mt-1 text-xs leading-5 ${active ? "text-on-surface-variant" : "text-text-muted"}`}>
        {description}
      </div>
    </button>
  );
}

export function GeneralSettingsPage() {
  const theme = useSettingsStore((s) => s.theme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const defaultShell = useSettingsStore((s) => s.defaultShell);
  const sidebarDensity = useSettingsStore((s) => s.sidebarDensity);
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const debugMode = useSettingsStore((s) => s.debugMode);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const update = useSettingsStore((s) => s.update);

  const isCustomFontFamily = useMemo(
    () => !FONT_FAMILY_OPTIONS.some((opt) => opt.value === fontFamily),
    [fontFamily]
  );
  const normalizedDefaultShell = normalizeShellKey(defaultShell);
  const shellSelectValue = normalizedDefaultShell ?? defaultShell;
  const isCustomShellValue = !normalizedDefaultShell;

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-4">
          <div className="text-sm font-semibold text-on-surface">外观</div>

          <div className="mt-3">
            <label className="mb-1 block text-xs text-on-surface-variant">应用主题</label>
            <div className="grid grid-cols-3 gap-2">
              {THEME_OPTIONS.map((opt) => {
                const active = theme === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setTheme(opt.value)}
                    className="ui-interactive ui-focus-ring ui-selection-card rounded-xl border px-3 py-2 text-sm"
                    data-selected={active ? "true" : "false"}
                    aria-pressed={active}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-4">
            <label className="mb-1 block text-xs text-on-surface-variant">浅色配色</label>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              {LIGHT_PALETTE_OPTIONS.map((option) => (
                <PaletteCard
                  key={option.value}
                  active={lightThemePalette === option.value}
                  label={option.label}
                  description={option.description}
                  swatches={option.swatches}
                  onClick={() => update("lightThemePalette", option.value)}
                />
              ))}
            </div>
          </div>

          <div className="mt-4">
            <label className="mb-1 block text-xs text-on-surface-variant">暗色配色</label>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              {DARK_PALETTE_OPTIONS.map((option) => (
                <PaletteCard
                  key={option.value}
                  active={darkThemePalette === option.value}
                  label={option.label}
                  description={option.description}
                  swatches={option.swatches}
                  onClick={() => update("darkThemePalette", option.value)}
                />
              ))}
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="text-sm font-semibold text-on-surface">终端与侧栏</div>
          <div className="mt-3 space-y-3">
            <div>
              <label className="mb-1 block text-xs text-on-surface-variant">终端字体大小</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={10}
                  max={24}
                  step={1}
                  value={fontSize}
                  onChange={(e) => update("fontSize", Number(e.target.value))}
                  className="w-full accent-accent"
                  aria-label="终端字体大小滑杆"
                />
                <Input
                  type="number"
                  min={10}
                  max={24}
                  value={fontSize}
                  onChange={(e) => update("fontSize", Math.min(24, Math.max(10, Number(e.target.value))))}
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

            <div>
              <label className="mb-1 block text-xs text-on-surface-variant">侧栏密度</label>
              <div className="grid grid-cols-2 gap-2">
                {SIDEBAR_DENSITY_OPTIONS.map((opt) => {
                  const active = sidebarDensity === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => update("sidebarDensity", opt.value)}
                      className="ui-interactive ui-focus-ring ui-selection-card rounded-xl border px-3 py-2 text-left"
                      data-selected={active ? "true" : "false"}
                      aria-pressed={active}
                    >
                      <div className="text-sm font-semibold">{opt.label}</div>
                      <div className="mt-0.5 text-[11px] leading-4 text-on-surface-variant">{opt.description}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-on-surface-variant">外部 PowerShell</span>
              <button
                className="switch ui-focus-ring"
                data-on={useExternalTerminal ? "true" : "false"}
                onClick={() => update("useExternalTerminal", !useExternalTerminal)}
                aria-label={useExternalTerminal ? "关闭外部 PowerShell" : "开启外部 PowerShell"}
                aria-pressed={useExternalTerminal}
              >
                <span className="switch-thumb" />
              </button>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-on-surface-variant">调试模式</span>
              <button
                className="switch ui-focus-ring"
                data-on={debugMode ? "true" : "false"}
                onClick={() => update("debugMode", !debugMode)}
                aria-label={debugMode ? "关闭调试模式" : "开启调试模式"}
                aria-pressed={debugMode}
              >
                <span className="switch-thumb" />
              </button>
            </div>
          </div>
        </Card>
      </section>

      <section>
        <Card className="p-4">
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
        </Card>
      </section>

      <AboutSection />
    </div>
  );
}
