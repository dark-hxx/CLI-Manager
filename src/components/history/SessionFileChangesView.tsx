import { getMaterialFileIcon } from "@baybreezy/file-extension-icon";
import { Clock3, CornerDownRight } from "lucide-react";
import { useMemo } from "react";
import { useI18n } from "../../lib/i18n";
import { sortHistoryItems, type HistoryDetailSortDirection } from "../../lib/historySort";
import type { HistoryFileChangeOperation, HistoryFileChangeSummary } from "../../lib/types";
import { formatTime } from "./historyViewUtils";
import type { SessionProcessModel } from "./sessionEvents";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu";

interface SessionFileChangesViewProps {
  fileChanges?: HistoryFileChangeSummary[];
  model: SessionProcessModel;
  direction: HistoryDetailSortDirection;
  onOpenDiff: (fileChanges?: HistoryFileChangeSummary[]) => void;
  onJumpToMessage: (messageIndex: number) => void;
}

interface ChangeOperationEntry {
  operation: HistoryFileChangeOperation;
  status: string;
  order: number;
}

interface ChangeNode {
  id: string;
  timestamp: string | null;
  messageIndex: number | null;
  files: HistoryFileChangeSummary[];
}

const EMPTY_FILE_CHANGES: HistoryFileChangeSummary[] = [];

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function fileChangeKind(status: string): "added" | "modified" | "deleted" {
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  return "modified";
}

function operationStatus(operation: HistoryFileChangeOperation): string {
  const patch = operation.patch ?? "";
  if (patch.includes("*** Add File:") || /^--- \/dev\/null$/m.test(patch)) return "A";
  if (patch.includes("*** Delete File:") || /^\+\+\+ \/dev\/null$/m.test(patch)) return "D";
  if (!operation.old_text && operation.new_text) return "A";
  if (operation.old_text && !operation.new_text) return "D";
  return "M";
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function compareNullableNumber(left: number | null | undefined, right: number | null | undefined): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  return left - right;
}

function compareOperations(left: ChangeOperationEntry, right: ChangeOperationEntry): number {
  const groupOrder = compareNullableNumber(
    left.operation.operation_group_index,
    right.operation.operation_group_index
  );
  if (groupOrder !== 0) return groupOrder;

  const messageOrder = compareNullableNumber(left.operation.message_index, right.operation.message_index);
  if (messageOrder !== 0) return messageOrder;

  const leftTime = Date.parse(left.operation.timestamp ?? "");
  const rightTime = Date.parse(right.operation.timestamp ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.order - right.order;
}

function changeNodeKey(operation: HistoryFileChangeOperation, fallbackOrder: number): string {
  if (operation.operation_group_index !== null && operation.operation_group_index !== undefined) {
    return `group:${operation.operation_group_index}`;
  }
  if (operation.timestamp) return `time:${operation.timestamp}`;
  if (operation.message_index !== null && operation.message_index !== undefined) {
    return `message:${operation.message_index}`;
  }
  return `operation:${fallbackOrder}`;
}

function buildChangeNodes(entries: ChangeOperationEntry[]): ChangeNode[] {
  const nodes = new Map<string, { node: ChangeNode; files: Map<string, HistoryFileChangeSummary> }>();

  for (const entry of [...entries].sort(compareOperations)) {
    const { operation } = entry;
    const nodeKey = changeNodeKey(operation, entry.order);
    let nodeEntry = nodes.get(nodeKey);
    if (!nodeEntry) {
      nodeEntry = {
        node: {
          id: nodeKey,
          timestamp: operation.timestamp ?? null,
          messageIndex: operation.message_index ?? null,
          files: [],
        },
        files: new Map(),
      };
      nodes.set(nodeKey, nodeEntry);
    }

    const existing = nodeEntry.files.get(operation.file_path);
    if (existing) {
      existing.additions += operation.additions;
      existing.deletions += operation.deletions;
      existing.operations.push(operation);
      continue;
    }

    nodeEntry.files.set(operation.file_path, {
      file_path: operation.file_path,
      status: entry.status,
      additions: operation.additions,
      deletions: operation.deletions,
      latest_message_index: operation.message_index ?? null,
      latest_operation_group_index: operation.operation_group_index ?? null,
      latest_timestamp: operation.timestamp ?? null,
      operations: [operation],
    });
  }

  return Array.from(nodes.values()).map(({ node, files }) => ({
    ...node,
    files: Array.from(files.values()).sort((left, right) => left.file_path.localeCompare(right.file_path)),
  }));
}

function structuredOperationEntries(fileChanges: HistoryFileChangeSummary[]): ChangeOperationEntry[] {
  let order = 0;
  return fileChanges.flatMap((fileChange) =>
    fileChange.operations.map((operation) => ({
      operation,
      status: operationStatus(operation),
      order: order++,
    }))
  );
}

function fallbackOperationEntries(model: SessionProcessModel): ChangeOperationEntry[] {
  return model.diffBlocks.map((block, order) => {
    const changes = countPatchLines(block.patch);
    const operation: HistoryFileChangeOperation = {
      source: "message_diff",
      tool_name: null,
      file_path: block.filePath,
      old_text: null,
      new_text: null,
      patch: block.patch,
      additions: changes.additions,
      deletions: changes.deletions,
      message_index: block.messageIndex,
      operation_group_index: null,
      timestamp: block.timestamp ?? null,
    };
    return {
      operation,
      status: operationStatus(operation),
      order,
    };
  });
}

export function SessionFileChangesView({
  fileChanges = EMPTY_FILE_CHANGES,
  model,
  direction,
  onOpenDiff,
  onJumpToMessage,
}: SessionFileChangesViewProps) {
  const { t, language } = useI18n();
  const changeNodes = useMemo(() => {
    const structured = structuredOperationEntries(fileChanges);
    return sortHistoryItems(
      buildChangeNodes(structured.length > 0 ? structured : fallbackOperationEntries(model)),
      direction,
    );
  }, [direction, fileChanges, model]);
  const allFileChanges = useMemo(() => changeNodes.flatMap((node) => node.files), [changeNodes]);
  const fileCount = useMemo(
    () => new Set(changeNodes.flatMap((node) => node.files.map((file) => file.file_path))).size,
    [changeNodes]
  );

  if (changeNodes.length === 0) {
    return <div className="ui-session-process-empty">{t("history.files.empty")}</div>;
  }

  return (
    <div className="ui-session-process-view">
      <div className="ui-session-process-toolbar">
        <div className="ui-session-process-summary">
          <span>{t("history.files.fileCount", { count: fileCount })}</span>
          <span>{t("history.files.changeRecordCount", { count: changeNodes.length })}</span>
        </div>
        <button type="button" className="ui-session-process-primary" onClick={() => onOpenDiff(allFileChanges)}>
          {t("history.files.openDiff")}
        </button>
      </div>

      <div className="ui-session-change-list">
        {changeNodes.map((node) => {
          const parsedTimestamp = Date.parse(node.timestamp ?? "");
          const hasTimestamp = Number.isFinite(parsedTimestamp);
          const timeLabel = hasTimestamp
            ? formatTime(parsedTimestamp, language)
            : node.messageIndex !== null
              ? t("history.files.messageRef", { index: node.messageIndex + 1 })
              : "-";
          return (
            <section key={node.id} className="ui-session-change-node">
              <span className="ui-session-change-marker" aria-hidden="true">
                <Clock3 size={13} />
              </span>
              <div className="ui-session-change-content">
                <div className="ui-session-change-header">
                  <time dateTime={node.timestamp ?? undefined}>{timeLabel}</time>
                  {hasTimestamp && node.messageIndex !== null && (
                    <small>{t("history.files.messageRef", { index: node.messageIndex + 1 })}</small>
                  )}
                </div>
                <div className="ui-session-change-files">
                  {node.files.map((fileChange) => {
                    const messageIndex = fileChange.latest_message_index ?? null;
                    const changeKind = fileChangeKind(fileChange.status);
                    return (
                      <ContextMenu key={fileChange.file_path}>
                        <ContextMenuTrigger asChild>
                          <button
                            type="button"
                            className="ui-session-change-file"
                            onClick={() => onOpenDiff([fileChange])}
                            aria-label={t("history.files.openFileDiff", { path: fileChange.file_path })}
                          >
                            <span className="ui-session-change-file-main" title={fileChange.file_path}>
                              <img
                                src={getMaterialFileIcon(fileName(fileChange.file_path))}
                                alt=""
                                width={16}
                                height={16}
                                draggable={false}
                              />
                              <b>{fileChange.file_path}</b>
                              <span className="ui-session-change-status" data-status={changeKind}>
                                {t(`history.files.status.${changeKind}`)}
                              </span>
                            </span>
                            <span className="ui-session-change-stats">
                              <span className="ui-session-change-additions">+{fileChange.additions}</span>
                              <span className="ui-session-change-stats-separator">/</span>
                              <span className="ui-session-change-deletions">-{fileChange.deletions}</span>
                            </span>
                          </button>
                        </ContextMenuTrigger>
                        <ContextMenuContent className="file-explorer-menu">
                          <ContextMenuItem
                            disabled={messageIndex === null}
                            onSelect={() => messageIndex !== null && onJumpToMessage(messageIndex)}
                          >
                            <CornerDownRight size={13} />
                            {t("history.files.jumpToConversation")}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
