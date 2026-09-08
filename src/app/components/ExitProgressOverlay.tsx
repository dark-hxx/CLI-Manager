import { useI18n } from "../../shared/i18n/index";

export type ExitPhase = "syncing" | "closing";

interface Props {
  phase: ExitPhase;
  /** 同步 conflict/error 的短暂提示（退出路径不再用 toast，窗口即将销毁看不到）。 */
  notice?: string | null;
}

/**
 * 退出进度全屏遮罩：确认退出后立即出现，覆盖"关闭期同步"与"终端清理"两个阶段，
 * 避免退出清理期间窗口无响应的体感。窗口随后被 destroy，无需关闭交互。
 */
export function ExitProgressOverlay({ phase, notice }: Props) {
  const { t } = useI18n();
  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-3 bg-black/60"
      role="status"
      aria-live="assertive"
      aria-busy="true"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      <p className="text-sm text-white/90">
        {phase === "syncing" ? t("app.exitProgress.syncing") : t("app.exitProgress.closing")}
      </p>
      {notice && <p className="max-w-md px-6 text-center text-xs text-amber-300">{notice}</p>}
    </div>
  );
}
