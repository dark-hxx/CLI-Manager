import type { ReactNode } from "react";

interface Props {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ icon, title, description, action }: Props) {
  return (
    <div className="flex flex-col items-center py-8 px-4 gap-2" style={{ color: "var(--text-muted)", animation: "fade-in var(--animate-duration-normal) ease-out" }}>
      <span style={{ opacity: 0.4 }}>{icon}</span>
      <p className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>{title}</p>
      {description && <p className="text-xs text-center leading-relaxed">{description}</p>}
      {action && (
        <button onClick={action.onClick} className="mt-2 text-xs px-3 py-1.5 rounded-md" style={{ backgroundColor: "var(--accent)", color: "#fff" }}>
          {action.label}
        </button>
      )}
    </div>
  );
}
