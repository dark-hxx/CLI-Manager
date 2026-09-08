import { getMaterialFileIcon } from "@baybreezy/file-extension-icon";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CornerDownRight, GitCompareArrows, X } from "lucide-react";
import { createPatch } from "diff";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryFileChangeSummary, HistoryMessage } from "../../../shared/types/index";
import DiffWorker from "../lib/diffParser.worker.ts?worker";
import { isDiffCandidate, normalizeDiffForViewer, type ParsedDiffBlock } from "./diffParser";
import { useI18n } from "../../../shared/i18n/index";
import { GitDiffViewer } from "../../git/api/DiffViewerModal";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../../shared/ui/context-menu";
import { cn } from "../../../shared/lib/utils";

interface DiffModalProps {
  open: boolean;
  messages?: HistoryMessage[];
  fileChanges?: HistoryFileChangeSummary[] | null;
  container?: HTMLElement | null;
  onClose: () => void;
  onJumpToMessage?: (messageIndex: number) => void;
}

interface DiffRenderBlock {
  id: string;
  filePath: string;
  status: string;
  patch: string;
  messageIndex: number | null;
  timestamp: string | null;
}

const EMPTY_DIFF_MESSAGES: HistoryMessage[] = [];

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function createStructuredPatch(filePath: string, oldText: string | null, newText: string | null): string {
  return createPatch(filePath, oldText ?? "", newText ?? "", "", "");
}

function buildStructuredBlocks(fileChanges: HistoryFileChangeSummary[] | null | undefined): DiffRenderBlock[] {
  if (!fileChanges?.length) return [];
  return fileChanges.flatMap((fileChange, fileIndex) =>
    fileChange.operations.map((operation, operationIndex) => {
      const patch = operation.patch || createStructuredPatch(fileChange.file_path, operation.old_text ?? null, operation.new_text ?? null);
      return {
        id: `structured-${fileIndex}-${operationIndex}`,
        filePath: fileChange.file_path,
        status: fileChange.status,
        patch: normalizeDiffForViewer(fileChange.file_path, patch),
        messageIndex: operation.message_index ?? null,
        timestamp: operation.timestamp ?? fileChange.latest_timestamp ?? null,
      };
    })
  );
}

function fallbackBlocks(blocks: ParsedDiffBlock[]): DiffRenderBlock[] {
  return blocks.map((block) => ({
    ...block,
    status: "M",
    messageIndex: block.messageIndex ?? null,
    timestamp: block.timestamp ?? null,
  }));
}

export function DiffModal({
  open,
  messages = EMPTY_DIFF_MESSAGES,
  fileChanges,
  container,
  onClose,
  onJumpToMessage,
}: DiffModalProps) {
  const { t } = useI18n();
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const [blocks, setBlocks] = useState<DiffRenderBlock[]>([]);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const selectedBlock = useMemo(
    () => blocks.find((block) => block.id === selectedBlockId) ?? blocks[0] ?? null,
    [blocks, selectedBlockId]
  );
  const portalContainer = container ?? undefined;
  const positionClass = container ? "absolute inset-0" : "fixed inset-0";

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    const updateBlocks = (nextBlocks: DiffRenderBlock[]) => {
      setBlocks(nextBlocks);
      setSelectedBlockId((current) =>
        current && nextBlocks.some((block) => block.id === current) ? current : nextBlocks[0]?.id ?? null
      );
      setParsing(false);
    };

    const structuredBlocks = buildStructuredBlocks(fileChanges);
    if (structuredBlocks.length > 0) {
      updateBlocks(structuredBlocks);
      return;
    }

    if (!workerRef.current) workerRef.current = new DiffWorker();
    const worker = workerRef.current;
    const requestId = ++requestIdRef.current;
    setParsing(true);

    const onMessage = (event: MessageEvent<{ id: number; blocks: ParsedDiffBlock[] }>) => {
      if (event.data.id !== requestId) return;
      updateBlocks(fallbackBlocks(event.data.blocks));
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({
      id: requestId,
      messages: messages.flatMap((message, index) =>
        isDiffCandidate(message.content)
          ? [{ content: message.content, timestamp: message.timestamp ?? null, messageIndex: index }]
          : []
      ),
    });

    return () => worker.removeEventListener("message", onMessage);
  }, [open, fileChanges, messages]);

  const jumpToMessage = (messageIndex: number | null) => {
    if (messageIndex === null || !onJumpToMessage) return;
    onJumpToMessage(messageIndex);
    onClose();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal container={portalContainer}>
        <DialogPrimitive.Overlay className={cn(positionClass, "bg-black/45")} style={{ zIndex: 56 }} />
        <DialogPrimitive.Content
          className={cn(positionClass, "flex items-center justify-center p-4 outline-none")}
          style={{ zIndex: 57 }}
        >
          <DialogPrimitive.Title className="sr-only">{t("history.diff.title")}</DialogPrimitive.Title>
          <div className="flex h-[min(84vh,780px)] w-full max-w-6xl overflow-hidden rounded-lg border border-border bg-surface">
            {parsing || !selectedBlock ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                    <GitCompareArrows size={15} />
                    {t("history.diff.title")}
                  </div>
                  <DialogPrimitive.Close
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-secondary"
                    title={t("common.close")}
                    aria-label={t("common.close")}
                  >
                    <X size={14} />
                  </DialogPrimitive.Close>
                </div>
                <div className="flex flex-1 items-center justify-center text-xs text-text-muted">
                  {parsing ? t("history.diff.parsing") : t("history.diff.empty")}
                </div>
              </div>
            ) : (
              <>
                {blocks.length > 1 && (
                  <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface-container-low">
                    <div className="border-b border-border px-3 py-2 text-xs font-semibold text-text-primary">
                      {t("history.diff.title")}
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-2 ui-thin-scroll">
                      {blocks.map((block) => (
                        <ContextMenu key={block.id}>
                          <ContextMenuTrigger asChild>
                            <button
                              type="button"
                              className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-[var(--interactive-hover-bg)] data-[selected=true]:bg-[var(--interactive-selected-bg)]"
                              data-selected={selectedBlock.id === block.id ? "true" : "false"}
                              onClick={() => setSelectedBlockId(block.id)}
                            >
                              <img
                                src={getMaterialFileIcon(fileName(block.filePath))}
                                alt=""
                                width={16}
                                height={16}
                                draggable={false}
                              />
                              <span className="min-w-0 flex-1 truncate text-text-primary" title={block.filePath}>
                                {block.filePath}
                              </span>
                            </button>
                          </ContextMenuTrigger>
                          <ContextMenuContent className="file-explorer-menu">
                            <ContextMenuItem
                              disabled={block.messageIndex === null || !onJumpToMessage}
                              onSelect={() => jumpToMessage(block.messageIndex)}
                            >
                              <CornerDownRight size={13} />
                              {t("history.files.jumpToConversation")}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      ))}
                    </div>
                  </aside>
                )}
                <div className="min-w-0 flex-1">
                  <GitDiffViewer
                    filePath={selectedBlock.filePath}
                    fileName={fileName(selectedBlock.filePath)}
                    status={selectedBlock.status}
                    diffText={selectedBlock.patch}
                    onClose={onClose}
                  />
                </div>
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
