import type {
  HistoryFileChangeOperation,
  HistoryFileChangeSummary,
  HistoryMessage,
  HistorySessionDetail,
  HistoryToolEvent,
} from "../../../shared/types/index";
import type { ReplayEvent, ReplayEventStatus } from "../api/replayStore";

export type ReplayProgressStatus = ReplayEventStatus | "incomplete";
export type ReplayProgressStepKind =
  | "tool"
  | "mcp"
  | "skill"
  | "validation"
  | "file"
  | "subtask"
  | "permission"
  | "notification"
  | "snapshot"
  | "error";

export interface ReplayProgressStep {
  id: string;
  kind: ReplayProgressStepKind;
  title: string;
  summary: string;
  status: ReplayProgressStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  sourceLabel: string | null;
  inputSummary: string | null;
  outputSummary: string | null;
  rawEvents: ReplayEvent[];
  files: HistoryFileChangeSummary[];
  snapshotEvent: ReplayEvent | null;
}

export interface ReplayProgressTurn {
  id: string;
  prompt: string;
  response: string | null;
  assistantMessages: HistoryMessage[];
  status: ReplayProgressStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  steps: ReplayProgressStep[];
  counts: {
    tools: number;
    files: number;
    validations: number;
    subtasks: number;
    errors: number;
  };
}

export interface ReplayProgressModel {
  turns: ReplayProgressTurn[];
  current: {
    title: string;
    summary: string;
    status: ReplayProgressStatus;
    timestamp: string | null;
  } | null;
  counts: {
    turns: number;
    tools: number;
    files: number;
    validations: number;
    errors: number;
  };
}

interface MutableTurn extends ReplayProgressTurn {
  historyIndex: number;
  replayPromptIndex: number | null;
  replayEvents: ReplayEvent[];
}

interface MutableStep extends ReplayProgressStep {
  turnIndex: number;
  order: number;
}

const VALIDATION_PATTERN = /\b(?:npm\s+(?:run\s+)?(?:test|build|lint)|pnpm\s+(?:run\s+)?(?:test|build|lint)|yarn\s+(?:test|build|lint)|npx\s+tsc(?:\s+--noEmit)?|tsc\s+--noEmit|vitest|jest|pytest|cargo\s+(?:check|test|clippy|build)|go\s+test|dotnet\s+test|mvn\s+(?:test|verify)|gradle\s+test)\b/i;

function compactText(value: string | null | undefined, maxLength = 180): string {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function payloadString(event: ReplayEvent | null | undefined, key: string): string | null {
  const value = event?.payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function replayEventName(event: ReplayEvent): string {
  return payloadString(event, "event") ?? "";
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function durationBetween(startedAt: string | null, endedAt: string | null): number | null {
  const start = timestampMs(startedAt);
  const end = timestampMs(endedAt);
  if (start === null || end === null) return null;
  return Math.max(0, end - start);
}

function sourceLabelFromHistory(tool: HistoryToolEvent): string | null {
  if (tool.category.startsWith("mcp:")) return tool.category.slice(4);
  if (tool.category === "skill") return tool.name;
  return null;
}

function isValidationTool(name: string, input: string | null, output: string | null): boolean {
  return VALIDATION_PATTERN.test(`${name} ${input ?? ""} ${output ?? ""}`);
}

function historyTurnIndexForMessage(messageTurnIndexes: number[], messageIndex: number | null | undefined): number {
  if (messageTurnIndexes.length === 0) return 0;
  if (messageIndex === null || messageIndex === undefined) return messageTurnIndexes.length - 1;
  return messageTurnIndexes[messageIndex] ?? messageTurnIndexes.length - 1;
}

function replayTurnIndexForEvent(promptEvents: ReplayEvent[], event: ReplayEvent): number {
  if (promptEvents.length === 0) return 0;
  let result = 0;
  for (let index = 0; index < promptEvents.length; index += 1) {
    if (promptEvents[index].eventIndex > event.eventIndex) break;
    result = index;
  }
  return result;
}

function groupFileChangesByTurn(
  fileChanges: HistoryFileChangeSummary[],
  messageTurnIndexes: number[],
  turnCount: number
): Map<number, HistoryFileChangeSummary[]> {
  const grouped = new Map<number, Map<string, HistoryFileChangeSummary>>();

  const append = (turnIndex: number, summary: HistoryFileChangeSummary, operation: HistoryFileChangeOperation | null) => {
    const safeTurnIndex = Math.max(0, Math.min(turnCount - 1, turnIndex));
    const files = grouped.get(safeTurnIndex) ?? new Map<string, HistoryFileChangeSummary>();
    const current = files.get(summary.file_path) ?? {
      ...summary,
      additions: 0,
      deletions: 0,
      operations: [],
    };
    if (operation) {
      current.additions += operation.additions;
      current.deletions += operation.deletions;
      current.operations.push(operation);
      current.latest_message_index = operation.message_index ?? current.latest_message_index ?? null;
      current.latest_operation_group_index = operation.operation_group_index ?? current.latest_operation_group_index ?? null;
      current.latest_timestamp = operation.timestamp ?? current.latest_timestamp ?? null;
    } else {
      current.additions += summary.additions;
      current.deletions += summary.deletions;
      current.operations = summary.operations;
    }
    files.set(summary.file_path, current);
    grouped.set(safeTurnIndex, files);
  };

  for (const summary of fileChanges) {
    if (summary.operations.length === 0) {
      append(historyTurnIndexForMessage(messageTurnIndexes, summary.latest_message_index), summary, null);
      continue;
    }
    for (const operation of summary.operations) {
      append(historyTurnIndexForMessage(messageTurnIndexes, operation.message_index), summary, operation);
    }
  }

  return new Map(
    Array.from(grouped.entries()).map(([turnIndex, files]) => [
      turnIndex,
      Array.from(files.values()).sort((a, b) => a.file_path.localeCompare(b.file_path)),
    ])
  );
}

function buildTurns(events: ReplayEvent[], historyDetail: HistorySessionDetail | null): {
  turns: MutableTurn[];
  messageTurnIndexes: number[];
  promptEvents: ReplayEvent[];
} {
  const promptEvents = events.filter((event) => event.kind === "prompt");
  const historyTurns: Array<{ prompt: HistoryMessage; assistants: HistoryMessage[] }> = [];
  const messageTurnIndexes: number[] = [];

  for (const [messageIndex, message] of (historyDetail?.messages ?? []).entries()) {
    if (message.role.toLowerCase() === "user") {
      historyTurns.push({ prompt: message, assistants: [] });
    } else if (message.role.toLowerCase() === "assistant" && historyTurns.length > 0) {
      historyTurns[historyTurns.length - 1].assistants.push(message);
    }
    if (historyTurns.length > 0) messageTurnIndexes[messageIndex] = historyTurns.length - 1;
  }

  const count = Math.max(
    historyTurns.length,
    promptEvents.length,
    events.length > 0 || Boolean(historyDetail?.messages.length) ? 1 : 0
  );
  const turns: MutableTurn[] = [];
  for (let index = 0; index < count; index += 1) {
    const historyTurn = historyTurns[index];
    const replayPrompt = promptEvents[index];
    const prompt = compactText(
      historyTurn?.prompt.content ?? payloadString(replayPrompt, "message") ?? replayPrompt?.detail ?? replayPrompt?.title ?? historyDetail?.messages[0]?.content ?? events[0]?.detail ?? events[0]?.title,
      600
    );
    const assistantMessages = historyTurn?.assistants ?? [];
    const response = assistantMessages.length > 0
      ? compactText(assistantMessages[assistantMessages.length - 1].content, 600)
      : null;
    turns.push({
      id: replayPrompt ? `turn-${replayPrompt.eventIndex}` : `turn-history-${index}`,
      historyIndex: index,
      replayPromptIndex: replayPrompt?.eventIndex ?? null,
      replayEvents: [],
      prompt,
      response,
      assistantMessages,
      status: "incomplete",
      startedAt: historyTurn?.prompt.timestamp ?? replayPrompt?.timestamp ?? null,
      endedAt: assistantMessages[assistantMessages.length - 1]?.timestamp ?? null,
      durationMs: null,
      steps: [],
      counts: { tools: 0, files: 0, validations: 0, subtasks: 0, errors: 0 },
    });
  }

  for (const event of events) {
    const turnIndex = Math.min(turns.length - 1, replayTurnIndexForEvent(promptEvents, event));
    turns[turnIndex]?.replayEvents.push(event);
  }

  return { turns, messageTurnIndexes, promptEvents };
}

function createHistoryToolStep(tool: HistoryToolEvent, turnIndex: number, order: number): MutableStep {
  const sourceLabel = sourceLabelFromHistory(tool);
  const kind: ReplayProgressStepKind = tool.category.startsWith("mcp:")
    ? "mcp"
    : tool.category === "skill"
      ? "skill"
      : isValidationTool(tool.name, tool.input_summary ?? null, tool.output_summary ?? null)
        ? "validation"
        : "tool";
  return {
    id: tool.call_id ? `tool-${tool.call_id}` : `history-tool-${turnIndex}-${order}`,
    turnIndex,
    order,
    kind,
    title: tool.name,
    summary: compactText(tool.output_summary ?? tool.input_summary ?? tool.name),
    status: tool.status === "failed" ? "failed" : tool.status === "completed" || Boolean(tool.output_summary) ? "completed" : "running",
    startedAt: tool.timestamp ?? null,
    endedAt: tool.status === "completed" || tool.status === "failed" ? tool.timestamp ?? null : null,
    durationMs: tool.duration_ms ?? null,
    sourceLabel,
    inputSummary: tool.input_summary ?? null,
    outputSummary: tool.output_summary ?? null,
    rawEvents: [],
    files: [],
    snapshotEvent: null,
  };
}

function applyReplayToolEvent(step: MutableStep, event: ReplayEvent): void {
  const name = replayEventName(event);
  const toolName = payloadString(event, "toolName");
  const mcpServer = payloadString(event, "mcpServer");
  const skillName = payloadString(event, "skillName");
  step.rawEvents.push(event);
  step.title = toolName ?? step.title ?? event.title;
  step.sourceLabel = mcpServer ?? skillName ?? step.sourceLabel;
  if (mcpServer) step.kind = "mcp";
  else if (skillName) step.kind = "skill";
  if (!step.inputSummary) step.inputSummary = payloadString(event, "message");
  if (!step.summary) step.summary = compactText(event.detail || event.title);

  if (name.endsWith("Start")) {
    step.startedAt = step.startedAt ?? event.timestamp;
    step.status = "running";
  } else if (name.endsWith("Stop")) {
    step.endedAt = event.timestamp;
    step.status = event.status === "failed" ? "failed" : "completed";
  } else {
    step.startedAt = step.startedAt ?? event.timestamp;
    step.status = event.status;
  }
  step.durationMs = event.durationMs ?? step.durationMs ?? durationBetween(step.startedAt, step.endedAt);
  if (step.kind === "tool" && isValidationTool(step.title, step.inputSummary, step.outputSummary)) {
    step.kind = "validation";
  }
}

function finalizeTurns(turns: MutableTurn[], steps: MutableStep[]): ReplayProgressTurn[] {
  for (const step of steps) turns[step.turnIndex]?.steps.push(step);

  for (const [turnIndex, turn] of turns.entries()) {
    const mutableSteps = turn.steps as MutableStep[];
    const latestTurn = turnIndex === turns.length - 1;
    if (!latestTurn) {
      for (const step of mutableSteps) {
        if (step.status === "running") step.status = "incomplete";
      }
    }
    mutableSteps.sort((a, b) => {
      const at = timestampMs(a.startedAt) ?? a.order;
      const bt = timestampMs(b.startedAt) ?? b.order;
      return at - bt || a.order - b.order;
    });
    const stopFailure = turn.replayEvents.find((event) => replayEventName(event) === "StopFailure");
    const stop = [...turn.replayEvents].reverse().find((event) => replayEventName(event) === "Stop");
    const running = turn.steps.some((step) => step.status === "running");
    const failed = Boolean(stopFailure) || turn.steps.some((step) => step.status === "failed" || step.kind === "error");
    turn.status = failed
      ? "failed"
      : latestTurn && running
        ? "running"
        : stop || turn.response || !latestTurn
          ? "completed"
          : "incomplete";
    turn.endedAt = stopFailure?.timestamp ?? stop?.timestamp ?? turn.endedAt;
    turn.durationMs = durationBetween(turn.startedAt, turn.endedAt);
    const filePaths = new Set(turn.steps.flatMap((step) => step.files.map((file) => file.file_path)));
    turn.counts = {
      tools: turn.steps.filter((step) => step.kind === "tool" || step.kind === "mcp" || step.kind === "skill").length,
      files: filePaths.size,
      validations: turn.steps.filter((step) => step.kind === "validation").length,
      subtasks: turn.steps.filter((step) => step.kind === "subtask").length,
      errors: turn.steps.filter((step) => step.kind === "error" || step.status === "failed").length,
    };
  }

  return [...turns].reverse();
}

export function buildReplayProgressModel(
  events: ReplayEvent[],
  historyDetail: HistorySessionDetail | null,
  sessionStatus: ReplayEventStatus | null = null
): ReplayProgressModel {
  if (events.length === 0 && !historyDetail?.messages.length) {
    return { turns: [], current: null, counts: { turns: 0, tools: 0, files: 0, validations: 0, errors: 0 } };
  }

  const sortedEvents = [...events].sort((a, b) => a.eventIndex - b.eventIndex);
  const { turns, messageTurnIndexes, promptEvents } = buildTurns(sortedEvents, historyDetail);
  const steps: MutableStep[] = [];
  const toolStepsByCallId = new Map<string, MutableStep>();

  for (const [index, tool] of (historyDetail?.tool_events ?? []).entries()) {
    const turnIndex = Math.min(turns.length - 1, historyTurnIndexForMessage(messageTurnIndexes, tool.message_index));
    const step = createHistoryToolStep(tool, turnIndex, index);
    steps.push(step);
    if (tool.call_id) toolStepsByCallId.set(tool.call_id, step);
  }

  for (const event of sortedEvents) {
    if (event.kind !== "tool" && event.kind !== "mcp" && event.kind !== "skill") continue;
    const turnIndex = Math.min(turns.length - 1, replayTurnIndexForEvent(promptEvents, event));
    const callId = payloadString(event, "toolUseId");
    let step = callId ? toolStepsByCallId.get(callId) : undefined;
    if (!step) {
      step = {
        id: callId ? `tool-${callId}` : `replay-tool-${event.eventIndex}`,
        turnIndex,
        order: 10_000 + event.eventIndex,
        kind: event.kind,
        title: payloadString(event, "toolName") ?? event.title,
        summary: compactText(event.detail || event.title),
        status: event.status,
        startedAt: null,
        endedAt: null,
        durationMs: event.durationMs,
        sourceLabel: payloadString(event, "mcpServer") ?? payloadString(event, "skillName"),
        inputSummary: payloadString(event, "message"),
        outputSummary: null,
        rawEvents: [],
        files: [],
        snapshotEvent: null,
      };
      steps.push(step);
      if (callId) toolStepsByCallId.set(callId, step);
    }
    applyReplayToolEvent(step, event);
  }

  const subtaskSteps = new Map<string, MutableStep>();
  for (const event of sortedEvents) {
    const turnIndex = Math.min(turns.length - 1, replayTurnIndexForEvent(promptEvents, event));
    if (event.kind === "subtask") {
      const agentId = payloadString(event, "agentId");
      const key = agentId ?? `event-${event.eventIndex}`;
      let step = subtaskSteps.get(key);
      if (!step) {
        step = {
          id: `subtask-${key}`,
          turnIndex,
          order: 20_000 + event.eventIndex,
          kind: "subtask",
          title: payloadString(event, "agentType") ?? event.title,
          summary: compactText(event.detail || event.title),
          status: event.status,
          startedAt: null,
          endedAt: null,
          durationMs: event.durationMs,
          sourceLabel: agentId,
          inputSummary: payloadString(event, "message"),
          outputSummary: null,
          rawEvents: [],
          files: [],
          snapshotEvent: null,
        };
        steps.push(step);
        subtaskSteps.set(key, step);
      }
      step.rawEvents.push(event);
      if (replayEventName(event).endsWith("Start")) {
        step.startedAt = step.startedAt ?? event.timestamp;
        step.status = "running";
      } else if (replayEventName(event).endsWith("Stop")) {
        step.endedAt = event.timestamp;
        step.status = event.status === "failed" ? "failed" : "completed";
      }
      step.durationMs = durationBetween(step.startedAt, step.endedAt) ?? step.durationMs;
      continue;
    }
    if (event.kind === "snapshot" || event.kind === "permission" || event.kind === "notification" || event.kind === "error") {
      steps.push({
        id: `${event.kind}-${event.eventIndex}`,
        turnIndex,
        order: 30_000 + event.eventIndex,
        kind: event.kind,
        title: event.title,
        summary: compactText(event.detail || event.title),
        status: event.status,
        startedAt: event.timestamp,
        endedAt: event.timestamp,
        durationMs: event.durationMs,
        sourceLabel: null,
        inputSummary: null,
        outputSummary: null,
        rawEvents: [event],
        files: [],
        snapshotEvent: event.kind === "snapshot" ? event : null,
      });
    }
  }

  const fileChangesByTurn = groupFileChangesByTurn(
    historyDetail?.file_changes ?? [],
    messageTurnIndexes,
    turns.length
  );
  for (const [turnIndex, files] of fileChangesByTurn) {
    const timestamps = files
      .map((file) => file.latest_timestamp ?? null)
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => (timestampMs(a) ?? 0) - (timestampMs(b) ?? 0));
    const latestTimestamp = timestamps[timestamps.length - 1] ?? null;
    steps.push({
      id: `files-${turnIndex}`,
      turnIndex,
      order: 25_000 + turnIndex,
      kind: "file",
      title: files.length === 1 ? files[0].file_path : `${files.length} files`,
      summary: files.map((file) => file.file_path).join(", "),
      status: "completed",
      startedAt: latestTimestamp,
      endedAt: latestTimestamp,
      durationMs: null,
      sourceLabel: null,
      inputSummary: null,
      outputSummary: null,
      rawEvents: [],
      files,
      snapshotEvent: null,
    });
  }

  if (sessionStatus && sessionStatus !== "running") {
    for (const step of steps) {
      if (step.status === "running") step.status = "incomplete";
    }
  }
  const finalizedTurns = finalizeTurns(turns, steps);
  const latestTurn = finalizedTurns[0] ?? null;
  const currentStep = latestTurn
    ? [...latestTurn.steps].reverse().find((step) => step.status === "running") ?? latestTurn.steps[latestTurn.steps.length - 1] ?? null
    : null;
  const current = latestTurn
    ? {
        title: currentStep?.title || latestTurn.prompt,
        summary: currentStep?.summary || latestTurn.response || latestTurn.prompt,
        status: currentStep?.status ?? latestTurn.status,
        timestamp: currentStep?.startedAt ?? latestTurn.startedAt,
      }
    : null;
  const allSteps = finalizedTurns.flatMap((turn) => turn.steps);
  const files = new Set(allSteps.flatMap((step) => step.files.map((file) => file.file_path)));

  return {
    turns: finalizedTurns,
    current,
    counts: {
      turns: finalizedTurns.length,
      tools: allSteps.filter((step) => step.kind === "tool" || step.kind === "mcp" || step.kind === "skill").length,
      files: files.size,
      validations: allSteps.filter((step) => step.kind === "validation").length,
      errors: allSteps.filter((step) => step.kind === "error" || step.status === "failed").length,
    },
  };
}

export function createReplayEventMatcher(query: string): (event: ReplayEvent) => boolean {
  const normalized = query.trim();
  if (!normalized) return () => true;
  const matcher = new RegExp(normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return (event) => {
    const fields = [
      event.title,
      event.detail,
      ...event.tags,
      payloadString(event, "toolName"),
      payloadString(event, "mcpServer"),
      payloadString(event, "skillName"),
      payloadString(event, "message"),
    ];
    return fields.some((value) => value && matcher.test(value));
  };
}
