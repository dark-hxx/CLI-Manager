import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperManifest = path.join(repoRoot, "src-tauri", "helpers", "Cargo.toml");
const helperNames = ["cli-manager-daemon", "cli-manager-web-daemon", "cli-manager-codex-proxy"];

export function helperTargetRoot(env = process.env) {
  return path.resolve(repoRoot, env.CARGO_TARGET_DIR || path.join("src-tauri", "target"));
}

export function helperProfile(env = process.env) {
  return env.TAURI_ENV_DEBUG === "true" ? "debug" : "release";
}

export function buildAndInstallHelperBinaries({
  targetRoot = helperTargetRoot(),
  profile = helperProfile(),
  spawn = spawnSync,
} = {}) {
  const helperTarget = path.join(targetRoot, "helper-binaries");
  mkdirSync(helperTarget, { recursive: true });
  const args = ["build", "--manifest-path", helperManifest, "--target-dir", helperTarget];
  if (profile === "release") args.push("--release");

  const result = spawn("cargo", args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`helper binary build failed with exit code ${result.status ?? "unknown"}`);
  }

  const sourceDir = path.join(helperTarget, profile);
  const outputDir = path.join(targetRoot, profile);
  mkdirSync(outputDir, { recursive: true });
  for (const name of helperNames) {
    const source = path.join(sourceDir, `${name}.exe`);
    const output = path.join(outputDir, `${name}.exe`);
    if (!existsSync(source)) throw new Error(`missing helper binary: ${source}`);
    copyFileSync(source, output);
  }
}

export function helperBinaryPaths(targetRoot, profile) {
  return helperNames.map((name) => path.join(targetRoot, profile, `${name}.exe`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform === "win32") {
    buildAndInstallHelperBinaries();
  }
}
