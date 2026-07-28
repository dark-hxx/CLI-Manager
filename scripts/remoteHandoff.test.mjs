import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-remote-handoff-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/lib/remoteHandoff.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "remoteHandoff.ts",
}).outputText.replace(
  'import { invoke } from "@tauri-apps/api/core";',
  "const invoke = () => { throw new Error('invoke is not used by this test'); };",
);
const outputPath = join(tempDir, "remoteHandoff.mjs");
writeFileSync(outputPath, output, "utf8");
const handoff = await import(pathToFileURL(outputPath).href);

const baseSession = {
  id: "local-session",
  kind: "pty",
  projectId: "project-1",
  cliSessionId: "thread-1",
  startupCmd: "codex",
  cwd: null,
  remotePath: "/srv/project",
};

const sshProject = {
  id: "project-1",
  name: "Remote project",
  cli_tool: "codex",
  environment_type: "ssh",
  ssh_host_id: "host-1",
  remote_path: "/srv/project",
};

const sshHost = {
  id: "host-1",
  auth_mode: "agent",
};

function eligibility(overrides = {}) {
  return handoff.getRemoteHandoffEligibility({
    session: baseSession,
    project: sshProject,
    sshHost,
    worktree: null,
    notification: "done",
    processStatus: "exited",
    activeHandoff: null,
    ...overrides,
  });
}

test("stopped SSH Codex sessions with unattended authentication can be handed off", () => {
  assert.deepEqual(eligibility(), { eligible: true, reason: null });
  assert.deepEqual(eligibility({ notification: "failed", processStatus: "running" }), {
    eligible: true,
    reason: null,
  });
  assert.deepEqual(eligibility({ notification: "none", processStatus: "exited" }), {
    eligible: true,
    reason: null,
  });
  assert.equal(handoff.getRemoteHandoffWorkDir(baseSession, sshProject), "/srv/project");
});

test("SSH sessions reject running and unknown states before backend preflight", () => {
  for (const notification of ["running", "attention"]) {
    assert.deepEqual(eligibility({ notification, processStatus: "running" }), {
      eligible: false,
      reason: "task_running",
    });
  }
  assert.deepEqual(eligibility({
    session: { ...baseSession, cliSessionId: undefined },
    notification: "running",
    processStatus: "running",
  }), { eligible: false, reason: "task_running" });
  assert.deepEqual(eligibility({
    session: { ...baseSession, cliSessionId: undefined },
    notification: "none",
    processStatus: "running",
  }), { eligible: false, reason: "task_state_unknown" });
  assert.deepEqual(eligibility({ notification: "none", processStatus: undefined }), {
    eligible: false,
    reason: "task_state_unknown",
  });
  assert.deepEqual(eligibility({
    session: { ...baseSession, cliSessionId: undefined },
    notification: "none",
    processStatus: "exited",
  }), { eligible: false, reason: "missing_cli_session_id" });
});

test("SSH handoff fails closed for missing hosts, interactive auth, and Worktrees", () => {
  assert.deepEqual(eligibility({ sshHost: undefined }), {
    eligible: false,
    reason: "ssh_host_missing",
  });
  assert.deepEqual(eligibility({ sshHost: { ...sshHost, auth_mode: "password_prompt" } }), {
    eligible: false,
    reason: "ssh_interactive_auth_unsupported",
  });
  assert.deepEqual(eligibility({ session: { ...baseSession, worktreeId: "worktree-1" } }), {
    eligible: false,
    reason: "ssh_worktree_unsupported",
  });
});

test("WSL remains unsupported while local Codex handoff behavior is preserved", () => {
  const wslProject = { ...sshProject, environment_type: "wsl", ssh_host_id: null };
  assert.deepEqual(eligibility({ project: wslProject, sshHost: undefined }), {
    eligible: false,
    reason: "path_unsupported",
  });

  const localProject = {
    ...sshProject,
    environment_type: "local",
    ssh_host_id: null,
    remote_path: "",
  };
  const localSession = { ...baseSession, cwd: "F:\\repo", remotePath: undefined };
  assert.deepEqual(eligibility({
    session: localSession,
    project: localProject,
    sshHost: undefined,
  }), { eligible: true, reason: null });
  assert.deepEqual(eligibility({
    session: localSession,
    project: localProject,
    sshHost: undefined,
    notification: "none",
    processStatus: "running",
  }), { eligible: false, reason: "task_state_unknown" });
});
