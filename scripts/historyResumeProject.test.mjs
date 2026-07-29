import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-history-resume-project-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/lib/historyResumeProject.ts", import.meta.url),
  "utf8"
);
const historyWorkspaceSource = readFileSync(
  new URL("../src/components/HistoryWorkspace.tsx", import.meta.url),
  "utf8"
);
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const outputPath = join(tempDir, "historyResumeProject.mjs");
writeFileSync(outputPath, output, "utf8");

const { findLocalHistoryCwdProjects } = await import(pathToFileURL(outputPath).href);

function project(id, path, environmentType = "local") {
  return { id, path, environment_type: environmentType };
}

test("matches a unique local project by exact history cwd", () => {
  const projects = [
    project("claude", "F:\\github\\CLI-Manager\\"),
    project("other", "F:\\github\\Other"),
  ];

  assert.deepEqual(
    findLocalHistoryCwdProjects({ cwd: "F:/github/CLI-Manager" }, projects).map(
      (item) => item.id
    ),
    ["claude"]
  );
});

test("keeps duplicate cwd matches so the caller can require selection", () => {
  const projects = [
    project("claude", "F:\\github\\CLI-Manager"),
    project("codex", "F:/github/CLI-Manager/"),
  ];

  assert.deepEqual(
    findLocalHistoryCwdProjects({ cwd: "F:/github/CLI-Manager" }, projects).map(
      (item) => item.id
    ),
    ["claude", "codex"]
  );
});

test("includes WSL projects, excludes SSH projects and sessions without cwd", () => {
  const projects = [
    project("local", "F:\\github\\CLI-Manager"),
    project("ssh", "F:\\github\\CLI-Manager", "ssh"),
    project("wsl", "/mnt/f/github/CLI-Manager", "wsl"),
  ];

  assert.deepEqual(
    findLocalHistoryCwdProjects({ cwd: "F:/github/CLI-Manager" }, projects).map(
      (item) => item.id
    ),
    ["local"]
  );
  assert.deepEqual(
    findLocalHistoryCwdProjects({ cwd: "/mnt/f/github/CLI-Manager" }, projects).map(
      (item) => item.id
    ),
    ["wsl"]
  );
  assert.deepEqual(findLocalHistoryCwdProjects({ cwd: null }, projects), []);
});

test("local history resume binds the terminal tab to the selected CLI session", () => {
  const resumeSessionStart = historyWorkspaceSource.indexOf(
    "  const resumeSession = useCallback(async ("
  );
  const requestResumeStart = historyWorkspaceSource.indexOf(
    "  const requestResume = useCallback(",
    resumeSessionStart
  );

  assert.notEqual(resumeSessionStart, -1);
  assert.notEqual(requestResumeStart, -1);
  const localResumeStart = historyWorkspaceSource.indexOf(
    "      const requestedShell =",
    resumeSessionStart
  );
  assert.notEqual(localResumeStart, -1);
  const localResumeBody = historyWorkspaceSource.slice(
    localResumeStart,
    requestResumeStart
  );

  assert.match(
    localResumeBody,
    /await createSession\([\s\S]*?worktree\?\.id,\s*undefined,\s*session\.session_id\.trim\(\),\s*\);/
  );
});
