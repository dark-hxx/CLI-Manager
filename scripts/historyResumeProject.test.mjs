import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-history-resume-project-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const emitModule = (name, path) => {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022}}).outputText
  .replaceAll('"./historyResumeEnvironment"', '"./historyResumeEnvironment.mjs"')
    .replaceAll('"../../../shared/lib/wslPaths"', '"./wslPaths.mjs"');
  writeFileSync(join(tempDir, name + ".mjs"), output);
};
emitModule("wslPaths", "../src/shared/lib/wslPaths.ts");
emitModule("historyResumeEnvironment", "../src/features/history/lib/historyResumeEnvironment.ts");

const source = readFileSync(
  new URL("../src/features/history/lib/historyResumeProject.ts", import.meta.url),
  "utf8"
);
const historyWorkspaceSource = readFileSync(
  new URL("../src/features/history/api/HistoryWorkspace.tsx", import.meta.url),
  "utf8"
);
writeFileSync(
  join(tempDir, "cliTools.mjs"),
  `export const resolveCliToolHistorySourceId = (tool) => {
    const value = tool?.trim().toLowerCase();
    return ["claude", "codex", "grok", "pi"].includes(value) ? value : null;
  };\n`,
  "utf8",
);
writeFileSync(
  join(tempDir, "providerSwitching.mjs"),
  "export const getProviderSwitchAppType = (project) => project.providerSource ?? null;\n",
  "utf8",
);
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
  .replaceAll('"./historyResumeEnvironment"', '"./historyResumeEnvironment.mjs"')
  .replace('from "../../../shared/lib/cliTools"', 'from "./cliTools.mjs"')
  .replace('from "../../providers/api/providerSwitching"', 'from "./providerSwitching.mjs"');
const outputPath = join(tempDir, "historyResumeProject.mjs");
writeFileSync(outputPath, output, "utf8");

const {
  findLocalHistoryCwdProjects,
  selectLocalHistoryResumeProject,
} = await import(pathToFileURL(outputPath).href);

function project(id, path, environmentType = "local") {
  return {
    id,
    name: id,
    path,
    environment_type: environmentType,
    cli_tool: id.includes("pi") ? "pi" : id.includes("codex") ? "codex" : "claude",
  };
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

test("current project wins only when it belongs to the matched candidate set", () => {
  const projects = [
    project("pi-a", "F:/repo"),
    project("pi-b", "F:/repo"),
    project("codex", "F:/repo"),
  ];
  const session = { cwd: "F:/repo", project_key: "repo", source: "pi" };

  assert.equal(
    selectLocalHistoryResumeProject(session, projects, null, "pi-b").project?.id,
    "pi-b",
  );
  const wrongSource = selectLocalHistoryResumeProject(session, projects, null, "codex");
  assert.equal(wrongSource.project, null);
  assert.deepEqual(wrongSource.candidates.map((item) => item.id), ["pi-a", "pi-b"]);
});

test("exact worktree project has priority over duplicate cwd candidates", () => {
  const projects = [project("pi-a", "F:/repo"), project("pi-b", "F:/repo")];
  const worktree = { id: "wt", project_id: "pi-b", path: "F:/repo/wt" };
  const selection = selectLocalHistoryResumeProject(
    { cwd: "F:/repo/wt", project_key: "repo", source: "pi" },
    projects,
    worktree,
    "pi-a",
  );

  assert.equal(selection.project?.id, "pi-b");
  assert.equal(selection.worktree?.id, "wt");
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
