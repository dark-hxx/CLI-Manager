import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type StatuslineProfileTool = "claude" | "codex";

export interface StatuslineProfile<T> {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  payload: T;
}

export interface StatuslineProfileState<T> {
  revision: number;
  activeProfileId: string;
  profiles: StatuslineProfile<T>[];
  externalPayload: T | null;
}

export interface StatuslineImportConflict {
  tool: StatuslineProfileTool;
  profileId: string;
  name: string;
  active: boolean;
}

export interface StatuslineImportAnalysis {
  revision: number;
  conflicts: StatuslineImportConflict[];
  claudeCount: number;
  codexCount: number;
}

export interface StatuslineImportDecision {
  tool: StatuslineProfileTool;
  profileId: string;
  action: "overwrite" | "skip" | "rename";
  newName?: string;
}

interface ProfileArgs {
  tool: StatuslineProfileTool;
  configDir?: string;
}

export function useStatuslineProfiles<T>(args: ProfileArgs) {
  const [state, setState] = useState<StatuslineProfileState<T> | null>(null);

  const call = useCallback(async (command: string, payload: Record<string, unknown> = {}) => {
    const next = await invoke<StatuslineProfileState<T>>(command, { ...args, ...payload });
    setState(next);
    return next;
  }, [args.configDir, args.tool]);

  return {
    state,
    load: useCallback(() => call("statusline_profiles_load"), [call]),
    save: useCallback((profileId: string, payload: T) => call("statusline_profiles_save", { profileId, payload }), [call]),
    create: useCallback((name: string, payload: T) => call("statusline_profiles_create", { name, payload }), [call]),
    switchProfile: useCallback((profileId: string) => call("statusline_profiles_switch", { profileId }), [call]),
    rename: useCallback((profileId: string, name: string) => call("statusline_profiles_rename", { profileId, name }), [call]),
    duplicate: useCallback((profileId: string, name: string) => call("statusline_profiles_duplicate", { profileId, name }), [call]),
    remove: useCallback((profileId: string) => call("statusline_profiles_delete", { profileId }), [call]),
    captureExternal: useCallback((name: string) => call("statusline_profiles_capture_external", { name }), [call]),
  };
}
