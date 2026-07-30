import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReleaseEnvironment,
  exportActionsEnvironment,
  normalizeR2PublicBaseUrl,
  renderInstaller,
} from "./r2-release-config.mjs";

const root = await mkdtemp(join(tmpdir(), "cli-manager-r2-config-"));

try {
  assert.equal(
    normalizeR2PublicBaseUrl("https://downloads.example.com/"),
    "https://downloads.example.com",
  );
  for (const invalid of [
    "",
    "http://downloads.example.com",
    "https://user@downloads.example.com",
    "https://downloads.example.com/releases",
    "https://downloads.example.com?channel=stable",
    "https://downloads.example.com#stable",
  ]) {
    assert.throws(() => normalizeR2PublicBaseUrl(invalid));
  }

  const environment = buildReleaseEnvironment("https://downloads.example.com/");
  assert.equal(environment.R2_PUBLIC_BASE_URL, "https://downloads.example.com");
  assert.equal(
    environment.CLI_MANAGER_R2_AGENT_MANIFEST_URL,
    "https://downloads.example.com/CLI-Manager/releases/ssh-agent/latest/ssh-agent-release-manifest.json",
  );
  assert.deepEqual(JSON.parse(environment.TAURI_CONFIG).plugins.updater.endpoints, [
    "https://downloads.example.com/CLI-Manager/releases/latest/latest.json",
    "https://github.com/dark-hxx/CLI-Manager/releases/latest/download/latest.json",
  ]);

  const environmentFile = join(root, "github-env");
  await exportActionsEnvironment("https://downloads.example.com", environmentFile);
  assert.match(
    await readFile(environmentFile, "utf8"),
    /^VITE_R2_PUBLIC_BASE_URL=https:\/\/downloads\.example\.com$/m,
  );

  const installerInput = join(root, "install-input.sh");
  const installerOutput = join(root, "install-output.sh");
  await writeFile(
    installerInput,
    '#!/bin/sh\nR2_PUBLIC_BASE_URL="https://old.example.com"\nprintf "%s\\n" "$R2_PUBLIC_BASE_URL"\n',
    "utf8",
  );
  await renderInstaller(installerInput, installerOutput, "https://downloads.example.com/");
  assert.match(
    await readFile(installerOutput, "utf8"),
    /^R2_PUBLIC_BASE_URL="https:\/\/downloads\.example\.com"$/m,
  );

  console.log("R2 release config test: 12 checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
