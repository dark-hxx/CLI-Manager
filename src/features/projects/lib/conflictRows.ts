import type { ConflictBlock, ConflictDetail } from "./conflictProtocol";

export type ConflictRow =
  | { kind: "context"; key: string; left: string; right: string; leftNumber: number; rightNumber: number }
  | { kind: "code"; key: string; left: string; right: string; leftNumber: number | null; rightNumber: number | null; blockId: string }
  | { kind: "control"; key: string; block: ConflictBlock };

function lines(text: string): string[] {
  if (!text) return [];
  const result = text.split(/\r?\n/);
  if (result[result.length - 1] === "") result.pop();
  return result;
}

/** Rust offsets are UTF-8 bytes, not JS UTF-16 indices (BOM/non-ASCII must survive). */
export function buildConflictRows(detail: ConflictDetail): ConflictRow[] {
  if (detail.capability !== "blocks" || detail.source === null) return [];
  const bytes = new TextEncoder().encode(detail.source);
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const rows: ConflictRow[] = [];
  let cursor = 0;
  let leftNumber = 1;
  let rightNumber = 1;
  const context = (end: number) => {
    for (const [index, line] of lines(decoder.decode(bytes.subarray(cursor, end))).entries()) {
      rows.push({ kind: "context", key: `context-${cursor}-${index}`, left: line, right: line, leftNumber: leftNumber++, rightNumber: rightNumber++ });
    }
  };
  for (const block of detail.blocks) {
    context(block.start);
    rows.push({ kind: "control", key: block.id, block });
    const left = lines(block.base);
    const right = lines(block.worktree);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      rows.push({ kind: "code", key: `${block.id}-${index}`, blockId: block.id, left: left[index] ?? "", right: right[index] ?? "",
        leftNumber: index < left.length ? leftNumber++ : null, rightNumber: index < right.length ? rightNumber++ : null });
    }
    cursor = block.end;
  }
  context(bytes.length);
  return rows;
}
