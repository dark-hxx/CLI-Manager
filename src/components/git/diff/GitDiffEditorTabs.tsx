import { X } from "../../icons";
import { useI18n } from "../../../lib/i18n";
import {
  useGitDiffWorkspaceStore,
  type GitDiffWorkspaceTab,
} from "../../../stores/gitDiffWorkspaceStore";

interface GitDiffEditorTabsProps {
  workspaceKey: string;
  tabs: GitDiffWorkspaceTab[];
  activeId: string | null;
}

export function GitDiffEditorTabs({
  workspaceKey,
  tabs,
  activeId,
}: GitDiffEditorTabsProps) {
  const { t } = useI18n();
  const activateTab = useGitDiffWorkspaceStore((state) => state.activateTab);
  const closeTab = useGitDiffWorkspaceStore((state) => state.closeTab);

  return tabs.map((tab) => {
    const active = tab.id === activeId;
    const label = t("git.diff.title", { fileName: tab.fileName });
    return (
      <div
        key={tab.id}
        className="ui-file-editor-tab group flex h-7 max-w-[220px] shrink-0 items-center rounded-t text-[11px] text-on-surface-variant hover:bg-surface-container-high"
        data-active={active ? "true" : "false"}
        style={active ? { background: "var(--surface-container)", color: "var(--on-surface)" } : undefined}
        title={`${tab.repositoryRelativePath || tab.projectPath}/${tab.filePath}`}
      >
        <button
          type="button"
          className="min-w-0 flex-1 truncate px-2 text-left"
          onClick={() => activateTab(workspaceKey, tab.id)}
        >
          {label}
        </button>
        <button
          type="button"
          className="mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-70 hover:bg-surface-container-highest hover:opacity-100"
          aria-label={t("files.editor.closeNamed", { name: label })}
          onClick={(event) => {
            event.stopPropagation();
            closeTab(workspaceKey, tab.id);
          }}
        >
          <X size={11} />
        </button>
      </div>
    );
  });
}
