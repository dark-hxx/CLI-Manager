import { useMemo, type ReactNode } from "react";
import { FileCode2, GitCompareArrows, X } from "lucide-react";
import type { HistoryMessage } from "../../lib/types";

interface DiffModalProps {
  open: boolean;
  messages: HistoryMessage[];
  onClose: () => void;
  onJumpToMessage: (messageIndex: number) => void;
}

interface DiffBlock {
  id: string;
  filePath: string;
  patch: string;
  messageIndex: number;
  timestamp: string | null;
}

interface LineTheme {
  color: string;
  backgroundColor: string;
}

const THEME_DEFAULT: LineTheme = {
  color: "var(--text-primary)",
  backgroundColor: "transparent",
};
const THEME_ADD: LineTheme = {
  color: "var(--success)",
  backgroundColor: "rgba(16, 185, 129, 0.1)",
};
const THEME_DELETE: LineTheme = {
  color: "var(--danger)",
  backgroundColor: "rgba(244, 63, 94, 0.1)",
};
const THEME_HUNK: LineTheme = {
  color: "#93c5fd",
  backgroundColor: "rgba(59, 130, 246, 0.12)",
};
const THEME_HEADER: LineTheme = {
  color: "var(--warning)",
  backgroundColor: "rgba(245, 158, 11, 0.1)",
};

function extractFilePath(diffText: string): string {
  const applyPatchHeader = diffText.match(/^\*\*\* (?:Update|Add|Delete) File:\s+([^\r\n]+)/m);
  if (applyPatchHeader) {
    return applyPatchHeader[1].trim();
  }
  const gitHeader = diffText.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (gitHeader) {
    return gitHeader[2];
  }
  const plusHeader = diffText.match(/^\+\+\+\s+(?:b\/)?([^\r\n]+)/m);
  if (plusHeader) {
    return plusHeader[1];
  }
  return "unknown-file";
}

function splitApplyPatchBlocks(content: string): string[] {
  const segments: string[] = [];
  const byEnvelope = content.match(/\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/g);
  if (!byEnvelope) {
    return segments;
  }

  for (const patch of byEnvelope) {
    const fileParts = patch
      .split(/(?=^\*\*\* (?:Update|Add|Delete) File:\s+)/m)
      .map((item) => item.trim())
      .filter((item) => item.length > 0 && /^\*\*\* (?:Update|Add|Delete) File:\s+/m.test(item));
    if (fileParts.length > 0) {
      segments.push(...fileParts);
    } else {
      segments.push(patch.trim());
    }
  }
  return segments;
}

function splitDiffBlocks(content: string): string[] {
  const chunks: string[] = [];
  const fenced = /```(?:diff|patch)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(content)) !== null) {
    const body = match[1]?.trim();
    if (body) {
      chunks.push(body);
    }
  }
  if (content.includes("*** Begin Patch")) {
    chunks.push(...splitApplyPatchBlocks(content));
  }

  if (content.includes("diff --git")) {
    chunks.push(content);
  } else if (chunks.length === 0 && content.includes("@@") && content.includes("+++")) {
    chunks.push(content);
  }

  const blocks: string[] = [];
  for (const chunk of chunks) {
    if (chunk.includes("diff --git")) {
      const parts = chunk
        .split(/(?=^diff --git )/m)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      blocks.push(...parts);
      continue;
    }
    blocks.push(chunk.trim());
  }

  return blocks.filter((item) => {
    const isUnified =
      item.includes("@@") && (item.includes("+++ ") || item.includes("diff --git"));
    const isApplyPatch = /^\*\*\* (?:Update|Add|Delete) File:\s+/m.test(item);
    return isUnified || isApplyPatch;
  });
}

function classifyLineTheme(line: string): LineTheme {
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
    return THEME_HEADER;
  }
  if (line.startsWith("@@")) {
    return THEME_HUNK;
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return THEME_ADD;
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return THEME_DELETE;
  }
  return THEME_DEFAULT;
}

function renderHighlightedPatch(patch: string): ReactNode {
  const lines = patch.split("\n");
  return lines.map((line, index) => {
    const theme = classifyLineTheme(line);
    return (
      <span
        key={`${line}-${index}`}
        style={{
          display: "block",
          width: "max-content",
          minWidth: "100%",
          color: theme.color,
          backgroundColor: theme.backgroundColor,
          paddingLeft: "0.25rem",
          paddingRight: "0.25rem",
        }}
      >
        {line || " "}
      </span>
    );
  });
}

function DiffCodeViewer({ patch }: { patch: string }) {
  return (
    <div className="mt-2">
      <div
        className="rounded-md border overflow-x-scroll overflow-y-hidden max-w-full diff-code-scroll"
        style={{
          borderColor: "var(--border)",
          backgroundColor: "var(--bg-secondary)",
          scrollbarGutter: "stable both-edges",
        }}
      >
        <pre
          className="text-xs whitespace-pre m-0 p-2 min-w-max font-mono leading-5 diff-code-inner"
          style={{ color: "var(--text-primary)" }}
        >
          {renderHighlightedPatch(patch)}
        </pre>
      </div>
    </div>
  );
}

function parseDiffs(messages: HistoryMessage[]): DiffBlock[] {
  const result: DiffBlock[] = [];
  messages.forEach((msg, index) => {
    const content = msg.content?.trim();
    if (!content) return;
    const blocks = splitDiffBlocks(content);
    blocks.forEach((patch, seq) => {
      result.push({
        id: `${index}-${seq}`,
        filePath: extractFilePath(patch),
        patch,
        messageIndex: index,
        timestamp: msg.timestamp ?? null,
      });
    });
  });
  return result;
}

export function DiffModal({ open, messages, onClose, onJumpToMessage }: DiffModalProps) {
  const blocks = useMemo(() => parseDiffs(messages), [messages]);

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 56, backgroundColor: "rgba(0, 0, 0, 0.45)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-5xl h-[min(84vh,780px)] rounded-lg border overflow-hidden flex flex-col"
        style={{ borderColor: "var(--border)", backgroundColor: "var(--bg-primary)" }}
      >
        <div
          className="px-3 py-2 border-b flex items-center justify-between"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            <GitCompareArrows size={15} />
            Diff 视图
          </div>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md border w-7 h-7"
            style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
            title="关闭"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          {blocks.length === 0 && (
            <div className="px-3 py-6 text-xs text-center" style={{ color: "var(--text-muted)" }}>
              当前会话暂未解析到 unified diff
            </div>
          )}

          {blocks.map((block) => (
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
                    来自消息 #{block.messageIndex + 1} · {block.timestamp ?? "-"}
                  </div>
                </div>
                <button
                  onClick={() => {
                    onJumpToMessage(block.messageIndex);
                    onClose();
                  }}
                  className="text-xs px-2 py-1 rounded-md shrink-0"
                  style={{ backgroundColor: "var(--accent)", color: "#fff" }}
                >
                  跳回消息
                </button>
              </div>
              <DiffCodeViewer patch={block.patch} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
