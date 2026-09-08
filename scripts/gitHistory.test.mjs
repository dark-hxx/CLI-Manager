import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 按相对路径读取被测源码供契约断言使用。
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const historyView = read("../src/features/git/components/GitHistoryView.tsx");
const transport = read("../src/features/git/lib/gitTransport.ts");
const remote = read("../src/features/remote/api/sshRemoteGit.ts");
const bridge = read("../src-tauri/src/infrastructure/daemon/ssh_agent_bridge.rs");
const agentProtocol = read("../src-tauri/ssh-agent/src/protocol.rs");

// 验证提交历史查询接入所有 Git 传输实现。
test("commit history is wired through every Git transport", () => {
  for (const method of ["listCommits", "getCommitDetail", "getCommitFileDiff"]) {
    assert.match(transport, new RegExp(`${method}\\(`));
  }
  for (const kind of ["gitListCommits", "gitCommitDetail", "gitCommitFileDiff"]) {
    assert.match(remote, new RegExp(kind));
  }
});

// 验证历史请求写帧前拒绝缺少相应能力的旧 SSH 代理。
test("old SSH agents are rejected before history frames are written", () => {
  assert.match(bridge, /"gitListCommits" \| "gitCommitDetail" \| "gitCommitFileDiff" => Some\("gitHistory"\)/);
  assert.match(agentProtocol, /"gitHistory"/);
});

// 验证历史差异保持只读且允许根仓库标识。
test("history viewer keeps commit diffs read-only", () => {
  assert.match(historyView, /transport\.getCommitFileDiff/);
  assert.match(historyView, /filePath,\s+selectedFile\?\.oldPath,/);
  assert.doesNotMatch(historyView, /revertHunk=|revertLines=|onRequestDiscard=/);
  assert.match(historyView, /repositoryId === null/);
  assert.doesNotMatch(historyView, /!repositoryId/);
});

// 验证历史列表与详情使用独立代次丢弃过期响应。
test("history requests use independent stale-result generations", () => {
  assert.match(historyView, /listGenerationRef/);
  assert.match(historyView, /detailGenerationRef/);
  assert.match(historyView, /generation !== listGenerationRef\.current/);
  assert.match(historyView, /generation === detailGenerationRef\.current/);
});

// 验证历史行默认折叠且不会强制展开最新提交。
test("history rows start collapsed and toggle without forcing the newest commit open", () => {
  assert.doesNotMatch(historyView, /const firstId = result\.value\.commits\[0\]/);
  assert.match(historyView, /current === commit\.id \? null : commit\.id/);
  assert.match(historyView, /item\.id === current\) \? current : null/);
});

// 验证父级刷新期间差异加载回调保持稳定。
test("history diff loader keeps a stable callback across parent refreshes", () => {
  assert.match(historyView, /const loadSelectedFileDiff = useCallback/);
  assert.match(historyView, /loadDiff=\{loadSelectedFileDiff\}/);
  assert.doesNotMatch(historyView, /loadDiff=\{\(\) => transport\.getCommitFileDiff/);
});
