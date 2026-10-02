import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "cli-manager-dsh-tui-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
async function load(path, name) {
  const out = join(dir, name + ".mjs");
  await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true, platform: "node", format: "esm", outfile: out });
  return import(pathToFileURL(out).href);
}
const tui = await load("../src/shared/lib/deepseekTui.ts", "tui");
const startup = await load("../src/features/projects/api/projectStartupCommand.ts", "startup");
const icons = await load("../src/shared/lib/cliTools.ts", "icons");

test("DSH descriptors select the plugin profile, including legacy identities and launcher aliases", () => {
  for (const tool of ["dsh", "dsh.cmd", "dsh web", "deepseek-harness", "dsh --profile dsh-tui", "dsh-tui", "dst", "dst.cmd"]) {
    assert.equal(tui.isDeepSeekTuiTool(tool), true, tool);
    assert.equal(icons.resolveCliToolIconKey(tool), "deepseek-harness", tool);
    assert.equal(icons.resolveCliToolHistorySourceId(tool), null, tool);
    assert.equal(icons.resolveCliToolImagePasteMode(tool), "unsupported", tool);
    assert.equal(tui.buildDeepSeekTuiCommand(tool, "", "", "pwsh"), "dsh-tui");
  }
  for (const tool of ["deepseek", "echo dsh", "my-dsh-tui", "dsh --profile web"]) assert.equal(tui.isDeepSeekTuiTool(tool), false);
  assert.equal(icons.CLI_TOOL_DESCRIPTORS.filter((tool) => tool.vendor === "deepseek").length, 1);
  assert.equal(icons.CLI_TOOL_DESCRIPTORS.find((tool) => tool.vendor === "deepseek").command, "dsh-tui");
});

test("legacy generated Web defaults migrate without changing literal prompt options", () => {
  assert.equal(tui.buildDeepSeekTuiCommand("dsh", "--profile web --port 0 --no-open", ""), "dsh-tui");
  assert.equal(tui.buildDeepSeekTuiCommand("dsh web", "web --port=0", ""), "dsh-tui");
  assert.equal(tui.buildDeepSeekTuiCommand("dsh", '-- --profile web --port 0 --no-open', ""),
    'dsh-tui -- --profile web --port 0 --no-open');
  assert.equal(tui.buildDeepSeekTuiCommand("dsh", '--patch --port=0', ""), 'dsh-tui --patch --port=0');
  assert.equal(tui.buildDeepSeekTuiCommand("dsh", '--patch --no-open', ""), 'dsh-tui --patch --no-open');
  assert.throws(() => tui.buildDeepSeekTuiCommand("dsh", "--port 4100", ""), /web_args_unsupported/);
  assert.throws(() => tui.buildDeepSeekTuiCommand("dsh-tui", "--profile web", ""), /profile_required/);
});

test("source launch uses official host CLI with literal quoting and preserves project cwd", () => {
  assert.equal(tui.buildDeepSeekTuiCommand("dsh", "", "C:/source tree", "pwsh"),
    "node 'C:/source tree/apps/cli/lib/bin.js' --profile dsh-tui");
  assert.equal(tui.buildDeepSeekTuiCommand("dsh", "", "C:/O'Neil", "pwsh"),
    "node 'C:/O''Neil/apps/cli/lib/bin.js' --profile dsh-tui");
  assert.equal(tui.buildDeepSeekTuiCommand("dst", "", "C:/source tree", "cmd"),
    'node "C:/source tree/apps/cli/lib/bin.js" --profile dsh-tui');
  for (const root of ["relative", "C:/bad\nroot", "C:/a&evil"]) {
    assert.throws(() => tui.buildDeepSeekTuiCommand("dsh", "", root, "cmd"));
  }
  for (const env of ["ssh", "wsl"]) assert.throws(() => tui.buildDeepSeekTuiCommand("dsh", "", "C:/source", "pwsh", env), /native_only/);
  assert.throws(() => tui.buildDeepSeekTuiCommand("dsh", "", "C:/source", "C:/Windows/System32/wsl.exe"), /native_only/);
  assert.throws(() => tui.buildDeepSeekTuiCommand("dsh", "", "C:/source", "unknown-shell"), /shell_unsupported/);
});

test("host patches precede app arguments and literal prompts keep their separator", () => {
  const command = tui.buildDeepSeekTuiCommand("dsh-tui", '--patch "C:/my patch.yml" --resume sid-1 -- hello --resume=literal', "");
  assert.equal(command, 'dsh-tui --patch "C:/my patch.yml" --resume sid-1 -- hello --resume=literal');
  assert.deepEqual(tui.prepareDeepSeekTuiCommand(command), {
    command: 'dsh-tui --patch "C:/my patch.yml" -- hello --resume=literal', resumeSessionId: "sid-1",
  });
  assert.deepEqual(tui.prepareDeepSeekTuiCommand('& dst --resume sid-2'), { command: '& dst', resumeSessionId: 'sid-2' });
  assert.deepEqual(tui.prepareDeepSeekTuiCommand('dst --resume sid-2'), { command: 'dst', resumeSessionId: 'sid-2' });
  assert.equal(tui.withDeepSeekTuiPatch('dsh --profile dsh-tui --patch user.yml -- -- prompt', 'C:/app cache/bridge.yml', 'pwsh'),
    "dsh --profile dsh-tui --patch user.yml --patch 'C:/app cache/bridge.yml' -- -- prompt");
  const patched = tui.withDeepSeekTuiPatch('dsh --profile dsh-tui --patch user.yml -- -- prompt', 'C:/app cache/bridge.yml', 'pwsh');
  assert.equal(tui.withDeepSeekTuiPatch(patched, 'C:/app cache/bridge.yml', 'pwsh'), patched);
  assert.equal(tui.withDeepSeekTuiPatch('dsh --profile dsh-tui --patch="C:/app cache/bridge.yml"', 'C:/app cache/bridge.yml', 'pwsh'),
    "dsh --profile dsh-tui --patch 'C:/app cache/bridge.yml'");
});

test("explicit per-tab recovery never falls back to the global latest-session pointer", () => {
  for (const args of ["--resume", "--resume=", "--continue", "-c", '--resume ""', "--resume ../../other"]) {
    assert.throws(() => tui.buildDeepSeekTuiCommand("dsh", args, ""), /resume_required/);
  }
  assert.deepEqual(tui.prepareDeepSeekTuiCommand('dsh --profile dsh-tui --resume=sid-3'),
    { command: 'dsh --profile dsh-tui', resumeSessionId: 'sid-3' });
  assert.throws(() => tui.prepareDeepSeekTuiCommand('dsh --profile dsh-tui --profile web'), /profile_required/);
  const previous = 'dsh --profile dsh-tui --patch overlay.yml --resume old-id -- -- literal';
  const restored = tui.buildDeepSeekTuiResumeCommand(previous, 'this-tab-id');
  assert.deepEqual(tui.prepareDeepSeekTuiCommand(restored), {
    command: 'dsh --profile dsh-tui --patch overlay.yml -- -- literal', resumeSessionId: 'this-tab-id',
  });
  for (const missing of [undefined, '', 'other;echo bad']) {
    const fresh = tui.buildDeepSeekTuiResumeCommand(previous, missing);
    assert.equal(fresh, 'dsh --profile dsh-tui --patch overlay.yml -- -- literal');
  }
  assert.equal(tui.buildDeepSeekTuiResumeCommand('dsh --profile dsh-tui -c'), 'dsh --profile dsh-tui');
});

test("managed TUI rejects shell chains without consuming another command's resume selector", () => {
  for (const command of ['dsh-tui && echo --resume other', 'dsh-tui;echo --resume other',
    'dsh-tui || echo fallback', 'dsh-tui | other', 'dsh-tui > output', 'dsh-tui < input',
    'dsh-tui\necho --resume other', 'dsh --profile dsh-tui ; other']) {
    assert.equal(tui.isDeepSeekTuiCommand(command), false, command);
    assert.throws(() => tui.prepareDeepSeekTuiCommand(command), /deepseek_tui_args_invalid/);
  }
  const literal = 'dsh-tui --prompt "keep ; && || | < > literally"';
  assert.equal(tui.isDeepSeekTuiCommand(literal), true);
  assert.equal(tui.prepareDeepSeekTuiCommand(literal).command, literal);
  assert.equal(tui.isDeepSeekTuiCommand('& dsh --profile dsh-tui'), true);
});

test("native launchers retain their entry and receive bridge flags before app arguments", () => {
  assert.deepEqual(tui.prepareDeepSeekTuiCommand('dsh-tui'), { command: 'dsh-tui', resumeSessionId: null });
  assert.equal(tui.buildDeepSeekTuiCommand('dsh-tui', '--model example', ''), 'dsh-tui --model example');
  assert.equal(tui.withDeepSeekTuiPatch('dsh-tui --patch user.yml --model example', 'C:/cache path/bridge.yml', 'pwsh'),
    "dsh-tui --patch user.yml --patch 'C:/cache path/bridge.yml' --model example");
  assert.equal(tui.withDeepSeekTuiPatch('& dst --dump-config -- hello --patch literal', 'C:/cache path/bridge.yml', 'pwsh'),
    "& dst --dump-config --patch 'C:/cache path/bridge.yml' -- hello --patch literal");
  const resumed = tui.buildDeepSeekTuiResumeCommand('dsh-tui --model example', 'this-tab-id');
  assert.deepEqual(tui.prepareDeepSeekTuiCommand(resumed), { command: 'dsh-tui --model example', resumeSessionId: 'this-tab-id' });
  assert.throws(() => tui.prepareDeepSeekTuiCommand('dsh-tui --profile web'), /profile_required/);
  assert.throws(() => tui.prepareDeepSeekTuiCommand('dst --port 88'), /web_args_unsupported/);
});

test("recognition requires the real TUI launcher or official host profile", () => {
  for (const command of ['dsh --profile dsh-tui', 'dsh --profile=dsh-tui', 'dst --resume sid-1',
    "node 'C:/O''Neil/apps/cli/lib/bin.js' --profile dsh-tui"]) assert.equal(tui.isDeepSeekTuiCommand(command), true, command);
  for (const command of ['echo dsh --profile dsh-tui', 'dsh --profile web', 'node fake.js --profile dsh-tui',
    'dsh -- --profile dsh-tui']) assert.equal(tui.isDeepSeekTuiCommand(command), false, command);
});

test("project startup migrates stored DSH projects and retains explicit startup scripts", () => {
  const project = { cli_tool: 'dsh', cli_args: '--port 0 --no-open', startup_cmd: '', env_vars: '{}', shell: 'pwsh', provider_overrides: '{}' };
  assert.equal(startup.resolveProjectStartupCommand(project), 'dsh-tui');
  assert.equal(startup.resolveProjectStartupCommand({ ...project, startup_cmd: 'custom-script --any' }), 'custom-script --any');
  assert.equal(startup.resolveProjectStartupCommand({ ...project, cli_tool: 'codex', cli_args: '--model example' }), 'codex --model example');
  assert.equal(startup.resolveProjectStartupCommand({ ...project, env_vars: JSON.stringify({ CLI_MANAGER_DSH_SOURCE_ROOT: 'C:/source tree' }) }),
    "node 'C:/source tree/apps/cli/lib/bin.js' --profile dsh-tui");
});


test("restored or projectless commands select their actual source host for preflight", () => {
  for (const command of ['dsh --profile dsh-tui', 'dst', 'node fake.js --profile dsh-tui', "node 'C:/repo/apps/cli/lib/bin.js' --profile web"]) {
    assert.equal(tui.getDeepSeekTuiCommandSourceRoot(command), '', command);
  }
  assert.equal(tui.getDeepSeekTuiCommandSourceRoot("node 'C:/O''Neil/apps/cli/lib/bin.js' --profile dsh-tui"), "C:/O'Neil");
  assert.equal(tui.getDeepSeekTuiCommandSourceRoot("& node 'C:/source tree/apps/cli/lib/bin.js' --profile dsh-tui"), 'C:/source tree');
  assert.equal(tui.getDeepSeekTuiCommandSourceRoot('node "C:/source tree/apps/cli/lib/bin.js" --profile dsh-tui'), 'C:/source tree');
  assert.equal(tui.getDeepSeekTuiCommandSourceRoot("node '/tmp/source tree/apps/cli/lib/bin.js' --profile dsh-tui"), '/tmp/source tree');
});


test("direct TUI commands reject Web-only flags and conflicting resume IDs without reinterpreting host values", () => {
  for (const args of ['--port 88', '--port=88', '--no-open']) {
    assert.throws(() => tui.prepareDeepSeekTuiCommand(`dsh --profile dsh-tui ${args}`), /web_args_unsupported/);
  }
  assert.deepEqual(tui.prepareDeepSeekTuiCommand('dsh --profile dsh-tui --patch --no-open --patch --profile=web'), {
    command: 'dsh --profile dsh-tui --patch --no-open --patch --profile=web', resumeSessionId: null,
  });
  assert.deepEqual(tui.prepareDeepSeekTuiCommand('dsh --profile dsh-tui -- --port 88 --no-open'), {
    command: 'dsh --profile dsh-tui -- --port 88 --no-open', resumeSessionId: null,
  });
  assert.throws(() => tui.buildDeepSeekTuiCommand('dsh', '--resume first --resume second', ''), /args_invalid/);
  assert.throws(() => tui.prepareDeepSeekTuiCommand('dsh --profile dsh-tui --resume first --resume second'), /args_invalid/);
  assert.deepEqual(tui.prepareDeepSeekTuiCommand('dsh --profile dsh-tui --resume first --resume first'), {
    command: 'dsh --profile dsh-tui', resumeSessionId: 'first',
  });
});

test("bridge upgrades replace only reserved manager cache patches and preserve other user overlays", () => {
  const previous = `C:/cache/deepseek-tui/${'a'.repeat(64)}/bridge.yml`;
  const current = `C:/cache/deepseek-tui/${'b'.repeat(64)}/bridge.yml`;
  const user = `C:/user-project/deepseek-tui/${'a'.repeat(64)}/bridge.yml`;
  assert.equal(tui.stripDeepSeekTuiManagerPatch(`dsh --profile dsh-tui --patch '${previous}' --patch '${user}' -- --patch '${previous}'`, current),
    `dsh --profile dsh-tui --patch '${user}' -- --patch '${previous}'`);
  assert.equal(tui.withDeepSeekTuiPatch(`dsh --profile dsh-tui --patch '${previous}' --patch '${user}' -- --patch '${previous}'`, current, 'pwsh'),
    `dsh --profile dsh-tui --patch '${user}' --patch '${current}' -- --patch '${previous}'`);
  assert.equal(tui.withDeepSeekTuiPatch(`dsh --profile dsh-tui --patch --patch --patch '${previous}'`, current, 'pwsh'),
    `dsh --profile dsh-tui --patch --patch --patch '${current}'`);
});
