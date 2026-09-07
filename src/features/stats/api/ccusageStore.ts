import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { getDb } from "../../../shared/platform/db";
import type { CcusageSource } from "../../../shared/types/index";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";

const REPORT_KIND = "daily+session+blocks";
const LEGACY_REPORT_KIND = "daily";

interface CcusageRuntimeStatus {
  bunAvailable: boolean;
  bunxAvailable: boolean;
  bunVersion: string | null;
  bunxVersion: string | null;
}

interface CcusageWslToolStatus extends CcusageRuntimeStatus {
  distro: string;
}

interface CcusageToolStatus {
  host: CcusageRuntimeStatus;
  wsl: CcusageWslToolStatus | null;
}

interface CcusageReportResponse {
  source: CcusageSource;
  reportKind: string;
  payload: unknown;
  refreshedAt: number;
}

export type CcusageInstallTarget =
  | { kind: "host" }
  | { kind: "wsl"; distro: string };

type CcusageRuntimeScope =
  | { kind: "host" }
  | { kind: "wsl"; distro: string }
  | { kind: "mixed"; reason: "host-wsl" | "multi-wsl" };

export interface CcusageReport {
  source: CcusageSource;
  reportKind: string;
  payload: unknown;
  updatedAt: number;
  fromCache: boolean;
}

interface CcusageCacheRow {
  source: CcusageSource;
  report_kind: string;
  payload_json: string;
  updated_at: number;
}

interface CcusageStore {
  source: CcusageSource;
  toolStatus: CcusageToolStatus | null;
  report: CcusageReport | null;
  checkingStatus: boolean;
  installingTools: boolean;
  loadingCache: boolean;
  refreshing: boolean;
  error: string | null;
  setSource: (source: CcusageSource) => void;
  checkStatus: () => Promise<void>;
  installTools: (target?: CcusageInstallTarget) => Promise<void>;
  loadCachedReport: () => Promise<void>;
  refreshReport: () => Promise<void>;
}

const memoryCache = new Map<string, CcusageReport>();
let inFlightToolStatus: Promise<CcusageToolStatus> | null = null;
const inFlightReportRefreshes = new Map<string, Promise<CcusageReport>>();

function parseWslDistro(path: string | null | undefined): string | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\//g, "\\");
  const lower = normalized.toLowerCase();
  const prefix = lower.startsWith("\\\\wsl.localhost\\")
    ? "\\\\wsl.localhost\\"
    : lower.startsWith("\\\\wsl$\\")
      ? "\\\\wsl$\\"
      : null;
  if (!prefix) return null;
  const tail = normalized.slice(prefix.length);
  const [distro] = tail.split("\\");
  return distro?.trim() || null;
}

export function resolveCcusageWslTarget(
  claudeConfigDir: string | null | undefined,
  codexConfigDir: string | null | undefined,
  fallbackDistro?: string | null
): { distro: string | null; conflicts: string[] } {
  const distros = Array.from(new Set([parseWslDistro(claudeConfigDir), parseWslDistro(codexConfigDir)].filter((value): value is string => Boolean(value))));
  if (distros.length === 1) return { distro: distros[0], conflicts: [] };
  if (distros.length > 1) return { distro: null, conflicts: distros };
  const fallback = typeof fallbackDistro === "string" ? fallbackDistro.trim() : "";
  return { distro: fallback || null, conflicts: [] };
}

export function resolveCcusageRuntimeScope(
  source: CcusageSource,
  claudeConfigDir: string | null | undefined,
  codexConfigDir: string | null | undefined,
  useWsl = true,
  fallbackDistro?: string | null
): CcusageRuntimeScope {
  if (!useWsl) return { kind: "host" };
  const claudeDistro = parseWslDistro(claudeConfigDir);
  const codexDistro = parseWslDistro(codexConfigDir);
  const fallback = typeof fallbackDistro === "string" && fallbackDistro.trim() ? fallbackDistro.trim() : null;
  const hasClaudeConfig = typeof claudeConfigDir === "string" && claudeConfigDir.trim().length > 0;
  const hasCodexConfig = typeof codexConfigDir === "string" && codexConfigDir.trim().length > 0;

  if (source === "claude") return claudeDistro ? { kind: "wsl", distro: claudeDistro } : !hasClaudeConfig && fallback ? { kind: "wsl", distro: fallback } : { kind: "host" };
  if (source === "codex") return codexDistro ? { kind: "wsl", distro: codexDistro } : !hasCodexConfig && fallback ? { kind: "wsl", distro: fallback } : { kind: "host" };

  const distros = Array.from(new Set([claudeDistro, codexDistro].filter((value): value is string => Boolean(value))));
  const hasHostConfig = Boolean(
    (typeof claudeConfigDir === "string" && claudeConfigDir.trim() && !claudeDistro) ||
      (typeof codexConfigDir === "string" && codexConfigDir.trim() && !codexDistro)
  );
  if (distros.length > 1) return { kind: "mixed", reason: "multi-wsl" };
  if (distros.length === 1 && hasHostConfig) return { kind: "mixed", reason: "host-wsl" };
  if (distros.length === 1) return { kind: "wsl", distro: distros[0] };
  if (!hasClaudeConfig && !hasCodexConfig && fallback) return { kind: "wsl", distro: fallback };
  return { kind: "host" };
}

function runtimeScopeKey(scope: CcusageRuntimeScope): string {
  if (scope.kind === "host") return "host";
  if (scope.kind === "wsl") return `wsl:${scope.distro}`;
  return `mixed:${scope.reason}`;
}

function cacheKey(source: CcusageSource, runtimeKey: string, reportKind = REPORT_KIND): string {
  return `${source}:${runtimeKey}:${reportKind}`;
}

async function ensureCacheTable(): Promise<void> {
  const db = await getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ccusage_cache (
      cache_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      report_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_ccusage_cache_source ON ccusage_cache(source, report_kind)");
}

function normalizeRuntimeStatus(value: CcusageRuntimeStatus | null | undefined): CcusageRuntimeStatus {
  return {
    bunAvailable: Boolean(value?.bunAvailable),
    bunxAvailable: Boolean(value?.bunxAvailable),
    bunVersion: typeof value?.bunVersion === "string" ? value.bunVersion : null,
    bunxVersion: typeof value?.bunxVersion === "string" ? value.bunxVersion : null,
  };
}

function normalizeToolStatus(value: CcusageToolStatus): CcusageToolStatus {
  const host = normalizeRuntimeStatus(value.host);
  const rawWsl = value.wsl;
  return {
    host,
    wsl:
      rawWsl && typeof rawWsl.distro === "string" && rawWsl.distro.trim()
        ? {
            distro: rawWsl.distro,
            ...normalizeRuntimeStatus(rawWsl),
          }
        : null,
  };
}

async function readCachedReport(source: CcusageSource, runtimeKey: string): Promise<CcusageReport | null> {
  const keys = [cacheKey(source, runtimeKey), cacheKey(source, runtimeKey, LEGACY_REPORT_KIND)];
  for (const key of keys) {
    const memory = memoryCache.get(key);
    if (memory) return memory;
  }

  await ensureCacheTable();
  const db = await getDb();
  const rows = await db.select<CcusageCacheRow[]>(
    "SELECT source, report_kind, payload_json, updated_at FROM ccusage_cache WHERE cache_key IN ($1, $2) ORDER BY CASE cache_key WHEN $1 THEN 0 ELSE 1 END LIMIT 1",
    keys
  );
  const row = rows[0];
  if (!row) return null;

  try {
    const report: CcusageReport = {
      source: row.source,
      reportKind: row.report_kind,
      payload: JSON.parse(row.payload_json),
      updatedAt: row.updated_at,
      fromCache: true,
    };
    memoryCache.set(cacheKey(row.source, runtimeKey, row.report_kind), report);
    return report;
  } catch (err) {
    throw new Error(`ccusage 缓存 JSON 解析失败：${String(err)}`);
  }
}

async function writeCachedReport(report: CcusageReport, runtimeKey: string): Promise<void> {
  await ensureCacheTable();
  const db = await getDb();
  const key = cacheKey(report.source, runtimeKey);
  await db.execute(
    `INSERT INTO ccusage_cache (cache_key, source, report_kind, payload_json, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(cache_key) DO UPDATE SET
       source = excluded.source,
       report_kind = excluded.report_kind,
       payload_json = excluded.payload_json,
      updated_at = excluded.updated_at`,
    [key, report.source, report.reportKind, JSON.stringify(report.payload), report.updatedAt]
  );
  memoryCache.set(key, { ...report, fromCache: true });
}

function checkToolStatus(claudeConfigDir: string | null, codexConfigDir: string | null): Promise<CcusageToolStatus> {
  if (inFlightToolStatus) return inFlightToolStatus;
  inFlightToolStatus = invoke<CcusageToolStatus>("ccusage_get_status", {
    claudeConfigDir,
    codexConfigDir,
  })
    .then(normalizeToolStatus)
    .finally(() => {
      inFlightToolStatus = null;
    });
  return inFlightToolStatus;
}

function refreshReportFromBackend(
  source: CcusageSource,
  claudeConfigDir: string | null,
  codexConfigDir: string | null,
  useWsl: boolean,
  fallbackDistro: string | null
): Promise<CcusageReport> {
  const runtimeKey = runtimeScopeKey(resolveCcusageRuntimeScope(source, claudeConfigDir, codexConfigDir, useWsl, fallbackDistro));
  const key = JSON.stringify([source, runtimeKey, claudeConfigDir ?? "", codexConfigDir ?? ""]);
  const existing = inFlightReportRefreshes.get(key);
  if (existing) return existing;

  const request = (async () => {
    const response = await invoke<CcusageReportResponse>("ccusage_refresh_report", {
      source,
      claudeConfigDir,
      codexConfigDir,
      useWsl,
    });
    const report: CcusageReport = {
      source: response.source,
      reportKind: response.reportKind,
      payload: response.payload,
      updatedAt: response.refreshedAt,
      fromCache: false,
    };
    await writeCachedReport(report, runtimeKey);
    return report;
  })().finally(() => {
    if (inFlightReportRefreshes.get(key) === request) {
      inFlightReportRefreshes.delete(key);
    }
  });

  inFlightReportRefreshes.set(key, request);
  return request;
}

export const useCcusageStore = create<CcusageStore>((set, get) => ({
  source: "all",
  toolStatus: null,
  report: null,
  checkingStatus: false,
  installingTools: false,
  loadingCache: false,
  refreshing: false,
  error: null,

  setSource: (source) => {
    set({ source, error: null });
  },

  checkStatus: async () => {
    const settings = useSettingsStore.getState();
    set({ checkingStatus: true, error: null });
    try {
      const status = await checkToolStatus(settings.claudeHookConfigDir, settings.codexHookConfigDir);
      set({ toolStatus: status, checkingStatus: false });
    } catch (err) {
      set({ error: String(err), checkingStatus: false });
      throw err;
    }
  },

  installTools: async (target = { kind: "host" }) => {
    set({ installingTools: true, error: null });
    try {
      const status = await invoke<CcusageToolStatus>("ccusage_install_tools", {
        target: target.kind,
        distro: target.kind === "wsl" ? target.distro : null,
        claudeConfigDir: useSettingsStore.getState().claudeHookConfigDir,
        codexConfigDir: useSettingsStore.getState().codexHookConfigDir,
      });
      set({ toolStatus: normalizeToolStatus(status), installingTools: false });
    } catch (err) {
      set({ error: String(err), installingTools: false });
      throw err;
    }
  },

  loadCachedReport: async () => {
    const source = get().source;
    const settings = useSettingsStore.getState();
    const fallbackDistro = get().toolStatus?.wsl?.distro ?? null;
    const runtimeKey = runtimeScopeKey(
      resolveCcusageRuntimeScope(
        source,
        settings.claudeHookConfigDir,
        settings.codexHookConfigDir,
        settings.ccusageUseWsl,
        fallbackDistro
      )
    );
    set({ loadingCache: true, error: null });
    try {
      const report = await readCachedReport(source, runtimeKey);
      if (get().source === source) {
        set({ report, loadingCache: false });
      }
    } catch (err) {
      set({ error: String(err), loadingCache: false });
      throw err;
    }
  },

  refreshReport: async () => {
    const source = get().source;
    const settings = useSettingsStore.getState();
    const fallbackDistro = get().toolStatus?.wsl?.distro ?? null;
    set({ refreshing: true, error: null });
    try {
      const report = await refreshReportFromBackend(
        source,
        settings.claudeHookConfigDir,
        settings.codexHookConfigDir,
        settings.ccusageUseWsl,
        fallbackDistro
      );
      if (get().source === source) {
        set({ report, refreshing: false });
      }
    } catch (err) {
      set({ error: String(err), refreshing: false });
      throw err;
    }
  },
}));
