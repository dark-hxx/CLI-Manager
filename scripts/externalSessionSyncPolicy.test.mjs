import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const storeSource = readFileSync(
  new URL("../src/stores/externalSessionSyncStore.ts", import.meta.url),
  "utf8"
);
const sidebarSource = readFileSync(
  new URL("../src/components/sidebar/index.tsx", import.meta.url),
  "utf8"
);
const terminalStoreSource = readFileSync(
  new URL("../src/stores/terminalStore.ts", import.meta.url),
  "utf8"
);

function functionBody(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("does not generate or inject synced history context", () => {
  assert.equal(
    existsSync(new URL("../src/lib/syncedHistoryContext.ts", import.meta.url)),
    false
  );
  const launchSources = `${sidebarSource}\n${terminalStoreSource}`;
  assert.doesNotMatch(launchSources, /append-system-prompt-file|developer_instructions|syncedHistoryContext/);
});

test("startup materialization preserves existing project names and groups", () => {
  const materializeBody = functionBody(
    storeSource,
    "async function ensureProjectsForExternalSessionGroups(",
    "async function ensureProjectsForSyncedSessions("
  );
  assert.doesNotMatch(materializeBody, /updateProject\s*\(/);
  assert.match(materializeBody, /if \(existingProject && matchesProjectSource\(existingProject, group\.source\)\) continue;/);
  assert.match(materializeBody, /createProject\s*\(/);
});

test("successful project sync persists project keys in the ignore list", () => {
  const syncBody = functionBody(
    storeSource,
    "syncProjectCandidates: async (keys, shell) =>",
    "ignoreProjectCandidates: async (keys) =>"
  );
  assert.match(syncBody, /if \(get\(\)\.syncingProjects\) return;/);
  assert.match(syncBody, /selectedProjects\.map\(\(project\) => project\.key\)/);
  assert.match(syncBody, /ignoredProjectKeys: nextIgnoredProjects/);
  assert.match(syncBody, /await persistCurrentState\(get\(\)\)/);
});

test("loading existing synced sessions backfills their project ignore keys", () => {
  const loadBody = functionBody(
    storeSource,
    "load: async () =>",
    "scanAndPrompt: async () =>"
  );
  assert.match(loadBody, /groupProjectCandidates\(syncedSessions, \[\], syncedSessions\)/);
  assert.match(loadBody, /ignoredProjectKeys\.length !== storedIgnoredProjectKeys\.length/);
});
