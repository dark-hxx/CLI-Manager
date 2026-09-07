import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { providerErrorCode } from "./nativeProviderTypes";
import { publishProviderFailoverState, subscribeProviderFailoverState } from "./providerFailoverSync";
import type {
  NativeProviderAppType,
  NativeProviderFailoverConfig,
  NativeProviderFailoverState,
  NativeProviderHomeIdentity,
  NativeProviderOptimizerConfig,
  NativeProviderRectifierConfig,
  NativeProviderRoutingState,
} from "./nativeProviderTypes";

export interface UseNativeProviderRoutingResult {
  state: NativeProviderRoutingState | null;
  rectifierConfig: NativeProviderRectifierConfig | null;
  optimizerConfig: NativeProviderOptimizerConfig | null;
  failoverState: Partial<Record<NativeProviderAppType, NativeProviderFailoverState>>;
  loading: boolean;
  failoverLoading: Partial<Record<NativeProviderAppType, boolean>>;
  action: string | null;
  errorCode: string | null;
  refresh: () => Promise<void>;
  refreshFailover: (appType: NativeProviderAppType) => Promise<void>;
  setServiceEnabled: (enabled: boolean) => Promise<void>;
  setPreferredPort: (port: number) => Promise<void>;
  setQuickControls: (input: {
    showLocalQuickControl: boolean;
    showFailoverQuickControl: boolean;
    usageLoggingEnabled: boolean;
  }) => Promise<void>;
  setTakeover: (
    appType: NativeProviderAppType,
    homeIdentity: NativeProviderHomeIdentity,
    enabled: boolean,
  ) => Promise<void>;
  setFailoverEnabled: (appType: NativeProviderAppType, enabled: boolean) => Promise<void>;
  setFailoverQueue: (appType: NativeProviderAppType, providerIds: string[]) => Promise<void>;
  reorderFailoverQueue: (appType: NativeProviderAppType, providerIds: string[]) => Promise<void>;
  updateFailoverConfig: (appType: NativeProviderAppType, config: NativeProviderFailoverConfig) => Promise<void>;
  resetCircuit: (appType: NativeProviderAppType) => Promise<void>;
  setRectifierConfig: (config: NativeProviderRectifierConfig) => Promise<void>;
  setOptimizerConfig: (config: NativeProviderOptimizerConfig) => Promise<void>;
  clearError: () => void;
}

export function useNativeProviderRouting(): UseNativeProviderRoutingResult {
  const [state, setState] = useState<NativeProviderRoutingState | null>(null);
  const [rectifierConfig, setRectifierConfigState] = useState<NativeProviderRectifierConfig | null>(null);
  const [optimizerConfig, setOptimizerConfigState] = useState<NativeProviderOptimizerConfig | null>(null);
  const [failoverState, setFailoverState] = useState<Partial<Record<NativeProviderAppType, NativeProviderFailoverState>>>({});
  const [loading, setLoading] = useState(true);
  const [failoverLoading, setFailoverLoading] = useState<Partial<Record<NativeProviderAppType, boolean>>>({});
  const [action, setAction] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [stateResult, rectifierResult, optimizerResult] = await Promise.allSettled([
        invoke<NativeProviderRoutingState>("routing_get_state"),
        invoke<NativeProviderRectifierConfig>("routing_get_rectifier_config"),
        invoke<NativeProviderOptimizerConfig>("routing_get_optimizer_config"),
      ]);
      if (stateResult.status === "rejected") throw stateResult.reason;
      let nextState = stateResult.value;
      if (nextState.persisted.service.serviceEnabled && nextState.daemon.status !== "running") {
        try {
          nextState = await invoke<NativeProviderRoutingState>("routing_set_service_enabled", { enabled: true });
        } catch {
          // Keep the real stopped state visible when daemon recovery fails.
        }
      }
      setState(nextState);
      if (rectifierResult.status === "fulfilled") setRectifierConfigState(rectifierResult.value);
      if (optimizerResult.status === "fulfilled") setOptimizerConfigState(optimizerResult.value);
      setErrorCode(null);
    } catch (error) {
      setErrorCode(providerErrorCode(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshFailover = useCallback(async (appType: NativeProviderAppType) => {
    setFailoverLoading((current) => ({ ...current, [appType]: true }));
    try {
      const next = await invoke<NativeProviderFailoverState>("routing_get_failover_queue", { appType });
      publishProviderFailoverState(next);
      setFailoverState((current) => {
        const previous = current[appType];
        return {
          ...current,
          [appType]: previous
            ? {
                ...previous,
                // 排序以服务端 provider.sort_index 为真源；保留本地 config，避免
                // 参数草稿编辑期间的后台轮询覆盖输入，仅同步顺序与运行态。
                providers: next.providers,
                circuit: next.circuit,
                circuits: next.circuits,
              }
            : next,
        };
      });
    } catch {
      // Queue polling is auxiliary; a transient daemon read must not mask the takeover controls.
    } finally {
      setFailoverLoading((current) => ({ ...current, [appType]: false }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => subscribeProviderFailoverState((next) => {
    setFailoverState((current) => ({ ...current, [next.appType]: next }));
  }), []);

  const run = useCallback(async (name: string, work: () => Promise<NativeProviderRoutingState>) => {
    setAction(name);
    setErrorCode(null);
    try {
      setState(await work());
    } catch (error) {
      setErrorCode(providerErrorCode(error));
      throw error;
    } finally {
      setAction(null);
    }
  }, []);

  const setServiceEnabled = useCallback((enabled: boolean) => run(
    "service",
    () => invoke<NativeProviderRoutingState>("routing_set_service_enabled", { enabled }),
  ), [run]);

  const setPreferredPort = useCallback((port: number) => run(
    "preferred-port",
    () => invoke<NativeProviderRoutingState>("routing_set_preferred_port", { port }),
  ), [run]);

  const setQuickControls = useCallback((input: {
    showLocalQuickControl: boolean;
    showFailoverQuickControl: boolean;
    usageLoggingEnabled: boolean;
  }) => run(
    "quick-controls",
    () => invoke<NativeProviderRoutingState>("routing_set_quick_controls", { input }),
  ), [run]);

  const setTakeover = useCallback((appType: NativeProviderAppType, homeIdentity: NativeProviderHomeIdentity, enabled: boolean) => run(
    "takeover",
    () => invoke<NativeProviderRoutingState>("routing_set_takeover", {
      input: { appType, homeIdentity, enabled },
    }),
  ), [run]);

  const runFailover = useCallback(async <T,>(name: string, work: () => Promise<T>): Promise<T> => {
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

  const setFailoverEnabled = useCallback((appType: NativeProviderAppType, enabled: boolean) => runFailover(
    "failover-enabled",
    async () => {
      const next = await invoke<NativeProviderFailoverState>("routing_set_failover_enabled", { appType, enabled });
      publishProviderFailoverState(next);
      setFailoverState((current) => ({ ...current, [appType]: next }));
    },
  ), [runFailover]);

  const setFailoverQueue = useCallback((appType: NativeProviderAppType, providerIds: string[]) => runFailover(
    "failover-queue",
    async () => {
      const previous = failoverState[appType];
      if (previous) {
        const queued = new Set(providerIds);
        setFailoverState((current) => {
          const currentState = current[appType];
          if (!currentState) return current;
          return {
            ...current,
            [appType]: {
              ...currentState,
              providers: currentState.providers.map((provider) => (
                queued.has(provider.id) === provider.inFailoverQueue
                  ? provider
                  : { ...provider, inFailoverQueue: queued.has(provider.id) }
              )),
            },
          };
        });
      }
      try {
        const next = await invoke<NativeProviderFailoverState>("routing_set_failover_queue", {
          input: { appType, providerIds },
        });
        publishProviderFailoverState(next);
        setFailoverState((current) => ({ ...current, [appType]: next }));
      } catch (error) {
        if (previous) setFailoverState((current) => ({ ...current, [appType]: previous }));
        throw error;
      }
    },
  ), [failoverState, runFailover]);

  const reorderFailoverQueue = useCallback((appType: NativeProviderAppType, providerIds: string[]) => runFailover(
    "failover-reorder",
    async () => {
      await invoke("provider_catalog_reorder", { appType, providerIds });
      const next = await invoke<NativeProviderFailoverState>("routing_get_failover_queue", { appType });
      publishProviderFailoverState(next);
      setFailoverState((current) => ({ ...current, [appType]: next }));
    },
  ), [runFailover]);

  const updateFailoverConfig = useCallback((appType: NativeProviderAppType, config: NativeProviderFailoverConfig) => runFailover(
    "failover-config",
    async () => {
      const next = await invoke<NativeProviderFailoverState>("routing_update_failover_config", {
        input: { appType, config },
      });
      publishProviderFailoverState(next);
      setFailoverState((current) => ({ ...current, [appType]: next }));
    },
  ), [runFailover]);

  const resetCircuit = useCallback((appType: NativeProviderAppType) => runFailover(
    "circuit-reset",
    async () => {
      const next = await invoke<NativeProviderFailoverState>("routing_reset_circuit", { appType });
      publishProviderFailoverState(next);
      setFailoverState((current) => ({ ...current, [appType]: next }));
    },
  ), [runFailover]);

  const setRectifierConfig = useCallback((config: NativeProviderRectifierConfig) => runFailover(
    "rectifier",
    async () => {
      const next = await invoke<NativeProviderRectifierConfig>("routing_set_rectifier_config", { config });
      setRectifierConfigState(next);
    },
  ), [runFailover]);

  const setOptimizerConfig = useCallback((config: NativeProviderOptimizerConfig) => runFailover(
    "optimizer",
    async () => {
      const next = await invoke<NativeProviderOptimizerConfig>("routing_set_optimizer_config", { config });
      setOptimizerConfigState(next);
    },
  ), [runFailover]);

  return {
    state,
    rectifierConfig,
    optimizerConfig,
    failoverState,
    loading,
    failoverLoading,
    action,
    errorCode,
    refresh,
    refreshFailover,
    setServiceEnabled,
    setPreferredPort,
    setQuickControls,
    setTakeover,
    setFailoverEnabled,
    setFailoverQueue,
    reorderFailoverQueue,
    updateFailoverConfig,
    resetCircuit,
    setRectifierConfig,
    setOptimizerConfig,
    clearError: () => setErrorCode(null),
  };
}
