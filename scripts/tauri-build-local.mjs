import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

// 只为本地打包子进程覆盖优化参数和缓存位置，保留父环境及正式发布配置。
export function localBuildOptions(args, env = process.env) {
  return {
    command: process.execPath,
    args: [path.join(repoRoot, "scripts/tauri-cli.mjs"), "build",
      "--config", "src-tauri/tauri.local.conf.json", ...args],
    options: {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...env,
        CARGO_TARGET_DIR: path.resolve(repoRoot, env.CARGO_TARGET_DIR || "src-tauri/target", "local"),
        CARGO_PROFILE_RELEASE_LTO: "off",
        CARGO_PROFILE_RELEASE_OPT_LEVEL: "2",
        CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
        CARGO_PROFILE_RELEASE_INCREMENTAL: "true",
        CARGO_INCREMENTAL: "1",
      },
    },
  };
}

function spawnAndWait(spawnProcess, command, args, options) {
  return new Promise((resolve) => {
    const child = spawnProcess(command, args, options);
    child.once("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

// Windows 本地打包完成后复用发布流水线的便携包脚本；--no-bundle 表示调用方不要任何打包产物。
export function portablePackagePlan(args, env = process.env, platform = process.platform) {
  if (platform !== "win32" || args.includes("--no-bundle")) return null;
  const { version } = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const localTarget = path.resolve(repoRoot, env.CARGO_TARGET_DIR || "src-tauri/target", "local");
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(repoRoot, "scripts/package-portable.ps1"),
      "-Version", version,
      "-SourceDir", path.join(localTarget, "release"),
      "-OutputDir", path.join(repoRoot, "dist/portable")],
    options: { cwd: repoRoot, stdio: "inherit", env },
  };
}

// 复用既有 Tauri 入口；启动失败、信号终止和非零退出都传回调用方，打包成功后再生成便携 ZIP。
export async function runLocalBuild(args, env = process.env, spawnProcess = spawn, platform = process.platform) {
  const plan = localBuildOptions(args, env);
  const code = await spawnAndWait(spawnProcess, plan.command, plan.args, plan.options);
  if (code !== 0) return code;
  const portable = portablePackagePlan(args, env, platform);
  if (!portable) return 0;
  return spawnAndWait(spawnProcess, portable.command, portable.args, portable.options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = await runLocalBuild(process.argv.slice(2));
}
