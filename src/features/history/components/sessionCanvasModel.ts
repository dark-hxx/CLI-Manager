import type { HistoryMessage, HistorySessionDetail } from "../../../shared/types/index";
import type { TranslationKey } from "../../../shared/i18n/index";
import type { SessionEventKind, SessionProcessModel } from "./sessionEvents";

export type SessionCanvasNodeKind = "start" | "turn" | "tool" | "file" | "test" | "error" | "subtask";
export type SessionCanvasFilter = "all" | Exclude<SessionCanvasNodeKind, "start" | "turn">;

export interface SessionCanvasNode {
  id: string;
  kind: SessionCanvasNodeKind;
  parentId: string | null;
  title: string;
  summary: string;
  details: string[];
  messageIndex: number | null;
  timestamp: string | null;
  count: number;
  totalTokens: number;
  additions: number;
  deletions: number;
  filePath?: string;
  status?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SessionCanvasEdge {
  id: string;
  source: string;
  target: string;
  kind: "main" | "branch";
}

export interface SessionCanvasModel {
  nodes: SessionCanvasNode[];
  edges: SessionCanvasEdge[];
  turnCount: number;
  branchCount: number;
}

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

interface TurnRange {
  id: string;
  order: number;
  startIndex: number;
  endIndex: number;
  userIndex: number | null;
}

interface BranchDraft {
  id: string;
  parentId: string;
  kind: Exclude<SessionCanvasNodeKind, "start" | "turn">;
  title: string;
  details: string[];
  messageIndex: number | null;
  timestamp: string | null;
  count: number;
  additions: number;
  deletions: number;
  filePath?: string;
  status?: string;
}

const MAIN_NODE_WIDTH = 248;
// 固定高度必须覆盖标题、双行摘要、状态栏、间距与内边距，避免 flex 子项被纵向压缩后裁字。
const MAIN_NODE_HEIGHT = 124;
const BRANCH_NODE_WIDTH = 218;
const BRANCH_NODE_HEIGHT = 108;
const MAIN_NODE_GAP = 104;
const BRANCH_NODE_GAP = 24;
const BRANCH_OFFSET = 56;
const SCENE_PADDING = 56;

function compactText(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function messageTokens(message: HistoryMessage): number {
  return (message.input_tokens ?? 0)
    + (message.output_tokens ?? 0)
    + (message.cache_read_tokens ?? 0)
    + (message.cache_creation_tokens ?? 0);
}

function buildTurnRanges(messages: HistoryMessage[]): TurnRange[] {
  const ranges: TurnRange[] = [];
  let activeStart: number | null = null;
  let activeUserIndex: number | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role.toLowerCase() !== "user") continue;
    if (activeStart !== null) {
      ranges.push({
        id: `turn-${ranges.length + 1}`,
        order: ranges.length + 1,
        startIndex: activeStart,
        endIndex: index - 1,
        userIndex: activeUserIndex,
      });
    }
    activeStart = index;
    activeUserIndex = index;
  }

  if (activeStart !== null) {
    ranges.push({
      id: `turn-${ranges.length + 1}`,
      order: ranges.length + 1,
      startIndex: activeStart,
      endIndex: messages.length - 1,
      userIndex: activeUserIndex,
    });
  } else if (messages.length > 0) {
    ranges.push({
      id: "turn-1",
      order: 1,
      startIndex: 0,
      endIndex: messages.length - 1,
      userIndex: null,
    });
  }

  return ranges;
}

function findParentId(messageIndex: number | null | undefined, turns: TurnRange[]): string {
  if (messageIndex === null || messageIndex === undefined) return "session-start";
  return turns.find((turn) => messageIndex >= turn.startIndex && messageIndex <= turn.endIndex)?.id ?? "session-start";
}

function branchKindFromEvent(kind: SessionEventKind): BranchDraft["kind"] | null {
  if (kind === "tool" || kind === "file" || kind === "test" || kind === "error" || kind === "subtask") return kind;
  return null;
}

function branchTitle(kind: BranchDraft["kind"], t: Translate): string {
  return t(`history.canvas.kind.${kind}` as TranslationKey);
}

export function buildSessionCanvasModel(
  session: HistorySessionDetail | null,
  processModel: SessionProcessModel,
  t: Translate
): SessionCanvasModel {
  if (!session) return { nodes: [], edges: [], turnCount: 0, branchCount: 0 };

  const turns = buildTurnRanges(session.messages);
  const mainNodes: SessionCanvasNode[] = [
    {
      id: "session-start",
      kind: "start",
      parentId: null,
      title: t("history.canvas.sessionStart"),
      summary: t("history.canvas.sessionStartSummary", { count: session.messages.length }),
      details: [session.title, session.project_key].filter(Boolean),
      messageIndex: null,
      timestamp: session.created_at > 0 ? new Date(session.created_at).toISOString() : null,
      count: session.messages.length,
      totalTokens: 0,
      additions: 0,
      deletions: 0,
      x: 0,
      y: 0,
      width: MAIN_NODE_WIDTH,
      height: MAIN_NODE_HEIGHT,
    },
  ];

  for (const turn of turns) {
    const messages = session.messages.slice(turn.startIndex, turn.endIndex + 1);
    const userMessage = turn.userIndex === null ? messages[0] : session.messages[turn.userIndex];
    const assistantMessage = [...messages].reverse().find((message) => message.role.toLowerCase() === "assistant");
    const totalTokens = messages.reduce((total, message) => total + messageTokens(message), 0);
    const prompt = compactText(userMessage?.content ?? "");
    const reply = compactText(assistantMessage?.content ?? "");
    const details = [
      prompt ? t("history.canvas.promptDetail", { text: prompt }) : "",
      reply ? t("history.canvas.replyDetail", { text: reply }) : "",
    ].filter(Boolean);

    mainNodes.push({
      id: turn.id,
      kind: "turn",
      parentId: turn.order === 1 ? "session-start" : `turn-${turn.order - 1}`,
      title: t(turn.userIndex === null ? "history.canvas.fallbackTurn" : "history.canvas.turnTitle", { index: turn.order }),
      summary: prompt || reply || t("history.detail.noText"),
      details,
      messageIndex: turn.userIndex ?? turn.startIndex,
      timestamp: userMessage?.timestamp ?? messages[0]?.timestamp ?? null,
      count: messages.length,
      totalTokens,
      additions: 0,
      deletions: 0,
      x: 0,
      y: 0,
      width: MAIN_NODE_WIDTH,
      height: MAIN_NODE_HEIGHT,
    });
  }

  const drafts = new Map<string, BranchDraft>();
  let branchSequence = 0;
  const addBranch = (
    mapKey: string,
    input: Omit<BranchDraft, "id" | "count" | "details" | "additions" | "deletions"> & {
      detail?: string | null;
      additions?: number;
      deletions?: number;
    }
  ) => {
    const current = drafts.get(mapKey);
    if (current) {
      current.count += 1;
      current.additions += input.additions ?? 0;
      current.deletions += input.deletions ?? 0;
      if (input.detail && !current.details.includes(input.detail)) current.details.push(input.detail);
      if (input.status === "failed" || !current.status) current.status = input.status;
      if (current.messageIndex === null && input.messageIndex !== null) current.messageIndex = input.messageIndex;
      if (!current.timestamp && input.timestamp) current.timestamp = input.timestamp;
      return;
    }
    drafts.set(mapKey, {
      id: `branch-${branchSequence += 1}`,
      parentId: input.parentId,
      kind: input.kind,
      title: input.title,
      details: input.detail ? [input.detail] : [],
      messageIndex: input.messageIndex,
      timestamp: input.timestamp,
      count: 1,
      additions: input.additions ?? 0,
      deletions: input.deletions ?? 0,
      filePath: input.filePath,
      status: input.status,
    });
  };

  for (const event of session.tool_events ?? []) {
    const parentId = findParentId(event.message_index, turns);
    const detail = compactText(event.output_summary ?? event.input_summary ?? event.category);
    addBranch(`tool:${parentId}:${event.category}:${event.name}`, {
      parentId,
      kind: "tool",
      title: event.name || branchTitle("tool", t),
      detail,
      messageIndex: event.message_index ?? null,
      timestamp: event.timestamp ?? null,
      status: event.status ?? undefined,
    });
  }

  for (const change of session.file_changes ?? []) {
    for (const operation of change.operations) {
      const parentId = findParentId(operation.message_index, turns);
      const detail = compactText(operation.tool_name ?? operation.source);
      addBranch(`file:${parentId}:${change.file_path}`, {
        parentId,
        kind: "file",
        title: fileName(change.file_path),
        detail,
        messageIndex: operation.message_index ?? null,
        timestamp: operation.timestamp ?? null,
        filePath: change.file_path,
        additions: operation.additions,
        deletions: operation.deletions,
      });
    }
  }

  const hasStructuredTools = (session.tool_events?.length ?? 0) > 0;
  const hasStructuredFiles = (session.file_changes?.some((change) => change.operations.length > 0) ?? false);
  for (const event of processModel.events) {
    const kind = branchKindFromEvent(event.kind);
    if (!kind) continue;
    if (kind === "tool" && hasStructuredTools) continue;
    if (kind === "file" && hasStructuredFiles) continue;
    const parentId = findParentId(event.messageIndex, turns);
    const keyPart = kind === "file" ? event.filePath ?? event.title : kind === "tool" ? event.toolName ?? event.title : kind;
    addBranch(`${kind}:${parentId}:${keyPart}`, {
      parentId,
      kind,
      title: kind === "file" && event.filePath ? fileName(event.filePath) : kind === "tool" ? event.toolName ?? event.title : branchTitle(kind, t),
      detail: event.detail,
      messageIndex: event.messageIndex,
      timestamp: event.timestamp,
      filePath: event.filePath,
    });
  }

  const kindOrder: Record<BranchDraft["kind"], number> = { tool: 0, subtask: 1, file: 2, test: 3, error: 4 };
  const branchesByParent = new Map<string, BranchDraft[]>();
  for (const draft of drafts.values()) {
    const group = branchesByParent.get(draft.parentId) ?? [];
    group.push(draft);
    branchesByParent.set(draft.parentId, group);
  }
  for (const group of branchesByParent.values()) {
    group.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.title.localeCompare(b.title));
  }

  let maxTopBranches = 0;
  let maxBottomBranches = 0;
  for (const group of branchesByParent.values()) {
    maxTopBranches = Math.max(maxTopBranches, group.filter((item) => item.kind === "tool" || item.kind === "subtask").length);
    maxBottomBranches = Math.max(maxBottomBranches, group.filter((item) => item.kind !== "tool" && item.kind !== "subtask").length);
  }
  const mainY = SCENE_PADDING + maxTopBranches * (BRANCH_NODE_HEIGHT + BRANCH_NODE_GAP) + BRANCH_OFFSET;

  mainNodes.forEach((node, index) => {
    node.x = SCENE_PADDING + index * (MAIN_NODE_WIDTH + MAIN_NODE_GAP);
    node.y = mainY;
  });

  const positionedBranches: SessionCanvasNode[] = [];
  for (const parent of mainNodes) {
    const group = branchesByParent.get(parent.id) ?? [];
    const top = group.filter((item) => item.kind === "tool" || item.kind === "subtask");
    const bottom = group.filter((item) => item.kind !== "tool" && item.kind !== "subtask");
    const positionGroup = (items: BranchDraft[], above: boolean) => {
      items.forEach((draft, index) => {
        const summary = draft.kind === "file"
          ? t("history.canvas.fileSummary", { count: draft.count, additions: draft.additions, deletions: draft.deletions })
          : t("history.canvas.groupSummary", { count: draft.count });
        positionedBranches.push({
          ...draft,
          summary,
          totalTokens: 0,
          x: parent.x + (MAIN_NODE_WIDTH - BRANCH_NODE_WIDTH) / 2,
          y: above
            ? parent.y - BRANCH_OFFSET - BRANCH_NODE_HEIGHT - index * (BRANCH_NODE_HEIGHT + BRANCH_NODE_GAP)
            : parent.y + MAIN_NODE_HEIGHT + BRANCH_OFFSET + index * (BRANCH_NODE_HEIGHT + BRANCH_NODE_GAP),
          width: BRANCH_NODE_WIDTH,
          height: BRANCH_NODE_HEIGHT,
        });
      });
    };
    positionGroup(top, true);
    positionGroup(bottom, false);
  }

  const edges: SessionCanvasEdge[] = [];
  for (let index = 1; index < mainNodes.length; index += 1) {
    edges.push({ id: `main-${index}`, source: mainNodes[index - 1].id, target: mainNodes[index].id, kind: "main" });
  }
  for (const node of positionedBranches) {
    edges.push({ id: `edge-${node.id}`, source: node.parentId!, target: node.id, kind: "branch" });
  }

  return {
    nodes: [...mainNodes, ...positionedBranches],
    edges,
    turnCount: turns.length,
    branchCount: positionedBranches.length,
  };
}
