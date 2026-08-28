import type { TranslationKey } from "@/lib/i18n";

/**
 * 取模型失败原因的可读化。
 *
 * 后端返回的是 `provider_models_*` 错误码（HTTP 失败为 `provider_models_http_<状态码>`）。
 * 之前 UI 一律显示同一句「获取模型失败」，用户和排查者都看不出是地址错、密钥错、
 * 还是供应商没实现该接口——这类失败正是最需要区分的。
 */

const ERROR_MESSAGE_KEYS: Record<string, TranslationKey> = {
  provider_models_base_url_required: "providerCatalog.models.errorBaseUrlRequired",
  provider_models_active_key_required: "providerCatalog.models.errorKeyRequired",
  provider_models_invalid_key: "providerCatalog.models.errorInvalidKey",
  provider_models_request_failed: "providerCatalog.models.errorRequestFailed",
  provider_models_client_failed: "providerCatalog.models.errorRequestFailed",
  provider_models_invalid_response: "providerCatalog.models.errorInvalidResponse",
  provider_models_empty: "providerCatalog.models.errorEmpty",
};

const HTTP_STATUS_PREFIX = "provider_models_http_";

export interface ModelFetchErrorText {
  key: TranslationKey;
  params?: Record<string, string | number>;
}

/** 把错误码映射成 i18n key（含参数）；未知码回落到通用文案并附带原始码。 */
export function modelFetchErrorText(errorCode: string): ModelFetchErrorText {
  const known = ERROR_MESSAGE_KEYS[errorCode];
  if (known) return { key: known };

  if (errorCode.startsWith(HTTP_STATUS_PREFIX)) {
    const status = errorCode.slice(HTTP_STATUS_PREFIX.length);
    // 401/403 基本都是密钥问题，404 基本都是地址问题，值得单独给出可操作的提示。
    if (status === "401" || status === "403") {
      return { key: "providerCatalog.models.errorUnauthorized", params: { status } };
    }
    if (status === "404") {
      return { key: "providerCatalog.models.errorNotFound", params: { status } };
    }
    return { key: "providerCatalog.models.errorHttp", params: { status } };
  }

  return { key: "providerCatalog.models.errorUnknown", params: { code: errorCode } };
}
