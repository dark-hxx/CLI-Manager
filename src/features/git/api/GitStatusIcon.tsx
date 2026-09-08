import type { GitFileChange } from "../../../shared/types/index";

interface GitStatusIconProps {
  status: GitFileChange["status"];
  size?: number;
}

export const STATUS_CONFIG: Record<
  GitFileChange["status"],
  { label: string; color: string; symbol: string }
> = {
  M: { label: "Modified", color: "#4f8cff", symbol: "M" },
  A: { label: "Added", color: "#35c46b", symbol: "A" },
  D: { label: "Deleted", color: "#f7768e", symbol: "D" },
  R: { label: "Renamed", color: "#7aa2f7", symbol: "R" },
  C: { label: "Conflict", color: "#db4b4b", symbol: "C" },
  U: { label: "Untracked", color: "#a9b1d6", symbol: "U" },
  "??": { label: "Untracked", color: "#a9b1d6", symbol: "?" },
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
