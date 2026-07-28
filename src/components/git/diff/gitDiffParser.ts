import { parseDiff, type FileData } from "react-diff-view";

export interface GitDiffParserRequest {
  generation: number;
  content: string;
}

export interface GitDiffParserResponse {
  generation: number;
  file: FileData | null;
  failed: boolean;
}

export function parseGitDiffFile(content: string): FileData | null {
  if (!content) return null;
  return parseDiff(content)[0] ?? null;
}
