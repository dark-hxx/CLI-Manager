import type { CSSProperties } from "react";

interface Props {
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ className = "", style }: Props) {
  return (
    <div
      className={`rounded-md ${className}`}
      style={{ backgroundColor: "var(--bg-tertiary)", animation: "pulse 1.5s ease-in-out infinite", ...style }}
    />
  );
}

export function SidebarSkeleton() {
  return (
    <div className="px-3 py-2 space-y-2" style={{ animation: "fade-in var(--animate-duration-normal) ease-out" }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-2 py-1.5 px-2">
          <Skeleton className="w-3.5 h-3.5 rounded-full shrink-0" />
          <Skeleton className="h-3.5 flex-1" style={{ maxWidth: `${60 + i * 8}%` }} />
        </div>
      ))}
    </div>
  );
}
