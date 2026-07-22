import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = path.join(repoRoot, "src-tauri");
const DEV_CONFIG = "src-tauri/tauri.dev.conf.json";
const args = process.argv.slice(2);

function commandArgsContainConfig(argsToCheck) {
  const commandArgs = [];
  for (const arg of argsToCheck) {
    if (arg === "--") break;
    commandArgs.push(arg);
  }

  return commandArgs.some(
    (arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config=") || arg.startsWith("-c="),
  );
}

function commandOptionValue(argsToCheck, option) {
  for (let index = 0; index < argsToCheck.length; index += 1) {
    const arg = argsToCheck[index];
    if (arg === "--") break;
    if (arg === option) return argsToCheck[index + 1] ?? null;
    if (arg.startsWith(`${option}=`)) return arg.slice(option.length + 1);
  }
  return null;
}

function commandArgsContain(argsToCheck, option) {
  for (const arg of argsToCheck) {
    if (arg === "--") break;
    if (arg === option) return true;
  }
  return false;
}

function withDevConfig(argsToRun) {
  if (argsToRun[0] !== "dev" || commandArgsContainConfig(argsToRun)) {
    return argsToRun;
  }

  return ["dev", "--config", DEV_CONFIG, ...argsToRun.slice(1)];
}

function resolveConfigPaths(argsToRun) {
  const resolvedArgs = [...argsToRun];

  for (let index = 0; index < resolvedArgs.length; index += 1) {
    const arg = resolvedArgs[index];
    if (arg === "--") break;

    if ((arg === "--config" || arg === "-c") && resolvedArgs[index + 1]) {
      const config = resolvedArgs[index + 1];
      if (!path.isAbsolute(config) && !config.trimStart().startsWith("{")) {
        resolvedArgs[index + 1] = path.resolve(repoRoot, config);
      }
      index += 1;
      continue;
    }

    const configPrefix = ["--config=", "-c="].find((prefix) => arg.startsWith(prefix));
    if (!configPrefix) continue;

    const config = arg.slice(configPrefix.length);
    if (!path.isAbsolute(config) && !config.trimStart().startsWith("{")) {
      resolvedArgs[index] = `${configPrefix}${path.resolve(repoRoot, config)}`;
    }
  }

  return resolvedArgs;
}

function devSpawnEnv(argsToRun) {
  if (process.platform !== "win32" || argsToRun[0] !== "dev" || !process.env.LOCALAPPDATA) {
    return process.env;
  }

  return {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER:
      process.env.WEBVIEW2_USER_DATA_FOLDER ??
      path.join(process.env.LOCALAPPDATA, "com.cli-manager.app", "EBWebView-dev"),
  };
}

const tauriArgs = resolveConfigPaths(withDevConfig(args));

function buildWindowsDevProxy(argsToRun) {
  if (process.platform !== "win32" || argsToRun[0] !== "dev") {
    return Promise.resolve(0);
  }

  const cargoArgs = [
    "build",
    "--locked",
    "--manifest-path",
    path.join(tauriRoot, "Cargo.toml"),
    "--bin",
    "cli-manager-codex-proxy",
  ];
  const target = commandOptionValue(argsToRun, "--target")
    ?? commandOptionValue(argsToRun, "-t");
  if (target) cargoArgs.push("--target", target);
  if (commandArgsContain(argsToRun, "--release")) cargoArgs.push("--release");

  return new Promise((resolve) => {
    const child = spawn("cargo", cargoArgs, {
      cwd: tauriRoot,
      stdio: "inherit",
      shell: true,
      env: devSpawnEnv(argsToRun),
    });
    child.on("error", (error) => {
      console.error(`Failed to build Codex app-server proxy: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const proxyBuildCode = await buildWindowsDevProxy(tauriArgs);
  if (proxyBuildCode !== 0) {
    process.exitCode = proxyBuildCode;
    return;
  }

  let child;
  try {
    child = spawn("tauri", tauriArgs, {
      cwd: tauriRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: devSpawnEnv(tauriArgs),
    });
  } catch (error) {
    console.error(`Failed to start Tauri CLI: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  child.on("error", (error) => {
    console.error(`Failed to start Tauri CLI: ${error.message}`);
    process.exitCode = 1;
  });

  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

void main();
