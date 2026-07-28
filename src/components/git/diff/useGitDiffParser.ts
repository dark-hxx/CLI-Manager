import { useEffect, useMemo, useRef, useState } from "react";
import type { FileData } from "react-diff-view";
import { debugConsoleWarn } from "../../../lib/debugConsole";
import { shouldParseGitDiffInWorker } from "../../../lib/gitDiffLimits";
import {
  parseGitDiffFile,
  type GitDiffParserRequest,
  type GitDiffParserResponse,
} from "./gitDiffParser";

interface AsyncParseResult {
  source: string;
  file: FileData | null;
  workerFallback: boolean;
}

function parseWithoutWorker(content: string): FileData | null {
  try {
    return parseGitDiffFile(content);
  } catch (error) {
    debugConsoleWarn("[GitDiffViewer] Failed to parse diff:", error);
    return null;
  }
}

export function useGitDiffParser(content: string, byteLength: number) {
  const useWorker = shouldParseGitDiffInWorker(byteLength);
  const generationRef = useRef(0);
  const [asyncResult, setAsyncResult] = useState<AsyncParseResult>({
    source: "",
    file: null,
    workerFallback: false,
  });
  const synchronousFile = useMemo(
    () => useWorker ? null : parseWithoutWorker(content),
    [content, useWorker],
  );

  useEffect(() => {
    if (!content || !useWorker) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let worker: Worker | null = null;
    let settled = false;
    const fallback = (reason: unknown) => {
      if (settled || generationRef.current !== generation) return;
      settled = true;
      worker?.terminate();
      debugConsoleWarn("[GitDiffViewer] Diff parser worker failed; using main thread:", reason);
      setAsyncResult({
        source: content,
        file: parseWithoutWorker(content),
        workerFallback: true,
      });
    };

    try {
      worker = new Worker(new URL("./gitDiffParser.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<GitDiffParserResponse>) => {
        if (
          settled
          || event.data.generation !== generation
          || generationRef.current !== generation
        ) return;
        if (event.data.failed) fallback("worker_parse_failed");
        else {
          settled = true;
          worker?.terminate();
          setAsyncResult({ source: content, file: event.data.file, workerFallback: false });
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        fallback(event.message || "worker_error");
      };
      const request: GitDiffParserRequest = { generation, content };
      worker.postMessage(request);
    } catch (error) {
      fallback(error);
    }

    return () => {
      generationRef.current += 1;
      worker?.terminate();
    };
  }, [content, useWorker]);

  if (!content) return { file: null, parsing: false, workerFallback: false };
  if (!useWorker) return { file: synchronousFile, parsing: false, workerFallback: false };
  if (asyncResult.source === content) {
    return {
      file: asyncResult.file,
      parsing: false,
      workerFallback: asyncResult.workerFallback,
    };
  }
  return { file: null, parsing: true, workerFallback: false };
}
