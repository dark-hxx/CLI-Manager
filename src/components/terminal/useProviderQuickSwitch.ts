import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { providerErrorCode, type NativeProviderAppType, type NativeProviderCard, type NativeProviderFailoverState, type NativeProviderGlobalCurrent, type NativeProviderGlobalPreview, type NativeProviderGlobalApplyResult, type NativeProviderHomeState, type NativeProviderRoutingState } from "../settings/providers/nativeProviderTypes";
import { publishProviderFailoverState, subscribeProviderFailoverState } from "../settings/providers/providerFailoverSync";

export interface ProviderQuickSwitchSnapshot {
  providers: NativeProviderCard[];
  current: NativeProviderGlobalCurrent | null;
  routing: NativeProviderRoutingState | null;
  failover: NativeProviderFailoverState | null;
}

export interface UseProviderQuickSwitchResult extends ProviderQuickSwitchSnapshot {
  loading: boolean;
  failoverLoading: boolean;
  action: string | null;
  errorCode: string | null;
  hasLocalTakeover: boolean;
  refresh: () => Promise<void>;
  refreshFailover: () => Promise<void>;
  previewGlobal: (providerId: string) => Promise<NativeProviderGlobalPreview>;
  applyGlobal: (preview: NativeProviderGlobalPreview) => Promise<NativeProviderGlobalApplyResult>;
  setFailoverQueue: (providerIds: string[]) => Promise<void>;
  reorderFailoverQueue: (providerIds: string[]) => Promise<void>;
  setLocalRouting: (enabled: boolean) => Promise<void>;
  setFailoverEnabled: (enabled: boolean) => Promise<void>;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return providerErrorCode(error);
}

export function useProviderQuickSwitch(
  appType: NativeProviderAppType,
  open: boolean,
): UseProviderQuickSwitchResult {
  const [snapshot, setSnapshot] = useState<ProviderQuickSwitchSnapshot>({
    providers: [],
    current: null,
    routing: null,
    failover: null,
  });
  const [loading, setLoading] = useState(false);
  const [failoverLoading, setFailoverLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [errorCodeState, setErrorCodeState] = useState<string | null>(null);
  const [activeHome, setActiveHome] = useState<NativeProviderHomeState | null>(null);
  const requestVersionRef = useRef(0);

  const refreshFailover = useCallback(async () => {
    const version = ++requestVersionRef.current;
    setFailoverLoading(true);
    try {
      const next = await invoke<NativeProviderFailoverState>("routing_get_failover_queue", { appType });
      if (version !== requestVersionRef.current) return;
      publishProviderFailoverState(next);
      setSnapshot((current) => ({
        ...current,
        // 接收服务端完整快照：设置页与侧边栏共用 provider.sort_index，若只合并
        // circuit，设置页重排后侧边栏会永久保留旧 providers 顺序。
        failover: next,
      }));
    } catch (error) {
      if (version === requestVersionRef.current) setErrorCodeState(errorCode(error));
    } finally {
      if (version === requestVersionRef.current) setFailoverLoading(false);
    }
  }, [appType]);

  const refresh = useCallback(async () => {
    const version = ++requestVersionRef.current;
    setLoading(true);
    setErrorCodeState(null);
    try {
      const [providersResult, homeResult, routingResult, failoverResult] = await Promise.allSettled([
        invoke<NativeProviderCard[]>("provider_catalog_list", { appType }),
        invoke<NativeProviderHomeState>("provider_home_active_get"),
        invoke<NativeProviderRoutingState>("routing_get_state"),
        invoke<NativeProviderFailoverState>("routing_get_failover_queue", { appType }),
      ]);
      if (version !== requestVersionRef.current) return;
      if (providersResult.status === "rejected") throw providersResult.reason;
      const activeHome = homeResult.status === "fulfilled" ? homeResult.value : null;
      if (failoverResult.status === "fulfilled") publishProviderFailoverState(failoverResult.value);
      setSnapshot({
        providers: providersResult.value.filter((provider) => provider.appType === appType),
        current: null,
        routing: routingResult.status === "fulfilled" ? routingResult.value : null,
        failover: failoverResult.status === "fulfilled" ? failoverResult.value : null,
      });
      setActiveHome(activeHome);
      if (homeResult.status === "rejected" && failoverResult.status === "rejected") {
        setErrorCodeState(errorCode(homeResult.reason));
      }
    } catch (error) {
      if (version === requestVersionRef.current) setErrorCodeState(errorCode(error));
    } finally {
      if (version === requestVersionRef.current) setLoading(false);
    }
  }, [appType]);

  useEffect(() => {
    requestVersionRef.current += 1;
    if (!open) return;
    void refresh();
  }, [appType, open, refresh]);

  useEffect(() => subscribeProviderFailoverState((next) => {
    if (next.appType !== appType) return;
    setSnapshot((current) => ({ ...current, failover: next }));
  }), [appType]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => {
      if (!action && !failoverLoading) void refreshFailover();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [action, failoverLoading, open, refreshFailover]);

  const runMutation = useCallback(async <T,>(name: string, work: () => Promise<T>): Promise<T> => {
    setAction(name);
    setErrorCodeState(null);
    try {
      return await work();
    } catch (error) {
      setErrorCodeState(errorCode(error));
      throw error;
    } finally {
      setAction(null);
    }
  }, []);

  const previewGlobal = useCallback((providerId: string) => runMutation(
    "preview-global",
    async () => {
      if (!activeHome) throw new Error("provider_home_active_unavailable");
      return invoke<NativeProviderGlobalPreview>("provider_global_preview", {
        input: { appType, providerId, homeIdentity: activeHome.identity },
      });
    },
  ), [activeHome, appType, runMutation]);

  const applyGlobal = useCallback((preview: NativeProviderGlobalPreview) => runMutation(
    "apply-global",
    async () => {
      if (!activeHome) throw new Error("provider_home_active_unavailable");
      const result = await invoke<NativeProviderGlobalApplyResult>("provider_global_apply", {
        input: {
          appType,
          providerId: preview.providerId,
          homeIdentity: activeHome.identity,
          previewFingerprint: preview.fingerprint,
        },
      });
      await refresh();
      return result;
    },
  ), [activeHome, appType, refresh, runMutation]);

  const setFailoverQueue = useCallback((providerIds: string[]) => runMutation(
    "failover-queue",
    async () => {
      const next = await invoke<NativeProviderFailoverState>("routing_set_failover_queue", {
        input: { appType, providerIds },
      });
      publishProviderFailoverState(next);
      setSnapshot((current) => ({ ...current, failover: next }));
      await refresh();
    },
  ), [appType, refresh, runMutation]);

  // 后端 provider_catalog_reorder 会重写该 appType 全量 sort_index 并回吐新顺序的卡片列表。
  // 这里必须把新顺序同时落到 providers 与 failover.providers：refreshFailover() 只合并
  // circuit/circuits，不碰 providers，单靠它列表不会重排（需等一次完整 refresh）。
  const reorderFailoverQueue = useCallback((providerIds: string[]) => runMutation(
    "failover-reorder",
    async () => {
      const cards = await invoke<NativeProviderCard[]>("provider_catalog_reorder", { appType, providerIds });
      const ordered = cards.filter((card) => card.appType === appType);
      const rank = new Map(ordered.map((card, index) => [card.id, index]));
      const rankOf = (id: string) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
      setSnapshot((current) => ({
        ...current,
        providers: ordered,
        failover: current.failover
          ? {
              ...current.failover,
              // sortIndex 同步刷新：handleMove 依赖它算相对位置，留旧值会让箭头按错基准移动。
              providers: [...current.failover.providers]
                .sort((a, b) => rankOf(a.id) - rankOf(b.id))
                .map((provider) => ({
                  ...provider,
                  sortIndex: rank.get(provider.id) ?? provider.sortIndex,
                })),
            }
          : current.failover,
      }));
      await refreshFailover();
    },
  ), [appType, refreshFailover, runMutation]);

  // 本地路由是两层能力：daemon listener + 当前 CLI Home 接管。侧边栏开关串起整条链路，
  // 但关闭时只撤当前 CLI 的接管，daemon 保持运行，避免影响其他 CLI 的既有接管。
  const setLocalRouting = useCallback((enabled: boolean) => runMutation(
    "local-routing",
    async () => {
      if (!activeHome) throw new Error("provider_home_active_unavailable");
      if (enabled) {
        const routingState = await invoke<NativeProviderRoutingState>("routing_get_state");
        const serviceRunning = routingState.persisted.service.serviceEnabled
          && routingState.daemon.status === "running";
        if (!serviceRunning) {
          await invoke<NativeProviderRoutingState>("routing_set_service_enabled", { enabled: true });
        }
        await invoke<NativeProviderRoutingState>("routing_set_takeover", {
          input: { appType, homeIdentity: activeHome.identity, enabled: true },
        });
      } else {
        // 后端不允许「无接管却开着自动故障转移」，先降级再撤接管。
        const failoverState = await invoke<NativeProviderFailoverState>("routing_get_failover_queue", { appType })
          .catch(() => null);
        if (failoverState?.config.autoFailoverEnabled) {
          const next = await invoke<NativeProviderFailoverState>("routing_set_failover_enabled", { appType, enabled: false });
          publishProviderFailoverState(next);
        }
        await invoke<NativeProviderRoutingState>("routing_set_takeover", {
          input: { appType, homeIdentity: activeHome.identity, enabled: false },
        });
      }
      await refresh();
    },
  ), [activeHome, appType, refresh, runMutation]);

  const setFailoverEnabled = useCallback((enabled: boolean) => runMutation(
    "failover-enabled",
    async () => {
      const next = await invoke<NativeProviderFailoverState>("routing_set_failover_enabled", { appType, enabled });
      publishProviderFailoverState(next);
      setSnapshot((current) => ({ ...current, failover: next }));
      await refresh();
    },
  ), [appType, refresh, runMutation]);

  const hasLocalTakeover = Boolean(snapshot.routing?.persisted.takeovers.some(
    (takeover) => takeover.appType === appType && takeover.homeIdentity.identity === activeHome?.identity.identity,
  ));

  return {
    ...snapshot,
    loading,
    failoverLoading,
    action,
    errorCode: errorCodeState,
    hasLocalTakeover,
    refresh,
    refreshFailover,
    previewGlobal,
    applyGlobal,
    setFailoverQueue,
    reorderFailoverQueue,
    setLocalRouting,
    setFailoverEnabled,
  };
}
