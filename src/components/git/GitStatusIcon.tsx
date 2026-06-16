import type { GitFileChange } from "../../lib/types";

interface GitStatusIconProps {
  status: GitFileChange["status"];
  size?: number;
}

const STATUS_CONFIG: Record<
  GitFileChange["status"],
  { label: string; color: string; symbol: string }
> = {
  M: { label: "Modified", color: "#ff9e64", symbol: "M" },
  A: { label: "Added", color: "#9ece6a", symbol: "A" },
  D: { label: "Deleted", color: "#f7768e", symbol: "D" },
  R: { label: "Renamed", color: "#7aa2f7", symbol: "R" },
  U: { label: "Untracked", color: "#9aa5ce", symbol: "U" },
};

export function GitStatusIcon({ status, size = 14 }: GitStatusIconProps) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.M;

  return (
    <span
      className="inline-flex items-center justify-center rounded font-mono font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.7,
        color: config.color,
        backgroundColor: `${config.color}20`,
      }}
      title={config.label}
      aria-label={config.label}
    >
      {config.symbol}
    </span>
  );
}
