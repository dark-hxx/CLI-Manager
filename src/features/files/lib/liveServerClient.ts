import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface LiveServerSession {
  readonly projectPath: string;
  readonly origin: string;
  readonly port: number;
}

export interface LiveServerOpenResult {
  readonly session: LiveServerSession;
  readonly url: string;
  readonly reused: boolean;
}

export interface LiveServerClient {
  readonly start: (projectPath: string, relativePath: string) => Promise<LiveServerOpenResult>;
  readonly status: (projectPath: string) => Promise<LiveServerSession | null>;
  readonly stop: (projectPath: string) => Promise<boolean>;
  readonly openUrl: (url: string) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openLiveServerUrl(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (error) {
    throw new Error(`browser_open_failed: ${errorMessage(error)}`);
  }
}

export const tauriLiveServerClient: LiveServerClient = Object.freeze({
  start: (projectPath: string, relativePath: string) => (
    invoke<LiveServerOpenResult>("live_server_start", { projectPath, relativePath })
  ),
  status: (projectPath: string) => (
    invoke<LiveServerSession | null>("live_server_status", { projectPath })
  ),
  stop: (projectPath: string) => invoke<boolean>("live_server_stop", { projectPath }),
  openUrl: openLiveServerUrl,
});
