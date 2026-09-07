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
const retryMarkerPath = path.join(temporaryDirectory, "locked-binary-retry.marker");
const lockedBinaryPath = path.join(
  repoRoot,
  "src-tauri",
  "target",
  "debug",
  "cli-manager.exe",
);
const environmentLogPath = path.join(temporaryDirectory, "cargo-environment.log");

function writeCommand(name, body) {
  writeFileSync(path.join(temporaryDirectory, `${name}.cmd`), `@echo off\r\n${body}\r\n`, "utf8");
}

function runTauriCli(args, cargoExitCode = 0, extraEnv = {}) {
  writeFileSync(logPath, "", "utf8");
  rmSync(retryMarkerPath, { force: true });
  writeFileSync(environmentLogPath, "", "utf8");
  const result = spawnSync(process.execPath, [tauriCliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${temporaryDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      TAURI_CLI_DEV_PROXY_TEST_LOG: logPath,
      TAURI_CLI_DEV_PROXY_TEST_ENV_LOG: environmentLogPath,
      TAURI_CLI_DEV_PROXY_TEST_CARGO_EXIT_CODE: String(cargoExitCode),
      TAURI_CLI_LOCKED_BINARY_RETRY_MARKER: retryMarkerPath,
      TAURI_CLI_LOCKED_BINARY_PATH: lockedBinaryPath,
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    lines: readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean),
    environment: readFileSync(environmentLogPath, "utf8").split(/\r?\n/).filter(Boolean),
  };
}

try {
  writeCommand(
    "cargo",
    `>> "%TAURI_CLI_DEV_PROXY_TEST_LOG%" echo cargo %*\r\nif defined TAURI_CONFIG set TAURI_CONFIG >> "%TAURI_CLI_DEV_PROXY_TEST_ENV_LOG%"\r\nexit /b %TAURI_CLI_DEV_PROXY_TEST_CARGO_EXIT_CODE%`,
  );
  writeCommand(
    "tauri",
    `if "%TAURI_CLI_LOCKED_BINARY_RETRY_TEST%"=="1" if not exist "%TAURI_CLI_LOCKED_BINARY_RETRY_MARKER%" (\r\n` +
      `  > "%TAURI_CLI_LOCKED_BINARY_RETRY_MARKER%" echo retry\r\n` +
      `  >> "%TAURI_CLI_DEV_PROXY_TEST_LOG%" echo error: failed to remove file \`%TAURI_CLI_LOCKED_BINARY_PATH%\`\r\n` +
      `  >> "%TAURI_CLI_DEV_PROXY_TEST_LOG%" echo Caused by: os error 5\r\n` +
      `  echo error: failed to remove file \`%TAURI_CLI_LOCKED_BINARY_PATH%\` 1>&2\r\n` +
      `  echo Caused by: os error 5 1>&2\r\n` +
      `  exit /b 1\r\n` +
      `)\r\n` +
      `>> "%TAURI_CLI_DEV_PROXY_TEST_LOG%" echo tauri %*\r\n` +
      `exit /b 0`,
  );

  const dev = runTauriCli(["dev", "--target", "x86_64-pc-windows-msvc"]);
  assert.equal(dev.status, 0, "tauri dev must succeed after the proxy build succeeds");
  assert.equal(dev.lines.length, 2, "proxy build must finish before Tauri starts");
  assert.match(dev.lines[0], /cargo build --locked/);
  assert.match(dev.lines[0], /--no-default-features/);
  assert.match(dev.lines[0], /--bin cli-manager --bin cli-manager-codex-proxy/);
  assert.match(dev.lines[0], /--target x86_64-pc-windows-msvc/);
  assert.match(dev.lines[1], /^tauri dev --config /);
  assert.equal(dev.environment.length, 1);
  assert.equal(
    dev.environment[0],
    'TAURI_CONFIG={"$schema":"https://schema.tauri.app/config/2","productName":"CLI-Manager Dev","version":"1.2.1-dev.0"}',
  );

  const inlineConfigValue = JSON.stringify({ build: { devUrl: "http://127.0.0.1:2420" } });
  const inlineConfig = runTauriCli(["dev", "--config", inlineConfigValue]);
  assert.equal(inlineConfig.status, 0);
  assert.equal(inlineConfig.environment[0], `TAURI_CONFIG=${inlineConfigValue}`);

  const mergeConfigPath = path.join(temporaryDirectory, "merge-config.json");
  writeFileSync(
    mergeConfigPath,
    JSON.stringify({ build: { beforeDevCommand: "npm run custom-dev", frontendDist: "../dist" } }),
    "utf8",
  );
  const mergedConfig = runTauriCli([
    "dev",
    "--config",
    mergeConfigPath,
    "--config",
    JSON.stringify({ build: { devUrl: "http://127.0.0.1:2420", frontendDist: null } }),
  ]);
  assert.equal(mergedConfig.status, 0);
  assert.equal(
    mergedConfig.environment[0],
    'TAURI_CONFIG={"build":{"beforeDevCommand":"npm run custom-dev","devUrl":"http://127.0.0.1:2420"}}',
  );

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

  const features = runTauriCli(["dev", "--features", "diagnostics", "telemetry"]);
  assert.equal(features.status, 0);
  assert.match(features.lines[0], /--features diagnostics,telemetry/);

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

  const retryEnv = { TAURI_CLI_LOCKED_BINARY_RETRY_TEST: "1" };
  const retryWithLock = runTauriCli(["dev"], 0, retryEnv);
  assert.equal(retryWithLock.status, 0, "locked local dev binary must be recovered automatically");
  assert.equal(
    retryWithLock.lines.filter((line) => line.startsWith("tauri ")).length,
    1,
  );

  const buildWithLock = runTauriCli(["build"], 0, retryEnv);
  assert.equal(buildWithLock.status, 1, "locked binary recovery must stay limited to tauri dev");
  assert.equal(buildWithLock.lines.filter((line) => line.startsWith("tauri ")).length, 0);

  const runnerArguments = runTauriCli([
    "dev",
    "--",
    "--features",
    "runner-feature",
    "--",
    "--features",
    "ignored",
  ]);
  assert.equal(runnerArguments.status, 0);
  assert.match(runnerArguments.lines[0], /--features runner-feature/);
  assert.doesNotMatch(runnerArguments.lines[0], /ignored/);

  const failedBuild = runTauriCli(["dev"], 23);
  assert.equal(failedBuild.status, 23, "proxy build failure must stop tauri dev");
  assert.equal(failedBuild.lines.length, 1);
  assert.match(failedBuild.lines[0], /^cargo build --locked/);

  const build = runTauriCli(["build"]);
  assert.equal(build.status, 0);
  assert.deepEqual(build.lines, ["tauri build"]);

  console.log("tauri dev proxy preparation test: 22 checks passed");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
