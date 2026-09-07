import { useSettingsStore, type ThemeMode } from "../../../shared/preferences/settingsStore";

const OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function ThemeToggle() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  return (
    <div className="ui-segmented" role="group" aria-label="应用主题切换">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => setTheme(opt.value)}
          className="ui-focus-ring ui-segmented-btn"
          data-active={theme === opt.value ? "true" : "false"}
          aria-label={`切换到 ${opt.label} 主题`}
          aria-pressed={theme === opt.value}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
