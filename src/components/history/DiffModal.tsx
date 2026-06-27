import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Diff, Hunk, parseDiff, type FileData } from "react-diff-view";
import { createPatch } from "diff";
import "react-diff-view/style/index.css";
import { FileCode2, GitCompareArrows, X } from "lucide-react";
import type { HistoryFileChangeSummary, HistoryMessage } from "../../lib/types";
import DiffWorker from "../../lib/diffParser.worker.ts?worker";
import { isDiffCandidate, type ParsedDiffBlock } from "../../lib/diffParser";
import { useI18n } from "../../lib/i18n";
import { cn } from "@/lib/utils";

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
  patch: string;
  messageIndex: number | null;
  timestamp: string | null;
}

function classifyFallbackLine(line: string): string {
  if (
    line.startsWith("*** Begin Patch") ||
    line.startsWith("*** End Patch") ||
    line.startsWith("*** Update File:") ||
    line.startsWith("*** Add File:") ||
    line.startsWith("*** Delete File:") ||
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return "history-diff-fallback-header";
  }
  if (line.startsWith("@@")) return "history-diff-fallback-hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "history-diff-fallback-add";
  if (line.startsWith("-") && !line.startsWith("---")) return "history-diff-fallback-delete";
  return "history-diff-fallback-line";
}

function renderHighlightedPatch(patch: string): ReactNode {
  return patch.split("\n").map((line, index) => (
    <span key={index} className={classifyFallbackLine(line)}>
      {line || " "}
    </span>
  ));
}

const FallbackDiffViewer = memo(function FallbackDiffViewer({ patch }: { patch: string }) {
  return (
    <div className="mt-2 rounded-md border border-border bg-bg-secondary overflow-x-scroll overflow-y-hidden max-w-full diff-code-scroll">
      <pre className="text-xs whitespace-pre m-0 p-2 min-w-max font-mono leading-5 diff-code-inner text-text-primary">
        {renderHighlightedPatch(patch)}
      </pre>
    </div>
  );
});

function parseBlockFiles(patch: string): FileData[] {
  if (!patch.includes("diff --git") && !patch.includes("--- ")) return [];
  try {
    return parseDiff(patch, { nearbySequences: "zip" });
  } catch {
    return [];
  }
}

function countChanges(files: FileData[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "insert") additions += 1;
        if (change.type === "delete") deletions += 1;
      }
    }
  }
  return { additions, deletions };
}

function DiffBlockViewer({ block }: { block: DiffRenderBlock }) {
  const files = useMemo(() => parseBlockFiles(block.patch), [block.patch]);
  const changes = useMemo(() => countChanges(files), [files]);

  if (files.length === 0) {
    return <FallbackDiffViewer patch={block.patch} />;
  }

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
        <span className="rounded bg-success/10 px-1.5 py-0.5 text-success">+{changes.additions}</span>
        <span className="rounded bg-danger/10 px-1.5 py-0.5 text-danger">-{changes.deletions}</span>
      </div>
      {files.map((file, index) => (
        <div key={`${file.oldPath ?? "old"}-${file.newPath ?? "new"}-${index}`} className="history-diff-viewer rounded-md border border-border overflow-x-auto diff-code-scroll">
          <Diff
            viewType="split"
            diffType={file.type}
            hunks={file.hunks}
            gutterType="default"
            optimizeSelection
          >
            {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
          </Diff>
        </div>
      ))}
    </div>
  );
}

function createStructuredPatch(filePath: string, oldText: string | null, newText: string | null): string {
  return createPatch(filePath, oldText ?? "", newText ?? "", "", "");
}

function buildStructuredBlocks(fileChanges: HistoryFileChangeSummary[] | null | undefined): DiffRenderBlock[] {
  if (!fileChanges?.length) return [];
  return fileChanges.flatMap((fileChange, fileIndex) =>
    fileChange.operations.map((operation, operationIndex) => ({
      id: `structured-${fileIndex}-${operationIndex}`,
      filePath: fileChange.file_path,
      patch: operation.patch || createStructuredPatch(fileChange.file_path, operation.old_text ?? null, operation.new_text ?? null),
      messageIndex: operation.message_index ?? null,
      timestamp: operation.timestamp ?? fileChange.latest_timestamp ?? null,
    }))
  );
}

export function DiffModal({
  open,
  messages = [],
  fileChanges,
  container,
  onClose,
  onJumpToMessage,
}: DiffModalProps) {
  const { t } = useI18n();
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const [blocks, setBlocks] = useState<DiffRenderBlock[]>([]);
  const [parsing, setParsing] = useState(false);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    const structuredBlocks = buildStructuredBlocks(fileChanges);
    if (structuredBlocks.length > 0) {
      setBlocks(structuredBlocks);
      setParsing(false);
      return;
    }

    if (!workerRef.current) {
      workerRef.current = new DiffWorker();
    }
    const worker = workerRef.current;
    const requestId = ++requestIdRef.current;
    setParsing(true);

    const onMessage = (event: MessageEvent<{ id: number; blocks: ParsedDiffBlock[] }>) => {
      if (event.data.id !== requestId) return;
      setBlocks(event.data.blocks);
      setParsing(false);
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({
      id: requestId,
      messages: messages.flatMap((m, index) =>
        isDiffCandidate(m.content) ? [{ content: m.content, timestamp: m.timestamp ?? null, messageIndex: index }] : []
      ),
    });

    return () => {
      worker.removeEventListener("message", onMessage);
    };
  }, [open, fileChanges, messages]);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Overlay
          className={cn(
            "absolute inset-0 bg-black/45",
            "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out"
          )}
          style={{ zIndex: 56 }}
        />
        <DialogPrimitive.Content
          className={cn(
            "absolute inset-0 flex items-center justify-center p-4 outline-none",
            "data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
          )}
          style={{ zIndex: 56 }}
        >
          <div
            className="w-full max-w-6xl h-[min(84vh,780px)] rounded-lg border overflow-hidden flex flex-col"
            style={{ borderColor: "var(--border)", backgroundColor: "var(--bg-primary)" }}
          >
            <div
              className="px-3 py-2 border-b flex items-center justify-between"
              style={{ borderColor: "var(--border)" }}
            >
              <DialogPrimitive.Title
                className="inline-flex items-center gap-1.5 text-sm font-semibold"
                style={{ color: "var(--text-primary)" }}
              >
                <GitCompareArrows size={15} />
                {t("history.diff.title")}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close
                className="inline-flex items-center justify-center rounded-md border w-7 h-7"
                style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
                title={t("common.close")}
                aria-label={t("common.close")}
              >
                <X size={14} />
              </DialogPrimitive.Close>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
              {parsing && (
                <div className="px-3 py-6 text-xs text-center" style={{ color: "var(--text-muted)" }}>
                  {t("history.diff.parsing")}
                </div>
              )}

              {!parsing && blocks.length === 0 && (
                <div className="px-3 py-6 text-xs text-center" style={{ color: "var(--text-muted)" }}>
                  {t("history.diff.empty")}
                </div>
              )}

              {!parsing &&
                blocks.map((block) => (
                  <div
                    key={block.id}
                    className="px-3 py-3 border-b min-w-0"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                          <FileCode2 size={12} />
                          <span className="truncate">{block.filePath}</span>
                        </div>
                        <div className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                          {block.messageIndex !== null
                            ? t("history.diff.fromMessage", { index: block.messageIndex + 1 })
                            : block.timestamp ?? "-"}
                          {block.messageIndex !== null && block.timestamp ? ` · ${block.timestamp}` : ""}
                        </div>
                      </div>
                      {block.messageIndex !== null && onJumpToMessage && (
                        <button
                          onClick={() => {
                            onJumpToMessage(block.messageIndex as number);
                            onClose();
                          }}
                          className="text-xs px-2 py-1 rounded-md shrink-0"
                          style={{ backgroundColor: "var(--accent)", color: "#fff" }}
                        >
                          {t("history.diff.jumpBack")}
                        </button>
                      )}
                    </div>
                    <DiffBlockViewer block={block} />
                  </div>
                ))}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
