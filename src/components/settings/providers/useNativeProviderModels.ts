import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NativeProviderAppType, NativeProviderClaudeConfig } from "./nativeProviderTypes";

interface FetchModelsResponse { models: string[] }

interface FetchModelsOptions {
  appType: NativeProviderAppType;
  providerId?: string;
  baseUrl: string;
  /** 表单里尚未落库的临时密钥；有值时后端直接用它，不去读已存的激活密钥。 */
  apiKey?: string;
  claude?: Pick<NativeProviderClaudeConfig, "isFullUrl" | "apiFormat" | "apiKeyField">;
  apiFormat?: string;
}

export function useNativeProviderModels() {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 请求代际：`reset()` 与每次新请求都会推进它，在途响应回来时若代际已变就丢弃，
  // 避免旧地址的结果盖掉已经失效的列表。与 useNativeProviderCatalog 的做法一致。
  const requestRef = useRef(0);

  /**
   * 丢弃上一次拉到的模型列表。
   *
   * 取模型的结果只对「当次那个供应商 + 那个地址」有意义。承载它的表单弹框是常挂载的
   * （Mantine Modal 关闭时组件不卸载），所以换 CLI 类型、换供应商、改地址或重开弹框时
   * 必须显式清掉，否则会把上一个供应商的接口结果冒充成当前供应商的候选。
   */
  const reset = useCallback(() => {
    requestRef.current += 1;
    setModels([]);
    setError(null);
    setLoading(false);
  }, []);

  const fetchModels = useCallback(async (options: FetchModelsOptions) => {
    const apiKey = options.apiKey?.trim();
    // 两者皆无则后端无从取密钥，提前给出与后端一致的错误码。
    if (!apiKey && !options.providerId) {
      setError("provider_models_active_key_required");
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<FetchModelsResponse>("provider_fetch_models", {
        input: {
          appType: options.appType,
          providerId: options.providerId,
          baseUrl: options.baseUrl,
          apiKey: apiKey || undefined,
          isFullUrl: options.claude?.isFullUrl,
          apiFormat: options.claude?.apiFormat ?? options.apiFormat,
          apiKeyField: options.claude?.apiKeyField,
        },
      });
      if (requestRef.current !== requestId) return;
      setModels(result.models);
    } catch (reason) {
      if (requestRef.current !== requestId) return;
      setModels([]);
      setError(typeof reason === "string" ? reason : "provider_models_request_failed");
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, []);

  return { models, loading, error, fetchModels, reset };
}
