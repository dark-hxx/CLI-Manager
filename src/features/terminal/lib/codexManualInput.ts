export type ManualCodexInputPlatform = "windows" | "macos" | "linux" | "unknown";

// No manual direct-codex enter override: the typed command should be submitted unchanged.
export function resolveManualDirectCodexEnterData(_params: {
  data: string;
  inputBuffer: string;
  os: ManualCodexInputPlatform;
}): string | null {
  return null;
}
