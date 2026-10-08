import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "cli-manager-dsh-node options-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const outfile = join(dir, "helpers.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/shared/lib/deepseekTui.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
const helpers = await import(pathToFileURL(outfile).href);
const managerPath = join(dir, "manager preload % !.mjs");
const userPath = join(dir, "user preload & ! %.cjs");
const probePath = join(dir, "probe.mjs");
const recordPath = join(dir, "records.jsonl");
const wrapperPath = join(dir, "node options.cmd");
const npmShimPath = join(dir, "mock npm launcher.cmd");
// Rust bridge_cache_publication_is_complete_and_shared_without_tab_state also round-trips
// a real space+bang cache directory. Execute the same normalization and batch resource here.
// Production returns an equivalent file URI with bang encoded before any shell sees it.
const preloadUrl = pathToFileURL(managerPath).href.replaceAll("!", "%21");
writeFileSync(managerPath, 'process.env.CLI_MANAGER_TEST_PRELOAD = "loaded";\n');
writeFileSync(userPath, 'process.env.CLI_MANAGER_TEST_USER_PRELOAD = "loaded";\n');
writeFileSync(probePath, `import { appendFileSync } from "node:fs";
appendFileSync(process.env.CLI_MANAGER_TEST_RECORD, JSON.stringify({ phase: process.argv[2], present: Object.hasOwn(process.env, "NODE_OPTIONS"), options: process.env.NODE_OPTIONS, manager: process.env.CLI_MANAGER_TEST_PRELOAD ?? null, user: process.env.CLI_MANAGER_TEST_USER_PRELOAD ?? null, args: process.argv.slice(3) }) + "\\n");
if (process.argv[2] === "failure") process.exit(7);
`);
const rust = readFileSync(new URL("../src-tauri/src/features/deepseek/launch.rs", import.meta.url), "utf8");
assert.ok(rust.includes(`.replace('!', "%21")`), "Actual Rust URL normalization must encode bang");
assert.ok(rust.includes('include_str!("../../../resources/deepseek-tui-node-options.cmd")'), "Use the exact production batch resource");
const template = readFileSync(new URL("../src-tauri/resources/deepseek-tui-node-options.cmd", import.meta.url), "utf8");
assert.ok(template.includes("{{PRELOAD_URL}}"));
assert.ok(template.includes("%*"));
assert.ok(!/\bcall\b/i.test(template), "Arguments are forwarded once, without CALL expansion");
writeFileSync(wrapperPath, template.replaceAll("{{PRELOAD_URL}}", preloadUrl.replaceAll("%", "%%")));
// Match npm's ENDLOCAL & node.exe %* trampoline rather than substituting a direct executable.
writeFileSync(npmShimPath, [
  "@echo off", "setlocal", `set "NODE_EXE=${process.execPath}"`,
  `endlocal & "%NODE_EXE%" "${probePath}" %*`, "",
].join("\r\n"));
const originalOptions = `  --require="${userPath.replaceAll("\\", "/")}"  `;
const argumentsToPreserve = ["space & ! % literal", "single'quote", "double quoted value"];
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
const shQuote = value => `'${value.replaceAll("'", `'"'"'`)}'`;
const cmdQuote = value => `"${value}"`;
function envFor(original) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (["NODE_OPTIONS", "CLI_MANAGER_TEST_PRELOAD", "CLI_MANAGER_TEST_USER_PRELOAD"].includes(key.toUpperCase())) delete env[key];
  }
  if (original !== undefined) env.NODE_OPTIONS = original;
  env.CLI_MANAGER_TEST_RECORD = recordPath;
  return env;
}
function commandFor(kind, phase, values = argumentsToPreserve) {
  const quote = kind === "powershell" ? psQuote : kind === "cmd" ? cmdQuote : shQuote;
  return `${kind === "powershell" ? "& " : ""}${quote(process.execPath)} ${quote(probePath)} ${quote(phase)} ${values.map(quote).join(" ")}`;
}
function records() {
  return readFileSync(recordPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function verify(original, phase) {
  const data = records();
  assert.equal(data.length, 2, "Both managed and subsequent ordinary Node must execute");
  const [managed, ordinary] = data;
  assert.equal(managed.phase, phase);
  assert.equal(managed.manager, "loaded", "Manager --import must actually run");
  assert.equal(managed.user, original === undefined ? null : "loaded", "Original user --require must actually run");
  assert.ok(managed.options.includes(`--import=${preloadUrl}`));
  if (original !== undefined) assert.ok(managed.options.includes(original.trim()));
  assert.deepEqual(managed.args, argumentsToPreserve);
  assert.equal(ordinary.phase, "ordinary");
  assert.equal(ordinary.present, original !== undefined, "Originally absent NODE_OPTIONS must stay absent");
  assert.equal(ordinary.options, original, "Original NODE_OPTIONS whitespace and value must be restored exactly");
  assert.equal(ordinary.manager, null, "Subsequent ordinary Node must not load the manager preload");
  assert.equal(ordinary.user, original === undefined ? null : "loaded");
}
function run(kind, executable, original, phase, npmShim = false) {
  writeFileSync(recordPath, "");
  const command = npmShim
    ? `${cmdQuote(npmShimPath)} ${cmdQuote(phase)} ${argumentsToPreserve.map(cmdQuote).join(" ")}`
    : commandFor(kind, phase);
  const wrapped = helpers.withDeepSeekTuiPreload(command, preloadUrl, wrapperPath, kind);
  const next = commandFor(kind, "ordinary", []);
  let args;
  if (kind === "powershell") args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${wrapped}; ${next}`];
  else if (kind === "cmd") args = ["/d", "/q", "/v:off", "/s", "/c", `"${wrapped} & ${next}"`];
  else args = ["--noprofile", "--norc", "-c", `${wrapped}; ${next}`];
  const result = spawnSync(executable, args, { env: envFor(original), encoding: "utf8", timeout: 20000, windowsHide: true, windowsVerbatimArguments: kind === "cmd" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Shell failed: ${result.stderr}\n${result.stdout}`);
  assert.equal(result.stderr, "", "Preload paths and inherited NODE_OPTIONS must not become shell code or missing imports");
  verify(original, phase);
}
const windows = process.platform === "win32";
const shells = [
  { kind: "powershell", executable: "powershell.exe", enabled: windows },
  { kind: "cmd", executable: process.env.ComSpec || "cmd.exe", enabled: windows },
];
const bash = windows
  ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"].find(existsSync)
  : "/bin/bash";
shells.push({ kind: "bash", executable: bash, enabled: !!bash && existsSync(bash) });
for (const { kind, executable, enabled } of shells) {
  for (const original of [undefined, originalOptions]) {
    for (const phase of ["managed", "failure"]) {
      test(`${kind}: ${phase}, ${original === undefined ? "absent" : "user --require"} NODE_OPTIONS remains scoped`, { skip: enabled ? false : `${kind} unavailable` }, () => run(kind, executable, original, phase));
    }
  }
}
test("PowerShell: terminating throw restores exact NODE_OPTIONS before the next Node", { skip: windows ? false : "Windows PowerShell unavailable" }, () => {
  writeFileSync(recordPath, "");
  const command = `${commandFor("powershell", "managed")}; throw 'fixture failure'`;
  const wrapped = helpers.withDeepSeekTuiPreload(command, preloadUrl, wrapperPath, "powershell");
  const script = `try { ${wrapped} } catch { if ($_.Exception.Message -ne 'fixture failure') { throw } }; ${commandFor("powershell", "ordinary", [])}`;
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { env: envFor(originalOptions), encoding: "utf8", timeout: 20000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  verify(originalOptions, "managed");
});

for (const original of [undefined, originalOptions]) {
  for (const phase of ["managed", "failure"]) {
    test(`cmd npm .cmd→node.exe: ${phase}, ${original === undefined ? "absent" : "user --require"} options stay scoped`, { skip: windows ? false : "CMD unavailable" }, () => run("cmd", process.env.ComSpec || "cmd.exe", original, phase, true));
  }
}
