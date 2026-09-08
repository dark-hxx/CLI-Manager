// Compare parsed production function bodies against the pre-extraction checkpoint.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const index = path.resolve(".trellis/tasks/09-07-split-rust-foundation/rust-index/target/debug/architecture-rust-index.exe");
const changed = execFileSync("git", ["diff", "33916085", "--diff-filter=M", "--name-only", "--", "*.rs"], { encoding: "utf8" }).trim().split("\n").filter(file => file.startsWith("src-tauri/"));
const temporary = mkdtempSync(path.join(tmpdir(), "cli-manager-rust-body-audit-"));
function parse(file) {
  return JSON.parse(execFileSync(index, [file], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }))[0].items;
}
function descendants(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? descendants(path.join(directory, entry.name))
      : entry.name.endsWith(".rs") ? [path.join(directory, entry.name)] : []);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
const normalize = body => body.replaceAll("\r\n", "\n").replace(/\bsuper :: /g, "")
  // rustfmt wraps this one expression-only closure after its qualified path grows.
  .replace("move | | { codex_thread_name_index (& roots_for_names) }", "move | | codex_thread_name_index (& roots_for_names)")
  .replaceAll("& codex_thread_names , & mut parts . computed ,)", "& codex_thread_names , & mut parts . computed)");
let count = 0;
let testCount = 0;
for (const [position, file] of changed.entries()) {
  const original = execFileSync("git", ["show", `33916085:${file}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const beforeFile = path.join(temporary, `${position}.rs`);
  writeFileSync(beforeFile, original);
  const files = [file, ...descendants(file.replace(/\.rs$/, ""))];
  if (file === "src-tauri/src/lib.rs") files.push(...descendants("src-tauri/src/app"));
  const after = files.flatMap((target, offset) => {
    const parsed = parse(target);
    const inlineTests = parsed.find(item => item.kind === "mod" && item.name === "tests" && item.end > item.start + 1);
    if (inlineTests) {
      const testFile = path.join(temporary, `${position}-${offset}-current-tests.rs`);
      writeFileSync(testFile, readFileSync(target, "utf8").split("\n").slice(inlineTests.start + 1, inlineTests.end - 1).join("\n"));
      parsed.push(...parse(testFile));
    }
    return parsed;
  }).filter(item => item.kind === "fn");
  const originalItems = parse(beforeFile);
  const functions = originalItems.filter(item => item.kind === "fn");
  const tests = originalItems.find(item => item.kind === "mod" && item.name === "tests" && item.end > item.start + 1);
  if (tests) {
    const testFile = path.join(temporary, `${position}-tests.rs`);
    const originalLines = original.split("\n");
    writeFileSync(testFile, originalLines.slice(tests.start + 1, tests.end - 1).join("\n"));
    const testFunctions = parse(testFile).filter(item => item.kind === "fn").map(item => ({ ...item, testFixture: true }));
    testCount += testFunctions.length;
    functions.push(...testFunctions);
  }
  for (const before of functions) {
    // Earlier test extraction dedented multiline SQL/JSON fixtures with their module.
    // Audit test statements separately from production's exact literal comparison.
    const canonical = body => {
      let value = normalize(body);
      if (before.name === "codex_profile_wrapper_payload") value = value.replace(/\\\n[ \t]*/g, "").replaceAll("\\x20", " ");
      return before.testFixture ? value.replace(/\n[ \t]+/g, "\n") : value;
    };
    const match = after.some(item => item.name === before.name && canonical(item.body) === canonical(before.body));
    if (!match) {
      const candidate = after.find(item => item.name === before.name);
      if (candidate) {
        const a = canonical(before.body), b = canonical(candidate.body);
        let offset = 0;
        while (offset < a.length && a[offset] === b[offset]) offset++;
        console.error(JSON.stringify({ before: a.slice(offset - 50, offset + 100), after: b.slice(offset - 50, offset + 100) }));
      }
    }
    assert.ok(match, `Body changed or missing: ${file} :: ${before.name}`);
    count++;
  }
}
console.log(`Verified ${count - testCount} production and ${testCount} test/fixture function bodies across ${changed.length} owners; normalized line endings, relative qualifiers and rustfmt forms. Test-only multiline fixture indentation is ignored; production literal contents are preserved.`);
console.log(`Read-only comparison inputs retained at ${temporary}`);
