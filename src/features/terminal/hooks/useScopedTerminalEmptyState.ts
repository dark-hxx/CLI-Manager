import type { Group, TerminalScope } from "../../../shared/types/index";
import { useMemo } from "react";
import { useI18n } from "../../../shared/i18n/index";
import type { Project, WorktreeRecord } from "../../../shared/types/index";

interface ScopedTerminalEmptyStateContext {
  hasScopedTerminalFilter: boolean;
  terminalScopeValue: TerminalScope;
  scopedWorktree: WorktreeRecord | null | undefined;
  scopedProject: Project | null | undefined;
  t: ReturnType<typeof useI18n>["t"];
  handleOpenScopedTerminal: () => void;
  scopedGroup: Group | null | undefined;
}

export function useScopedTerminalEmptyState({
  hasScopedTerminalFilter,
  terminalScopeValue,
  scopedWorktree,
  scopedProject,
  t,
  handleOpenScopedTerminal,
  scopedGroup,
}: ScopedTerminalEmptyStateContext) {
  return useMemo(() => {
    if (!hasScopedTerminalFilter) return null;

    if (terminalScopeValue.kind === "worktree") {
      const name = scopedWorktree?.name ?? scopedProject?.name ?? "";
      return {
        title: t("terminal.empty.worktreeTitle", { name }),
        description: t("terminal.empty.worktreeDescription", { name }),
        action:
          scopedProject && scopedWorktree
            ? { label: t("terminal.empty.worktreeAction", { name: scopedWorktree.name }), onClick: handleOpenScopedTerminal }
            : undefined,
      };
    }

    if (terminalScopeValue.kind === "group") {
      const name = scopedGroup?.name ?? "";
      return {
        title: t("terminal.empty.groupTitle", { name }),
        description: t("terminal.empty.groupDescription", { name }),
      };
    }

    const name = scopedProject?.name ?? "";
    return {
      title: t("terminal.empty.projectTitle", { name }),
      description: t("terminal.empty.projectDescription", { name }),
      action: scopedProject
        ? { label: t("terminal.empty.projectAction", { name: scopedProject.name }), onClick: handleOpenScopedTerminal }
        : undefined,
    };
  }, [
    handleOpenScopedTerminal,
    hasScopedTerminalFilter,
    scopedGroup?.name,
    scopedProject,
    scopedWorktree,
    t,
    terminalScopeValue,
  ]);
}
