import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-ssh-files-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

function writeModule(name, source) {
  const path = join(tempDir, name);
  writeFileSync(path, source, "utf8");
  return path;
}

function transpile(relativePath, outputName, replacements) {
  let output = ts.transpileModule(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
      fileName: outputName.replace(/\.mjs$/, ".ts"),
    },
  ).outputText;
  for (const [from, to] of Object.entries(replacements)) {
    output = output.replaceAll(`from "${from}"`, `from "${to}"`);
  }
  return writeModule(outputName, output);
}

writeModule("ssh.mjs", `
export const buildSshConnectionSpec = () => ({ host: "example.test", port: 22, username: "dev" });
`);
writeModule("sshClientIdentity.mjs", `
export const getSshClientInstanceId = () => "client-1";
`);
writeModule("sshToolIntegration.mjs", `
export const resolveSshToolSource = (value) => value === "claude" || value === "codex" ? value : null;
export const resolveSshHistorySource = resolveSshToolSource;
`);
writeModule("sshHostStore.mjs", `
const state = {
  loaded: true,
  hosts: [{ id: "host-1" }],
  fetchHosts: async () => undefined,
};
export const useSshHostStore = { getState: () => state };
`);
writeModule("sshAgentIntegrationStore.mjs", `
const state = {
  loaded: true,
  installations: [{
    host_id: "host-1",
    status: "installed",
    install_path: "/home/dev/.local/bin/cli-manager-ssh-agent",
    installation_id: "installation-1",
    remote_machine_id: "machine-1",
  }],
  preferences: [],
  integrations: [],
  fetchAll: async () => undefined,
};
export const useSshAgentIntegrationStore = { getState: () => state };
`);
writeModule("tauriCore.mjs", "export const invoke = async () => undefined;\n");
writeModule("backgroundOperationStore.mjs", `
const state = { start() {}, succeed() {}, fail() {} };
export const useBackgroundOperationStore = { getState: () => state };
`);
writeModule("i18n.mjs", "export {};\n");

const historyPath = transpile("../src/lib/sshAgentHistory.ts", "sshAgentHistory.mjs", {
  "./ssh": "./ssh.mjs",
  "./sshClientIdentity": "./sshClientIdentity.mjs",
  "./sshToolIntegration": "./sshToolIntegration.mjs",
  "../stores/sshAgentIntegrationStore": "./sshAgentIntegrationStore.mjs",
  "../stores/sshHostStore": "./sshHostStore.mjs",
});
const remoteFilesPath = transpile("../src/lib/sshRemoteFiles.ts", "sshRemoteFiles.mjs", {
  "@tauri-apps/api/core": "./tauriCore.mjs",
  "./sshAgentHistory": "./sshAgentHistory.mjs",
  "../stores/backgroundOperationStore": "./backgroundOperationStore.mjs",
  "./i18n": "./i18n.mjs",
});

const { buildSshAgentHistoryContext } = await import(pathToFileURL(historyPath).href);
const { buildSshRemoteFileContext } = await import(pathToFileURL(remoteFilesPath).href);

const sshProjectWithoutCliTool = {
  id: "project-1",
  name: "Remote shell",
  environment_type: "ssh",
  ssh_host_id: "host-1",
  remote_path: "/srv/project",
  cli_tool: "",
  cli_config_root: "",
};

test("SSH file context does not require a configured CLI tool", async () => {
  const context = await buildSshRemoteFileContext(sshProjectWithoutCliTool);

  assert.equal(context.rootPath, "/srv/project");
  assert.equal(context.launch.toolSource, "");
  assert.equal(context.launch.agentInstallationId, "installation-1");
  assert.match(context.consumerId, /^files:client-1:host-1:project-1$/);
});

test("remote history still requires a supported CLI source", async () => {
  await assert.rejects(
    buildSshAgentHistoryContext(sshProjectWithoutCliTool),
    /history_remote_source_required/,
  );
});
