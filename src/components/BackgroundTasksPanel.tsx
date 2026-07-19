import { useMemo, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import { useI18n } from "../lib/i18n";
import { useProjectStore } from "../stores/projectStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalStore, type TabNotificationState } from "../stores/terminalStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { Activity, AlertTriangle, Check, Layers, X } from "./icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export interface BackgroundTaskMeta {
  sessionId: string;
  cwd?: string | null;
  shell?: string | null;
  environmentType?: string | null;
  sshHostId?: string | null;
  remotePath?: string | null;
  alive: boolean;
  taskStatus?: TabNotificationState | null;
  taskUpdatedAtMs?: number | null;
  createdAtMs: number;
}

interface Props {
  tasks: BackgroundTaskMeta[];
  onRefresh: () => Promise<void>;
  showText: boolean;
  popoverStyle?: CSSProperties;
}

type BackgroundTaskDisplayStatus = "running" | "attention" | "done" | "failed";

function resolveTaskStatus(task: BackgroundTaskMeta): BackgroundTaskDisplayStatus {
  if (
    task.taskStatus === "running" ||
    task.taskStatus === "attention" ||
    task.taskStatus === "done" ||
    task.taskStatus === "failed"
  ) {
    return task.taskStatus;
  }
  return task.alive ? "running" : "done";
}

export function BackgroundTasksPanel({ tasks, onRefresh, showText, popoverStyle }: Props) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [discardIntent, setDiscardIntent] = useState<BackgroundTaskMeta | null>(null);
  const [discardPending, setDiscardPending] = useState(false);
  const persistedSessions = useSessionStore((state) => state.sessions);
  const projects = useProjectStore((state) => state.projects);
  const attachDaemonSession = useTerminalStore((state) => state.attachDaemonSession);
  const discardDaemonSession = useTerminalStore((state) => state.discardDaemonSession);

  const rows = useMemo(() => tasks.map((task) => {
    const session = persistedSessions.find((item) => item.id === task.sessionId);
    const project = session?.projectId
      ? projects.find((item) => item.id === session.projectId)
      : undefined;
    return {
      ...task,
      status: resolveTaskStatus(task),
      title: session?.title || project?.name || task.remotePath || task.cwd || t("terminal.backgroundTasks.untitled"),
      projectName: project?.name,
      location: task.environmentType === "ssh"
        ? `SSH · ${task.remotePath || task.sshHostId || "-"}`
        : task.cwd,
    };
  }), [persistedSessions, projects, t, tasks]);

  const handleRestore = async (sessionId: string) => {
    try {
      const restored = await attachDaemonSession(sessionId);
      if (!restored) {
        toast.error(t("terminal.backgroundTasks.restoreFailed"));
        await onRefresh();
        return;
      }
      setOpen(false);
    } catch (err) {
      toast.error(t("terminal.backgroundTasks.restoreFailed"), { description: String(err) });
    }
  };

  const confirmDiscard = async () => {
    if (!discardIntent || discardPending) return;
    setDiscardPending(true);
    try {
      await discardDaemonSession(discardIntent.sessionId);
      setDiscardIntent(null);
      await onRefresh();
    } catch (err) {
      toast.error(t("terminal.backgroundTasks.discardFailed"), { description: String(err) });
    } finally {
      setDiscardPending(false);
    }
  };
  const discardIntentStatus = discardIntent ? resolveTaskStatus(discardIntent) : null;
  const discardIntentTerminalState = discardIntentStatus === "done" || discardIntentStatus === "failed";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="ui-focus-ring ui-icon-action ui-action-background-tasks"
          data-active={open ? "true" : "false"}
          data-has-tasks={tasks.length > 0 ? "true" : "false"}
          disabled={tasks.length === 0}
          aria-label={t("terminal.backgroundTasks.title")}
        >
          <Layers size={14} strokeWidth={1.8} />
          {showText && <span>{t("terminal.backgroundTasks.shortTitle")}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent id="background-tasks-panel" side="left" align="start" className="w-80 p-0" style={popoverStyle}>
        <div className="border-b border-border px-3 py-2 text-xs font-semibold text-text-primary">
          {t("terminal.backgroundTasks.title")}
        </div>
        <div className="background-tasks-panel__list">
          {rows.length === 0 ? (
            <div className="background-tasks-panel__empty flex min-h-32 flex-col items-center justify-center gap-1 rounded-lg px-4 py-6 text-center">
              <div className="text-xs font-medium text-text-primary">
                {t("terminal.backgroundTasks.empty")}
              </div>
              <div className="text-[11px] text-text-muted">
                {t("terminal.backgroundTasks.emptyDescription")}
              </div>
            </div>
          ) : rows.map((task) => {
            const terminalState = task.status === "done" || task.status === "failed";
            return (
              <div key={task.sessionId} className="background-tasks-panel__item mb-2 rounded-lg p-2 last:mb-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-text-primary">{task.title}</div>
                  {task.projectName && (
                    <div className="truncate text-[10px] text-text-muted">{task.projectName}</div>
                  )}
                  {task.location && (
                    <div className="truncate text-[10px] text-text-muted">{task.location}</div>
                  )}
                  </div>
                  <span
                    className="background-tasks-panel__status flex shrink-0 items-center gap-1 text-[10px]"
                    data-status={task.status}
                  >
                    {task.status === "done" ? <Check size={11} /> : null}
                    {task.status === "failed" ? <X size={11} /> : null}
                    {task.status === "attention" ? <AlertTriangle size={11} /> : null}
                    {task.status === "running" ? <Activity size={11} /> : null}
                    {task.status === "running" ? t("terminal.backgroundTasks.running") : null}
                    {task.status === "attention" ? t("terminal.backgroundTasks.attention") : null}
                    {task.status === "done" ? t("terminal.backgroundTasks.completed") : null}
                    {task.status === "failed" ? t("terminal.backgroundTasks.failed") : null}
                  </span>
                </div>
                <div className="mt-1 text-[10px] text-text-muted">
                  {new Date(task.createdAtMs).toLocaleString(language, { hour12: false })}
                </div>
                <div className="mt-2 flex justify-end gap-1.5">
                  <button
                    className="background-tasks-panel__action ui-flat-action px-2 py-1 text-[11px]"
                    onClick={() => void handleRestore(task.sessionId)}
                  >
                    {t("terminal.backgroundTasks.restore")}
                  </button>
                  <button
                    className="background-tasks-panel__action background-tasks-panel__action--danger ui-flat-action px-2 py-1 text-[11px]"
                    onClick={() => setDiscardIntent(task)}
                  >
                    <X size={11} />
                    {terminalState
                      ? t("terminal.backgroundTasks.delete")
                      : t("terminal.backgroundTasks.discard")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </PopoverContent>
      <ConfirmDialog
        open={discardIntent !== null}
        title={discardIntentTerminalState
          ? t("terminal.backgroundTasks.confirmDeleteTitle")
          : t("terminal.backgroundTasks.confirmDiscardTitle")}
        message={discardIntentTerminalState
          ? t("terminal.backgroundTasks.confirmDelete")
          : t("terminal.backgroundTasks.confirmDiscard")}
        confirmText={discardIntentTerminalState
          ? t("terminal.backgroundTasks.delete")
          : t("terminal.backgroundTasks.discard")}
        cancelText={t("common.cancel")}
        danger
        onConfirm={() => {
          void confirmDiscard();
        }}
        onClose={() => {
          if (!discardPending) setDiscardIntent(null);
        }}
      />
    </Popover>
  );
}
