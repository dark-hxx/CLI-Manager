import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const detailSource = readFileSync(
  new URL("../src/components/history/SessionDetailPane.tsx", import.meta.url),
  "utf8",
);
const workspaceSource = readFileSync(
  new URL("../src/components/HistoryWorkspace.tsx", import.meta.url),
  "utf8",
);
const listSource = readFileSync(
  new URL("../src/components/history/HistoryListPane.tsx", import.meta.url),
  "utf8",
);
const storeSource = readFileSync(
  new URL("../src/stores/historyStore.ts", import.meta.url),
  "utf8",
);

test("conversation is the default view and transcript remains independent", () => {
  assert.match(workspaceSource, /useState<HistoryDetailView>\("conversation"\)/);
  assert.match(workspaceSource, /setDetailView\("conversation"\)/);
  assert.match(detailSource, /id: "conversation", labelKey: "history\.detail\.view\.conversation"/);
  assert.match(detailSource, /id: "transcript", labelKey: "history\.detail\.view\.transcript"/);
  assert.match(detailSource, /detailView === "transcript" && visibleMessages\.length > 0/);
  assert.match(detailSource, /data-index=\{virtualIndex\}/);
  assert.match(detailSource, /virtualIndex=\{virtualRow\.index\}/);
});

test("conversation keeps only visible user and assistant text", () => {
  assert.match(detailSource, /message\.parts\?\.length \? message\.parts : fallbackMessageParts\(message\)/);
  assert.match(detailSource, /role === "user" \|\| role === "assistant"/);
  assert.match(detailSource, /if \(role !== "user" && role !== "assistant"\) return false;/);
  assert.match(detailSource, /if \(textParts\.length === 0\) return;/);
  assert.match(detailSource, /isConversationVisibleMessage/);
  assert.match(detailSource, /firstLine\.startsWith\("base directory for this skill:"\)/);
  assert.match(storeSource, /parts: parts\.length > 0 \? parts : undefined/);
});

test("search and cross-view jumps keep the conversation view targetable", () => {
  assert.match(workspaceSource, /message\.parts\?\.some\(\(part\) => matcher\.test\(part\.content\)\)/);
  assert.match(workspaceSource, /const jumpToMessage = async[\s\S]*setDetailView\(targetMessage && isConversationVisibleMessage\(targetMessage\) \? "conversation" : "transcript"\)/);
  assert.match(detailSource, /findConversationRowIndex\(conversationRows, activeMatchIndex\)/);
  assert.match(detailSource, /findConversationRowIndex\(conversationRows, focusedMessageIndex\)/);
});

test("the whole session row opens once while action buttons stop propagation", () => {
  assert.match(listSource, /onClick=\{\(\) => selectionMode[\s\S]*onOpenSession\(row\.item\.sessionKey\)/);
  assert.match(listSource, /className="ui-focus-ring absolute inset-0 rounded-\[inherit\]/);
  assert.match(listSource, /role=\{selectionMode \? "checkbox" : undefined\}/);
  assert.match(listSource, /event\.stopPropagation\(\);[\s\S]*onDeleteSession\(row\.item\)/);
});

test("session detail keeps the last-request-wins guard", () => {
  const openSessionSource = storeSource.slice(
    storeSource.indexOf("openSession: async"),
    storeSource.indexOf("openSearchHit: async"),
  );
  assert.match(openSessionSource, /const requestSeq = \+\+sessionDetailRequestSeq/);
  assert.match(
    openSessionSource,
    /if \(requestSeq === sessionDetailRequestSeq\) set\(\{ activeSession: detail \}\)/,
  );
  assert.match(
    openSessionSource,
    /if \(requestSeq === sessionDetailRequestSeq\) set\(\{ loadingSessionDetail: false \}\)/,
  );
});
