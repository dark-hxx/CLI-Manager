import { invoke } from "@tauri-apps/api/core";
import { translateCurrent } from "../../../shared/i18n/index";

export interface DeepSeekSourceInfo {
  hostEntryPath?: string;
  version: string;
  profileVersion: string;
}

/** Validate the official host and prepared TUI plugin profile without installing or executing either. */
export async function validateDeepSeekSource(sourceRoot: string, envText?: string | null): Promise<DeepSeekSourceInfo> {
  try {
    let env: unknown;
    try { env = JSON.parse(envText || "{}"); }
    catch { throw new Error("deepseek_env_invalid"); }
    if (!env || typeof env !== "object" || Array.isArray(env)
      || Object.values(env).some((value) => typeof value !== "string")) throw new Error("deepseek_env_invalid");
    return await invoke<DeepSeekSourceInfo>("deepseek_tui_preflight", { sourceRoot: sourceRoot || null, envVars: env });
  } catch (error) {
    throw deepSeekLaunchError(error);
  }
}

/** Translate stable preparation failures before they reach project and terminal UI. */
export function deepSeekLaunchError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const keys = {
    deepseek_source_invalid: "configModal.deepseek.sourceInvalid",
    deepseek_source_unbuilt: "configModal.deepseek.sourceUnbuilt",
    deepseek_source_native_only: "configModal.deepseek.guestHelp",
    deepseek_shell_unsupported: "configModal.deepseek.shellUnsupported",
    deepseek_env_invalid: "configModal.deepseek.envInvalid",
    deepseek_tui_args_invalid: "configModal.deepseek.argsInvalid",
    deepseek_tui_profile_required: "configModal.deepseek.profileRequired",
    deepseek_tui_web_args_unsupported: "configModal.deepseek.webArgsUnsupported",
    deepseek_tui_resume_required: "configModal.deepseek.resumeRequired",
    deepseek_tui_node_missing: "configModal.deepseek.nodeMissing",
    deepseek_tui_host_missing: "configModal.deepseek.hostMissing",
    deepseek_tui_launcher_missing: "configModal.deepseek.launcherMissing",
    deepseek_tui_home_invalid: "configModal.deepseek.homeInvalid",
    deepseek_tui_profile_missing: "configModal.deepseek.profileMissing",
    deepseek_tui_profile_unbuilt: "configModal.deepseek.profileUnbuilt",
    deepseek_tui_bridge_unsupported: "configModal.deepseek.bridgeUnsupported",
    deepseek_tui_patch_failed: "configModal.deepseek.patchFailed",
  } as const;
  const key = keys[message as keyof typeof keys];
  return key ? new Error(translateCurrent(key)) : error instanceof Error ? error : new Error(message);
}
