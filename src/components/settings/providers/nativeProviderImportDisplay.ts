import type { TranslationKey } from "@/lib/i18n";
import type { Project, WorktreeRecord } from "@/lib/types";
import type { NativeProviderImportIssue } from "./nativeProviderTypes";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

export function issueScopeLabel(
  issue: NativeProviderImportIssue,
  projects: Project[],
  worktrees: WorktreeRecord[],
  t: Translate,
): string {
  if (issue.scopeKind === "project") {
    const project = projects.find((item) => item.id === issue.scopeId);
    return t("providerCatalog.import.projectScope", {
      name: project?.name ?? t("providerCatalog.import.unknownProject", { id: issue.scopeId }),
    });
  }

  if (issue.scopeKind === "worktree") {
    const worktree = worktrees.find((item) => item.id === issue.scopeId);
    if (worktree) {
      const project = projects.find((item) => item.id === worktree.project_id);
      return t("providerCatalog.import.worktreeScope", {
        project: project?.name ?? t("providerCatalog.import.unknownProject", { id: worktree.project_id }),
        name: worktree.name,
      });
    }
  }

  return t("providerCatalog.import.unknownScope", {
    kind: issue.scopeKind,
    id: issue.scopeId,
  });
}
