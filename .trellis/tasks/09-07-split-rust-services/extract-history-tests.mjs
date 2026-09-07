import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const planArgument = process.argv.slice(2).find(argument => argument !== "--write");
const plan = planArgument ? JSON.parse(readFileSync(planArgument, "utf8")) : null;
const file = plan?.file ?? "src-tauri/src/commands/history.rs";
const destination = file.replace(/\.rs$/, "/tests");
const index = ".trellis/tasks/09-07-split-rust-foundation/rust-index/target/debug/architecture-rust-index.exe";
const parse = file => JSON.parse(execFileSync(index, [file], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }))[0].items;
const source = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const lines = source.split("\n");
const owner = parse(file).find(item => item.kind === "mod" && item.name === "tests");
assert.ok(owner && lines[owner.start - 1] === "#[cfg(test)]" && lines[owner.start] === "mod tests {");
// Preserve multiline literal bytes; rustfmt can dedent code after extraction.
const body = lines.slice(owner.start + 1, owner.end - 1).join("\n");
const scratch = path.join(mkdtempSync(path.join(tmpdir(), "cli-manager-history-tests-")), "tests.rs");
writeFileSync(scratch, body);
const testLines = body.split("\n");
const items = parse(scratch);
const groups = new Map();
const fixtures = [];
const imports = items.filter(item => item.kind === "use").map(item => testLines.slice(item.start - 1, item.end).join("\n"));
const groupFor = name => {
  if (plan) return plan.groups.find(group => new RegExp(group.pattern).test(name))?.name ?? "profile";
  if (/kimi/.test(name)) return "kimi_source";
  if (/grok/.test(name)) return "grok";
  if (/opencode/.test(name) && !/history_stats/.test(name)) return "opencode";
  if (/copilot|antigravity|gemini|kiro|pi_session|cline|cursor/.test(name)) return "other_sources";
  if (/remote_history/.test(name)) return "remote";
  if (/route_usage|history_stats|resolve_stats|hour_of_day|scan_session_combined|qualify_model|codex_usage_delta|extract_usage_tokens/.test(name)) return "usage_stats";
  if (/convert_|conversion_matrix|append_jsonl|v2_adapter/.test(name)) return "conversion";
  if (/resolve_session_file_ref|path_within_history_scope|wsl|codex_runtime_path|codex_state_registration|session_matches_project_path/.test(name)) return "scope_paths";
  return "session_pipeline";
};
for (const item of items.filter(item => item.kind !== "use")) {
  assert.equal(item.kind, "fn");
  const text = testLines.slice(item.start - 1, item.end).join("\n");
  if (!/#\[(?:tokio::)?test\]/.test(text)) {
    fixtures.push(text.replace(/^(\s*)(async )?fn /m, "$1pub(super) $2fn "));
    continue;
  }
  const group = groupFor(item.name);
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(text);
}
const outputs = new Map();
outputs.set(`${destination}/fixtures.rs`, `${imports.join("\n")}\n\n${fixtures.join("\n\n")}\n`);
for (const [name, tests] of groups) outputs.set(`${destination}/${name}.rs`, `use super::*;\n\n${tests.join("\n\n")}\n`);
outputs.set(`${destination}.rs`, `${imports.join("\n")}\nmod fixtures;\nuse fixtures::*;\n${[...groups.keys()].map(name => `mod ${name};`).join("\n")}\n`);
for (const [target, content] of outputs) {
  assert.ok(!existsSync(target), target);
  assert.ok(content.split("\n").length <= 2000, target);
}
if (!process.argv.includes("--write")) {
  console.log(JSON.stringify({ functions: items.filter(item => item.kind === "fn").map(item => item.name), groups: [...outputs].map(([file, text]) => ({ file, lines: text.split("\n").length })) }));
} else {
  mkdirSync(destination, { recursive: true });
  for (const [target, content] of outputs) writeFileSync(target, content);
  lines.splice(owner.start - 1, owner.end - owner.start + 1, "#[cfg(test)]", "mod tests;");
  writeFileSync(file, lines.join("\n"));
  console.log(`Extracted ${[...groups.values()].reduce((count, tests) => count + tests.length, 0)} tests into ${groups.size} named groups with shared fixtures.`);
}
