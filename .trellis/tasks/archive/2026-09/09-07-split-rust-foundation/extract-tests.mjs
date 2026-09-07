// Mechanical test-module extraction; same Rust module identity, no production edits.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const files = [
  "src-tauri/src/codex_app_server_proxy.rs",
  "src-tauri/src/provider/import.rs",
  "src-tauri/src/commands/db_repair.rs",
  "src-tauri/src/daemon/ssh_agent_bridge.rs",
  "src-tauri/ssh-agent/src/history.rs",
];
const outputs = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const match = /#\[cfg\(test\)\]\r?\nmod tests \{\r?\n([\s\S]*)\r?\n\}\s*$/.exec(source);
  assert.ok(match, file);
  const directory = file.replace(/\.rs$/, "");
  const target = `${directory}/tests.rs`;
  assert.ok(!existsSync(target), target);
  assert.ok(!/include_(str|bytes)!|#\[path/.test(match[1]), "relative fixture path requires review");
  const body = match[1].split(/\r?\n/).map((line) => line.startsWith("    ") ? line.slice(4) : line).join("\n") + "\n";
  assert.ok(body.split("\n").length <= 2000, target);
  outputs.push([target, body], [file, source.slice(0, match.index) + "#[cfg(test)]\nmod tests;\n"]);
}
for (const [file, content] of outputs) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}
console.log(`Extracted ${files.length} test modules without changing their module identities or bodies.`);
