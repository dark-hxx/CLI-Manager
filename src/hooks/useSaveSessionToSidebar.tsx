import { useCallback } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { useAppPrompt } from "../components/ui/useAppPrompt";
import { useProjectStore } from "../stores/projectStore";
import {
  buildSavedSessionProjectInput,
  canSaveSessionToSidebar,
  type BuildSavedSessionFailureReason,
} from "../lib/saveSessionToSidebar";
import { logError, logInfo, logWarn } from "../lib/logger";
import type { Project, TerminalSession } from "../lib/types";

export interface UseSaveSessionToSidebarResult {
  canSave: (session: TerminalSession, project: Project | null) => boolean;
  saveSession: (session: TerminalSession, project: Project | null) => Promise<void>;
  saveSessionDialog: ReactNode;
}

// i18n key per failure reason. Kept as a plain map (rather than inline switch)
// so the toast description path is one lookup regardless of reason.
const REASON_I18N_KEY: Record<BuildSavedSessionFailureReason, TranslationKey> = {
  no_kind: "saveSession.reason.noKind",
  no_session_id: "saveSession.noSessionId",
  no_path: "saveSession.reason.noPath",
};

export function useSaveSessionToSidebar(): UseSaveSessionToSidebarResult {
  const { t } = useI18n();
  const { prompt, promptDialog } = useAppPrompt();

  const canSave = useCallback(
    (session: TerminalSession, project: Project | null) =>
      canSaveSessionToSidebar(session, project),
    [],
  );

  const saveSession = useCallback(
    async (session: TerminalSession, project: Project | null) => {
      const name = await prompt({
        title: t("saveSession.dialogTitle"),
        placeholder: t("saveSession.namePlaceholder"),
      });
      if (name === null) return;

      const result = buildSavedSessionProjectInput({ name, session, project });
      if (!result.ok) {
        // Surface the specific reason instead of a generic failure toast: a
        // validation rejection or field mismatch is shown in the toast
        // description and logged (logWarn -> Tauri plugin-log backend) for
        // post-hoc debugging with CLI_MANAGER_DEBUG=1.
        logWarn("saveSessionToSidebar: build input failed", {
          reason: result.reason,
          sessionId: session.id,
          hasBoundCliSessionId: Boolean(session.cliSessionId),
          hasProject: Boolean(project),
        });
        toast.error(t("saveSession.failed"), {
          description: t(REASON_I18N_KEY[result.reason]),
        });
        return;
      }

      try {
        logInfo("saveSessionToSidebar: creating project", {
          sessionId: session.id,
          cliTool: result.input.cli_tool,
          groupId: result.input.group_id,
          hasStartupCmd: Boolean(result.input.startup_cmd),
          // buildSavedSessionProjectInput always sets cli_args on the ok
          // branch (via buildResumeCliArgs), but the CreateProjectInput
          // interface types it optional so we guard defensively here.
          cliArgsSuffix: (result.input.cli_args ?? "").slice(-64),
        });
        await useProjectStore.getState().createProject(result.input);
        logInfo("saveSessionToSidebar: project created", {
          sessionId: session.id,
        });
        toast.success(t("saveSession.success"));
      } catch (err) {
        logError("saveSessionToSidebar: createProject threw", {
          sessionId: session.id,
          message: err instanceof Error ? err.message : String(err),
        });
        toast.error(t("saveSession.failed"), { description: String(err) });
      }
    },
    [prompt, t],
  );

  return {
    canSave,
    saveSession,
    saveSessionDialog: promptDialog,
  };
}
