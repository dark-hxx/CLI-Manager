import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperManifest = path.join(repoRoot, "src-tauri", "helpers", "Cargo.toml");
const helperNames = ["cli-manager-daemon", "cli-manager-web-daemon", "cli-manager-codex-proxy"];
// Windows 上运行中的可执行文件无法被覆盖，这三个错误码都表示“被占用”。
const LOCK_CODES = ["EBUSY", "EPERM", "EACCES"];
const INSTALL_ATTEMPTS = 20;
const INSTALL_DELAY_MS = 250;

export function helperTargetRoot(env = process.env) {
  return path.resolve(repoRoot, env.CARGO_TARGET_DIR || path.join("src-tauri", "target"));
}

export function helperProfile(env = process.env) {
  return env.TAURI_ENV_DEBUG === "true" ? "debug" : "release";
}

// helper 编译环境必须稳定：TAURI_CONFIG 的存在与否会改变 cli-manager 库 build script 的输入，
// 让整套依赖图在“设了/没设”之间反复失效重编（实测单次 45s 以上）。
// helper 只由本脚本与打包脚本编译，统一剥离该变量以保证增量缓存命中。
function helperBuildEnv(env = process.env) {
  const { TAURI_CONFIG: _ignored, ...stable } = env;
  return stable;
}

// 目标目录下的 helper 可能正被运行中的 daemon 独占；文件锁只影响覆盖，不影响编译产物。
// 逐个重试后仍失败则告警并保留旧二进制，避免一个占用文件打断整条 dev 启动流程。
async function copyIntoPlace({ helperTarget, targetRoot, profile }) {
  const sourceDir = path.join(helperTarget, profile);
  const outputDir = path.join(targetRoot, profile);
  mkdirSync(outputDir, { recursive: true });

  const locked = [];
  for (const name of helperNames) {
    const source = path.join(sourceDir, `${name}.exe`);
    if (!existsSync(source)) throw new Error(`missing helper binary: ${source}`);

    const output = path.join(outputDir, `${name}.exe`);
    let installed = false;
    for (let attempt = 0; attempt < INSTALL_ATTEMPTS && !installed; attempt += 1) {
      try {
        copyFileSync(source, output);
        installed = true;
      } catch (error) {
        if (!LOCK_CODES.includes(error.code)) throw error;
        if (attempt === INSTALL_ATTEMPTS - 1) {
          locked.push(name);
          break;
        }
        // 等待占用进程释放句柄；Windows 上运行中的 exe 无法被覆盖。
        await new Promise((resolve) => setTimeout(resolve, INSTALL_DELAY_MS));
      }
    }
  }

  if (locked.length > 0) {
    console.warn(
      `[helper-binaries] 无法覆盖 ${locked.join(", ")}（被运行中的进程占用），已保留旧二进制。` +
        "关闭对应 daemon 后重新启动 dev 即可完成更新。",
    );
  }
  return { locked };
}

// 编译 helper 并安装到主应用 target 目录。
// 用 spawn 而非 spawnSync：dev server 已监听后调用，同步阻塞会挡住 Tauri CLI 的 devUrl 轮询。
export async function buildAndInstallHelperBinaries({
  targetRoot = helperTargetRoot(),
  profile = helperProfile(),
  env = process.env,
} = {}) {
  const helperTarget = path.join(targetRoot, "helper-binaries");
  mkdirSync(helperTarget, { recursive: true });
  const args = ["build", "--manifest-path", helperManifest, "--target-dir", helperTarget];
  if (profile === "release") args.push("--release");

  await new Promise((resolve, reject) => {
    const child = spawn("cargo", args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: helperBuildEnv(env),
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`helper binary build failed with exit code ${code ?? "unknown"}`));
    });
  });

  return copyIntoPlace({ helperTarget, targetRoot, profile });
}

export function helperBinaryPaths(targetRoot, profile) {
  return helperNames.map((name) => path.join(targetRoot, profile, `${name}.exe`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform === "win32") {
    await buildAndInstallHelperBinaries();
  }
}
