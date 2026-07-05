import { useSettingsStore } from "../stores/settingsStore";

function isDebugConsoleEnabled(): boolean {
  return useSettingsStore.getState().debugMode;
}

export function debugConsoleLog(...args: unknown[]): void {
  if (!isDebugConsoleEnabled()) return;
  console.log(...args);
}

export function debugConsoleInfo(...args: unknown[]): void {
  if (!isDebugConsoleEnabled()) return;
  console.info(...args);
}

export function debugConsoleWarn(...args: unknown[]): void {
  if (!isDebugConsoleEnabled()) return;
  console.warn(...args);
}
