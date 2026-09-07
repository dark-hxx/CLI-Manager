import type { HistorySessionView } from "./types";

/**
 * 优先使用后端从会话元数据解析出的父会话 ID；Claude 的路径约定作为兼容回退。
 */
export function inferSubagentParentSessionId(session: HistorySessionView): string | null {
  const explicitParentId = session.parent_session_id?.trim();
  if (explicitParentId && explicitParentId !== session.session_id) {
    return explicitParentId;
  }

  const parts = (session.file_path ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  const subagentsIndex = parts.findIndex((part) => part.toLowerCase() === "subagents");
  if (subagentsIndex <= 0) return null;

  const fileName = parts[subagentsIndex + 1] ?? "";
  if (!/^agent-[^/]+\.jsonl$/i.test(fileName)) return null;

  const parentSessionId = parts[subagentsIndex - 1] ?? "";
  if (!parentSessionId || parentSessionId === session.session_id) return null;
  return parentSessionId;
}
