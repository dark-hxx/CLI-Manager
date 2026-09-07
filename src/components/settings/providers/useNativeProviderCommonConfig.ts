import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { providerErrorCode, type NativeProviderAppType, type NativeProviderCommonConfig } from "./nativeProviderTypes";

function commonConfigFormat(appType: NativeProviderAppType): "json" | "toml" {
  return appType === "claude" ? "json" : "toml";
}

export interface UseNativeProviderCommonConfigResult {
  document: NativeProviderCommonConfig | null;
  draft: string;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  validating: boolean;
  errorCode: string | null;
  setDraft: (value: string) => void;
  refresh: () => Promise<void>;
  validate: () => Promise<void>;
  save: () => Promise<void>;
  clearError: () => void;
}

export function useNativeProviderCommonConfig(appType: NativeProviderAppType): UseNativeProviderCommonConfigResult {
  const [document, setDocument] = useState<NativeProviderCommonConfig | null>(null);
  const [draft, setDraftState] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setErrorCode(null);
    try {
      const next = await invoke<NativeProviderCommonConfig>("provider_common_config_get", { appType });
      if (requestRef.current !== requestId) return;
      setDocument(next);
      setDraftState(next.value);
    } catch (error) {
      if (requestRef.current !== requestId) return;
      setDocument(null);
      setDraftState("");
      setErrorCode(providerErrorCode(error));
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [appType]);

  useEffect(() => {
    setDocument(null);
    setDraftState("");
    void refresh();
  }, [appType, refresh]);

  const setDraft = useCallback((value: string) => {
    setDraftState(value);
    setErrorCode(null);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setErrorCode(null);
    try {
      const next = await invoke<NativeProviderCommonConfig>("provider_common_config_set", {
        input: {
          appType,
          value: draft,
          format: document?.format ?? commonConfigFormat(appType),
        },
      });
      setDocument(next);
      setDraftState(next.value);
    } catch (error) {
      setErrorCode(providerErrorCode(error));
      throw error;
    } finally {
      setSaving(false);
    }
  }, [appType, document?.format, draft]);

  const validate = useCallback(async () => {
    setValidating(true);
    setErrorCode(null);
    try {
      await invoke("provider_common_config_validate", {
        input: {
          appType,
          value: draft,
          format: document?.format ?? commonConfigFormat(appType),
        },
      });
    } catch (error) {
      setErrorCode(providerErrorCode(error));
      throw error;
    } finally {
      setValidating(false);
    }
  }, [appType, document?.format, draft]);

  return {
    document,
    draft,
    dirty: document ? document.value !== draft : draft.trim().length > 0,
    loading,
    saving,
    validating,
    errorCode,
    setDraft,
    refresh,
    validate,
    save,
    clearError: () => setErrorCode(null),
  };
}
