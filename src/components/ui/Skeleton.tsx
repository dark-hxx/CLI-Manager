import type { CSSProperties } from "react";

interface Props {
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ className = "", style }: Props) {
  return (
    <div
      className={`animate-pulse rounded-md bg-bg-tertiary ${className}`}
      style={style}
    />
  );
}

export function SidebarSkeleton() {
  return (
    <div className="animate-fade-in space-y-2 px-3 py-2">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-2 py-1.5 px-2">
          <Skeleton className="w-3.5 h-3.5 rounded-full shrink-0" />
          <Skeleton className="h-3.5 flex-1" style={{ maxWidth: `${60 + i * 8}%` }} />
        </div>
      ))}
    </div>
  );
}
