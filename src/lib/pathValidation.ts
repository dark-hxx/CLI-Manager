import { invoke } from "@tauri-apps/api/core";

/** Shared with terminal/project editing: check that a local path exists. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    const result = await invoke<boolean[]>("check_paths_exist", { paths: [path] });
    return Boolean(result[0]);
  } catch {
    return false;
  }
}
