import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const task = ".trellis/tasks/09-07-architecture-convergence";
const { map, routes } = JSON.parse(readFileSync(`${task}/rust-ownership-plan.json`, "utf8"));
const edits = JSON.parse(readFileSync(`${task}/rust-path-edits.json`, "utf8"));
let count = 0;
for (const [file, target] of Object.entries(map)) {
  const expected = execFileSync("git", ["show", `8cf2a86c:${file}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).replaceAll("\r\n", "\n");
  let actual = readFileSync(target, "utf8").replaceAll("\r\n", "\n");
  for (const edit of edits[file] ?? []) actual = actual.replaceAll(`"${edit.after}"`, `"${edit.before}"`);
  for (const [key, route] of Object.entries(routes)) {
    if (!key.startsWith(`${file}:`)) continue;
    const relative = path.posix.relative(path.posix.dirname(target), route.target);
    const line = `#[path = "${relative}"]\n`;
    assert.ok(actual.includes(line), `Missing namespace route: ${key}`);
    actual = actual.replace(line, "");
  }
  assert.equal(actual, expected, `${file}: bytes changed beyond explicit module/resource paths`);
  count++;
}
console.log(`${count} complete Rust sources byte-match 8cf2a86c after reversing explicit namespace/resource paths; signatures, module order, bodies and fixtures unchanged.`);
