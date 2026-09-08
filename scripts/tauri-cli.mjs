import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = path.join(repoRoot, "src-tauri");
const DEV_CONFIG = "src-tauri/tauri.dev.conf.json";
const args = process.argv.slice(2);
const CARGO_VALUE_OPTIONS = ["--target", "-t", "--profile", "--target-dir", "--features", "-F"];

// 只检查首个分隔符前的 Tauri 参数是否已指定配置。
function commandArgsContainConfig(argsToCheck) {
  const commandArgs = [];
  for (const arg of argsToCheck) {
    if (arg === "--") break;
    commandArgs.push(arg);
  }

  return commandArgs.some(
    // 识别配置参数的长短名称及等号形式。
    (arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config=") || arg.startsWith("-c="),
  );
}

// 提取预构建需要的目标、配置和特性参数，不读取第二个分隔符后的程序参数。
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
      // 匹配 Cargo 支持的带值选项及其等号形式。
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

// 仅为未显式指定配置的 dev 命令注入项目开发配置。
function withDevConfig(argsToRun) {
  if (argsToRun[0] !== "dev" || commandArgsContainConfig(argsToRun)) {
    return argsToRun;
  }

  return ["dev", "--config", DEV_CONFIG, ...argsToRun.slice(1)];
}

// 将 Tauri 配置文件参数解析为仓库绝对路径，内联 JSON 保持原值。
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

    // 查找等号形式的配置参数前缀。
    const configPrefix = ["--config=", "-c="].find((prefix) => arg.startsWith(prefix));
    if (!configPrefix) continue;

    const config = arg.slice(configPrefix.length);
    if (!path.isAbsolute(config) && !config.trimStart().startsWith("{")) {
      resolvedArgs[index] = `${configPrefix}${path.resolve(repoRoot, config)}`;
    }
  }

  return resolvedArgs;
}

// 按出现顺序收集首个分隔符前的配置合并参数。
function configMergeValues(argsToCheck) {
  const values = [];

  for (let index = 1; index < argsToCheck.length; index += 1) {
    const arg = argsToCheck[index];
    if (arg === "--") break;

    const option = ["--config", "-c"].find(
      // 识别配置选项的独立值或等号赋值形式。
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

// 递归合并对象，null 删除字段，数组和标量整体替换。
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

// 读取内联 JSON 或配置文件并解析，错误由调用方处理。
function readConfigMergeValue(value) {
  const trimmedValue = value.trim();
  const configText = trimmedValue.startsWith("{")
    ? trimmedValue
    : readFileSync(path.resolve(tauriRoot, trimmedValue), "utf8");
  return JSON.parse(configText);
}

// 将配置合并结果镜像到 Cargo 环境，失败时警告并保留基础环境。
function tauriCargoEnv(argsToRun) {
  const environment = devSpawnEnv(argsToRun);
  const configValues = configMergeValues(argsToRun);
  if (configValues.length === 0) return environment;

  try {
    const mergedConfig = configValues.reduce(
      // 按参数顺序读取并合并后续配置覆盖值。
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

// 为 Windows dev 默认隔离 WebView 用户数据目录，尊重已有环境覆盖。
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

// 仅在 Windows dev 预构建主程序和 Codex 代理，并返回构建退出码。
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

  // 把 Cargo 进程错误及退出事件汇合为预构建结果。
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;

    console.log(
      "[tauri-dev] Preparing Rust dev binaries (Cargo fingerprint will reuse unchanged artifacts)...",
    );

    // 只结算一次预构建，记录耗时和结果后完成 Promise。
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
    // Cargo 启动错误打印诊断并将预构建标记失败。
    child.on("error", (error) => {
      console.error(`Failed to build Codex app-server proxy: ${error.message}`);
      finish(1);
    });
    // 将 Cargo 退出码交给统一结算，缺少退出码按失败处理。
    child.on("exit", (code) => finish(code ?? 1));
  });
}

// 等待必要预构建成功后启动 Tauri，向包装进程传播失败或退出状态。
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
