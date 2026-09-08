import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-diagnostics-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));
function emit(name, path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022}}).outputText
    .replaceAll('"../../../shared/lib/wslPaths"', '"./wslPaths.mjs"');
  writeFileSync(join(tempDir, name + ".mjs"), output);
  return import(pathToFileURL(join(tempDir, name + ".mjs")).href);
}
await emit("wslPaths", "../src/shared/lib/wslPaths.ts");
const { resolveHistoryResumeEnvironment: resolve, historyPathsMatch } = await emit("resume", "../src/features/history/lib/historyResumeEnvironment.ts");
const { buildSessionMcpEvidence } = await emit("health", "../src/features/agents/api/agentCapabilities.ts");
const { inferredToolActivity } = await emit("activity", "../src/features/history/api/toolActivity.ts");
const { HISTORY_SOURCE_DESCRIPTORS } = await emit("sources", "../src/shared/lib/historySources.ts");
const unc = (distro, path) => `\\\\wsl.localhost\\${distro}${path.replaceAll("/", "\\")}`;
const session = (source, distro = "Ubuntu Test") => ({source, cwd: "/home/dev/my repo", project_key: "repo",
  file_path: unc(distro, `/home/dev/.${source}/sessions/run.jsonl`)});
for (const source of ["claude", "codex", "pi", "grok", "kimi", "opencode"]) {
  test(`${source}: WSL resume preserves distro and cwd including spaces`, () => {
    const result = resolve(session(source), null, null, undefined, "windows");
    assert.equal(result.cwd, unc("Ubuntu Test", "/home/dev/my repo"));
    assert.equal(result.shell, "wsl");
    if (source === "opencode") assert.deepEqual(result.env, {});
  });
}
test("all twelve native sources have explicit resume support", () => {
  assert.equal(HISTORY_SOURCE_DESCRIPTORS.length, 12);
  const supported = HISTORY_SOURCE_DESCRIPTORS.filter(s => s.capabilities.resume === "supported").map(s => s.id).sort();
  assert.deepEqual(supported, ["claude", "codex", "grok", "kimi", "opencode", "pi"]);
});
test("WSL project matching rejects cross-distro and local lookalikes", () => {
  const entry = session("codex");
  assert.equal(historyPathsMatch(entry, {path: unc("Ubuntu Test", entry.cwd), environment_type: "wsl"}), true);
  assert.equal(historyPathsMatch(entry, {path: unc("Debian", entry.cwd), environment_type: "wsl"}), false);
  assert.equal(historyPathsMatch(entry, {path: entry.cwd, environment_type: "local"}), false);
  assert.throws(() => resolve(entry, {path: unc("Debian", entry.cwd)}, null, "wsl", "windows"), /distro_conflict/);
});
test("missing WSL identity and malformed paths fail before process launch", () => {
  assert.throws(() => resolve({...session("pi"), file_path: "", session_ref: {transportKind: "wsl", rawPointers: []}}, null, null, "wsl", "windows"), /distro_required/);
  assert.throws(() => resolve({...session("codex"), cwd: "/home/../private"}, null, null, "wsl", "windows"), /path_invalid/);
  const entry = {...session("codex"), file_path: "", cwd: "/home/dev/repo"};
  assert.deepEqual(resolve(entry, null, null, "bash", "linux"), {cwd: entry.cwd, shell: "bash", env: {}});
});
test("Windows mount paths and WSL UNC aliases resolve consistently", () => {
  const entry = {...session("codex"), cwd: "D:/work/my repo", file_path: session("codex").file_path.replace("wsl.localhost", "wsl$")};
  assert.equal(resolve(entry, null, null, "wsl", "windows").cwd, unc("Ubuntu Test", "/mnt/d/work/my repo"));
});
test("inferred call sites are deduplicated and never become health evidence", () => {
  const inferred = {call_id: "parent:inferred:1", name: "mcp__docs__read", category: "mcp:docs", status: "completed", evidence: {kind: "inferred"}};
  const events = [inferred, {...inferred}, {call_id: "outer", name: "exec", category: "builtin", status: "completed"}];
  assert.deepEqual(inferredToolActivity(events), {total: 1, builtin: [], mcp: [{name: "docs", count: 1}]});
  assert.deepEqual(buildSessionMcpEvidence({tool_events: events}), []);
});
test("only terminal results produce health and latest timestamp wins", () => {
  const unknown = [undefined, "started", "running", "pending", "cancelled", "denied"];
  assert.deepEqual(buildSessionMcpEvidence({tool_events: unknown.map(status => ({category: "mcp:docs", status}))}), []);
  const tool_events = [
    {category: "mcp:docs", status: "failed", timestamp: "2026-09-07T03:00:00Z"},
    {category: "mcp:docs", status: "completed", timestamp: "2026-09-07T02:00:00Z"},
  ];
  assert.equal(buildSessionMcpEvidence({tool_events})[0].success, false);
});
