/** IPC contract: semantic sides must not be inferred from marker order. */
export interface ConflictContext {
  projectPath: string; worktreePath: string; worktreeBranch: string; baseBranch: string;
}
export type ConflictState = "preparing" | "resolving" | "ready" | "committing" | "completed" | "aborting" | "aborted" | "recovery_required";
export type ConflictSide = "base_branch" | "worktree";
export type ConflictChoice = { kind: ConflictSide | "both" } | { kind: "edited"; text: string };
export interface ConflictSnapshot {
  sessionId: string; revision: number; state: ConflictState; worktreeBranch: string; baseBranch: string;
  headOid: string; baseOid: string; total: number; resolved: number; unresolved: number; draftCount: number; listSnapshotId: string;
}
export interface ConflictEntry {
  fileId: string; displayPath: string; stages: { oid: string; mode: number; stage: number }[];
  capability: string; reason: string | null; resolved: boolean;
}
export interface ConflictBlock { id: string; start: number; end: number; base: string; worktree: string; ancestor: string | null }
export interface ConflictDraft { revision: number; choices: Record<string, ConflictChoice>; sourceHash: string; operationId: string; payloadHash: string }
export interface ConflictDetail {
  fileId: string; version: string; capability: string; reason: string | null; source: string | null;
  blocks: ConflictBlock[]; draft: ConflictDraft; baseExists: boolean; worktreeExists: boolean; markerSize: number;
}
export interface ConflictPage { snapshot: ConflictSnapshot; files: ConflictEntry[]; nextCursor: number | null }
export interface ConflictError { code: string; detail: string }
export type ConflictProbe =
  | { kind: "none"; headOid: string; baseOid: string }
  | { kind: "managed"; snapshot: ConflictSnapshot }
  | { kind: "foreign"; error: ConflictError }
  | { kind: "recovery"; snapshot: ConflictSnapshot | null; error: ConflictError };
export type ConflictInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
export function conflictErrorText(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && "detail" in error) return `${error.code}: ${error.detail}`;
  return error instanceof Error ? error.message : String(error);
}
export function isConflictTerminal(snapshot: ConflictSnapshot | null): boolean {
  return snapshot?.state === "completed" || snapshot?.state === "aborted";
}
