import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  providerErrorCode,
  type NativeProviderAppType,
  type NativeProviderCard,
  type NativeProviderCreateInput,
  type NativeProviderDetail,
  type NativeProviderKeyCreateInput,
  type NativeProviderKeySummary,
  type NativeProviderKeyUpdateInput,
  type NativeProviderDocumentUpdateInput,
  type NativeProviderUpdateInput,
} from "./nativeProviderTypes";

export interface UseNativeProviderCatalogResult {
  providers: NativeProviderCard[];
  detail: NativeProviderDetail | null;
  selectedProviderId: string | null;
  loading: boolean;
  detailLoading: boolean;
  action: string | null;
  errorCode: string | null;
  setSelectedProviderId: (providerId: string | null) => void;
  refresh: () => Promise<void>;
  refreshSelection: (providerId: string | null) => Promise<void>;
  createProvider: (input: NativeProviderCreateInput, initialApiKey?: string) => Promise<void>;
  updateProvider: (input: NativeProviderUpdateInput) => Promise<void>;
  updateDocument: (input: NativeProviderDocumentUpdateInput) => Promise<void>;
  duplicateProvider: (providerId: string, name?: string) => Promise<void>;
  deleteProvider: (providerId: string) => Promise<void>;
  setProviderEnabled: (providerId: string, enabled: boolean) => Promise<void>;
  reorderProviders: (providerIds: string[]) => Promise<void>;
  createKey: (input: NativeProviderKeyCreateInput) => Promise<void>;
  updateKey: (input: NativeProviderKeyUpdateInput) => Promise<void>;
  activateKey: (providerId: string, keyId: string) => Promise<void>;
  setKeyEnabled: (providerId: string, keyId: string, enabled: boolean) => Promise<void>;
  deleteKey: (providerId: string, keyId: string, replacementKeyId?: string) => Promise<void>;
  reorderKeys: (providerId: string, keyIds: string[]) => Promise<void>;
  revealKey: (providerId: string, keyId: string) => Promise<string>;
  clearError: () => void;
}

/** 随供应商一并创建的第一个密钥的名称。不做唯一性校验，允许与已有密钥重名。 */
export const DEFAULT_INITIAL_KEY_LABEL = "default";

/**
 * 供应商已创建、但紧随其后的密钥创建失败。
 *
 * 单独建一个类型是为了让调用方能区分「整个新建失败」与「供应商建成了只差密钥」：
 * 后者绝不能让用户重试新建，否则会多出一个重复供应商。
 */
export class ProviderKeyCreateAfterProviderError extends Error {
  constructor(readonly providerId: string, readonly cause: unknown) {
    super(providerErrorCode(cause));
    this.name = "ProviderKeyCreateAfterProviderError";
  }
}

/** 无历史选择时的默认供应商：优先全局启用的那个（`is_current`），否则列表第一个。 */
function defaultProviderId(providers: NativeProviderCard[]): string | null {
  return providers.find((provider) => provider.isCurrent)?.id ?? providers[0]?.id ?? null;
}

export function useNativeProviderCatalog(
  appType: NativeProviderAppType,
): UseNativeProviderCatalogResult {
  const [providers, setProviders] = useState<NativeProviderCard[]>([]);
  const [detail, setDetail] = useState<NativeProviderDetail | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  // 会话内的手动选中锚点：让 refresh()（增删改、启停后都会跑）不把用户当前看的供应商顶掉。
  // 打开设置页或切换 appType 时会被清空，从而回落到「全局启用优先」的默认选中。
  const preferredRef = useRef<{ appType: NativeProviderAppType; providerId: string | null }>({
    appType,
    providerId: null,
  });

  const fetchDetail = useCallback(async (providerId: string | null) => {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    if (!providerId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }

    setDetailLoading(true);
    try {
      const next = await invoke<NativeProviderDetail>("provider_catalog_get", {
        appType,
        providerId,
      });
      if (detailRequestRef.current === requestId) setDetail(next);
    } catch (error) {
      if (detailRequestRef.current === requestId) {
        setDetail(null);
        setErrorCode(providerErrorCode(error));
      }
    } finally {
      if (detailRequestRef.current === requestId) setDetailLoading(false);
    }
  }, [appType]);

  const refresh = useCallback(async () => {
    const requestId = listRequestRef.current + 1;
    listRequestRef.current = requestId;
    setLoading(true);
    setErrorCode(null);
    try {
      const next = await invoke<NativeProviderCard[]>("provider_catalog_list", { appType });
      if (listRequestRef.current === requestId) {
        const preferred = preferredRef.current;
        const preferredId = preferred.appType === appType
          && preferred.providerId
          && next.some((provider) => provider.id === preferred.providerId)
          ? preferred.providerId
          : null;
        setProviders(next);
        setSelectedProviderId((current) => {
          if (preferredId) return preferredId;
          if (current && next.some((provider) => provider.id === current)) return current;
          return defaultProviderId(next);
        });
      }
    } catch (error) {
      if (listRequestRef.current === requestId) {
        setProviders([]);
        setSelectedProviderId(null);
        setDetail(null);
        setErrorCode(providerErrorCode(error));
      }
    } finally {
      if (listRequestRef.current === requestId) setLoading(false);
    }
  }, [appType]);

  useEffect(() => {
    setProviders([]);
    setDetail(null);
    setSelectedProviderId(null);
    // 进入设置页或切换 appType：丢弃手动选中锚点，让 refresh 回落到「全局启用优先」的默认选中。
    preferredRef.current = { appType, providerId: null };
    void refresh();
  }, [appType, refresh]);

  useEffect(() => {
    void fetchDetail(selectedProviderId);
  }, [fetchDetail, selectedProviderId]);

  const selectProvider = useCallback((providerId: string | null) => {
    preferredRef.current = { appType, providerId };
    setSelectedProviderId(providerId);
  }, [appType]);

  const runAction = useCallback(async <T,>(name: string, work: () => Promise<T>): Promise<T> => {
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

  const refreshSelection = useCallback(async (providerId: string | null) => {
    if (providerId) selectProvider(providerId);
    await refresh();
    await fetchDetail(providerId);
  }, [fetchDetail, refresh, selectProvider]);

  const createProvider = useCallback(async (input: NativeProviderCreateInput, initialApiKey?: string) => {
    await runAction("create-provider", async () => {
      const created = await invoke<NativeProviderDetail>("provider_catalog_create", { input });
      const apiKey = initialApiKey?.trim();
      if (!apiKey) {
        // 密钥非必填：留空只建供应商，保留「先建壳、后补密钥」的用法。
        await refreshSelection(created.card.id);
        return;
      }
      try {
        await invoke<NativeProviderKeySummary>("provider_key_create", {
          input: {
            providerId: created.card.id,
            appType: input.appType,
            label: DEFAULT_INITIAL_KEY_LABEL,
            apiKey,
            activate: true,
          },
        });
      } catch (error) {
        // 供应商已经落库了，密钥没建成。必须先把它刷进列表，否则用户重试提交会再建一个重复供应商。
        await refreshSelection(created.card.id);
        throw new ProviderKeyCreateAfterProviderError(created.card.id, error);
      }
      await refreshSelection(created.card.id);
    });
  }, [refreshSelection, runAction]);

  const updateProvider = useCallback(async (input: NativeProviderUpdateInput) => {
    await runAction("update-provider", async () => {
      const updated = await invoke<NativeProviderDetail>("provider_catalog_update", { input });
      await refreshSelection(updated.card.id);
    });
  }, [refreshSelection, runAction]);

  const updateDocument = useCallback(async (input: NativeProviderDocumentUpdateInput) => {
    await runAction("update-document", async () => {
      const updated = await invoke<NativeProviderDetail>("provider_document_update", { input });
      await refreshSelection(updated.card.id);
    });
  }, [refreshSelection, runAction]);

  const duplicateProvider = useCallback(async (providerId: string, name?: string) => {
    await runAction("duplicate-provider", async () => {
      const duplicated = await invoke<NativeProviderDetail>("provider_catalog_duplicate", {
        appType,
        providerId,
        name,
      });
      await refreshSelection(duplicated.card.id);
    });
  }, [appType, refreshSelection, runAction]);

  const deleteProvider = useCallback(async (providerId: string) => {
    await runAction("delete-provider", async () => {
      await invoke<void>("provider_catalog_delete", { appType, providerId });
      await refresh();
    });
  }, [appType, refresh, runAction]);

  const setProviderEnabled = useCallback(async (providerId: string, enabled: boolean) => {
    await runAction("set-provider-enabled", async () => {
      await invoke<NativeProviderDetail>("provider_catalog_set_enabled", {
        appType,
        providerId,
        enabled,
      });
      await refreshSelection(providerId);
    });
  }, [appType, refreshSelection, runAction]);

  const reorderProviders = useCallback(async (providerIds: string[]) => {
    await runAction("reorder-providers", async () => {
      await invoke<NativeProviderCard[]>("provider_catalog_reorder", {
        appType,
        providerIds,
      });
      await refresh();
    });
  }, [appType, refresh, runAction]);

  const createKey = useCallback(async (input: NativeProviderKeyCreateInput) => {
    await runAction("create-key", async () => {
      await invoke<NativeProviderKeySummary>("provider_key_create", { input });
      await refreshSelection(input.providerId);
    });
  }, [refreshSelection, runAction]);

  const updateKey = useCallback(async (input: NativeProviderKeyUpdateInput) => {
    await runAction("update-key", async () => {
      await invoke<NativeProviderKeySummary>("provider_key_update", { input });
      await refreshSelection(input.providerId);
    });
  }, [refreshSelection, runAction]);

  const activateKey = useCallback(async (providerId: string, keyId: string) => {
    await runAction("activate-key", async () => {
      await invoke<NativeProviderKeySummary>("provider_key_activate", {
        appType,
        providerId,
        keyId,
      });
      await refreshSelection(providerId);
    });
  }, [appType, refreshSelection, runAction]);

  const setKeyEnabled = useCallback(async (providerId: string, keyId: string, enabled: boolean) => {
    await runAction("set-key-enabled", async () => {
      await invoke<NativeProviderKeySummary>("provider_key_set_enabled", {
        appType,
        providerId,
        keyId,
        enabled,
      });
      await refreshSelection(providerId);
    });
  }, [appType, refreshSelection, runAction]);

  const deleteKey = useCallback(async (providerId: string, keyId: string, replacementKeyId?: string) => {
    await runAction("delete-key", async () => {
      await invoke<void>("provider_key_delete", {
        appType,
        providerId,
        keyId,
        replacementKeyId: replacementKeyId ?? null,
      });
      await refreshSelection(providerId);
    });
  }, [appType, refreshSelection, runAction]);

  const reorderKeys = useCallback(async (providerId: string, keyIds: string[]) => {
    await runAction("reorder-keys", async () => {
      await invoke<NativeProviderKeySummary[]>("provider_key_reorder", {
        appType,
        providerId,
        keyIds,
      });
      await refreshSelection(providerId);
    });
  }, [appType, refreshSelection, runAction]);

  const revealKey = useCallback(async (providerId: string, keyId: string) => (
    runAction("reveal-key", () => invoke<string>("provider_key_reveal", {
      appType,
      providerId,
      keyId,
    }))
  ), [appType, runAction]);

  return {
    providers,
    detail,
    selectedProviderId,
    loading,
    detailLoading,
    action,
    errorCode,
    setSelectedProviderId: selectProvider,
    refresh,
    refreshSelection,
    createProvider,
    updateProvider,
    updateDocument,
    duplicateProvider,
    deleteProvider,
    setProviderEnabled,
    reorderProviders,
    createKey,
    updateKey,
    activateKey,
    setKeyEnabled,
    deleteKey,
    reorderKeys,
    revealKey,
    clearError: () => setErrorCode(null),
  };
}
