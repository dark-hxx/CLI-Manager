import type { SubagentTranscriptSource, TerminalSession } from "../../../lib/types";
import { type CliHookPayload } from "../types/terminalStoreTypes";

export function hasCodexTerminalEvent(content: string): boolean {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { type?: string; payload?: { type?: string } };
      if (record.type === "event_msg" && (record.payload?.type === "task_complete" || record.payload?.type === "turn_aborted")) {
        return true;
      }
    } catch {
      // 尾部可能是不完整 JSONL，等待下一次追加。
    }
  }
  return false;
}

export function trimOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function inferWslDistroFromCwd(cwd: string | null | undefined): string | null {
  const value = trimOptional(cwd);
  if (!value) return null;
  const normalized = value.replace(/\//g, "\\");
  const match = normalized.match(/^(?:\\\\wsl(?:\.localhost|\$)\\|\\\\\?\\UNC\\wsl(?:\.localhost|\$)\\)([^\\]+)(?:\\|$)/i);
  return match?.[1]?.trim() || null;
}

export function resolveHookWslDistroName(payload: CliHookPayload): string | null {
  return trimOptional(payload.wslDistroName) ?? inferWslDistroFromCwd(payload.cwd);
}

export function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}

export function normalizeRemotePathForCompare(path: string): string {
  const normalized = path.trim().replace(/\/{2,}/g, "/").replace(/\/+$/g, "");
  return normalized || "/";
}

export function isSameTranscriptPath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

export function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

export function buildSubagentTitle(
  parentSession: TerminalSession | undefined,
  agentType: string | null,
  existingSubagentCount: number
): string {
  const parentTitle = parentSession?.title || "Terminal";
  const agentLabel = agentType || "子Agent";

  // 如果同一父终端已经有子 Agent，添加序号
  if (existingSubagentCount > 0) {
    return `${agentLabel} #${existingSubagentCount + 1} (${parentTitle})`;
  }

  // 首个子 Agent：显示父终端标题，便于识别来源
  return `${agentLabel} (${parentTitle})`;
}

export function resolveSubagentTranscriptSource(payload: CliHookPayload): SubagentTranscriptSource {
  const childPath = trimOptional(payload.agentTranscriptPath);
  const parentPath = trimOptional(payload.transcriptPath);

  if (childPath && !isSameTranscriptPath(childPath, parentPath)) {
    return {
      kind: "child-jsonl",
      transcriptPath: childPath,
      parentTranscriptPath: parentPath ?? undefined,
    };
  }

  if (payload.source === "codex" && trimOptional(payload.agentId) && trimOptional(payload.sessionId)) {
    return {
      kind: "pending",
      parentTranscriptPath: parentPath ?? undefined,
      reason: "waiting for Codex rollout transcript discovery",
    };
  }

  if (payload.event === "AgentToolStart" || payload.event === "AgentToolStop") {
    return {
      kind: "pending",
      parentTranscriptPath: parentPath ?? undefined,
      reason: childPath ? "child transcript path equals parent transcript path" : "waiting for Agent tool child transcript discovery",
    };
  }

  if (parentPath) {
    return {
      kind: "parent-jsonl",
      transcriptPath: parentPath,
      parentTranscriptPath: parentPath,
      reason: childPath ? "child transcript path equals parent transcript path" : "missing child transcript path",
    };
  }

  return {
    kind: "lifecycle-only",
    reason: "missing transcript path",
  };
}

export function shouldUpgradeSubagentSource(previous: SubagentTranscriptSource | undefined, next: SubagentTranscriptSource): boolean {
  if (!previous) return true;
  if (previous.kind === "child-jsonl") return next.kind === "child-jsonl" && previous.transcriptPath !== next.transcriptPath;
  if (next.kind === "child-jsonl") return true;
  if (previous.kind === "pending" && next.kind !== "pending") return true;
  if (previous.kind === "lifecycle-only" && next.kind === "parent-jsonl") return true;
  return previous.kind === next.kind && previous.reason !== next.reason;
}

export function mergeSubagentSource(previous: SubagentTranscriptSource | undefined, next: SubagentTranscriptSource): SubagentTranscriptSource {
  if (!shouldUpgradeSubagentSource(previous, next)) return previous ?? next;
  if (next.kind === "child-jsonl") return next;
  return {
    ...next,
    parentTranscriptPath: next.parentTranscriptPath ?? previous?.parentTranscriptPath,
  };
}

export function shouldSubscribeSubagentSource(previous: SubagentTranscriptSource | undefined, next: SubagentTranscriptSource): boolean {
  return next.kind === "child-jsonl" && Boolean(next.transcriptPath) && previous?.transcriptPath !== next.transcriptPath;
}

export function shouldAttemptDerivedChildTranscript(payload: CliHookPayload, source: SubagentTranscriptSource): boolean {
  if (payload.source !== "claude" || source.kind === "child-jsonl") return false;
  return Boolean(
    trimOptional(payload.agentId)
    && trimOptional(payload.sessionId)
    && (trimOptional(payload.cwd) || trimOptional(source.parentTranscriptPath))
  );
}

export function findSubagentSessionId(sessions: TerminalSession[], payload: CliHookPayload): string | null {
  const agentId = payload.agentId?.trim() || null;
  if (agentId) {
    const byAgent = sessions.find(
      (session) =>
        session.kind === "subagent-transcript" &&
        (session.subagent?.agentId === agentId || session.id === `subagent:${agentId}`)
    );
    if (byAgent) return byAgent.id;
  }

  const toolUseId = payload.toolUseId?.trim() || null;
  if (toolUseId) {
    const byTool = sessions.find(
      (session) =>
        session.kind === "subagent-transcript" &&
        (session.subagent?.toolUseId === toolUseId || session.id === `subagent:tool:${toolUseId}`)
    );
    if (byTool) return byTool.id;
  }

  // Fallback：仅当 payload 既无 agentId 也无 toolUseId（完全无法识别）时，才通过 parentTabId 推断。
  // 若 payload 带 agentId/toolUseId 但未匹配到，说明是新的子 Agent，应返回 null 以创建新 Tab，
  // 避免并发场景下第二个子 Agent 被错误合并到第一个。
  if (agentId || toolUseId) return null;

  const candidates = sessions.filter(
    (session) => session.kind === "subagent-transcript" && session.subagent?.parentSessionId === payload.tabId
  );
  return candidates.length === 1 ? candidates[0].id : null;
}
