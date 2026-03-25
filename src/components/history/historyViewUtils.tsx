import type { ReactNode } from "react";
import type { HistorySessionView } from "../../lib/types";

export type TimeGroupLabel = "Today" | "Yesterday" | "This Week" | "This Month" | "Earlier";

export function formatTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

export function highlightText(text: string, query: string): ReactNode {
  const trimmed = query.trim();
  if (!trimmed) return text;
  const regex = new RegExp(`(${escapeRegExp(trimmed)})`, "ig");
  const parts = text.split(regex);
  const normalized = trimmed.toLowerCase();
  return parts.map((part, idx) => {
    if (part.toLowerCase() === normalized) {
      return (
        <mark
          key={`${part}-${idx}`}
          className="rounded-sm px-0.5"
          style={{ backgroundColor: "var(--warning)", color: "var(--bg-primary)" }}
        >
          {part}
        </mark>
      );
    }
    return <span key={`${part}-${idx}`}>{part}</span>;
  });
}

export function makeSessionLabel(session: HistorySessionView): string {
  if (session.branch && session.branch.trim()) {
    return `${session.project_key} · ${session.branch}`;
  }
  return session.project_key;
}

export function toGroupLabel(ts: number, nowTs: number): TimeGroupLabel {
  if (!Number.isFinite(ts) || ts <= 0) return "Earlier";
  const todayStart = new Date(nowTs);
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  if (ts >= todayMs) return "Today";

  const yesterdayMs = todayMs - 24 * 60 * 60 * 1000;
  if (ts >= yesterdayMs) return "Yesterday";

  const day = todayStart.getDay();
  const mondayOffset = day === 0 ? 6 : day - 1;
  const weekMs = todayMs - mondayOffset * 24 * 60 * 60 * 1000;
  if (ts >= weekMs) return "This Week";

  const monthMs = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1).getTime();
  if (ts >= monthMs) return "This Month";

  return "Earlier";
}

export function roleBadge(role: string): { label: string; color: string; bg: string; border: string } {
  const normalized = role.toLowerCase();
  if (normalized === "user") {
    return {
      label: "USER",
      color: "#1d4ed8",
      bg: "rgba(59, 130, 246, 0.12)",
      border: "rgba(59, 130, 246, 0.35)",
    };
  }
  if (normalized === "assistant") {
    return {
      label: "ASSISTANT",
      color: "#047857",
      bg: "rgba(16, 185, 129, 0.12)",
      border: "rgba(16, 185, 129, 0.3)",
    };
  }
  if (normalized === "system") {
    return {
      label: "SYSTEM",
      color: "#7c3aed",
      bg: "rgba(124, 58, 237, 0.12)",
      border: "rgba(124, 58, 237, 0.35)",
    };
  }
  return {
    label: normalized.toUpperCase(),
    color: "var(--text-secondary)",
    bg: "var(--bg-tertiary)",
    border: "var(--border)",
  };
}
