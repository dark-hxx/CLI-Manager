import { emit } from "@tauri-apps/api/event";
import { LockKeyhole, PauseCircle, RotateCcw } from "lucide-react";
import { REMOTE_HANDOFF_CANCEL_REQUEST_EVENT } from "../../lib/remoteHandoff";
import { useI18n } from "../../lib/i18n";
import { logWarn } from "../../lib/logger";
import type { TerminalSession } from "../../lib/types";

interface RemoteHandoffOverlayProps {
  session: TerminalSession;
}

export function RemoteHandoffOverlay({ session }: RemoteHandoffOverlayProps) {
  const { t } = useI18n();
  const handoff = session.remoteHandoff;
  if (!handoff) return null;

  const cancelling = handoff.phase === "cancelling";
  const recoveryFailed = handoff.phase === "recovery_failed";
  const phaseLabel = handoff.phase === "pending"
    ? t("remoteHandoff.overlay.pending")
    : cancelling
      ? t("remoteHandoff.overlay.cancelling")
      : recoveryFailed
        ? t("remoteHandoff.overlay.recoveryFailed")
        : t("remoteHandoff.overlay.active");
  const title = recoveryFailed
    ? t("remoteHandoff.overlay.recoveryTitle")
    : t("remoteHandoff.overlay.title");
  const description = recoveryFailed
    ? t("remoteHandoff.overlay.recoveryDescription")
    : t("remoteHandoff.overlay.description");

  return (
    <section
      className="absolute inset-0 z-20 flex min-h-0 items-start justify-center overflow-auto px-5 py-5 text-center"
      style={{
        color: "var(--terminal-theme-foreground, #ececec)",
        background: "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 82%, transparent)",
        backdropFilter: "blur(14px) saturate(115%)",
      }}
      aria-label={title}
    >
      <div className="my-auto flex w-full max-w-[520px] flex-col items-center">
        <div
          className="mb-4 flex h-16 w-16 items-center justify-center rounded-full"
          style={{
            color: "#facc15",
            border: "1px solid color-mix(in srgb, #facc15 42%, transparent)",
            background: "color-mix(in srgb, #facc15 10%, var(--terminal-theme-background, #0c0e10))",
            boxShadow: "0 0 36px color-mix(in srgb, #facc15 16%, transparent)",
          }}
        >
          <LockKeyhole size={30} strokeWidth={1.8} aria-hidden="true" />
        </div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-normal text-amber-300">
          {phaseLabel}
        </p>
        <h2 className="m-0 text-xl font-semibold tracking-normal">
          {title}
        </h2>
        <p
          className="mb-5 mt-2 max-w-[460px] text-sm leading-6"
          style={{ color: "var(--terminal-theme-muted, #9ca0a6)" }}
        >
          {description}
        </p>

        <dl className="mb-6 grid w-full grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2 text-left text-xs">
          <dt style={{ color: "var(--terminal-theme-muted, #9ca0a6)" }}>
            {t("remoteHandoff.overlay.sessionId")}
          </dt>
          <dd className="m-0 truncate font-mono" title={handoff.cliSessionId}>
            {handoff.cliSessionId}
          </dd>
          <dt style={{ color: "var(--terminal-theme-muted, #9ca0a6)" }}>
            {t("remoteHandoff.overlay.project")}
          </dt>
          <dd className="m-0 truncate" title={handoff.projectName}>
            {handoff.projectName}
          </dd>
          <dt style={{ color: "var(--terminal-theme-muted, #9ca0a6)" }}>
            {t("remoteHandoff.overlay.workDir")}
          </dt>
          <dd className="m-0 truncate font-mono" title={handoff.workDir}>
            {handoff.workDir}
          </dd>
          <dt style={{ color: "var(--terminal-theme-muted, #9ca0a6)" }}>
            {t("remoteHandoff.overlay.provider")}
          </dt>
          <dd className="m-0 truncate" title={handoff.providerName}>
            {handoff.providerName || t("remoteHandoff.overlay.pendingValue")}
          </dd>
        </dl>

        <button
          type="button"
          className={
            recoveryFailed
              ? "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-cyan-300/35 bg-cyan-400/12 px-4 text-sm font-medium text-cyan-50 transition-colors hover:bg-cyan-400/20"
              : "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-rose-400/35 bg-rose-500/12 px-4 text-sm font-medium text-rose-100 transition-colors hover:bg-rose-500/20 disabled:cursor-wait disabled:opacity-60"
          }
          disabled={cancelling}
          onClick={() => {
            void emit(REMOTE_HANDOFF_CANCEL_REQUEST_EVENT).catch((error) => {
              logWarn("Failed to request remote handoff cancellation from terminal overlay", error);
            });
          }}
        >
          {recoveryFailed
            ? <RotateCcw size={16} aria-hidden="true" />
            : <PauseCircle size={16} aria-hidden="true" />}
          {cancelling
            ? t("remoteHandoff.overlay.cancellingAction")
            : recoveryFailed
              ? t("remoteHandoff.overlay.retryAction")
              : t("remoteHandoff.overlay.cancelAction")}
        </button>
      </div>
    </section>
  );
}
