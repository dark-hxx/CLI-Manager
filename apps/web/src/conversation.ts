import type { ConversationEvent, ProjectContext, TimelineItem } from "./domain";

export function launchContextKey(
  contexts: ProjectContext[],
  targetType: "project" | "group" | "worktree",
  targetId: string,
) {
  if (targetType === "project") {
    return contexts.find((item) => item.projectId === targetId && !item.worktreeId)?.key;
  }
  if (targetType === "worktree") {
    return contexts.find((item) => item.worktreeId === targetId)?.key;
  }
  return undefined;
}

export function mergeConversationEvents(current: ConversationEvent[], incoming: ConversationEvent[]): ConversationEvent[] {
  const events = new Map(current.map((event) => [`${event.operationId}:${event.sequence}`, event]));
  for (const event of incoming) events.set(`${event.operationId}:${event.sequence}`, event);
  return [...events.values()].sort((a, b) => a.operationId === b.operationId ? a.sequence - b.sequence : a.occurredAt - b.occurredAt || a.operationId.localeCompare(b.operationId));
}

export function establishedSessionId(events: ConversationEvent[]): string | undefined {
  return events.find((event) => event.kind === "session_started")?.sessionId;
}

export function validSelectedSessionId(
  availableSessionIds: ReadonlySet<string>,
  current?: string,
  saved?: string,
): string | undefined {
  if (current && availableSessionIds.has(current)) return current;
  return saved && availableSessionIds.has(saved) ? saved : undefined;
}

export function conversationTimeline(events: ConversationEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const event of events) {
    const id = `${event.operationId}:${event.messageId || "assistant"}`;
    if (event.kind === "user_message") {
      items.push({ id: `${event.operationId}:user:${event.messageId ?? event.sequence}`, type: "prompt", text: event.text ?? "", occurredAt: event.occurredAt });
    } else if (event.kind === "assistant_delta" || event.kind === "assistant_done") {
      const existing = items.find((item) => item.id === id && item.type === "assistant");
      if (existing && existing.type === "assistant") {
        existing.text = event.kind === "assistant_delta" ? existing.text + (event.text ?? "") : event.text ?? existing.text;
        existing.streaming = event.kind === "assistant_delta";
      } else {
        items.push({ id, type: "assistant", text: event.text ?? "", occurredAt: event.occurredAt, streaming: event.kind === "assistant_delta" });
      }
    } else if (["tool_status", "approval_required", "turn_failed"].includes(event.kind) && event.text) {
      items.push({ id: `${event.operationId}:${event.sequence}`, type: "activity", text: event.text, occurredAt: event.occurredAt });
    }
    if (event.kind === "turn_completed" || event.kind === "turn_failed") {
      for (const item of items) if (item.type === "assistant" && item.id.startsWith(`${event.operationId}:`)) item.streaming = false;
    }
  }
  return items;
}

export function visibleConversationTimeline(events: ConversationEvent[], local: TimelineItem[]): TimelineItem[] {
  const receivedTurns = new Set(events.filter((event) => event.kind === "user_message").map((event) => event.operationId));
  const receivedPrompts = new Set(local.flatMap((item) => item.type === "operation" && receivedTurns.has(item.operation.id) ? [item.operation.idempotencyKey] : []));
  return [...conversationTimeline(events), ...local.filter((item) => item.type !== "prompt" || !receivedPrompts.has(item.id))];
}
