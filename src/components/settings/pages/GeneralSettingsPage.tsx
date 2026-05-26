import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  useSettingsStore,
  type CloseBehavior,
  type DarkThemePalette,
  type LightThemePalette,
  type SidebarDensity,
  type ThemeMode,
} from "../../../stores/settingsStore";
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

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const LIGHT_TEXT_COLORS: Record<LightThemePalette, string> = {
  "warm-paper": "#2e3336",
  "cream-green": "#25302a",
  "ink-red": "#1f1f1c",
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
};

function getDefaultUiTextColor(
  resolvedTheme: "dark" | "light",
  lightPalette: LightThemePalette,
  darkPalette: DarkThemePalette
) {
  return resolvedTheme === "dark" ? DARK_TEXT_COLORS[darkPalette] : LIGHT_TEXT_COLORS[lightPalette];
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
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
  const uiTextColor = useSettingsStore((s) => s.uiTextColor);
  const sidebarDensity = useSettingsStore((s) => s.sidebarDensity);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const closeBehavior = useSettingsStore((s) => s.closeBehavior);
  const debugMode = useSettingsStore((s) => s.debugMode);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const update = useSettingsStore((s) => s.update);
  const [uiTextColorDraft, setUiTextColorDraft] = useState(uiTextColor);

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
  const isCustomUiFontFamily = useMemo(
    () => !UI_FONT_FAMILY_OPTIONS.some((opt) => opt.value === uiFontFamily),
    [uiFontFamily]
  );

  return (
    <div className="space-y-4">
      <section>
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

          <div className="mt-4">
            <label className="mb-1 block text-xs text-on-surface-variant">应用字体</label>
            <Select
              value={uiFontFamily}
              onChange={(e) => update("uiFontFamily", e.target.value)}
              aria-label="应用字体"
            >
              {isCustomUiFontFamily && <option value={uiFontFamily}>当前自定义（保留）</option>}
              {UI_FONT_FAMILY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <div className="mt-1 text-[11px] text-text-muted">
              影响除终端外的应用整体界面字体；终端字体在「终端设置」中单独配置。
            </div>
          </div>

          <div className="mt-4">
            <label className="mb-1 block text-xs text-on-surface-variant">应用字体颜色</label>
            <div className="flex items-center gap-2">
              <Input
                type="color"
                value={colorPickerValue}
                onChange={(e) => {
                  setUiTextColorDraft(e.target.value);
                }}
                onBlur={() => commitUiTextColor()}
                className="h-8 w-12 shrink-0 cursor-pointer p-1"
                aria-label="应用字体颜色选择器"
              />
              <Input
                type="text"
                value={uiTextColorDraft}
                onChange={(e) => {
                  setUiTextColorDraft(e.target.value.trim());
                }}
                onBlur={() => commitUiTextColor()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitUiTextColor();
                  }
                }}
                placeholder={defaultUiTextColor}
                className="font-mono text-xs"
                aria-label="应用字体颜色十六进制值"
                aria-invalid={uiTextColorDraftInvalid}
              />
              <button
                type="button"
                className="ui-flat-action ui-focus-ring h-8 shrink-0 px-3 text-xs"
                onClick={() => {
                  setUiTextColorDraft("");
                  void update("uiTextColor", "");
                }}
                disabled={!uiTextColor && uiTextColorDraft === ""}
              >
                跟随主题
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-text-muted">
              <span
                className="h-4 w-4 rounded-full border border-border"
                style={{ backgroundColor: uiTextColor || defaultUiTextColor }}
              />
              <span>{uiTextColor ? `当前自定义 ${uiTextColor}` : `当前跟随主题 ${defaultUiTextColor}`}</span>
            </div>
            <div className={`mt-1 text-[11px] ${uiTextColorDraftInvalid ? "text-danger" : "text-text-muted"}`}>
              {uiTextColorDraftInvalid
                ? "请输入 #RRGGBB 格式，例如 #c0caf5。"
                : "仅影响除终端外的应用主文字颜色；留空时跟随当前主题。"}
            </div>
          </div>
        </Card>
      </section>

      <section>
        <Card className="p-4">
          <div className="text-sm font-semibold text-on-surface">侧栏与行为</div>
          <div className="mt-3 space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-2xl border border-primary bg-surface-container-low px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-on-surface">精简模式</div>
                <div className="mt-1 text-[11px] text-text-muted">隐藏内嵌终端，把项目列表作为启动器。</div>
              </div>
              <Switch
                className="shrink-0"
                checked={viewMode === "compact"}
                onCheckedChange={() => update("viewMode", viewMode === "compact" ? "standard" : "compact")}
                aria-label={viewMode === "compact" ? "关闭精简模式" : "开启精简模式"}
              />
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

            <div>
              <label className="mb-1 block text-xs text-on-surface-variant">关闭按钮行为</label>
              <Select
                value={closeBehavior}
                onChange={(e) => update("closeBehavior", e.target.value as CloseBehavior)}
                aria-label="关闭按钮行为"
              >
                {CLOSE_BEHAVIOR_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
              <div className="mt-1 text-[11px] text-text-muted">控制点击窗口关闭按钮时的动作。</div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <span className="text-xs text-on-surface-variant">调试模式</span>
              <Switch
                checked={debugMode}
                onCheckedChange={() => update("debugMode", !debugMode)}
                aria-label={debugMode ? "关闭调试模式" : "开启调试模式"}
              />
            </div>
          </div>
        </Card>
      </section>

      <AboutSection />
    </div>
  );
}
