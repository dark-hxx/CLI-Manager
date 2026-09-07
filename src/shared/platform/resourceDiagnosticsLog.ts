import { invoke, isTauri } from "@tauri-apps/api/core";

export type ResourceDiagnosticLevel = "info" | "warn";
export type ResourceDiagnosticSource =
  | "webview"
  | "terminalProcessManager"
  | "ptyHostSocket";
export type ResourceDiagnosticEvent =
  | "runtimeSnapshot"
  | "backlogThresholdExceeded"
  | "backlogRecovered"
  | "backlogCleared";

export function writeResourceDiagnostic(
  level: ResourceDiagnosticLevel,
  source: ResourceDiagnosticSource,
  event: ResourceDiagnosticEvent,
  payload: Record<string, unknown>,
): void {
  if (!isTauri()) return;
  void invoke("resource_diagnostics_write", {
    entry: { level, source, event, payload },
  }).catch(() => undefined);
}
