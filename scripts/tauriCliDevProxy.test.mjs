import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriCliPath = path.join(repoRoot, "scripts", "tauri-cli.mjs");

if (process.platform !== "win32") {
  console.log("tauri dev proxy preparation test skipped: Windows only");
  process.exit(0);
}

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "cli-manager-tauri-dev-proxy-"));
const logPath = path.join(temporaryDirectory, "commands.log");

function writeCommand(name, body) {
  writeFileSync(path.join(temporaryDirectory, `${name}.cmd`), `@echo off\r\n${body}\r\n`, "utf8");
}

function runTauriCli(args, cargoExitCode = 0) {
  writeFileSync(logPath, "", "utf8");
  const result = spawnSync(process.execPath, [tauriCliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${temporaryDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      TAURI_CLI_DEV_PROXY_TEST_LOG: logPath,
      TAURI_CLI_DEV_PROXY_TEST_CARGO_EXIT_CODE: String(cargoExitCode),
    },
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    lines: readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean),
  };
}

try {
  writeCommand(
    "cargo",
    `>> "%TAURI_CLI_DEV_PROXY_TEST_LOG%" echo cargo %*\r\nexit /b %TAURI_CLI_DEV_PROXY_TEST_CARGO_EXIT_CODE%`,
  );
  writeCommand("tauri", `>> "%TAURI_CLI_DEV_PROXY_TEST_LOG%" echo tauri %*\r\nexit /b 0`);

  const dev = runTauriCli(["dev", "--target", "x86_64-pc-windows-msvc"]);
  assert.equal(dev.status, 0, "tauri dev must succeed after the proxy build succeeds");
  assert.equal(dev.lines.length, 2, "proxy build must finish before Tauri starts");
  assert.match(dev.lines[0], /cargo build --locked/);
  assert.match(dev.lines[0], /--bin cli-manager-codex-proxy/);
  assert.match(dev.lines[0], /--target x86_64-pc-windows-msvc/);
  assert.match(dev.lines[1], /^tauri dev --config /);

  const shortTarget = runTauriCli(["dev", "-t", "aarch64-pc-windows-msvc"]);
  assert.equal(shortTarget.status, 0);
  assert.match(shortTarget.lines[0], /--target aarch64-pc-windows-msvc/);

  const inlineLongTarget = runTauriCli(["dev", "--target=x86_64-pc-windows-gnu"]);
  assert.equal(inlineLongTarget.status, 0);
  assert.match(inlineLongTarget.lines[0], /--target x86_64-pc-windows-gnu/);

  const inlineShortTarget = runTauriCli(["dev", "-t=aarch64-pc-windows-msvc"]);
  assert.equal(inlineShortTarget.status, 0);
  assert.match(inlineShortTarget.lines[0], /--target aarch64-pc-windows-msvc/);

  const release = runTauriCli(["dev", "--release"]);
  assert.equal(release.status, 0);
  assert.match(release.lines[0], /--bin cli-manager-codex-proxy --release$/);

  const runnerReleaseArgument = runTauriCli(["dev", "--", "--release"]);
  assert.equal(runnerReleaseArgument.status, 0);
  assert.match(runnerReleaseArgument.lines[0], /--bin cli-manager-codex-proxy --release$/);

  const runnerProfile = runTauriCli(["dev", "--", "--profile", "custom"]);
  assert.equal(runnerProfile.status, 0);
  assert.match(runnerProfile.lines[0], /--profile custom$/);

  const runnerTargetDirectory = runTauriCli([
    "dev",
    "--",
    "--target-dir",
    "custom-target",
  ]);
  assert.equal(runnerTargetDirectory.status, 0);
  assert.match(runnerTargetDirectory.lines[0], /--target-dir custom-target$/);

  const runnerTarget = runTauriCli([
    "dev",
    "--",
    "--target",
    "aarch64-pc-windows-msvc",
  ]);
  assert.equal(runnerTarget.status, 0);
  assert.match(runnerTarget.lines[0], /--target aarch64-pc-windows-msvc$/);

  const applicationArguments = runTauriCli([
    "dev",
    "--",
    "--release",
    "--",
    "--release",
    "--profile",
    "ignored",
  ]);
  assert.equal(applicationArguments.status, 0);
  assert.equal(
    applicationArguments.lines[0].match(/--release/g)?.length,
    1,
    "application arguments must not affect the proxy Cargo build",
  );
  assert.doesNotMatch(applicationArguments.lines[0], /ignored/);

  const failedBuild = runTauriCli(["dev"], 23);
  assert.equal(failedBuild.status, 23, "proxy build failure must stop tauri dev");
  assert.equal(failedBuild.lines.length, 1);
  assert.match(failedBuild.lines[0], /^cargo build --locked/);

  const build = runTauriCli(["build"]);
  assert.equal(build.status, 0);
  assert.deepEqual(build.lines, ["tauri build"]);

  console.log("tauri dev proxy preparation test: 12 checks passed");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
