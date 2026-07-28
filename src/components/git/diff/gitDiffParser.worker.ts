/// <reference lib="webworker" />

import {
  parseGitDiffFile,
  type GitDiffParserRequest,
  type GitDiffParserResponse,
} from "./gitDiffParser";

self.onmessage = (event: MessageEvent<GitDiffParserRequest>) => {
  const { generation, content } = event.data;
  let response: GitDiffParserResponse;
  try {
    response = { generation, file: parseGitDiffFile(content), failed: false };
  } catch {
    response = { generation, file: null, failed: true };
  }
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
};
