import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetRoot = path.join(repoRoot, "src-tauri", "target");
const profile = process.env.TAURI_ENV_DEBUG === "true" ? "debug" : "release";
const binaryName = process.platform === "win32" ? "cli-manager-daemon.exe" : "cli-manager-daemon";
const universalDir = path.join(targetRoot, "universal-apple-darwin", profile);
const output = path.join(universalDir, binaryName);

if (process.env.TAURI_ENV_PLATFORM !== "darwin" || process.env.TAURI_ENV_ARCH !== "universal") {
  process.exit(0);
}

const arm64 = path.join(targetRoot, "aarch64-apple-darwin", profile, binaryName);
const x64 = path.join(targetRoot, "x86_64-apple-darwin", profile, binaryName);

for (const binary of [arm64, x64]) {
  if (!existsSync(binary)) {
    console.error(`Missing architecture-specific daemon binary: ${binary}`);
    process.exit(1);
  }
}

const result = spawnSync("lipo", ["-create", arm64, x64, "-output", output], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Failed to start lipo: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
