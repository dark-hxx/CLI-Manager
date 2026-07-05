import type { ReactNode } from "react";
import { AlertTriangle } from "./icons";

interface FailureAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "outline";
}

interface AppFailureStateProps {
  title: string;
  description: string;
  detail?: string | null;
  icon?: ReactNode;
  primaryAction?: FailureAction;
  secondaryAction?: FailureAction;
}

function ActionButton({ action }: { action: FailureAction }) {
  const variantClassName = action.variant === "outline" ? "ui-btn-outline" : "ui-btn-primary";

  return (
    <button type="button" className={`ui-btn ${variantClassName}`} onClick={action.onClick}>
      {action.label}
    </button>
  );
}

export function AppFailureState({
  title,
  description,
  detail,
  icon,
  primaryAction,
  secondaryAction,
}: AppFailureStateProps) {
  return (
    <div className="ui-workspace-shell flex h-screen items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-xl flex-col items-center gap-4 text-center">
        <div className="ui-empty-state-icon text-danger">
          {icon ?? <AlertTriangle size={28} strokeWidth={2.1} />}
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-text-primary">{title}</h1>
          <p className="mx-auto max-w-[42rem] text-sm leading-6 text-text-secondary">{description}</p>
        </div>
        {detail ? (
          <pre className="w-full overflow-auto rounded-xl border border-border/70 bg-surface-container-low px-4 py-3 text-left text-[12px] leading-5 text-text-secondary whitespace-pre-wrap break-words">
            {detail}
          </pre>
        ) : null}
        {primaryAction || secondaryAction ? (
          <div className="flex flex-wrap items-center justify-center gap-3">
            {primaryAction ? <ActionButton action={primaryAction} /> : null}
            {secondaryAction ? <ActionButton action={secondaryAction} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
