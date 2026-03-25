import type { ReactNode } from "react";

interface Props {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({ icon, title, description, action, className = "" }: Props) {
  return (
    <div className={`flex animate-fade-in flex-col items-center gap-2 px-4 py-8 text-text-muted ${className}`}>
      <span className="opacity-40">{icon}</span>
      <p className="text-sm font-medium text-text-secondary">{title}</p>
      {description && <p className="text-xs text-center leading-relaxed">{description}</p>}
      {action && (
        <button onClick={action.onClick} className="mt-2 rounded-md bg-accent px-3 py-1.5 text-xs text-white">
          {action.label}
        </button>
      )}
    </div>
  );
}
