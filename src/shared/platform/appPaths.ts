import { invoke } from "@tauri-apps/api/core";

export interface CliManagerDataPaths {
  dataDir: string;
  dbPath: string;
  dbUrl: string;
  settingsStorePath: string;
  sessionsStorePath: string;
  syncStorePath: string;
  externalSessionSyncStorePath: string;
  logsDir: string;
  codexProvidersDir: string;
  claudeProvidersDir: string;
}

let pathsPromise: Promise<CliManagerDataPaths> | null = null;

export function getCliManagerDataPaths(): Promise<CliManagerDataPaths> {
  if (!pathsPromise) {
    pathsPromise = invoke<CliManagerDataPaths>("app_get_data_paths");
  }
  return pathsPromise;
}
