import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("./prepare-r2-release.mjs", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "cli-manager-r2-release-"));

try {
  const input = join(root, "input");
  const output = join(root, "output");
  await mkdir(input);
  await writeFile(
    join(input, "latest.json"),
    JSON.stringify({
      version: "1.3.1",
      platforms: {
        "windows-x86_64": {
          signature: "signed-updater-value",
          url: "https://github.com/dark-hxx/CLI-Manager/releases/download/V1.3.1/app.msi.zip",
        },
      },
    }),
  );
  await writeFile(
    join(input, "ssh-agent-release-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      artifacts: [
        {
          target: "linux-x86_64",
          url: "https://github.com/dark-hxx/CLI-Manager/releases/download/V1.3.1/agent-x64",
          size: 42,
          sha256: "a".repeat(64),
        },
      ],
    }),
  );
  await writeFile(join(input, "app.msi.zip"), "desktop-asset");

  await execFileAsync(process.execPath, [
    script,
    input,
    output,
    "https://github.bwm.de5.net",
    "V1.3.1",
  ]);

  const sourceLatest = JSON.parse(await readFile(join(input, "latest.json"), "utf8"));
  const r2Latest = JSON.parse(await readFile(join(output, "latest.json"), "utf8"));
  const r2Agent = JSON.parse(
    await readFile(join(output, "ssh-agent-release-manifest.json"), "utf8"),
  );

  assert.match(sourceLatest.platforms["windows-x86_64"].url, /^https:\/\/github\.com\//);
  assert.equal(
    r2Latest.platforms["windows-x86_64"].url,
    "https://github.bwm.de5.net/CLI-Manager/releases/V1.3.1/app.msi.zip",
  );
  assert.equal(r2Latest.platforms["windows-x86_64"].signature, "signed-updater-value");
  assert.equal(
    r2Agent.artifacts[0].url,
    "https://github.bwm.de5.net/CLI-Manager/releases/V1.3.1/agent-x64",
  );
  assert.equal(await readFile(join(output, "app.msi.zip"), "utf8"), "desktop-asset");

  await assert.rejects(
    execFileAsync(process.execPath, [script, input, join(root, "invalid"), "http://mirror.invalid", "V1.3.1"]),
  );

  console.log("prepare R2 release test: 7 checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
