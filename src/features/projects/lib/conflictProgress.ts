import type { ConflictDetail, ConflictEntry } from "./conflictProtocol";

/** Block choices are drafts; only the backend can confirm a file as resolved. */
export function conflictChoiceProgress(detail: ConflictDetail | null) {
  const blocks = detail?.capability === "blocks" ? detail.blocks : [];
  const chosen = blocks.filter((block) => detail?.draft.choices[block.id]).length;
  return { chosen, total: blocks.length, complete: blocks.length > 0 && chosen === blocks.length };
}

export function conflictFileState(file: ConflictEntry, detail: ConflictDetail | null) {
  if (file.resolved) return "resolved";
  if (detail?.fileId === file.fileId && conflictChoiceProgress(detail).complete) return "pendingConfirmation";
  return "unconfirmed";
}
