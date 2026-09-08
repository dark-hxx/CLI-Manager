import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appLocalDataDir, join } from "@tauri-apps/api/path";

/**
 * Resolve an asset-protocol URL for a path that lives under
 * `$APPLOCALDATA/`. Returns `null` when path resolution fails.
 *
 * The returned URL is shaped like `http://asset.localhost/<encoded-abs-path>`
 * on Windows and `asset://localhost/<encoded-abs-path>` on macOS/Linux.
 * Loading still requires the path to satisfy
 * `tauri.conf.json` → `app.security.assetProtocol.scope`.
 */
export async function backgroundAssetUrl(relPath: string): Promise<string | null> {
  try {
    const base = await appLocalDataDir();
    const abs = await join(base, relPath);
    return convertFileSrc(abs);
  } catch {
    return null;
  }
}

/**
 * Check whether a background image still exists on disk.
 *
 * Delegates to the Rust command `background_image_exists`, which resolves
 * the path under `$APPLOCALDATA/backgrounds/` and returns `false` for any
 * path that escapes the backgrounds directory.
 */
export async function backgroundImageExists(relPath: string): Promise<boolean> {
  try {
    return await invoke<boolean>("background_image_exists", { relativePath: relPath });
  } catch {
    return false;
  }
}
