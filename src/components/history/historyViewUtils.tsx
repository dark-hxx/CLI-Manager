import type { ReactNode } from "react";
import type { AppLanguage } from "../../lib/i18n";
import type { HistorySessionView } from "../../lib/types";

export type TimeGroupLabel = "Today" | "Yesterday" | "This Week" | "This Month" | "Earlier";

// 模块级 formatter 缓存：toLocaleString 每次创建 ICU formatter，对长会话/列表的开销可观。
const TIME_FORMATTERS = new Map<AppLanguage, Intl.DateTimeFormat>();

function getTimeFormatter(language: AppLanguage): Intl.DateTimeFormat {
  const cached = TIME_FORMATTERS.get(language);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(language, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  TIME_FORMATTERS.set(language, formatter);
  return formatter;
}

export function formatTime(ts: number, language: AppLanguage = "zh-CN"): string {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  return getTimeFormatter(language).format(new Date(ts));
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 同会话搜索时 query 通常稳定，但 highlightText 会被每条可见消息调用一次，
// 每次都 `new RegExp` 是浪费。用 1-entry cache 复用上次编译的 regex。
let cachedQuery: string | null = null;
let cachedRegex: RegExp | null = null;
let cachedNormalized: string = "";

function getHighlightRegex(trimmed: string): { regex: RegExp; normalized: string } {
  if (cachedQuery === trimmed && cachedRegex) {
    return { regex: cachedRegex, normalized: cachedNormalized };
  }
  const regex = new RegExp(`(${escapeRegExp(trimmed)})`, "ig");
  cachedQuery = trimmed;
  cachedRegex = regex;
  cachedNormalized = trimmed.toLowerCase();
  return { regex, normalized: cachedNormalized };
}

const HIGHLIGHT_TEXT_MAX_LENGTH = 24_000;
const HIGHLIGHT_PARTS_MAX = 400;

export function highlightText(text: string, query: string): ReactNode {
  const trimmed = query.trim();
  if (!trimmed || text.length > HIGHLIGHT_TEXT_MAX_LENGTH) return text;
  const { regex, normalized } = getHighlightRegex(trimmed);
  const parts = text.split(regex);
  if (parts.length > HIGHLIGHT_PARTS_MAX) return text;
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

function sessionRelationKey(source: string, projectKey: string, sessionId: string): string {
  return `${source}:${projectKey}:${sessionId}`;
}

export function inferSubagentParentSessionId(session: HistorySessionView): string | null {
  const parts = session.file_path.replace(/\\/g, "/").split("/").filter(Boolean);
  const subagentsIndex = parts.findIndex((part) => part.toLowerCase() === "subagents");
  if (subagentsIndex <= 0) return null;

  const fileName = parts[subagentsIndex + 1] ?? "";
  if (!/^agent-[^/]+\.jsonl$/i.test(fileName)) return null;

  const parentSessionId = parts[subagentsIndex - 1] ?? "";
  if (!parentSessionId || parentSessionId === session.session_id) return null;
  return parentSessionId;
}

export function buildHistorySessionChildMap(items: HistorySessionView[]): Map<string, HistorySessionView[]> {
  const bySessionId = new Map<string, HistorySessionView>();
  const childrenByParentKey = new Map<string, HistorySessionView[]>();

  for (const item of items) {
    bySessionId.set(sessionRelationKey(item.source, item.project_key, item.session_id), item);
  }

  for (const item of items) {
    const parentSessionId = inferSubagentParentSessionId(item);
    if (!parentSessionId) continue;

    const parentKey = sessionRelationKey(item.source, item.project_key, parentSessionId);
    const parent = bySessionId.get(parentKey);
    if (!parent) continue;

    const children = childrenByParentKey.get(parent.sessionKey) ?? [];
    children.push(item);
    childrenByParentKey.set(parent.sessionKey, children);
  }

  return childrenByParentKey;
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
