import { execFile, spawn } from "node:child_process";
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

    const option = ["--target", "-t", "--profile", "--target-dir"].find(
      (candidate) => arg === candidate || arg.startsWith(`${candidate}=`),
    );
    if (!option) continue;

    const inlineValue = arg.startsWith(`${option}=`)
      ? arg.slice(option.length + 1)
      : null;
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

const DEV_BINARY_NAME = "cli-manager.exe";

function extractLockedDevBinaryPath(output) {
  if (
    !/failed to remove file/i.test(output) ||
    !/(os error 5|access is denied|拒绝访问)/i.test(output)
  ) {
    return null;
  }

  const match = output.match(
    /failed to remove file\s+[`'\"]?([^`'\"\r\n]+cli-manager\.exe)[`'\"]?/i,
  );
  if (!match?.[1]) return null;

  const candidate = match[1].trim();
  return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(repoRoot, candidate);
}

function isLocalDevBinary(binaryPath) {
  if (process.platform !== "win32" || !binaryPath) return false;

  const resolvedPath = path.resolve(binaryPath);
  const relativePath = path.relative(tauriRoot, resolvedPath);
  return (
    relativePath &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath) &&
    path.basename(resolvedPath).toLowerCase() === DEV_BINARY_NAME
  );
}

function findProcessIdsByExecutablePath(executablePath) {
  const escapedPath = executablePath.replace(/'/g, "''");
  const script = [
    `$target = '${escapedPath}'`,
    `$processes = Get-CimInstance Win32_Process -Filter \"Name = '${DEV_BINARY_NAME}'\" -ErrorAction SilentlyContinue`,
    "$processes | Where-Object { $_.ExecutablePath -eq $target } | Select-Object -ExpandProperty ProcessId",
  ].join("; ");

  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, encoding: "utf8", timeout: 5_000 },
      (error, stdout) => {
        if (error && !stdout) {
          console.error(`Failed to inspect locked dev process: ${error.message}`);
          resolve([]);
          return;
        }

        resolve(
          [...stdout.matchAll(/\d+/g)]
            .map(([pid]) => Number(pid))
            .filter((pid) => Number.isInteger(pid) && pid > 0),
        );
      },
    );
  });
}

async function stopLockedDevProcesses(executablePath) {
  if (!isLocalDevBinary(executablePath)) return;

  const processIds = await findProcessIdsByExecutablePath(executablePath);
  if (processIds.length === 0) {
    console.error(`No running local dev process found for ${executablePath}; retrying once.`);
    return;
  }

  console.error(
    `Stopping ${processIds.length} local dev process(es) using ${executablePath} before retrying.`,
  );
  for (const pid of processIds) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        console.error(`Failed to stop local dev process ${pid}: ${error.message}`);
      }
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
}

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
  cargoArgs.push(...cargoBuildSelectionArgs(argsToRun));

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

  const runTauri = () =>
    new Promise((resolve) => {
      let output = "";
      let settled = false;
      let child;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      try {
        child = spawn("tauri", tauriArgs, {
          cwd: tauriRoot,
          stdio: ["inherit", "pipe", "pipe"],
          shell: process.platform === "win32",
          env: devSpawnEnv(tauriArgs),
        });
      } catch (error) {
        const message = `Failed to start Tauri CLI: ${error.message}`;
        console.error(message);
        finish({ code: 1, output: message });
        return;
      }

      const forwardOutput = (stream, target) => {
        if (!stream) return;
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          output += chunk;
          target.write(chunk);
        });
      };

      forwardOutput(child.stdout, process.stdout);
      forwardOutput(child.stderr, process.stderr);

      child.on("error", (error) => {
        const message = `Failed to start Tauri CLI: ${error.message}`;
        console.error(message);
        output += message;
        finish({ code: 1, output });
      });

      child.on("close", (code) => finish({ code: code ?? 1, output }));
    });

  const firstRun = await runTauri();
  const lockedBinaryPath = extractLockedDevBinaryPath(firstRun.output);
  if (tauriArgs[0] !== "dev" || firstRun.code === 0 || !isLocalDevBinary(lockedBinaryPath)) {
    process.exitCode = firstRun.code;
    return;
  }

  await stopLockedDevProcesses(lockedBinaryPath);
  console.error("Retrying Tauri dev once after releasing the locked local binary.");
  const retry = await runTauri();
  process.exitCode = retry.code;
}

void main();
