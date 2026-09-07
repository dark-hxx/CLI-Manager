import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

for (const [file, marker] of [
  ["src-tauri/src/commands/sync.rs", "sql: concat!("],
  ["src-tauri/src/live_server/http.rs", "    format!(\n        concat!("],
]) {
  const before = execFileSync("git", ["show", `6cf6222d:${file}`], { encoding: "utf8" });
  const after = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  const oldLine = before.split(/\r?\n/).find(line => line.length > 500);
  const original = oldLine.match(/r#"(.*)"#/s)?.[1] ?? oldLine.match(/sql: "(.*)"\.to_string/)[1];
  const start = after.indexOf(marker);
  assert.ok(start >= 0, file);
  const block = after.slice(start).split(/\n\s+\)/)[0];
  // The changed literals contain neither escaped quotes nor newline escapes.
  const joined = [...block.matchAll(/r#"(.*?)"#|"([^"\n]*)"/g)].map(match => match[1] ?? match[2]).join("")
    .replaceAll("{endpoint}", "{RELOAD_ENDPOINT}").replaceAll("{interval}", "{POLL_INTERVAL_MS}");
  assert.equal(joined, original, `${file}: string bytes changed`);
  console.log(`${file}: concatenated literal bytes unchanged`);
}
