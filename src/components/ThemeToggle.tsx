import { useSettingsStore, type ThemeMode } from "../stores/settingsStore";

const OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function ThemeToggle() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  return (
    <div className="flex rounded overflow-hidden border" style={{ borderColor: "var(--border)" }}>
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => setTheme(opt.value)}
          className="px-2 py-1 text-xs transition-colors"
          style={{
            backgroundColor: theme === opt.value ? "var(--accent)" : "var(--bg-tertiary)",
            color: theme === opt.value ? "#fff" : "var(--text-muted)",
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
