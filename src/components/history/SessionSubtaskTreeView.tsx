import { GitBranch, Info } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { sortHistoryItems, type HistoryDetailSortDirection } from "../../lib/historySort";
import type { SessionProcessModel } from "./sessionEvents";

interface SessionSubtaskTreeViewProps {
  model: SessionProcessModel;
  direction: HistoryDetailSortDirection;
  onJumpToMessage: (messageIndex: number) => void;
}

export function SessionSubtaskTreeView({ model, direction, onJumpToMessage }: SessionSubtaskTreeViewProps) {
  const { t } = useI18n();
  const orderedSubtaskEvents = sortHistoryItems(model.subtaskEvents, direction);
  if (orderedSubtaskEvents.length === 0) {
    return (
      <div className="ui-session-process-empty">
        {t("history.subtasks.empty")}
      </div>
    );
  }

  return (
    <div className="ui-session-process-view">
      <div className="ui-session-process-note">
        <Info size={13} />
        {t("history.subtasks.note")}
      </div>
      <div className="ui-session-subtask-tree">
        <div className="ui-session-subtask-root">
          <GitBranch size={14} />
          {t("history.subtasks.root")}
        </div>
        {orderedSubtaskEvents.map((event) => (
          <button
            key={event.id}
            type="button"
            className="ui-session-subtask-node"
            onClick={() => event.messageIndex !== null && onJumpToMessage(event.messageIndex)}
          >
            <span>{event.title}</span>
            <small>{event.detail}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
