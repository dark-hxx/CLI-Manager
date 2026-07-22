import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetRoot = path.join(repoRoot, "src-tauri", "target");
const profile = process.env.TAURI_ENV_DEBUG === "true" ? "debug" : "release";
const universalDir = path.join(targetRoot, "universal-apple-darwin", profile);
const helperBinaryNames = ["cli-manager-daemon", "cli-manager-codex-proxy"];

if (process.env.TAURI_ENV_PLATFORM !== "darwin" || process.env.TAURI_ENV_ARCH !== "universal") {
  process.exit(0);
}

mkdirSync(universalDir, { recursive: true });

for (const binaryName of helperBinaryNames) {
  const arm64 = path.join(targetRoot, "aarch64-apple-darwin", profile, binaryName);
  const x64 = path.join(targetRoot, "x86_64-apple-darwin", profile, binaryName);
  const output = path.join(universalDir, binaryName);

  for (const binary of [arm64, x64]) {
    if (!existsSync(binary)) {
      console.error(`Missing architecture-specific helper binary (${binaryName}): ${binary}`);
      process.exit(1);
    }
  }

  const result = spawnSync("lipo", ["-create", arm64, x64, "-output", output], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`Failed to start lipo for ${binaryName}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`lipo failed for ${binaryName} with exit code ${result.status ?? "unknown"}`);
    process.exit(result.status ?? 1);
  }
}
