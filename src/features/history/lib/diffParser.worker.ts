/// <reference lib="webworker" />

import { parseDiffBlocks, type DiffMessageInput, type ParsedDiffBlock } from "../api/diffParser";

interface RequestPayload {
  id: number;
  messages: DiffMessageInput[];
}

self.onmessage = (event: MessageEvent<RequestPayload>) => {
  const { id, messages } = event.data;
  const blocks: ParsedDiffBlock[] = parseDiffBlocks(messages);
  (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, blocks });
};
