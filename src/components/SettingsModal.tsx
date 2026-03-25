import { useState, useEffect, useCallback, useRef } from "react";
import { useSettingsStore, type ThemeMode, type LightThemePalette, type DarkThemePalette, type ShortcutAction, type KeyboardShortcutMap } from "../stores/settingsStore";
import { TERMINAL_THEME_PRESETS } from "../lib/terminalThemes";
import { useTemplateStore } from "../stores/templateStore";
import { useProjectStore } from "../stores/projectStore";
import { eventToCombo } from "../hooks/useKeyboardShortcuts";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { SHELL_OPTIONS, type CommandTemplate } from "../lib/types";
import { normalizeShellKey } from "../lib/shell";

type SettingsTab = "general" | "terminal-theme" | "shortcuts" | "templates";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "通用" },
  { id: "terminal-theme", label: "终端主题" },
  { id: "shortcuts", label: "快捷键" },
  { id: "templates", label: "命令模板" },
];

const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  newTerminal: "新建终端",
  closeTerminal: "关闭终端",
  nextTab: "下一个标签",
  prevTab: "上一个标签",
  commandPalette: "命令面板",
};

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
];

const FONT_FAMILY_OPTIONS: { value: string; label: string }[] = [
  {
    value: "Cascadia Code, Consolas, monospace",
    label: "Cascadia Code（推荐）",
  },
  {
    value: "\"JetBrains Mono\", \"Cascadia Code\", Consolas, monospace",
    label: "JetBrains Mono",
  },
  {
    value: "\"Fira Code\", \"Cascadia Code\", Consolas, monospace",
    label: "Fira Code",
  },
  {
    value: "Consolas, monospace",
    label: "Consolas",
  },
  {
    value: "\"Courier New\", monospace",
    label: "Courier New",
  },
];

// Color swatches to display for each theme preset
const SWATCH_KEYS = ["background", "foreground", "red", "green", "blue", "cyan"] as const;

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, mounted && !closing);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, 180);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  if (!mounted) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 ${closing ? "animate-fade-out" : "animate-fade-in"}`}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className={`flex h-[460px] w-[640px] overflow-hidden rounded-xl border border-border bg-bg-secondary shadow-2xl ${closing ? "animate-scale-out" : "animate-scale-in"}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Left tab nav */}
        <div
          className="w-[140px] flex flex-col py-3 border-r shrink-0"
          style={{ backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border)" }}
        >
          <span className="px-4 pb-2 text-xs font-bold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>
            设置
          </span>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="text-left px-4 py-2 text-xs transition-colors"
              style={{
                backgroundColor: activeTab === tab.id ? "var(--bg-secondary)" : "transparent",
                color: activeTab === tab.id ? "var(--text-primary)" : "var(--text-muted)",
                fontWeight: activeTab === tab.id ? 600 : 400,
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Right content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: "var(--border)" }}>
            <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              {TABS.find((t) => t.id === activeTab)?.label}
            </span>
            <button
              onClick={onClose}
              aria-label="关闭设置窗口"
              className="w-6 h-6 flex items-center justify-center rounded hover:opacity-80"
              style={{ color: "var(--text-muted)" }}
            >
              &times;
            </button>
          </div>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {activeTab === "general" && <GeneralTab />}
            {activeTab === "terminal-theme" && <TerminalThemeTab />}
            {activeTab === "shortcuts" && <ShortcutsTab />}
            {activeTab === "templates" && <TemplatesTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Tab 1: General ---

function GeneralTab() {
  const theme = useSettingsStore((s) => s.theme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const defaultShell = useSettingsStore((s) => s.defaultShell);
  const useExternalTerminal = useSettingsStore((s) => s.useExternalTerminal);
  const debugMode = useSettingsStore((s) => s.debugMode);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const update = useSettingsStore((s) => s.update);

  const inputStyle = {
    backgroundColor: "var(--bg-tertiary)",
    borderColor: "var(--border)",
    color: "var(--text-primary)",
  };
  const isCustomFontFamily = !FONT_FAMILY_OPTIONS.some((opt) => opt.value === fontFamily);
  const normalizedDefaultShell = normalizeShellKey(defaultShell);
  const shellSelectValue = normalizedDefaultShell ?? defaultShell;
  const isCustomShellValue = !normalizedDefaultShell;

  return (
    <div className="space-y-5">
      {/* App theme */}
      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--text-secondary)" }}>
          应用主题
        </label>
        <div className="flex rounded overflow-hidden border" style={{ borderColor: "var(--border)" }}>
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setTheme(opt.value)}
              className="px-3 py-1.5 text-xs transition-colors"
              style={{
                backgroundColor: theme === opt.value ? "var(--accent)" : "var(--bg-tertiary)",
                color: theme === opt.value ? "#fff" : "var(--text-muted)",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          浅色配色方案
        </label>
        <div className="grid grid-cols-3 gap-2">
          {LIGHT_PALETTE_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => update("lightThemePalette", option.value)}
              className="rounded-lg border p-2 text-left transition-colors"
              style={{
                borderColor: lightThemePalette === option.value ? "var(--accent)" : "var(--border)",
                backgroundColor: lightThemePalette === option.value ? "var(--bg-tertiary)" : "transparent",
              }}
            >
              <div className="flex items-center gap-1.5">
                {option.swatches.map((color) => (
                  <span
                    key={color}
                    className="h-3.5 w-3.5 rounded-full border"
                    style={{ backgroundColor: color, borderColor: "var(--border)" }}
                  />
                ))}
              </div>
              <div className="mt-1 text-[11px] font-semibold" style={{ color: "var(--text-primary)" }}>
                {option.label}
              </div>
              <div className="mt-0.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
                {option.description}
              </div>
            </button>
          ))}
        </div>
        <div className="mt-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
          仅在“浅色模式”或“跟随系统且当前为浅色”时生效。
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          暗色配色方案
        </label>
        <div className="grid grid-cols-3 gap-2">
          {DARK_PALETTE_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => update("darkThemePalette", option.value)}
              className="rounded-lg border p-2 text-left transition-colors"
              style={{
                borderColor: darkThemePalette === option.value ? "var(--accent)" : "var(--border)",
                backgroundColor: darkThemePalette === option.value ? "var(--bg-tertiary)" : "transparent",
              }}
            >
              <div className="flex items-center gap-1.5">
                {option.swatches.map((color) => (
                  <span
                    key={color}
                    className="h-3.5 w-3.5 rounded-full border"
                    style={{ backgroundColor: color, borderColor: "var(--border)" }}
                  />
                ))}
              </div>
              <div className="mt-1 text-[11px] font-semibold" style={{ color: "var(--text-primary)" }}>
                {option.label}
              </div>
              <div className="mt-0.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
                {option.description}
              </div>
            </button>
          ))}
        </div>
        <div className="mt-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
          仅在“深色模式”或“跟随系统且当前为深色”时生效。
        </div>
      </div>

      {/* Font size */}
      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--text-secondary)" }}>
          字体大小
        </label>
        <input
          type="number"
          min={10}
          max={24}
          value={fontSize}
          onChange={(e) => update("fontSize", Math.min(24, Math.max(10, Number(e.target.value))))}
          className="w-24 px-2 py-1.5 text-xs rounded border outline-none"
          style={inputStyle}
        />
      </div>

      {/* Font family */}
      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--text-secondary)" }}>
          字体族
        </label>
        <select
          value={fontFamily}
          onChange={(e) => update("fontFamily", e.target.value)}
          className="w-full px-2 py-1.5 text-xs rounded border outline-none"
          style={inputStyle}
          aria-label="终端字体族"
        >
          {isCustomFontFamily && <option value={fontFamily}>当前自定义（保留）</option>}
          {FONT_FAMILY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {/* Default shell */}
      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--text-secondary)" }}>
          默认 Shell
        </label>
        <select
          value={shellSelectValue}
          onChange={(e) => update("defaultShell", e.target.value)}
          className="w-full px-2 py-1.5 text-xs rounded border outline-none"
          style={inputStyle}
          aria-label="默认 Shell"
        >
          {isCustomShellValue && <option value={defaultShell}>当前自定义（保留）</option>}
          {SHELL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* External terminal */}
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: "var(--text-secondary)" }}>外部 PowerShell</span>
        <button
          className="switch"
          data-on={useExternalTerminal ? "true" : "false"}
          onClick={() => update("useExternalTerminal", !useExternalTerminal)}
          aria-label={useExternalTerminal ? "关闭外部 PowerShell" : "开启外部 PowerShell"}
          aria-pressed={useExternalTerminal}
        >
          <span className="switch-thumb" />
        </button>
      </div>

      {/* Debug mode */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--text-secondary)" }}>调试模式</span>
          <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            打开后记录更多日志（%LOCALAPPDATA%\\com.cli-manager.app\\logs\\cli-manager.log）
          </span>
        </div>
        <button
          className="switch"
          data-on={debugMode ? "true" : "false"}
          onClick={() => update("debugMode", !debugMode)}
          title="开启或关闭调试日志"
          aria-label={debugMode ? "关闭调试模式" : "开启调试模式"}
          aria-pressed={debugMode}
        >
          <span className="switch-thumb" />
        </button>
      </div>
    </div>
  );
}

// --- Tab 2: Terminal Theme ---

function TerminalThemeTab() {
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      {/* Auto option */}
      <div
        className="inline-flex items-center gap-2 px-3 py-2 mb-3 rounded-lg border-2 cursor-pointer transition-colors"
        style={{
          borderColor: terminalThemeName === "auto" ? "var(--accent)" : "var(--border)",
          backgroundColor: terminalThemeName === "auto" ? "var(--bg-tertiary)" : "transparent",
        }}
        onClick={() => update("terminalThemeName", "auto")}
      >
        <span className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
          跟随应用主题
        </span>
      </div>

      {/* Preset grid */}
      <div className="grid grid-cols-3 gap-2">
        {TERMINAL_THEME_PRESETS.map((preset) => (
          <div
            key={preset.id}
            className="flex flex-col gap-1.5 p-2.5 rounded-lg border-2 cursor-pointer transition-colors"
            style={{
              borderColor: terminalThemeName === preset.id ? "var(--accent)" : "var(--border)",
              backgroundColor: terminalThemeName === preset.id ? "var(--bg-tertiary)" : "transparent",
            }}
            onClick={() => update("terminalThemeName", preset.id)}
          >
            <span className="text-[11px] font-medium truncate" style={{ color: "var(--text-primary)" }}>
              {preset.name}
            </span>
            <div className="flex gap-1">
              {SWATCH_KEYS.map((key) => (
                <span
                  key={key}
                  className="w-4 h-4 rounded-sm border"
                  style={{
                    backgroundColor: (preset.theme as Record<string, string | undefined>)[key] ?? "#000",
                    borderColor: "var(--border)",
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Tab 3: Shortcuts ---

function ShortcutsTab() {
  const shortcuts = useSettingsStore((s) => s.keyboardShortcuts);
  const update = useSettingsStore((s) => s.update);
  const [recording, setRecording] = useState<ShortcutAction | null>(null);

  const handleRecord = useCallback((e: KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    const combo = eventToCombo(e);
    if (!combo) return; // modifier-only press
    const next: KeyboardShortcutMap = { ...shortcuts, [recording]: combo };
    update("keyboardShortcuts", next);
    setRecording(null);
  }, [recording, shortcuts, update]);

  useEffect(() => {
    if (!recording) return;
    window.addEventListener("keydown", handleRecord, true);
    return () => window.removeEventListener("keydown", handleRecord, true);
  }, [recording, handleRecord]);

  const resetDefaults = () => {
    update("keyboardShortcuts", {
      newTerminal: "Ctrl+Shift+T",
      closeTerminal: "Ctrl+W",
      nextTab: "Ctrl+Tab",
      prevTab: "Ctrl+Shift+Tab",
      commandPalette: "Ctrl+P",
    });
    setRecording(null);
  };

  return (
    <div>
      <table className="w-full text-xs">
        <thead>
          <tr style={{ color: "var(--text-muted)" }}>
            <th className="text-left pb-2 font-medium">操作</th>
            <th className="text-left pb-2 font-medium">快捷键</th>
            <th className="text-right pb-2 font-medium w-16"></th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => (
            <tr key={action} className="border-t" style={{ borderColor: "var(--border)" }}>
              <td className="py-2.5" style={{ color: "var(--text-secondary)" }}>
                {SHORTCUT_LABELS[action]}
              </td>
              <td className="py-2.5">
                {recording === action ? (
                  <span className="text-xs px-2 py-1 rounded animate-pulse" style={{ backgroundColor: "var(--accent)", color: "#fff" }}>
                    请按下快捷键...
                  </span>
                ) : (
                  <kbd
                    className="text-[11px] px-1.5 py-0.5 rounded border"
                    style={{ backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border)", color: "var(--text-primary)" }}
                  >
                    {shortcuts[action]}
                  </kbd>
                )}
              </td>
              <td className="py-2.5 text-right">
                <button
                  onClick={() => setRecording(recording === action ? null : action)}
                  className="text-[11px] px-2 py-0.5 rounded border"
                  style={{ borderColor: "var(--border)", color: "var(--accent)" }}
                >
                  {recording === action ? "取消" : "修改"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 pt-3 border-t" style={{ borderColor: "var(--border)" }}>
        <button
          onClick={resetDefaults}
          className="text-xs px-3 py-1.5 rounded border"
          style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
        >
          恢复默认
        </button>
      </div>
    </div>
  );
}

// --- Tab 4: Templates ---

function TemplatesTab() {
  const { templates, fetchTemplates, createTemplate, updateTemplate, deleteTemplate } = useTemplateStore();
  const { projects } = useProjectStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", command: "", description: "", project_id: null as string | null });

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const handleCreate = async () => {
    if (!form.name.trim() || !form.command.trim()) return;
    await createTemplate({
      project_id: form.project_id,
      name: form.name.trim(),
      command: form.command.trim(),
      description: form.description.trim(),
    });
    setForm({ name: "", command: "", description: "", project_id: null });
    setShowForm(false);
  };

  const handleSaveEdit = async (t: CommandTemplate) => {
    await updateTemplate(t.id, { name: form.name, command: form.command, description: form.description });
    setEditingId(null);
  };

  const startEdit = (t: CommandTemplate) => {
    setForm({ name: t.name, command: t.command, description: t.description, project_id: t.project_id });
    setEditingId(t.id);
    setShowForm(false);
  };

  const inputStyle = {
    backgroundColor: "var(--bg-tertiary)",
    borderColor: "var(--border)",
    color: "var(--text-primary)",
  };

  const scopeLabel = (t: CommandTemplate) => {
    if (!t.project_id) return "全局";
    const p = projects.find((p) => p.id === t.project_id);
    return p?.name ?? "项目";
  };

  return (
    <div>
      {/* Add button */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>{templates.length} 个模板</span>
        <button
          onClick={() => { setShowForm(!showForm); setEditingId(null); setForm({ name: "", command: "", description: "", project_id: null }); }}
          className="text-[11px] px-2.5 py-1 rounded"
          style={{ backgroundColor: "var(--accent)", color: "#fff" }}
        >
          + 新增
        </button>
      </div>

      {/* New form */}
      {showForm && (
        <div className="mb-3 p-3 rounded-lg border space-y-1.5" style={{ borderColor: "var(--border)", backgroundColor: "var(--bg-tertiary)" }}>
          <input type="text" placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-2 py-1 text-xs rounded border outline-none" style={inputStyle} />
          <input type="text" placeholder="命令" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })}
            className="w-full px-2 py-1 text-xs rounded border outline-none" style={inputStyle} />
          <input type="text" placeholder="描述（可选）" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full px-2 py-1 text-xs rounded border outline-none" style={inputStyle} />
          <select value={form.project_id ?? ""} onChange={(e) => setForm({ ...form, project_id: e.target.value || null })}
            className="w-full px-2 py-1 text-xs rounded border outline-none" style={inputStyle}>
            <option value="">全局模板</option>
            {projects.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
          </select>
          <div className="flex justify-end gap-1.5 pt-1">
            <button onClick={() => setShowForm(false)} className="px-2 py-0.5 text-[11px] rounded border" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>取消</button>
            <button onClick={handleCreate} className="px-2 py-0.5 text-[11px] rounded" style={{ backgroundColor: "var(--accent)", color: "#fff" }}>保存</button>
          </div>
        </div>
      )}

      {/* Template list */}
      <div className="space-y-1">
        {templates.map((t) =>
          editingId === t.id ? (
            <div key={t.id} className="p-3 rounded-lg border space-y-1.5" style={{ borderColor: "var(--accent)", backgroundColor: "var(--bg-tertiary)" }}>
              <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-2 py-1 text-xs rounded border outline-none" style={inputStyle} />
              <input type="text" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })}
                className="w-full px-2 py-1 text-xs rounded border outline-none" style={inputStyle} />
              <input type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="w-full px-2 py-1 text-xs rounded border outline-none" style={inputStyle} />
              <div className="flex justify-end gap-1.5 pt-1">
                <button onClick={() => setEditingId(null)} className="px-2 py-0.5 text-[11px] rounded border" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>取消</button>
                <button onClick={() => handleSaveEdit(t)} className="px-2 py-0.5 text-[11px] rounded" style={{ backgroundColor: "var(--accent)", color: "#fff" }}>保存</button>
              </div>
            </div>
          ) : (
            <div
              key={t.id}
              className="flex items-center gap-2 px-3 py-2 rounded-lg group transition-colors"
              style={{ color: "var(--text-secondary)" }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--bg-tertiary)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>{t.name}</span>
                  <span className="text-[9px] px-1 rounded-full border shrink-0" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
                    {scopeLabel(t)}
                  </span>
                </div>
                <div className="text-[10px] truncate" style={{ color: "var(--text-muted)" }}>{t.command}</div>
              </div>
              <div className="hidden group-hover:flex items-center gap-1 shrink-0">
                <button onClick={() => startEdit(t)} className="text-[11px] px-1.5 py-0.5 rounded border"
                  style={{ borderColor: "var(--border)", color: "var(--accent)" }}>编辑</button>
                <button onClick={() => deleteTemplate(t.id)} className="text-[11px] px-1.5 py-0.5 rounded border"
                  style={{ borderColor: "var(--border)", color: "var(--danger)" }}>删除</button>
              </div>
            </div>
          )
        )}
        {templates.length === 0 && (
          <div className="text-center py-6 text-xs" style={{ color: "var(--text-muted)" }}>暂无模板</div>
        )}
      </div>
    </div>
  );
}
