import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = path.join(repoRoot, "src-tauri");
const DEV_CONFIG = "src-tauri/tauri.dev.conf.json";
const args = process.argv.slice(2);
const CARGO_VALUE_OPTIONS = ["--target", "-t", "--profile", "--target-dir", "--features", "-F"];

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

function cargoBuildSelectionArgs(argsToCheck) {
  const selectionArgs = [];
  let separatorCount = 0;

  for (let index = 1; index < argsToCheck.length; index += 1) {
    const arg = argsToCheck[index];
    if (arg === "--") {
      separatorCount += 1;
      if (separatorCount === 2) break;
      continue;
    }

    if (arg === "--release") {
      selectionArgs.push(arg);
      continue;
    }

    const option = CARGO_VALUE_OPTIONS.find(
      (candidate) => arg === candidate || arg.startsWith(`${candidate}=`),
    );
    if (!option) continue;

    const inlineValue = arg.startsWith(`${option}=`)
      ? arg.slice(option.length + 1)
      : null;
    if (option === "--features" || option === "-F") {
      const featureValues = [];
      if (inlineValue !== null) {
        featureValues.push(inlineValue);
      } else {
        const value = argsToCheck[index + 1];
        if (!value || value === "--") continue;
        featureValues.push(value);
        index += 1;
      }

      while (index + 1 < argsToCheck.length) {
        const value = argsToCheck[index + 1];
        if (value === "--" || value.startsWith("-")) break;
        featureValues.push(value);
        index += 1;
      }
      selectionArgs.push("--features", featureValues.join(","));
      continue;
    }

    const value = inlineValue ?? argsToCheck[index + 1];
    if (!value || value === "--") continue;
    selectionArgs.push(option === "-t" ? "--target" : option, value);
    if (inlineValue === null) index += 1;
  }

  return selectionArgs;
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

function configMergeValues(argsToCheck) {
  const values = [];

  for (let index = 1; index < argsToCheck.length; index += 1) {
    const arg = argsToCheck[index];
    if (arg === "--") break;

    const option = ["--config", "-c"].find(
      (candidate) => arg === candidate || arg.startsWith(`${candidate}=`),
    );
    if (!option) continue;

    const inlineValue = arg.startsWith(`${option}=`)
      ? arg.slice(option.length + 1)
      : null;
    const value = inlineValue ?? argsToCheck[index + 1];
    if (!value || value === "--") continue;
    values.push(value);
    if (inlineValue === null) index += 1;
  }

  return values;
}

function mergeConfigValue(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return patch;
  }

  const merged = target && typeof target === "object" && !Array.isArray(target)
    ? { ...target }
    : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    merged[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeConfigValue(merged[key], value)
      : value;
  }
  return merged;
}

function readConfigMergeValue(value) {
  const trimmedValue = value.trim();
  const configText = trimmedValue.startsWith("{")
    ? trimmedValue
    : readFileSync(path.resolve(tauriRoot, trimmedValue), "utf8");
  return JSON.parse(configText);
}

function tauriCargoEnv(argsToRun) {
  const environment = devSpawnEnv(argsToRun);
  const configValues = configMergeValues(argsToRun);
  if (configValues.length === 0) return environment;

  try {
    const mergedConfig = configValues.reduce(
      (merged, value) => mergeConfigValue(merged, readConfigMergeValue(value)),
      {},
    );
    return { ...environment, TAURI_CONFIG: JSON.stringify(mergedConfig) };
  } catch (error) {
    console.warn(
      `[tauri-dev] Could not mirror --config for the Cargo prebuild: ${error.message}`,
    );
    return environment;
  }
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
    "--no-default-features",
    "--manifest-path",
    path.join(tauriRoot, "Cargo.toml"),
    "--bin",
    "cli-manager",
    "--bin",
    "cli-manager-codex-proxy",
  ];
  cargoArgs.push(...cargoBuildSelectionArgs(argsToRun));

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;

    console.log(
      "[tauri-dev] Preparing Rust dev binaries (Cargo fingerprint will reuse unchanged artifacts)...",
    );

    const finish = (code) => {
      if (settled) return;
      settled = true;
      const duration = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
      if (code === 0) {
        console.log(
          `[tauri-dev] Rust dev binaries ready in ${duration}; Cargo reused unchanged artifacts when possible.`,
        );
      } else {
        console.error(`[tauri-dev] Rust dev binary prebuild failed in ${duration} (exit ${code}).`);
      }
      resolve(code);
    };

    const child = spawn("cargo", cargoArgs, {
      cwd: tauriRoot,
      stdio: "inherit",
      shell: true,
      env: tauriCargoEnv(argsToRun),
    });
    child.on("error", (error) => {
      console.error(`Failed to build Codex app-server proxy: ${error.message}`);
      finish(1);
    });
    child.on("exit", (code) => finish(code ?? 1));
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
