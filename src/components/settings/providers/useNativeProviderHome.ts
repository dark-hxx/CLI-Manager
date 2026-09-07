import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getHistoryPathArgs } from "@/lib/historyPathArgs";
import {
  providerErrorCode,
  type NativeProviderAppType,
  type NativeProviderEnvironmentInspectInput,
  type NativeProviderEnvironmentKind,
  type NativeProviderEnvironmentReport,
  type NativeProviderGlobalApplyResult,
  type NativeProviderGlobalCurrent,
  type NativeProviderGlobalPreview,
  type NativeProviderHomeInput,
  type NativeProviderHomeIdentity,
  type NativeProviderHomeState,
} from "./nativeProviderTypes";

type NativeProviderRootOverrides = {
  claude: string | null;
  codex: string | null;
  grok: string | null;
};

type NativeProviderHistoryRootOverrides = NativeProviderRootOverrides;

export interface UseNativeProviderHomeResult {
  environmentKind: NativeProviderEnvironmentKind;
  environmentId: string;
  mode: "auto" | "manual";
  homePath: string;
  wslDistros: string[];
  wslDistrosLoading: boolean;
  wslDistrosErrorCode: string | null;
  home: NativeProviderHomeState | null;
  previewHome: NativeProviderHomeState | null;
  homeDraftDirty: boolean;
  current: NativeProviderGlobalCurrent | null;
  preview: NativeProviderGlobalPreview | null;
  report: NativeProviderEnvironmentReport | null;
  loading: boolean;
  action: string | null;
  errorCode: string | null;
  setEnvironmentKind: (kind: NativeProviderEnvironmentKind) => void;
  setEnvironmentId: (id: string) => void;
  refreshWslDistros: (preferredEnvironmentId?: string, restoreCachedHome?: boolean) => Promise<string | null>;
  setMode: (mode: "auto" | "manual") => void;
  setHomePath: (path: string) => void;
  refreshHome: (environmentIdOverride?: string) => Promise<void>;
  selectHome: () => Promise<void>;
  resetHome: () => Promise<void>;
  previewGlobal: () => Promise<NativeProviderGlobalPreview | null>;
  applyGlobal: (previewOverride?: NativeProviderGlobalPreview) => Promise<NativeProviderGlobalApplyResult | null>;
  inspectEnvironment: (
    roots?: NativeProviderRootOverrides,
    historyRoots?: NativeProviderHistoryRootOverrides,
    homeInputOverride?: NativeProviderHomeInput,
  ) => Promise<void>;
  repair: () => Promise<void>;
  clearError: () => void;
}

export function useNativeProviderHome(
  appType: NativeProviderAppType,
  providerId: string | null,
  configuredRoots: NativeProviderRootOverrides,
): UseNativeProviderHomeResult {
  const [environmentKind, setEnvironmentKindState] = useState<NativeProviderEnvironmentKind>("local");
  const [environmentId, setEnvironmentIdState] = useState("host");
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [homePath, setHomePath] = useState("");
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const [wslDistrosLoading, setWslDistrosLoading] = useState(false);
  const [wslDistrosErrorCode, setWslDistrosErrorCode] = useState<string | null>(null);
  const [home, setHome] = useState<NativeProviderHomeState | null>(null);
  const [previewHome, setPreviewHome] = useState<NativeProviderHomeState | null>(null);
  const [current, setCurrent] = useState<NativeProviderGlobalCurrent | null>(null);
  const [preview, setPreview] = useState<NativeProviderGlobalPreview | null>(null);
  const [report, setReport] = useState<NativeProviderEnvironmentReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const wslDistrosRequestRef = useRef(0);
  const environmentSelectionRequestRef = useRef(0);
  const initialHomeLoadRef = useRef(false);

  const clearHomeForEnvironment = useCallback(() => {
    setHome(null);
    setPreviewHome(null);
    setCurrent(null);
    setPreview(null);
    setReport(null);
    setMode("auto");
    setHomePath("");
  }, []);

  const loadCachedHome = useCallback(async (
    kind: NativeProviderEnvironmentKind,
    id: string | null,
  ) => {
    const requestId = ++environmentSelectionRequestRef.current;
    if (kind === "wsl" && !id?.trim()) {
      clearHomeForEnvironment();
      return;
    }
    try {
      const cached = await invoke<NativeProviderHomeState | null>("provider_home_cached_get", {
        environmentKind: kind,
        environmentId: id?.trim() || null,
      });
      if (requestId !== environmentSelectionRequestRef.current) return;
      if (!cached) {
        clearHomeForEnvironment();
        return;
      }
      setHome(cached);
      setMode(cached.mode);
      setHomePath(cached.homePath);
      setPreviewHome(null);
      setCurrent(null);
      setPreview(null);
      setReport(null);
    } catch {
      if (requestId === environmentSelectionRequestRef.current) clearHomeForEnvironment();
    }
  }, [clearHomeForEnvironment]);

  const refreshWslDistros = useCallback(async (
    preferredEnvironmentId?: string,
    restoreCachedHome = true,
  ) => {
    const requestId = ++wslDistrosRequestRef.current;
    setWslDistrosLoading(true);
    setWslDistrosErrorCode(null);
    try {
      const next = await invoke<string[]>("provider_wsl_list_distros");
      if (requestId !== wslDistrosRequestRef.current) return null;
      const distros = Array.from(new Set(
        next.map((distro) => distro.trim()).filter(Boolean),
      )).sort((left, right) => left.localeCompare(right));
      setWslDistros(distros);
      const selectedDistro = distros.find((distro) => {
        const preferred = preferredEnvironmentId?.trim();
        return preferred !== undefined
          && distro.localeCompare(preferred, undefined, { sensitivity: "accent" }) === 0;
      }) ?? distros[0] ?? null;
      const currentId = preferredEnvironmentId?.trim() ?? "";
      const currentMatch = distros.find((distro) =>
        distro.localeCompare(currentId, undefined, { sensitivity: "accent" }) === 0,
      );
      const nextId = selectedDistro && preferredEnvironmentId?.trim()
        ? selectedDistro
        : currentMatch ?? selectedDistro ?? "";
      setEnvironmentIdState(nextId);
      if (restoreCachedHome) void loadCachedHome("wsl", nextId || null);
      return nextId || null;
    } catch (error) {
      if (requestId !== wslDistrosRequestRef.current) return null;
      setWslDistros([]);
      setWslDistrosErrorCode(providerErrorCode(error));
      return null;
    } finally {
      if (requestId === wslDistrosRequestRef.current) setWslDistrosLoading(false);
    }
  }, [loadCachedHome]);

  const setEnvironmentKind = useCallback((kind: NativeProviderEnvironmentKind) => {
    setEnvironmentKindState(kind);
    if (kind === "local") {
      ++wslDistrosRequestRef.current;
      setWslDistros([]);
      setWslDistrosErrorCode(null);
      setEnvironmentIdState("host");
      void loadCachedHome("local", "host");
      return;
    }
    setEnvironmentIdState("");
    void loadCachedHome("wsl", null);
    void refreshWslDistros();
  }, [loadCachedHome, refreshWslDistros]);

  const setEnvironmentId = useCallback((id: string) => {
    setEnvironmentIdState(id);
    if (environmentKind === "wsl") void loadCachedHome("wsl", id);
  }, [environmentKind, loadCachedHome]);

  const identity = useCallback(() => ({
    environmentKind,
    environmentId: environmentId.trim() || null,
  }), [environmentId, environmentKind]);

  const homeInput = useCallback((): NativeProviderHomeInput => ({
    environmentKind,
    environmentId: environmentId.trim() || null,
    mode,
    homePath: mode === "manual" ? homePath.trim() : null,
  }), [environmentId, environmentKind, homePath, mode]);

  const run = useCallback(async <T,>(name: string, work: () => Promise<T>): Promise<T> => {
    setAction(name);
    setErrorCode(null);
    try {
      return await work();
    } catch (error) {
      setErrorCode(providerErrorCode(error));
      throw error;
    } finally {
      setAction(null);
    }
  }, []);

  const refreshCurrentForIdentity = useCallback(async (
    homeIdentity: Pick<NativeProviderHomeIdentity, "environmentKind" | "environmentId">,
  ) => {
    try {
      const next = await invoke<NativeProviderGlobalCurrent>("provider_global_current", {
        input: { appType, homeIdentity },
      });
      setCurrent(next);
    } catch {
      setCurrent(null);
    }
  }, [appType]);

  const refreshHome = useCallback(async (environmentIdOverride?: string) => {
    setLoading(true);
    setErrorCode(null);
    try {
      const next = await invoke<NativeProviderHomeState>("provider_home_get", {
        environmentKind,
        environmentId: environmentIdOverride?.trim() || environmentId.trim() || null,
      });
      setHome(next);
      setEnvironmentKindState(next.identity.environmentKind);
      setEnvironmentIdState(next.identity.environmentId);
      setMode(next.mode);
      setHomePath(next.homePath);
      setPreviewHome(null);
      await refreshCurrentForIdentity(next.identity);
      setPreview(null);
      setReport(null);
    } catch (error) {
      setHome(null);
      setCurrent(null);
      setPreviewHome(null);
      setPreview(null);
      setReport(null);
      setErrorCode(providerErrorCode(error));
    } finally {
      setLoading(false);
    }
  }, [environmentId, environmentKind, refreshCurrentForIdentity]);

  const loadActiveHome = useCallback(async () => {
    setLoading(true);
    setErrorCode(null);
    try {
      const next = await invoke<NativeProviderHomeState>("provider_home_active_get");
      setHome(next);
      setEnvironmentKindState(next.identity.environmentKind);
      setEnvironmentId(next.identity.environmentId);
      setMode(next.mode);
      setHomePath(next.homePath);
      setPreviewHome(null);
      if (next.identity.environmentKind === "wsl") {
        void refreshWslDistros(next.identity.environmentId);
      } else {
        ++wslDistrosRequestRef.current;
        setWslDistros([]);
        setWslDistrosErrorCode(null);
      }
      setPreview(null);
      setReport(null);
    } catch (error) {
      setHome(null);
      setCurrent(null);
      setPreviewHome(null);
      setPreview(null);
      setReport(null);
      setErrorCode(providerErrorCode(error));
    } finally {
      setLoading(false);
    }
  }, [refreshWslDistros]);

  const previewDraftHome = useCallback(async (): Promise<NativeProviderHomeState | null> => {
    try {
      return await invoke<NativeProviderHomeState>("provider_home_preview", {
        input: homeInput(),
      });
    } catch {
      return null;
    }
  }, [homeInput]);

  const homeDraftDirty = !home || (
    home.identity.identity !== `${environmentKind}:${environmentId.trim() || "host"}`
      || home.mode !== mode
      || (mode === "manual" && home.homePath !== homePath.trim())
  );

  useEffect(() => {
    if (!home || !homeDraftDirty || environmentKind !== "local" || mode !== "manual") {
      setPreviewHome(null);
      return;
    }
    setPreviewHome(null);
    setPreview(null);
    let cancelled = false;
    const timer = setTimeout(() => {
      void previewDraftHome().then((next) => {
        if (!cancelled) setPreviewHome(next);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [environmentKind, home, homeDraftDirty, mode, previewDraftHome]);

  useEffect(() => {
    setPreview(null);
    setCurrent(null);
    setReport(null);
  }, [appType, providerId]);

  useEffect(() => {
    if (initialHomeLoadRef.current) return;
    initialHomeLoadRef.current = true;
    void loadActiveHome();
  }, [loadActiveHome]);

  const selectHome = useCallback(async () => {
    const input = homeInput();
    await run("select-home", async () => {
      const next = await invoke<NativeProviderHomeState>("provider_home_select", { input });
      setHome(next);
      setEnvironmentKindState(next.identity.environmentKind);
      setEnvironmentIdState(next.identity.environmentId);
      setHomePath(next.homePath);
      setPreviewHome(null);
      setCurrent(null);
      setPreview(null);
      setReport(null);
    });
  }, [homeInput, run]);

  const resetHome = useCallback(async () => {
    await run("reset-home", async () => {
      const next = await invoke<NativeProviderHomeState>("provider_home_reset", {
        environmentKind,
        environmentId: environmentId.trim() || null,
      });
      setHome(next);
      setEnvironmentKindState(next.identity.environmentKind);
      setEnvironmentIdState(next.identity.environmentId);
      setMode(next.mode);
      setHomePath(next.homePath);
      setPreviewHome(null);
      setCurrent(null);
      setPreview(null);
      setReport(null);
    });
  }, [environmentId, environmentKind, run]);

  const previewGlobal = useCallback(async () => {
    if (!providerId) return null;
    return run("preview-global", async () => {
      const next = await invoke<NativeProviderGlobalPreview>("provider_global_preview", {
        input: { appType, providerId, homeIdentity: identity() },
      });
      setPreview(next);
      return next;
    });
  }, [appType, identity, providerId, run]);

  const applyGlobal = useCallback(async (previewOverride?: NativeProviderGlobalPreview) => {
    if (!providerId) return null;
    return run("apply-global", async () => {
      const applyPreview = previewOverride ?? preview ?? await invoke<NativeProviderGlobalPreview>("provider_global_preview", {
        input: { appType, providerId, homeIdentity: identity() },
      });
      const result = await invoke<NativeProviderGlobalApplyResult>("provider_global_apply", {
        input: {
          appType,
          providerId,
          homeIdentity: identity(),
          previewFingerprint: applyPreview.fingerprint,
        },
      });
      setPreview(null);
      await refreshHome();
      return result;
    });
  }, [appType, identity, preview, providerId, refreshHome, run]);

  const inspectEnvironment = useCallback(async (
    roots: NativeProviderRootOverrides = configuredRoots,
    historyRoots?: NativeProviderHistoryRootOverrides,
    homeInputOverride?: NativeProviderHomeInput,
  ) => {
    await run("inspect-environment", async () => {
      const pathArgs = historyRoots
        ? null
        : await getHistoryPathArgs();
      const input: NativeProviderEnvironmentInspectInput = {
        appType,
        homeIdentity: identity(),
        homeInput: homeInputOverride ?? homeInput(),
        configuredRoots: roots,
        historyRoots: historyRoots ?? {
          claude: pathArgs?.claudeConfigDir ?? null,
          codex: pathArgs?.codexConfigDir ?? null,
          grok: pathArgs?.grokSessionRoot ?? null,
        },
      };
      setReport(await invoke<NativeProviderEnvironmentReport>("provider_environment_inspect", { input }));
    });
  }, [appType, configuredRoots, homeInput, identity, run]);

  const repair = useCallback(async () => {
    await run("repair", async () => {
      await invoke("provider_global_repair");
      await inspectEnvironment();
    });
  }, [inspectEnvironment, run]);

  return {
    environmentKind,
    environmentId,
    mode,
    homePath,
    wslDistros,
    wslDistrosLoading,
    wslDistrosErrorCode,
    home,
    previewHome,
    homeDraftDirty,
    current,
    preview,
    report,
    loading,
    action,
    errorCode,
    setEnvironmentKind,
    setEnvironmentId,
    refreshWslDistros,
    setMode,
    setHomePath,
    refreshHome,
    selectHome,
    resetHome,
    previewGlobal,
    applyGlobal,
    inspectEnvironment,
    repair,
    clearError: () => setErrorCode(null),
  };
}
