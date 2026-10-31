import { spawn } from "node:child_process";
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

// 复用既有 Tauri 入口；启动失败、信号终止和非零退出都传回调用方。
export function runLocalBuild(args, env = process.env, spawnProcess = spawn) {
  const plan = localBuildOptions(args, env);
  return new Promise((resolve) => {
    const child = spawnProcess(plan.command, plan.args, plan.options);
    child.once("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = await runLocalBuild(process.argv.slice(2));
}
