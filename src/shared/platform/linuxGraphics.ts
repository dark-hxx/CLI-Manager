import { invoke } from "@tauri-apps/api/core";

export interface LinuxGraphicsDiagnostics {
  platform: string;
  sessionType: string | null;
  currentDesktop: string | null;
  wayland: boolean;
  nvidiaProprietary: boolean;
  requestedMode: string;
  effectiveMode: string;
  source: string;
  explicitSyncDisabled: boolean;
  dmabufDisabled: boolean;
  compositingDisabled: boolean;
}

let diagnosticsPromise: Promise<LinuxGraphicsDiagnostics> | null = null;

export function getLinuxGraphicsDiagnostics(): Promise<LinuxGraphicsDiagnostics> {
  if (!diagnosticsPromise) {
    diagnosticsPromise = invoke<LinuxGraphicsDiagnostics>("app_get_graphics_diagnostics").catch((error) => {
      diagnosticsPromise = null;
      throw error;
    });
  }
  return diagnosticsPromise;
}

export function isLinuxGraphicsConstrained(diagnostics: LinuxGraphicsDiagnostics): boolean {
  return diagnostics.platform === "linux" && (
    (diagnostics.wayland && diagnostics.nvidiaProprietary)
    || diagnostics.effectiveMode === "disable-dmabuf"
    || diagnostics.effectiveMode === "disable-compositing"
  );
}

export function shouldDisableTerminalWebgl(diagnostics: LinuxGraphicsDiagnostics): boolean {
  return diagnostics.effectiveMode === "disable-dmabuf"
    || diagnostics.effectiveMode === "disable-compositing";
}

export function formatLinuxGraphicsDiagnostics(diagnostics: LinuxGraphicsDiagnostics): string {
  return [
    `platform=${diagnostics.platform}`,
    `sessionType=${diagnostics.sessionType ?? "unknown"}`,
    `currentDesktop=${diagnostics.currentDesktop ?? "unknown"}`,
    `wayland=${diagnostics.wayland}`,
    `nvidiaProprietary=${diagnostics.nvidiaProprietary}`,
    `requestedMode=${diagnostics.requestedMode}`,
    `effectiveMode=${diagnostics.effectiveMode}`,
    `source=${diagnostics.source}`,
    `explicitSyncDisabled=${diagnostics.explicitSyncDisabled}`,
    `dmabufDisabled=${diagnostics.dmabufDisabled}`,
    `compositingDisabled=${diagnostics.compositingDisabled}`,
  ].join("\n");
}
