import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-resume-cli-args-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

function transpile(sourceUrl, outputName, replacements = {}) {
  const source = readFileSync(sourceUrl, "utf8");
  let output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: outputName.replace(/\.mjs$/, ".ts"),
  }).outputText;
  for (const [from, to] of Object.entries(replacements)) {
    output = output.replaceAll(`from "${from}"`, `from "${to}"`);
  }
  const outputPath = join(tempDir, outputName);
  writeFileSync(outputPath, output, "utf8");
  return outputPath;
}

writeFileSync(
  join(tempDir, "shell.mjs"),
  "export const normalizeShellKey = (value) => value;\n",
  "utf8",
);
writeFileSync(
  join(tempDir, "terminalStore.mjs"),
  "export const detectCliResumeKind = () => null;\n",
  "utf8",
);

transpile(new URL("../src/lib/resumeCliArgs.ts", import.meta.url), "resumeCliArgs.mjs");
transpile(new URL("../src/lib/providerSwitching.ts", import.meta.url), "providerSwitching.mjs");
const projectStartupPath = transpile(
  new URL("../src/lib/projectStartupCommand.ts", import.meta.url),
  "projectStartupCommand.mjs",
  {
    "./providerSwitching": "./providerSwitching.mjs",
    "./resumeCliArgs": "./resumeCliArgs.mjs",
    "./shell": "./shell.mjs",
  },
);
const saveSessionPath = transpile(
  new URL("../src/lib/saveSessionToSidebar.ts", import.meta.url),
  "saveSessionToSidebar.mjs",
  {
    "../stores/terminalStore": "./terminalStore.mjs",
    "./resumeCliArgs": "./resumeCliArgs.mjs",
  },
);

const { stripResumeCliArgs } = await import(
  pathToFileURL(join(tempDir, "resumeCliArgs.mjs")).href
);
const { appendResumeCliArgs } = await import(pathToFileURL(projectStartupPath).href);
const { buildResumeCliArgs } = await import(pathToFileURL(saveSessionPath).href);

const OLD_ID = "019f2c9e-ed25-73e1-a883-86d578fc9e08";
const NEW_ID = "019f5e8b-2d11-76d1-89b4-a0c0ff20d111";

test("strips supported Codex and Claude resume fragments", () => {
  const cases = [
    `resume ${OLD_ID}`,
    `resume --no-alt-screen ${OLD_ID}`,
    "resume --last",
    "resume --no-alt-screen --last",
    "resume --all",
    `resume --include-non-interactive ${OLD_ID}`,
    `--resume ${OLD_ID}`,
    `--resume=${OLD_ID}`,
    "--continue",
  ];

  for (const cliArgs of cases) {
    assert.equal(stripResumeCliArgs(cliArgs), "", cliArgs);
  }
});

test("keeps ordinary CLI arguments around a removed resume fragment", () => {
  assert.equal(
    stripResumeCliArgs(`--model o3 resume ${OLD_ID}`),
    "--model o3",
  );
  assert.equal(
    stripResumeCliArgs(`resume ${OLD_ID} --sandbox workspace-write`),
    "--sandbox workspace-write",
  );
  assert.equal(
    stripResumeCliArgs(`--model "o 3" --resume ${OLD_ID} --permission-mode plan`),
    '--model "o 3" --permission-mode plan',
  );
});

test("parses Codex resume options before the old session id", () => {
  const cases = [
    [`resume --model o3 ${OLD_ID}`, "--model o3"],
    [
      `resume --sandbox workspace-write ${OLD_ID}`,
      "--sandbox workspace-write",
    ],
    ["resume --all", ""],
    [`resume --include-non-interactive ${OLD_ID}`, ""],
    [`resume -c model=o3 ${OLD_ID}`, "-c model=o3"],
    [
      `resume --profile provider-a --enable feature-x ${OLD_ID} "old prompt"`,
      "--profile provider-a --enable feature-x",
    ],
    [
      `resume ${OLD_ID} "old prompt" --model o3 --search`,
      "--model o3 --search",
    ],
  ];

  for (const [cliArgs, expected] of cases) {
    assert.equal(stripResumeCliArgs(cliArgs), expected, cliArgs);
  }
});

test("remote and history resume command construction never appends a second resume target", () => {
  const project = {
    cli_tool: "codex",
    cli_args: `--model o3 resume ${OLD_ID} --sandbox workspace-write`,
    startup_cmd: "",
    provider_overrides: JSON.stringify({
      codex: {
        providerId: "provider-id",
        providerName: "Provider",
        profileName: "cli-manager-provider",
      },
    }),
    shell: "powershell",
  };

  const command = appendResumeCliArgs(
    `codex resume --no-alt-screen ${NEW_ID}`,
    "codex",
    project,
  );

  assert.equal(
    command,
    `codex resume --no-alt-screen ${NEW_ID} --model o3 --sandbox workspace-write --profile cli-manager-provider`,
  );
  assert.equal(command.match(/(?:^|\s)resume(?:\s|$)/g)?.length, 1);
  assert.equal(command.match(/(?:^|\s)--profile(?:\s|$)/g)?.length, 1);
});

test("saved-session CLI arguments reuse the same resume stripping rules", () => {
  assert.equal(
    buildResumeCliArgs("codex", `--model o3 resume ${OLD_ID}`, NEW_ID),
    `--model o3 resume --no-alt-screen ${NEW_ID}`,
  );
  assert.equal(
    buildResumeCliArgs("claude", "--continue --model sonnet", NEW_ID),
    `--model sonnet --resume ${NEW_ID}`,
  );
});
