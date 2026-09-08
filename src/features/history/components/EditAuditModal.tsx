import { useCallback, useEffect, useMemo, useState } from "react";
import { ArchiveRestore, History, Undo2 } from "lucide-react";
import { diffChars, type Change } from "diff";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "../../../shared/ui/dialog";
import { ConfirmDialog } from "../../../shared/ui/ConfirmDialog";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { useHistoryStore } from "../index";
import { useI18n, type TranslationKey } from "../../../shared/i18n/index";
import type { HistoryBackupStatus, HistoryEditAuditEntry, HistoryMessage } from "../../../shared/types/index";
import { formatTime } from "../api/historyViewUtils";

interface EditAuditModalProps {
  open: boolean;
  sessionKey: string | null;
  onClose: () => void;
}

const OP_LABEL_KEYS: Record<string, TranslationKey> = {
  edit: "history.edit.op.edit",
  delete: "history.edit.op.delete",
  insert: "history.edit.op.insert",
  restore: "history.edit.op.restore",
};

const UNDO_TITLE_KEYS: Record<string, TranslationKey> = {
  edit: "history.edit.undoEditTitle",
  delete: "history.edit.undoDeleteTitle",
  insert: "history.edit.undoInsertTitle",
};

/** 字符级 diff 的一侧渲染：old 侧隐藏新增段、高亮删除段；new 侧反之。 */
function DiffSegments({ parts, side }: { parts: Change[]; side: "old" | "new" }) {
  return (
    <>
      {parts.map((part, index) => {
        if (side === "old" && part.added) return null;
        if (side === "new" && part.removed) return null;
        const highlighted = side === "old" ? part.removed : part.added;
        if (!highlighted) return <span key={index}>{part.value}</span>;
        return side === "old" ? <del key={index}>{part.value}</del> : <ins key={index}>{part.value}</ins>;
      })}
    </>
  );
}

function AuditDiffLine({ tone, children }: { tone: "del" | "ins"; children: React.ReactNode }) {
  return (
    <div className="ui-history-audit-line" data-tone={tone}>
      <span className="ui-history-audit-gutter" aria-hidden="true">
        {tone === "del" ? "−" : "＋"}
      </span>
      <span className="ui-history-audit-text">{children}</span>
    </div>
  );
}

function AuditDiff({ entry }: { entry: HistoryEditAuditEntry }) {
  const parts = useMemo(
    () =>
      entry.op === "edit" && entry.before_text !== null && entry.after_text !== null
        ? diffChars(entry.before_text, entry.after_text)
        : null,
    [entry.after_text, entry.before_text, entry.op]
  );

  if (entry.op === "edit" && parts) {
    return (
      <div className="ui-history-audit-diff">
        <AuditDiffLine tone="del">
          <DiffSegments parts={parts} side="old" />
        </AuditDiffLine>
        <AuditDiffLine tone="ins">
          <DiffSegments parts={parts} side="new" />
        </AuditDiffLine>
      </div>
    );
  }
  if (entry.op === "delete" && entry.before_text) {
    return (
      <div className="ui-history-audit-diff">
        <AuditDiffLine tone="del">{entry.before_text}</AuditDiffLine>
      </div>
    );
  }
  if (entry.op === "insert" && entry.after_text) {
    return (
      <div className="ui-history-audit-diff">
        <AuditDiffLine tone="ins">{entry.after_text}</AuditDiffLine>
      </div>
    );
  }
  return null;
}

export function EditAuditModal({ open, sessionKey, onClose }: EditAuditModalProps) {
  const { t, language } = useI18n();
  const listEditAudit = useHistoryStore((s) => s.listEditAudit);
  const fetchBackupStatus = useHistoryStore((s) => s.fetchBackupStatus);
  const restoreSessionBackup = useHistoryStore((s) => s.restoreSessionBackup);
  const updateMessage = useHistoryStore((s) => s.updateMessage);
  const deleteMessage = useHistoryStore((s) => s.deleteMessage);
  const reinsertMessage = useHistoryStore((s) => s.reinsertMessage);

  const [entries, setEntries] = useState<HistoryEditAuditEntry[]>([]);
  const [backupStatus, setBackupStatus] = useState<HistoryBackupStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [undoingId, setUndoingId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (!sessionKey) return;
    setLoading(true);
    try {
      const [auditEntries, status] = await Promise.all([
        listEditAudit(sessionKey),
        fetchBackupStatus(sessionKey).catch(() => null),
      ]);
      setEntries(auditEntries);
      setBackupStatus(status);
    } catch (err) {
      toast.error(t("history.edit.failed"), { description: String(err) });
    } finally {
      setLoading(false);
    }
  }, [fetchBackupStatus, listEditAudit, sessionKey, t]);

  useEffect(() => {
    if (!open) return;
    void reload();
  }, [open, reload]);

  const handleRestore = async () => {
    if (!sessionKey || restoring) return;
    setRestoring(true);
    try {
      await restoreSessionBackup(sessionKey);
      toast.success(t("history.edit.restoreSuccess"));
      setRestoreConfirmOpen(false);
      await reload();
    } catch (err) {
      toast.error(t("history.edit.restoreFailed"), { description: String(err) });
    } finally {
      setRestoring(false);
    }
  };

  // 撤回目标定位：审计里的行号会随后续编辑漂移，以"当前会话中内容 + 角色匹配、行号最近"为准。
  const findCurrentMessage = useCallback(
    (entry: HistoryEditAuditEntry): HistoryMessage | null => {
      const state = useHistoryStore.getState();
      if (state.activeSessionKey !== sessionKey) return null;
      const targetText = entry.after_text;
      if (!targetText) return null;
      const candidates = (state.activeSession?.messages ?? []).filter(
        (message) =>
          message.editable === true &&
          (message.editable_text ?? message.content) === targetText &&
          (!entry.role || message.role === entry.role)
      );
      if (candidates.length === 0) return null;
      if (entry.line_index === null) return candidates[0];
      return candidates.reduce((best, message) =>
        Math.abs((message.line_index ?? 0) - (entry.line_index ?? 0)) <
        Math.abs((best.line_index ?? 0) - (entry.line_index ?? 0))
          ? message
          : best
      );
    },
    [sessionKey]
  );

  const performUndo = useCallback(
    async (entry: HistoryEditAuditEntry) => {
      if (!sessionKey || undoingId !== null) return;
      setUndoingId(entry.id);
      try {
        if (entry.op === "edit") {
          const message = entry.before_text ? findCurrentMessage(entry) : null;
          if (!message || !entry.before_text) {
            toast.error(t("history.edit.undoTargetMissing"));
            return;
          }
          await updateMessage(sessionKey, message, entry.before_text);
        } else if (entry.op === "insert") {
          const message = findCurrentMessage(entry);
          if (!message) {
            toast.error(t("history.edit.undoTargetMissing"));
            return;
          }
          await deleteMessage(sessionKey, message);
        } else if (entry.op === "delete") {
          if (!entry.before_text || !entry.role) {
            toast.error(t("history.edit.undoTargetMissing"));
            return;
          }
          await reinsertMessage(sessionKey, entry.line_index ?? 0, entry.role, entry.before_text);
        } else {
          return;
        }
        toast.success(t("history.edit.undoSuccess"));
        await reload();
      } catch (err) {
        toast.error(t("history.edit.failed"), { description: String(err) });
      } finally {
        setUndoingId(null);
      }
    },
    [deleteMessage, findCurrentMessage, reinsertMessage, reload, sessionKey, t, undoingId, updateMessage]
  );

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <DialogContent className="flex max-h-[78vh] w-[min(700px,92vw)] max-w-[700px] flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-2 pr-6">
            <DialogTitle className="flex items-center gap-1.5">
              <History size={14} />
              {t("history.edit.auditTitle")}
            </DialogTitle>
            {backupStatus?.hasBackup ? (
              <button
                type="button"
                className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
                style={{ color: "var(--warning)" }}
                onClick={() => setRestoreConfirmOpen(true)}
                disabled={restoring}
                title={backupStatus.backupPath ?? undefined}
              >
                <ArchiveRestore size={12} />
                {t("history.edit.restoreBackup")}
              </button>
            ) : (
              <span className="text-[11px] text-text-muted">{t("history.edit.noBackup")}</span>
            )}
          </div>

          <div className="mt-1 min-h-0 flex-1 overflow-y-auto pr-1">
            {loading && <div className="text-xs text-text-muted">{t("history.detail.loading")}</div>}
            {!loading && entries.length === 0 && (
              <EmptyState icon={<History size={30} strokeWidth={1.5} />} title={t("history.edit.auditEmpty")} />
            )}
            {!loading &&
              entries.map((entry) => {
                const opLabelKey = OP_LABEL_KEYS[entry.op];
                const undoTitleKey = UNDO_TITLE_KEYS[entry.op];
                return (
                  <div key={entry.id} className="ui-history-audit-entry">
                    <div className="ui-history-audit-head">
                      <span className="ui-history-audit-op" data-op={entry.op}>
                        {opLabelKey ? t(opLabelKey) : entry.op}
                      </span>
                      {entry.role && <span className="ui-dev-label">{entry.role}</span>}
                      {entry.line_index !== null && (
                        <span className="ui-dev-label">{t("history.edit.auditLine", { line: entry.line_index })}</span>
                      )}
                      <span className="ui-history-audit-time">{formatTime(entry.created_at, language)}</span>
                      {undoTitleKey && (
                        <button
                          type="button"
                          className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
                          onClick={() => {
                            void performUndo(entry);
                          }}
                          disabled={undoingId !== null}
                          title={t(undoTitleKey)}
                          aria-label={t(undoTitleKey)}
                        >
                          <Undo2 size={12} />
                          {t("history.edit.undo")}
                        </button>
                      )}
                    </div>
                    <AuditDiff entry={entry} />
                  </div>
                );
              })}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={restoreConfirmOpen}
        title={t("history.edit.restoreConfirmTitle")}
        message={t("history.edit.restoreConfirmMessage")}
        confirmText={t("history.edit.restoreBackup")}
        cancelText={t("common.cancel")}
        danger
        zIndex={220}
        onConfirm={() => {
          void handleRestore();
        }}
        onClose={() => setRestoreConfirmOpen(false)}
      />
    </>
  );
}
