export const GIT_DIFF_WORKER_THRESHOLD_BYTES = 64 * 1024;
export const GIT_DIFF_HIGHLIGHT_MAX_BYTES = 256 * 1024;
export const GIT_DIFF_HIGHLIGHT_MAX_LINES = 5_000;
export const GIT_DIFF_MAX_BYTES = 768 * 1024;
export const GIT_DIFF_MAX_LINES = 20_000;

export interface GitDiffMetadata {
  byteLength: number;
  lineCount: number;
}

export interface GitDiffWirePayload {
  content: string;
  canRevertHunks: boolean;
  byteLength?: number;
  lineCount?: number;
}

export interface NormalizedGitDiffPayload extends GitDiffMetadata {
  content: string;
  canRevertHunks: boolean;
}

export function getGitDiffByteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

export function countGitDiffLines(content: string): number {
  if (content.length === 0) return 0;
  let count = content.endsWith("\n") ? 0 : 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function normalizeCount(value: number | undefined, fallback: () => number): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 0 ? value : fallback();
}

export function normalizeGitDiffPayload(
  payload: GitDiffWirePayload,
): NormalizedGitDiffPayload {
  const normalized = {
    content: payload.content,
    canRevertHunks: payload.canRevertHunks,
    byteLength: normalizeCount(payload.byteLength, () => getGitDiffByteLength(payload.content)),
    lineCount: normalizeCount(payload.lineCount, () => countGitDiffLines(payload.content)),
  };
  if (normalized.byteLength > GIT_DIFF_MAX_BYTES || normalized.lineCount > GIT_DIFF_MAX_LINES) {
    throw new Error("git_diff_too_large");
  }
  return normalized;
}

export function shouldParseGitDiffInWorker(byteLength: number): boolean {
  return byteLength > GIT_DIFF_WORKER_THRESHOLD_BYTES;
}

export function shouldHighlightGitDiff(metadata: GitDiffMetadata): boolean {
  return metadata.byteLength <= GIT_DIFF_HIGHLIGHT_MAX_BYTES
    && metadata.lineCount <= GIT_DIFF_HIGHLIGHT_MAX_LINES;
}
