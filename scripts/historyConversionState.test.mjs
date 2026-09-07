import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const storeSource = readFileSync(
  new URL("../src/features/history/store/historyStore.ts", import.meta.url),
  "utf8"
);
const workspaceSource = readFileSync(
  new URL("../src/components/HistoryWorkspace.tsx", import.meta.url),
  "utf8"
);

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("converted summary and detail become active atomically", () => {
  const block = sourceBlock(storeSource, "addConvertedSession: (summary, detail) => {", "openSession: async");

  assert.match(block, /sameHistorySessionIdentity\(normalized, normalizedDetail\)/);
  assert.match(block, /sessionDetailRequestSeq \+= 1/);
  assert.match(block, /activeSessionKey: sessionKey/);
  assert.match(block, /activeSession: normalizedDetail/);
});

test("detail requests clear the previous active detail before awaiting", () => {
  const openSession = sourceBlock(storeSource, "openSession: async", "openSearchHit: async");
  const openSearchHit = sourceBlock(storeSource, "openSearchHit: async", "deleteSession: async");

  assert.match(openSession, /activeSession: null/);
  assert.match(openSearchHit, /activeSession: null/);
});

test("conversion avoids the not-yet-indexed read path and resume uses identity-gated detail", () => {
  const conversion = sourceBlock(workspaceSource, "const convertSession = useCallback", "const jumpToMessage");
  const resume = sourceBlock(workspaceSource, "const resumeConversation = useCallback", "const openByHit");

  assert.match(conversion, /addConvertedSession\(result\.summary, result\.detail\)/);
  assert.doesNotMatch(conversion, /openSession\(/);
  assert.match(workspaceSource, /sameHistorySessionIdentity\(activeView, storedActiveSession\)/);
  assert.match(resume, /!activeSession \|\| !activeView/);
});
