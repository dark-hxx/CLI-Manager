import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-git-graph-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/components/git/workspace/gitGraphLayout.ts", import.meta.url),
  "utf8",
);
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "gitGraphLayout.ts",
}).outputText;
const outputPath = join(tempDir, "gitGraphLayout.mjs");
writeFileSync(outputPath, output, "utf8");
const { layoutGitGraph, gitGraphColor } = await import(
  pathToFileURL(outputPath).href
);

const commit = (id, parents = [], refs = []) => ({
  id,
  shortId: id.slice(0, 8),
  parents,
  refs,
  title: id,
  authorName: "Test",
  authorEmail: null,
  authoredAt: 0,
});

test("linear and root commits remain in one stable lane", () => {
  const rows = layoutGitGraph([
    commit("c3", ["c2"]),
    commit("c2", ["c1"]),
    commit("c1"),
  ]);
  assert.deepEqual(
    rows.map((row) => row.lane),
    [0, 0, 0],
  );
  assert.equal(rows[0].segments[0].kind, "parent");
  assert.equal(rows[2].segments.length, 0);
});

test("merge parents fan out and converge without duplicate lanes", () => {
  const rows = layoutGitGraph([
    commit("merge", ["left", "right"]),
    commit("left", ["root"]),
    commit("right", ["root"]),
    commit("root"),
  ]);
  assert.equal(rows[0].laneCount, 2);
  assert.equal(
    rows[0].segments.filter((segment) => segment.kind === "parent").length,
    2,
  );
  assert.equal(rows[2].lane, 1);
  assert.equal(rows[3].lane, 0);
});

test("appending another cursor page preserves the existing prefix layout", () => {
  const commits = Array.from({ length: 75 }, (_, index) => {
    const number = 75 - index;
    return commit(
      `commit-${number}`,
      number > 1 ? [`commit-${number - 1}`] : [],
    );
  });
  const firstPage = layoutGitGraph(commits.slice(0, 50));
  const allPages = layoutGitGraph(commits);
  assert.deepEqual(allPages.slice(0, 50), firstPage);
});

test("search results mark omitted parents instead of drawing false edges", () => {
  const rows = layoutGitGraph(
    [commit("visible-2", ["hidden"]), commit("visible-1")],
    { connectOnlyVisible: true },
  );
  assert.equal(rows[0].truncatedParentCount, 1);
  assert.deepEqual(
    rows[0].segments.map((segment) => segment.kind),
    ["truncated"],
  );
});

test("lane colors are deterministic", () => {
  assert.equal(gitGraphColor(0), gitGraphColor(6));
  assert.equal(gitGraphColor(2), gitGraphColor(2));
});
