import { useEffect, useId, useRef, useState } from "react";
import { completionToken, fileItems, fileReference, fileRequest, replaceCompletion, skillItems,
  type CompletionItem } from "./completion.ts";
import type { JsonObject, JsonValue } from "./protocol";
import type { TextKey } from "./i18n";
import type { InputKey } from "./input";

export type CompletionContext = {
  enabled: boolean; source: string; projectId: string; worktreeId?: string; sessionId?: string; capabilities: readonly string[];
  run: (kind: string, payload: JsonObject) => Promise<JsonValue>;
};
type FileState = { key: string; items: CompletionItem[]; limited: boolean; error?: TextKey };

export function useComposerCompletion({ context, scope, text, caret, enabled, onReplace }: {
  context?: CompletionContext; scope: string; text: string; caret: [number, number]; enabled: boolean;
  onReplace: (text: string, caret: number) => void;
}) {
  const id = useId();
  const token = enabled && context?.enabled && ["claude", "codex"].includes(context.source)
    ? completionToken(text, ...caret) : null;
  const draftIdentity = JSON.stringify([scope, context?.source, context?.projectId, context?.worktreeId, context?.sessionId, token, text]);
  // A repeated draft starts a new interaction. Old dismissals, selections and callbacks cannot revive.
  const interaction = useRef({ draftIdentity, version: 0 });
  if (interaction.current.draftIdentity !== draftIdentity)
    interaction.current = { draftIdentity, version: interaction.current.version + 1 };
  const identity = JSON.stringify([draftIdentity, interaction.current.version]);
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const [dismissed, setDismissed] = useState("");
  const [choice, setChoice] = useState({ key: "", index: 0 });
  const [files, setFiles] = useState<FileState>();
  const [revision, setRevision] = useState(0);
  const [problem, setProblem] = useState<{ key: string; error: TextKey }>();
  const open = Boolean(token && identity !== dismissed);
  const skill = token?.kind === "command";
  const request = open && token ? skill ? { kind: "terminal.skills", value: token.query }
    : fileRequest(token.query) : null;
  const supported = Boolean(context?.projectId && request && (skill ? context.sessionId
    && context.capabilities.includes("terminal.skills") : context.capabilities.includes("file.management")));
  const requestKey = JSON.stringify([identity, request, supported, open, revision]);
  const catalogKey = JSON.stringify([scope, context?.source, context?.projectId, context?.worktreeId, context?.sessionId, revision]);
  const catalog = useRef<{ key: string; run: CompletionContext["run"]; value: JsonValue; at: number } | undefined>(undefined);
  const current = useRef({ key: requestKey, catalogKey, run: context?.run });
  current.current = { key: requestKey, catalogKey, run: context?.run };
  const flight = useRef<Promise<JsonValue> | undefined>(undefined);
  const run = context?.run;
  const projectId = context?.projectId;
  const worktreeId = context?.worktreeId;
  const sessionId = context?.sessionId;
  const source = context?.source ?? "";

  useEffect(() => {
    if (!request || !supported || !run || !projectId) return;
    let alive = true;
    const valid = () => alive && current.current.key === requestKey && current.current.run === run;
    const timer = setTimeout(async () => {
      // Host management is serial; do not queue every keystroke behind a slow directory search.
      try { await flight.current; } catch { /* The originating query owns its error. */ }
      if (!valid()) return;
      let pending: Promise<JsonValue> | undefined;
      try {
        const cached = skill && catalog.current?.key === catalogKey && catalog.current.run === run
          && Date.now() - catalog.current.at < 30_000 ? catalog.current.value : undefined;
        let value = cached;
        if (value === undefined) {
          pending = run(request.kind, { projectId, ...(worktreeId ? { worktreeId } : {}),
            ...(skill ? { sessionId: sessionId! } : { [request.kind === "file.list" ? "path" : "query"]: request.value }) });
          flight.current = pending;
          value = await pending;
          if (skill && current.current.catalogKey === catalogKey && current.current.run === run)
            catalog.current = { key: catalogKey, run, value, at: Date.now() };
        }
        if (valid()) {
          if (skill && value && typeof value === "object" && !Array.isArray(value) && value.available === false) {
            setFiles({ key: requestKey, items: [], limited: false,
              error: value.reason === "unbound" ? "completionSkillsUnbound" : "completionSkillsUnavailable" });
          } else setFiles({ key: requestKey, ...(skill ? skillItems(value, source, request.value) : fileItems(value)) });
        }
      } catch {
        if (valid()) setFiles({ key: requestKey, items: [], limited: false,
          error: skill ? "completionSkillsReadFailed" : "completionReadFailed" });
      } finally {
        if (flight.current === pending) flight.current = undefined;
      }
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [requestKey, run, projectId, worktreeId, sessionId, source]);

  const fileState = files?.key === requestKey ? files : undefined;
  const items = open && supported ? fileState?.items ?? [] : [];
  const index = choice.key === identity ? Math.min(choice.index, Math.max(0, items.length - 1)) : 0;
  const error: TextKey | undefined = problem?.key === identity ? problem.error
    : !token ? undefined : !request ? "completionRelativeOnly"
    : !supported ? skill ? "completionSkillsUnavailable" : "completionUnavailable" : fileState?.error;
  const loading = open && supported && !fileState;
  const dismiss = () => setDismissed(identity);
  const apply = (value: string, directory: boolean) => {
    if (!open || !token || latestIdentity.current !== identity) return;
    const replacement = replaceCompletion(text, token, value, directory);
    if (!replacement) { setProblem({ key: identity, error: "completionTooLong" }); return; }
    if (!directory) dismiss();
    onReplace(replacement.text, replacement.caret);
  };
  const select = (item: CompletionItem) => {
    // A pointer callback from an old list must not insert a different query's result.
    if (!items.some((candidate) => candidate.id === item.id)) return;
    apply(item.kind === "skill" ? item.value : fileReference(item.value, item.kind === "directory"), item.kind === "directory");
  };
  const key = (event: InputKey): boolean => {
    if (!open || event.isComposing || event.keyCode === 229 || event.key === "Process"
      || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
    if (event.key === "Escape") { dismiss(); return true; }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      if (items.length) setChoice({ key: identity, index: (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length });
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (items[index]) select(items[index]!);
      return true; // Empty/loading results must not turn candidate confirmation into submission.
    }
    return false;
  };
  const parent = token?.kind === "file" ? token.query.replace(/\/$/, "").split("/").slice(0, -1).join("/") : "";
  return { id, open, token, items, index, error, loading, limited: Boolean(fileState?.limited), key, select, dismiss,
    retry: () => setRevision((value) => value + 1),
    up: token?.kind === "file" && token.query.includes("/") ? () => apply(parent ? fileReference(parent, true) : "@", true) : undefined,
  };
}
