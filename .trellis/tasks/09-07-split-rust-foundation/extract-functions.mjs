// Mechanical named-responsibility extraction driven by syn item boundaries.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const defaults = [
  { file: "src-tauri/src/daemon/route_http.rs", groups: [{ name: "forwarding", first: "forward_request", last: "forward_request" }] },
  { file: "src-tauri/src/provider/global.rs", groups: [
    { name: "live_files", first: "wsl_command", last: "remove_live" },
    { name: "materialize", first: "parse_json_object", last: "materialize_grok_global_config" },
  ] },
  { file: "src-tauri/src/commands/ssh.rs", groups: [{ name: "process_io", first: "single_line", last: "run_agent_input_process" }] },
  { file: "src-tauri/ssh-agent/src/hook_config.rs", groups: [{ name: "json_hooks", first: "read_json", last: "serialize_json" }] },
];
const plans = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : defaults;
const index = ".trellis/tasks/09-07-split-rust-foundation/rust-index/target/debug/architecture-rust-index.exe";
const traits = new Set(["Read", "Write", "BufRead", "Engine", "StreamExt", "BodyExt", "Manager", "Emitter", "OsStrExt", "OpenOptionsExt", "PermissionsExt", "Digest", "Connection", "Row"]);
const outputs = new Map();
for (const plan of plans) {
  const source = readFileSync(plan.file, "utf8").replaceAll("\r\n", "\n");
  const lines = source.split("\n");
  const items = JSON.parse(execFileSync(index, [plan.file], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }))[0].items;
  const directory = plan.file.replace(/\.rs$/, "");
  const parentDefinitions = items.filter((item) => item.kind !== "impl" && item.kind !== "use" && item.name);
  const useItems = items.filter((item) => item.kind === "use");
  const replacements = [];
  const registrations = [];
  for (const group of plan.groups) {
    const first = items.find((item) => item.name === group.first);
    const last = items.findLast((item) => item.name === group.last);
    assert.ok(first && last && first.start <= last.end);
    const selected = items.filter((item) => item.start >= first.start && item.end <= last.end);
    assert.ok(selected.every((item) => ["fn", "const", "static", "struct", "enum", "type", "impl"].includes(item.kind)), `review non-function items in ${group.name}`);
    const selectedNames = new Set(selected.map((item) => item.name));
    const refs = new Set(selected.flatMap((item) => item.refs));
    const rawBody = lines.slice(first.start - 1, last.end).join("\n");
    for (const definition of parentDefinitions) {
      if (new RegExp(`\\{${definition.name}(?:[:}])`).test(rawBody)) refs.add(definition.name);
    }
    const outsideRefs = new Set(items.filter((item) => !selected.includes(item)).flatMap((item) => item.refs));
    const dependencies = parentDefinitions.filter((item) => refs.has(item.name) && !selectedNames.has(item.name)).map((item) => item.name);
    const uses = useItems.filter((item) => item.bindings.some((name) => refs.has(name) || traits.has(name)) || lines.slice(item.start - 1, item.end).join("\n").includes("::*"))
      .map((item) => lines.slice(item.start - 1, item.end).join("\n").replaceAll("super::", "super::super::"));
    const bodyLines = lines.slice(first.start - 1, last.end);
    for (const item of [...selected].reverse()) {
      for (const member of item.members ?? []) {
        if (!member.visibility) bodyLines[member.line - first.start] = bodyLines[member.line - first.start].replace(/^(\s*)(async )?fn /, "$1pub(super) $2fn ");
      }
      for (const field of item.fields ?? []) {
        assert.ok(field.name, "tuple fields require explicit review");
        if (!field.visibility) bodyLines[field.line - first.start] = bodyLines[field.line - first.start].replace(/^(\s*)([a-zA-Z_][a-zA-Z_0-9]*\s*:)/, "$1pub(super) $2");
      }
      if (item.visibility.replaceAll(" ", "") === "pub(super)") {
        for (let line = item.start - first.start; line <= item.end - first.start; line++) {
          if (bodyLines[line].startsWith("pub(super) ")) {
            bodyLines[line] = bodyLines[line].replace("pub(super)", "pub(crate)");
            break;
          }
        }
      }
      if (item.visibility || item.kind === "impl") continue;
      const offset = item.start - first.start;
      for (let line = offset; line <= item.end - first.start; line++) {
        if (/^(?:async )?(?:fn|const|static|struct|enum|type)\b/.test(bodyLines[line])) {
          bodyLines[line] = "pub(super) " + bodyLines[line];
          break;
        }
      }
    }
    const body = bodyLines.join("\n").replaceAll("super::", "super::super::");
    assert.ok(!/include_(str|bytes)!/.test(body), "relative embedded resource needs explicit review");
    const target = `${directory}/${group.name}.rs`;
    assert.ok(!existsSync(target), target);
    const prelude = dependencies.length ? `use super::{${[...new Set(dependencies)].join(", ")}};\n` : "";
    outputs.set(target, `${uses.join("\n")}\n${prelude}\n${body}\n`);
    const exported = selected.filter((item) => item.kind !== "impl" && (item.visibility || outsideRefs.has(item.name)));
    registrations.push(`mod ${group.name};`);
    for (const visibility of [...new Set(exported.map((item) => item.visibility))]) {
      const names = exported.filter((item) => item.visibility === visibility).map((item) => item.name);
      registrations.push(`${visibility ? visibility + " " : ""}use ${group.name}::{${names.join(", ")}};`);
    }
    replacements.push({ start: first.start - 1, count: last.end - first.start + 1, lines: [] });
  }
  const tests = items.find((item) => item.kind === "mod" && item.name === "tests");
  assert.ok(tests && tests.end === lines.filter((_, i) => i < lines.length - (lines.at(-1) === "" ? 1 : 0)).length);
  const testLines = lines.slice(tests.start - 1, tests.end);
  assert.equal(testLines[0], "#[cfg(test)]");
  assert.equal(testLines[1], "mod tests {");
  const body = testLines.slice(2, -1).map((line) => line.startsWith("    ") ? line.slice(4) : line).join("\n") + "\n";
  assert.ok(body.split("\n").length <= 2000);
  assert.ok(!/include_(str|bytes)!|#\[path/.test(body));
  assert.ok(!existsSync(`${directory}/tests.rs`));
  outputs.set(`${directory}/tests.rs`, body);
  replacements.push({ start: tests.start - 1, count: tests.end - tests.start + 1, lines: ["#[cfg(test)]", "mod tests;"] });
  for (const change of replacements.sort((a, b) => b.start - a.start)) lines.splice(change.start, change.count, ...change.lines);
  const insertion = lines.findIndex((line) => /^use /.test(line));
  assert.ok(insertion >= 0);
  lines.splice(insertion, 0, ...registrations, "");
  outputs.set(plan.file, lines.join("\n"));
}
for (const [file, source] of outputs) assert.ok(source.split("\n").length <= 2000, `${file} is still oversized`);
for (const [file, source] of outputs) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
}
console.log(`Extracted ${outputs.size - plans.length} named runtime/test modules across ${plans.length} owners.`);
