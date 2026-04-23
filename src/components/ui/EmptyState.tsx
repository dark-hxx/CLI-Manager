import type { ReactNode } from "react";

interface Props {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
  tone?: "default" | "inverse";
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
  tone = "default",
}: Props) {
  const mutedClass = tone === "inverse" ? "text-inverse-on-surface-variant" : "text-on-surface-variant";
  const titleClass = tone === "inverse" ? "text-inverse-on-surface" : "text-on-surface";
  const iconOpacity = tone === "inverse" ? "opacity-55" : "opacity-40";

  return (
    <div className={`ui-empty-state flex animate-fade-in flex-col items-center gap-2 px-4 py-8 ${mutedClass} ${className}`} data-tone={tone}>
      <span className={`ui-empty-state-icon ${iconOpacity}`}>{icon}</span>
      <p className={`ui-empty-state-title text-sm font-medium ${titleClass}`}>{title}</p>
      {description && <p className="ui-empty-state-description text-xs text-center leading-relaxed">{description}</p>}
      {action && (
        <button onClick={action.onClick} className="ui-flat-action ui-primary-action mt-2 h-8 px-3 text-xs">
          {action.label}
        </button>
      )}
    </div>
  );
}
