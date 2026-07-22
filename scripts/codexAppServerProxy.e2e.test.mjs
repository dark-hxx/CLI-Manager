import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "src-tauri", "Cargo.toml");
const proxyEnvironmentKeys = [
  "CLI_MANAGER_CODEX_APP_SERVER_PROXY",
  "CLI_MANAGER_CODEX_EXPECTED_SESSION_ID",
  "CLI_MANAGER_CODEX_LAUNCHER",
  "CLI_MANAGER_CODEX_BASE_URL_OVERRIDE",
  "CLI_MANAGER_CODEX_ENV_KEY_OVERRIDE",
  "CLI_MANAGER_CODEX_MODEL_OVERRIDE",
  "CLI_MANAGER_CODEX_WIRE_API_OVERRIDE",
  "CLI_MANAGER_TEST_API_KEY",
];
const providerSecret = "sk-e2e-secret-value";

if (process.platform !== "win32") {
  console.log("codex app-server proxy E2E skipped: Windows only");
  process.exit(0);
}

function buildProxy() {
  const build = spawnSync(
    "cargo",
    [
      "build",
      "--locked",
      "--manifest-path",
      manifestPath,
      "--bin",
      "cli-manager-codex-proxy",
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
      timeout: 10 * 60 * 1000,
      windowsHide: true,
    },
  );
  if (build.error) {
    throw build.error;
  }
  assert.equal(build.status, 0, "building the real Codex proxy must succeed");
}

function resolveProxyPath() {
  const configuredTarget = process.env.CARGO_TARGET_DIR;
  const targetRoot = configuredTarget
    ? path.resolve(repoRoot, configuredTarget)
    : path.join(repoRoot, "src-tauri", "target");
  return path.join(targetRoot, "debug", "cli-manager-codex-proxy.exe");
}

function readPeSubsystem(executablePath) {
  const image = readFileSync(executablePath);
  assert.ok(image.length >= 0x40, "proxy must contain a DOS header");
  assert.equal(image.toString("ascii", 0, 2), "MZ", "proxy must be a PE image");
  const peOffset = image.readUInt32LE(0x3c);
  assert.equal(
    image.toString("binary", peOffset, peOffset + 4),
    "PE\u0000\u0000",
    "proxy must contain a valid PE signature",
  );
  const optionalHeaderOffset = peOffset + 24;
  const optionalHeaderMagic = image.readUInt16LE(optionalHeaderOffset);
  assert.ok(
    optionalHeaderMagic === 0x10b || optionalHeaderMagic === 0x20b,
    `unexpected PE optional header magic: 0x${optionalHeaderMagic.toString(16)}`,
  );
  return image.readUInt16LE(optionalHeaderOffset + 68);
}

function cleanProxyEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of proxyEnvironmentKeys) {
    delete environment[key];
  }
  return { ...environment, ...overrides };
}

function runProxy({
  proxyPath,
  launcher,
  childArgs,
  capturePath,
  provider = false,
  exitCode = 0,
  requestId,
}) {
  const environment = cleanProxyEnvironment({
    CLI_MANAGER_CODEX_LAUNCHER: launcher,
    FAKE_CODEX_CAPTURE_PATH: capturePath,
    FAKE_CODEX_EXIT_CODE: String(exitCode),
  });
  if (provider) {
    Object.assign(environment, {
      CLI_MANAGER_CODEX_BASE_URL_OVERRIDE:
        "model_providers.cli_manager_remote.base_url=https://provider.example.com/v1",
      CLI_MANAGER_CODEX_ENV_KEY_OVERRIDE:
        "model_providers.cli_manager_remote.env_key=CLI_MANAGER_TEST_API_KEY",
      CLI_MANAGER_CODEX_MODEL_OVERRIDE: "model=gpt-5.4",
      CLI_MANAGER_CODEX_WIRE_API_OVERRIDE:
        "model_providers.cli_manager_remote.wire_api=responses",
      CLI_MANAGER_TEST_API_KEY: providerSecret,
    });
  }

  const request = {
    jsonrpc: "2.0",
    id: requestId,
    method: "initialize",
    params: { marker: `request-${requestId}` },
  };
  const result = spawnSync(proxyPath, childArgs, {
    cwd: repoRoot,
    env: environment,
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  return { result, request, capture: JSON.parse(readFileSync(capturePath, "utf8")) };
}

function assertForwarding(run) {
  assert.deepEqual(run.capture.request, run.request, "stdin JSONL must reach Codex unchanged");
  const response = JSON.parse(run.result.stdout.trim());
  assert.equal(response.id, run.request.id, "Codex response ID must be forwarded");
  assert.equal(
    response.result.marker,
    run.request.params.marker,
    "Codex stdout payload must be forwarded",
  );
}

buildProxy();
const proxyPath = resolveProxyPath();
assert.equal(
  readPeSubsystem(proxyPath),
  2,
  "Codex proxy must use the Windows GUI subsystem to avoid allocating a console",
);

const temporaryDirectory = mkdtempSync(
  path.join(os.tmpdir(), "cli-manager-codex-proxy-e2e-"),
);

try {
  const fakeCodexScript = path.join(temporaryDirectory, "fake-codex.mjs");
  const fakeCodexCmd = path.join(temporaryDirectory, "codex.cmd");
  writeFileSync(
    fakeCodexScript,
    `import { writeFileSync } from "node:fs";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input.trim());
writeFileSync(process.env.FAKE_CODEX_CAPTURE_PATH, JSON.stringify({
  args: process.argv.slice(2),
  request,
  apiKeyPresent: typeof process.env.CLI_MANAGER_TEST_API_KEY === "string",
  apiKeyMatches: process.env.CLI_MANAGER_TEST_API_KEY === ${JSON.stringify(providerSecret)},
}));
process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  id: request.id,
  result: { marker: request.params.marker },
}) + "\\n");
process.exitCode = Number(process.env.FAKE_CODEX_EXIT_CODE || "0");
`,
    "utf8",
  );
  writeFileSync(
    fakeCodexCmd,
    `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\nexit /b %errorlevel%\r\n`,
    "utf8",
  );

  const noProviderCapture = path.join(temporaryDirectory, "no-provider.json");
  const noProvider = runProxy({
    proxyPath,
    launcher: process.execPath,
    childArgs: [fakeCodexScript, "app-server", "--listen", "stdio://"],
    capturePath: noProviderCapture,
    exitCode: 23,
    requestId: 101,
  });
  assert.equal(noProvider.result.status, 23, "proxy must forward the EXE launcher's exit code");
  assert.deepEqual(noProvider.capture.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(noProvider.capture.apiKeyPresent, false);
  assertForwarding(noProvider);

  const providerCapture = path.join(temporaryDirectory, "provider.json");
  const withProvider = runProxy({
    proxyPath,
    launcher: fakeCodexCmd,
    childArgs: ["app-server", "--listen", "stdio://"],
    capturePath: providerCapture,
    provider: true,
    requestId: 202,
  });
  assert.equal(withProvider.result.status, 0, "proxy must complete through a CMD launcher");
  assert.deepEqual(withProvider.capture.args, [
    "-c",
    "model_provider=cli_manager_remote",
    "-c",
    "model_providers.cli_manager_remote.name=CLI-Manager remote",
    "-c",
    "model_providers.cli_manager_remote.base_url=https://provider.example.com/v1",
    "-c",
    "model_providers.cli_manager_remote.env_key=CLI_MANAGER_TEST_API_KEY",
    "-c",
    "model_providers.cli_manager_remote.wire_api=responses",
    "-c",
    "model=gpt-5.4",
    "app-server",
    "--listen",
    "stdio://",
  ]);
  assert.equal(withProvider.capture.apiKeyPresent, true);
  assert.equal(withProvider.capture.apiKeyMatches, true);
  assert.ok(!withProvider.capture.args.some((argument) => argument.includes(providerSecret)));
  assert.ok(!withProvider.result.stdout.includes(providerSecret));
  assert.ok(!withProvider.result.stderr.includes(providerSecret));
  assertForwarding(withProvider);

  console.log("codex app-server proxy E2E: 3 checks passed");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
