export const NATIVE_PROVIDER_DETAIL_VIEWS = [
  "basic",
  "effective",
  "keys",
  "documents",
] as const;

export type NativeProviderDetailView = (typeof NATIVE_PROVIDER_DETAIL_VIEWS)[number];

export const DEFAULT_NATIVE_PROVIDER_DETAIL_VIEW: NativeProviderDetailView = "basic";

export function resetNativeProviderDetailView(): NativeProviderDetailView {
  return DEFAULT_NATIVE_PROVIDER_DETAIL_VIEW;
}

export function normalizeNativeProviderDetailView(value: string | null | undefined): NativeProviderDetailView {
  if (value && NATIVE_PROVIDER_DETAIL_VIEWS.includes(value as NativeProviderDetailView)) {
    return value as NativeProviderDetailView;
  }
  return DEFAULT_NATIVE_PROVIDER_DETAIL_VIEW;
}
