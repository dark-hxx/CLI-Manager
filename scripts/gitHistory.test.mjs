import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const historyView = read("../src/components/git/GitHistoryView.tsx");
const transport = read("../src/lib/gitTransport.ts");
const remote = read("../src/lib/sshRemoteGit.ts");
const bridge = read("../src-tauri/src/daemon/ssh_agent_bridge.rs");
const agentProtocol = read("../src-tauri/ssh-agent/src/protocol.rs");

test("commit history is wired through every Git transport", () => {
  for (const method of ["listCommits", "getCommitDetail", "getCommitFileDiff"]) {
    assert.match(transport, new RegExp(`${method}\\(`));
  }
  for (const kind of ["gitListCommits", "gitCommitDetail", "gitCommitFileDiff"]) {
    assert.match(remote, new RegExp(kind));
  }
});

test("old SSH agents are rejected before history frames are written", () => {
  assert.match(bridge, /"gitListCommits" \| "gitCommitDetail" \| "gitCommitFileDiff" => Some\("gitHistory"\)/);
  assert.match(agentProtocol, /"gitHistory"/);
});

test("history viewer keeps commit diffs read-only", () => {
  assert.match(historyView, /transport\.getCommitFileDiff/);
  assert.match(historyView, /filePath,\s+selectedFile\?\.oldPath,/);
  assert.doesNotMatch(historyView, /revertHunk=|revertLines=|onRequestDiscard=/);
  assert.match(historyView, /repositoryId === null/);
  assert.doesNotMatch(historyView, /!repositoryId/);
});

test("history requests use independent stale-result generations", () => {
  assert.match(historyView, /listGenerationRef/);
  assert.match(historyView, /detailGenerationRef/);
  assert.match(historyView, /generation !== listGenerationRef\.current/);
  assert.match(historyView, /generation === detailGenerationRef\.current/);
});

test("history rows start collapsed and toggle without forcing the newest commit open", () => {
  assert.doesNotMatch(historyView, /const firstId = result\.value\.commits\[0\]/);
  assert.match(historyView, /current === commit\.id \? null : commit\.id/);
  assert.match(historyView, /item\.id === current\) \? current : null/);
});

test("history diff loader keeps a stable callback across parent refreshes", () => {
  assert.match(historyView, /const loadSelectedFileDiff = useCallback/);
  assert.match(historyView, /loadDiff=\{loadSelectedFileDiff\}/);
  assert.doesNotMatch(historyView, /loadDiff=\{\(\) => transport\.getCommitFileDiff/);
});
