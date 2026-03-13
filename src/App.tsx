import { useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { TerminalTabs } from "./components/TerminalTabs";
import { useSettingsStore } from "./stores/settingsStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import "./App.css";

function App() {
  const loadSettings = useSettingsStore((s) => s.load);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);

  useKeyboardShortcuts();

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }, [resolvedTheme]);

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 flex flex-col" style={{ backgroundColor: "var(--bg-primary)" }}>
        <TerminalTabs />
      </main>
    </div>
  );
}

export default App;
