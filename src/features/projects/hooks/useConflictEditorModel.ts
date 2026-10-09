import { useEffect, useRef, useState } from 'react';
import type { ConflictDetail } from '../lib/conflictProtocol';
import type { ConflictEditorModel } from '../lib/conflictEditorModel';

interface ModelState {
  identity: string;
  source: string | null;
  model: ConflictEditorModel | null;
  failed: boolean;
}

/** One worker per immutable source, terminated on completion, failure or departure.
 * Rust derives blocks from source + marker size; a draft-only refetch must reuse
 * the model even though IPC gives its blocks array a new reference. */
export function useConflictEditorModel(detail: ConflictDetail) {
  const identity = JSON.stringify([detail.fileId, detail.draft.sourceHash, detail.capability, detail.markerSize]);
  const source = detail.source;
  const latest = useRef(detail);
  latest.current = detail;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ModelState | null>(null);
  useEffect(() => {
    let active = true;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (model: ConflictEditorModel | null) => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      worker?.terminate();
      setState({ identity, source, model, failed: model === null });
    };
    setState(null);
    try {
      worker = new Worker(new URL('../lib/conflictEditor.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<ConflictEditorModel>) => finish(event.data);
      worker.onerror = () => finish(null);
      worker.onmessageerror = () => finish(null);
      timer = setTimeout(() => finish(null), 15000);
      // Never send manually edited draft text to an immutable source worker.
      const current = latest.current;
      worker.postMessage({ ...current, draft: { ...current.draft, choices: {} } });
    } catch { finish(null); }
    return () => { active = false; clearTimeout(timer); worker?.terminate(); };
  }, [identity, source, attempt]);
  const current = state?.identity === identity && state.source === source ? state : null;
  return { model: current?.model ?? null, failed: current?.failed ?? false, retry: () => setAttempt((value) => value + 1) };
}
