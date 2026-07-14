import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/lib/i18n";

interface AppConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export function useAppConfirm() {
  const { t } = useI18n();
  const [request, setRequest] = useState<AppConfirmOptions | null>(null);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const close = useCallback((confirmed: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setRequest(null);
    resolve?.(confirmed);
  }, []);

  useEffect(() => () => {
    resolverRef.current?.(false);
    resolverRef.current = null;
  }, []);

  const confirm = useCallback((options: AppConfirmOptions) => new Promise<boolean>((resolve) => {
    resolverRef.current?.(false);
    resolverRef.current = resolve;
    setRequest(options);
  }), []);

  const confirmDialog = (
    <ConfirmDialog
      open={request !== null}
      title={request?.title ?? ""}
      message={request?.message}
      confirmText={request?.confirmText ?? t("common.confirm")}
      cancelText={request?.cancelText ?? t("common.cancel")}
      danger={request?.danger}
      onConfirm={() => close(true)}
      onClose={() => close(false)}
    />
  );

  return { confirm, confirmDialog };
}
