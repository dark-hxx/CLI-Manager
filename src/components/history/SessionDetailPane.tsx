import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowRightLeft,
  BookCopy,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownRight,
  FolderOpen,
  GitCompare,
  History,
  ListChecks,
  Pencil,
  Square,
  Star,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { toast } from "sonner";
import aiAvatarUrl from "../../assets/history-ai-avatar.svg";
import userAvatarUrl from "../../assets/history-user-avatar.svg";
import type { HistoryFileChangeSummary, HistoryMessage, HistorySessionDetail, HistorySessionView } from "../../lib/types";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import { resolveHistorySourceIconKey } from "../../lib/cliTools";
import { CliToolIcon } from "../CliToolIcon";
import { EmptyState } from "../ui/EmptyState";
import { SessionTranscriptContent } from "./SessionTranscriptContent";
import { MetaEditor } from "./MetaEditor";
import { formatTime, makeSessionLabel } from "./historyViewUtils";
import { SessionTimelineView } from "./SessionTimelineView";
import { SessionCanvasView } from "./SessionCanvasView";
import { SessionContextView } from "./SessionContextView";
import { SessionFileChangesView } from "./SessionFileChangesView";
import { SessionToolDiagnosticsView } from "./SessionToolDiagnosticsView";
import { SessionSubtaskTreeView } from "./SessionSubtaskTreeView";
import type { SessionProcessModel } from "./sessionEvents";

export type HistoryDetailView = "transcript" | "timeline" | "canvas" | "context" | "changes" | "tools" | "subtasks";

interface SessionDetailPaneProps {
  activeView: HistorySessionView | null;
  activeSession: HistorySessionDetail | null;
  loadingSessionDetail: boolean;
  aliasDraft: string;
  tagsDraft: string;
  tagSuggestions: string[];
  sessionQuery: string;
  matchIndices: number[];
  matchCursor: number;
  focusedMessageIndex: number | null;
  focusedMessageSeq: number;
  visibleMessages: HistoryMessage[];
  visibleMessageCount: number;
  hasMoreMessages: boolean;
  totalMessageCount: number;
  processModel: SessionProcessModel;
  detailView: HistoryDetailView;
  messageListRef: RefObject<HTMLDivElement | null>;
  sessionSearchRef: RefObject<HTMLInputElement | null>;
  messageRefs: RefObject<Record<number, HTMLDivElement | null>>;
  onDetailViewChange: (view: HistoryDetailView) => void;
  onMessageListScroll: () => void;
  onAliasDraftChange: (value: string) => void;
  onTagsDraftChange: (value: string) => void;
  onSessionQueryChange: (value: string) => void;
  onSaveMeta: () => void;
  onJumpPrev: () => void;
  onJumpNext: () => void;
  onOpenPrompt: () => void;
  onOpenDiff: (fileChanges?: HistoryFileChangeSummary[]) => void;
  onResumeSession: () => void;
  canConvertSession: boolean;
  onConvertSession: () => void;
  onJumpToMessage: (messageIndex: number) => void;
  onToggleStar: () => void;
  onLoadMoreMessages: () => void;
  /** 会话级编辑开关：快照兜底会话/未加载完成时为 false。 */
  canEditMessages: boolean;
  /** 编辑/插入进入前的活跃会话警告闸门；返回 false 中止。 */
  onRequestMessageEdit: () => Promise<boolean>;
  /** 保存编辑；返回 true 表示成功（关闭编辑态）。 */
  onSaveMessageEdit: (message: HistoryMessage, newText: string) => Promise<boolean>;
  onDeleteMessage: (message: HistoryMessage) => void;
  /** 批量删除；确认并执行完成返回 true（退出选择模式）。 */
  onDeleteMessages: (messages: HistoryMessage[]) => Promise<boolean>;
  /** 插入消息；返回 true 表示成功（关闭插入表单）。 */
  onInsertMessage: (message: HistoryMessage, role: "user" | "assistant", text: string) => Promise<boolean>;
  onOpenEditAudit: () => void;
}

const DETAIL_VIEWS: Array<{ id: HistoryDetailView; labelKey: TranslationKey }> = [
  { id: "transcript", labelKey: "history.detail.view.transcript" },
  { id: "timeline", labelKey: "history.detail.view.timeline" },
  { id: "canvas", labelKey: "history.detail.view.canvas" },
  { id: "context", labelKey: "history.detail.view.context" },
  { id: "changes", labelKey: "history.detail.view.changes" },
  { id: "tools", labelKey: "history.detail.view.tools" },
  { id: "subtasks", labelKey: "history.detail.view.subtasks" },
];

const MESSAGE_PREVIEW_LINE_COUNT = 5;
const LONG_MESSAGE_LINE_THRESHOLD = 8;
const LONG_MESSAGE_CHAR_THRESHOLD = 900;
const TOKEN_FORMATTER = new Intl.NumberFormat("en-US");

function isInjectedPromptContent(content: string): boolean {
  const trimmed = content.trimStart();
  const lowerTrimmed = trimmed.toLowerCase();
  const firstLine = lowerTrimmed.split(/\r?\n/, 1)[0]?.replace(/^#+\s*/, "").trim() ?? "";
  return (
    firstLine.startsWith("agents.md instructions for ") ||
    firstLine.startsWith("system prompt") ||
    firstLine.startsWith("developer instructions") ||
    lowerTrimmed.startsWith("<system-reminder") ||
    lowerTrimmed.startsWith("<codex_internal_context") ||
    lowerTrimmed.startsWith("<session-context")
  );
}

function normalizeMessageRole(role: string): "user" | "assistant" | "other" {
  const normalized = role.toLowerCase();
  if (normalized === "user" || normalized.includes("human")) return "user";
  if (normalized === "assistant" || normalized.includes("model") || normalized.includes("llm")) return "assistant";
  return "other";
}

function shouldCollapseMessage(message: HistoryMessage): boolean {
  if (isInjectedPromptContent(message.content)) return true;
  const lines = message.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  return lines.length >= LONG_MESSAGE_LINE_THRESHOLD || message.content.length >= LONG_MESSAGE_CHAR_THRESHOLD;
}

function padTimePart(value: number): string {
  return String(value).padStart(2, "0");
}

function formatMessageTimestamp(timestamp?: string | null): string | null {
  const raw = timestamp?.trim();
  if (!raw) return null;

  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    const date = new Date(parsed);
    return `${padTimePart(date.getMonth() + 1)}/${padTimePart(date.getDate())} ${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
  }

  const fallback = /(\d{1,2})[/-](\d{1,2}).*?(\d{1,2}):(\d{2})/.exec(raw);
  if (fallback) {
    return `${padTimePart(Number(fallback[1]))}/${padTimePart(Number(fallback[2]))} ${padTimePart(Number(fallback[3]))}:${fallback[4]}`;
  }

  return raw;
}

function positiveToken(value?: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function formatMessageTokenMeta(message: HistoryMessage): string | null {
  const input = positiveToken(message.input_tokens);
  const output = positiveToken(message.output_tokens);
  const cache = positiveToken(message.cache_read_tokens) + positiveToken(message.cache_creation_tokens);
  const parts: string[] = [];

  if (input > 0) parts.push(`in ${TOKEN_FORMATTER.format(input)}`);
  if (output > 0) parts.push(`out ${TOKEN_FORMATTER.format(output)}`);
  if (cache > 0) parts.push(`cache ${TOKEN_FORMATTER.format(cache)}`);

  return parts.length > 0 ? parts.join(" / ") : null;
}

function formatMessageMeta(message: HistoryMessage): string | null {
  const timestamp = formatMessageTimestamp(message.timestamp);
  const tokens = formatMessageTokenMeta(message);
  return [timestamp, tokens].filter(Boolean).join("  ") || null;
}

function getCollapsedMessagePreview(content: string, fallback: string): string[] {
  const lines: string[] = [];
  let start = 0;

  for (let i = 0; i <= content.length && lines.length < MESSAGE_PREVIEW_LINE_COUNT; i++) {
    if (i < content.length && content[i] !== "\n") continue;
    const line = content.slice(start, i).replace(/\r$/, "").trim();
    if (line) lines.push(line);
    start = i + 1;
  }

  return lines.length > 0 ? lines : [fallback];
}

function ConversationMessageContent({
  message,
  query,
  open,
  collapsible,
}: {
  message: HistoryMessage;
  query: string;
  open: boolean;
  collapsible: boolean;
}) {
  const { t } = useI18n();
  if (!collapsible || open) {
    return <SessionTranscriptContent content={message.content} query={query} />;
  }

  const previewLines = getCollapsedMessagePreview(message.content, t("history.detail.noText"));

  return (
    <div className="ui-history-message-collapse">
      <span className="ui-history-message-collapse-preview">
        {previewLines.map((line, index) => (
          <span key={index}>{line}</span>
        ))}
      </span>
    </div>
  );
}

type InsertRole = "user" | "assistant";

interface HistoryMessageCardProps {
  message: HistoryMessage;
  index: number;
  isMatched: boolean;
  isFocused: boolean;
  query: string;
  messageRefs: RefObject<Record<number, HTMLDivElement | null>>;
  measureElement: (element: Element) => void;
  canEdit: boolean;
  isEditing: boolean;
  editDraft: string;
  editSaving: boolean;
  onEditDraftChange: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: () => void;
  isInserting: boolean;
  insertRole: InsertRole;
  insertDraft: string;
  insertSaving: boolean;
  onInsertRoleChange: (role: InsertRole) => void;
  onInsertDraftChange: (value: string) => void;
  onStartInsert: () => void;
  onCancelInsert: () => void;
  onSubmitInsert: () => void;
  onCopyMessage: () => void;
  onDeleteMessage: () => void;
  selectionMode: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
}

function HistoryMessageCard({
  message,
  index,
  isMatched,
  isFocused,
  query,
  messageRefs,
  measureElement,
  canEdit,
  isEditing,
  editDraft,
  editSaving,
  onEditDraftChange,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  isInserting,
  insertRole,
  insertDraft,
  insertSaving,
  onInsertRoleChange,
  onInsertDraftChange,
  onStartInsert,
  onCancelInsert,
  onSubmitInsert,
  onCopyMessage,
  onDeleteMessage,
  selectionMode,
  isSelected,
  onToggleSelect,
}: HistoryMessageCardProps) {
  const { t } = useI18n();
  const roleKind = normalizeMessageRole(message.role);
  const avatarUrl = roleKind === "user" ? userAvatarUrl : aiAvatarUrl;
  const forceOpen = isMatched || isFocused;
  const collapsible = shouldCollapseMessage(message);
  const messageMeta = formatMessageMeta(message);
  const [open, setOpen] = useState(forceOpen);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const messageEditable =
    canEdit && message.editable === true && message.line_index !== null && message.line_index !== undefined;

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  useEffect(() => {
    if (cardRef.current) measureElement(cardRef.current);
  }, [measureElement, open, isEditing, isInserting]);

  const setCardRef = (element: HTMLDivElement | null) => {
    cardRef.current = element;
    messageRefs.current[index] = element;
    if (element) measureElement(element);
  };
  const toggleTitle = open ? t("history.detail.collapseFull") : t("history.detail.expandFull");

  const handleEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancelEdit();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSubmitEdit();
    }
  };

  const handleInsertKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancelInsert();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSubmitInsert();
    }
  };

  return (
    <div
      data-index={index}
      data-role={roleKind}
      data-editing={isEditing ? "true" : undefined}
      data-inserting={isInserting ? "true" : undefined}
      ref={setCardRef}
      className="ui-history-message-card absolute left-0 top-0 w-full px-2.5 py-2"
      style={{
        borderColor: isFocused ? "var(--warning)" : isMatched ? "var(--accent)" : "transparent",
      }}
    >
      {roleKind !== "user" && (
        <span className="ui-history-message-avatar" aria-hidden="true">
          <img src={avatarUrl} alt="" />
        </span>
      )}
      <div className="ui-history-message-stack">
        <div className="ui-history-message-header">
          {selectionMode && messageEditable && (
            <button
              type="button"
              className="ui-history-message-select"
              data-selected={isSelected ? "true" : undefined}
              onClick={onToggleSelect}
              title={t("history.edit.selectMessage")}
              aria-label={t("history.edit.selectMessage")}
              aria-pressed={isSelected}
            >
              {isSelected ? <CheckSquare size={13} /> : <Square size={13} />}
            </button>
          )}
          {messageMeta && (
            <div className="ui-history-message-meta" title={messageMeta}>
              {messageMeta}
            </div>
          )}
          {!isEditing && !selectionMode && (
            <div className="ui-history-message-actions">
              <button
                type="button"
                className="ui-history-message-action"
                onClick={onCopyMessage}
                title={t("history.edit.copyMessage")}
                aria-label={t("history.edit.copyMessage")}
              >
                <Copy size={12} />
              </button>
              {messageEditable && (
                <>
                  <button
                    type="button"
                    className="ui-history-message-action"
                    onClick={onStartEdit}
                    title={t("history.edit.editMessage")}
                    aria-label={t("history.edit.editMessage")}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    className="ui-history-message-action"
                    onClick={onStartInsert}
                    title={t("history.edit.insertAfter")}
                    aria-label={t("history.edit.insertAfter")}
                  >
                    <CornerDownRight size={12} />
                  </button>
                  <button
                    type="button"
                    className="ui-history-message-action"
                    data-danger="true"
                    onClick={onDeleteMessage}
                    title={t("history.edit.deleteMessage")}
                    aria-label={t("history.edit.deleteMessage")}
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="ui-history-message-bubble">
          {isEditing ? (
            <div className="ui-history-message-edit">
              <textarea
                autoFocus
                value={editDraft}
                onChange={(event) => onEditDraftChange(event.target.value)}
                onKeyDown={handleEditKeyDown}
                disabled={editSaving}
                aria-label={t("history.edit.editMessage")}
              />
              <div className="ui-history-message-edit-footer">
                <span className="ui-history-message-edit-hint">{t("history.edit.editHint")}</span>
                <span className="ui-history-message-edit-buttons">
                  <button
                    type="button"
                    className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
                    onClick={onCancelEdit}
                    disabled={editSaving}
                  >
                    <X size={12} />
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
                    style={{ color: "var(--success)" }}
                    onClick={onSubmitEdit}
                    disabled={editSaving || !editDraft.trim()}
                  >
                    <Check size={12} />
                    {t("common.save")}
                  </button>
                </span>
              </div>
            </div>
          ) : (
            <>
              <ConversationMessageContent message={message} query={query} open={open} collapsible={collapsible} />
              {collapsible && (
                <button
                  type="button"
                  className="ui-history-message-expand"
                  onClick={() => setOpen((current) => !current)}
                  aria-expanded={open}
                  title={toggleTitle}
                >
                  <span className="ui-history-message-collapse-icon" aria-hidden="true">
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </span>
                  {toggleTitle}
                </button>
              )}
            </>
          )}
        </div>
        {isInserting && (
          <div className="ui-history-message-insert">
            <div className="ui-history-message-insert-header">
              <span>{t("history.edit.insertTitle")}</span>
              <span className="ui-history-message-insert-roles">
                <button
                  type="button"
                  className="ui-history-message-insert-role"
                  data-active={insertRole === "user"}
                  onClick={() => onInsertRoleChange("user")}
                >
                  {t("history.edit.roleUser")}
                </button>
                <button
                  type="button"
                  className="ui-history-message-insert-role"
                  data-active={insertRole === "assistant"}
                  onClick={() => onInsertRoleChange("assistant")}
                >
                  {t("history.edit.roleAssistant")}
                </button>
              </span>
            </div>
            <textarea
              autoFocus
              placeholder={t("history.edit.insertPlaceholder")}
              value={insertDraft}
              onChange={(event) => onInsertDraftChange(event.target.value)}
              onKeyDown={handleInsertKeyDown}
              disabled={insertSaving}
              aria-label={t("history.edit.insertTitle")}
            />
            <div className="ui-history-message-edit-footer">
              <span className="ui-history-message-edit-hint">{t("history.edit.editHint")}</span>
              <span className="ui-history-message-edit-buttons">
                <button
                  type="button"
                  className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
                  onClick={onCancelInsert}
                  disabled={insertSaving}
                >
                  <X size={12} />
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
                  style={{ color: "var(--success)" }}
                  onClick={onSubmitInsert}
                  disabled={insertSaving || !insertDraft.trim()}
                >
                  <Check size={12} />
                  {t("common.save")}
                </button>
              </span>
            </div>
          </div>
        )}
      </div>
      {roleKind === "user" && (
        <span className="ui-history-message-avatar" aria-hidden="true">
          <img src={avatarUrl} alt="" />
        </span>
      )}
    </div>
  );
}

export function SessionDetailPane({
  activeView,
  activeSession,
  loadingSessionDetail,
  aliasDraft,
  tagsDraft,
  tagSuggestions,
  sessionQuery,
  matchIndices,
  matchCursor,
  focusedMessageIndex,
  focusedMessageSeq,
  visibleMessages,
  visibleMessageCount,
  hasMoreMessages,
  totalMessageCount,
  processModel,
  detailView,
  messageListRef,
  sessionSearchRef,
  messageRefs,
  onDetailViewChange,
  onMessageListScroll,
  onAliasDraftChange,
  onTagsDraftChange,
  onSessionQueryChange,
  onSaveMeta,
  onJumpPrev,
  onJumpNext,
  onOpenPrompt,
  onOpenDiff,
  onResumeSession,
  canConvertSession,
  onConvertSession,
  onJumpToMessage,
  onToggleStar,
  onLoadMoreMessages,
  canEditMessages,
  onRequestMessageEdit,
  onSaveMessageEdit,
  onDeleteMessage,
  onDeleteMessages,
  onInsertMessage,
  onOpenEditAudit,
}: SessionDetailPaneProps) {
  const { t, language } = useI18n();
  // 消息编辑/插入的交互态：draft 提升到 pane，避免虚拟滚动卸载卡片时丢失输入。
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const [insertRole, setInsertRole] = useState<InsertRole>("user");
  const [insertDraft, setInsertDraft] = useState("");
  const [insertSaving, setInsertSaving] = useState(false);
  const [messageSelectionMode, setMessageSelectionMode] = useState(false);
  const [selectedMessageIndices, setSelectedMessageIndices] = useState<Set<number>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);

  useEffect(() => {
    setEditingIndex(null);
    setEditDraft("");
    setEditSaving(false);
    setInsertIndex(null);
    setInsertRole("user");
    setInsertDraft("");
    setInsertSaving(false);
    setMessageSelectionMode(false);
    setSelectedMessageIndices(new Set());
    setBatchDeleting(false);
  }, [activeView?.sessionKey]);
  // matchIndices.includes(idx) 在 visibleMessages.map 内对每个可见消息做 O(N) 扫描，
  // 当匹配数 N 和可见消息数 M 都达到几百时累计 O(N·M)。改 Set 后是 O(1) lookup。
  const matchSet = useMemo(() => new Set(matchIndices), [matchIndices]);
  const activeMatchIndex = matchIndices[Math.min(matchCursor, Math.max(0, matchIndices.length - 1))];
  const messageVirtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => messageListRef.current,
    estimateSize: () => 220,
    overscan: 6,
    getItemKey: (index) => `${visibleMessages[index]?.role ?? "message"}:${index}`,
  });

  useEffect(() => {
    if (activeMatchIndex === undefined) return;
    if (detailView === "transcript" && activeMatchIndex < visibleMessages.length) {
      messageVirtualizer.scrollToIndex(activeMatchIndex, { align: "center" });
    }
  }, [activeMatchIndex, detailView, messageVirtualizer, visibleMessages.length]);

  useEffect(() => {
    if (focusedMessageIndex === null || focusedMessageIndex >= visibleMessages.length) return;
    if (detailView === "transcript") messageVirtualizer.scrollToIndex(focusedMessageIndex, { align: "center" });
  }, [detailView, focusedMessageIndex, focusedMessageSeq, messageVirtualizer, visibleMessages.length]);

  if (!activeView) {
    return (
      <div className="row-span-2 flex min-h-0 items-center justify-center">
        <EmptyState
          icon={<BookCopy size={34} strokeWidth={1.5} />}
          title={t("history.detail.noSelectionTitle")}
          description={t("history.detail.noSelectionDescription")}
        />
      </div>
    );
  }

  const sourceIcon = resolveHistorySourceIconKey(activeView.source);

  const copyText = (text: string, label: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success(t("history.detail.copySuccess", { label })))
      .catch((err) => toast.error(t("history.detail.copyFailed"), { description: String(err) }));
  };

  const openSessionFile = () => {
    void invoke("open_folder_in_explorer", { path: activeView.file_path }).catch((err) =>
      toast.error(t("history.detail.openFileFailed"), { description: String(err) }),
    );
  };

  const copyMessageContent = (message: HistoryMessage) => {
    void navigator.clipboard
      .writeText(message.editable_text ?? message.content)
      .then(() => toast.success(t("history.edit.copySuccess")))
      .catch((err) => toast.error(t("history.detail.copyFailed"), { description: String(err) }));
  };

  const startEditMessage = async (index: number, message: HistoryMessage) => {
    if (!(await onRequestMessageEdit())) return;
    setInsertIndex(null);
    setEditingIndex(index);
    setEditDraft(message.editable_text ?? message.content);
  };

  const submitEditMessage = async (message: HistoryMessage) => {
    if (editSaving || !editDraft.trim()) return;
    setEditSaving(true);
    try {
      if (await onSaveMessageEdit(message, editDraft)) {
        setEditingIndex(null);
        setEditDraft("");
      }
    } finally {
      setEditSaving(false);
    }
  };

  const startInsertMessage = async (index: number) => {
    if (!(await onRequestMessageEdit())) return;
    setEditingIndex(null);
    setInsertIndex(index);
    setInsertRole("user");
    setInsertDraft("");
  };

  const submitInsertMessage = async (message: HistoryMessage) => {
    if (insertSaving || !insertDraft.trim()) return;
    setInsertSaving(true);
    try {
      if (await onInsertMessage(message, insertRole, insertDraft)) {
        setInsertIndex(null);
        setInsertDraft("");
      }
    } finally {
      setInsertSaving(false);
    }
  };

  const exitMessageSelection = () => {
    setMessageSelectionMode(false);
    setSelectedMessageIndices(new Set());
  };

  const toggleMessageSelectionMode = () => {
    if (messageSelectionMode) {
      exitMessageSelection();
      return;
    }
    setEditingIndex(null);
    setInsertIndex(null);
    setMessageSelectionMode(true);
    onDetailViewChange("transcript");
  };

  const toggleMessageSelected = (index: number) => {
    setSelectedMessageIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const submitBatchDelete = async () => {
    if (batchDeleting) return;
    const messages = Array.from(selectedMessageIndices)
      .sort((a, b) => a - b)
      .map((index) => visibleMessages[index])
      .filter((message): message is HistoryMessage => Boolean(message?.editable));
    if (messages.length === 0) return;
    setBatchDeleting(true);
    try {
      if (await onDeleteMessages(messages)) {
        exitMessageSelection();
      }
    } finally {
      setBatchDeleting(false);
    }
  };

  return (
    <>
      <div className="ui-history-detail-top [grid-row:1] min-h-0 shrink-0 overflow-y-auto p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-text-primary">{activeView.displayTitle}</h3>
            <div className="ui-dev-label mt-1 flex items-center gap-1.5 text-[11px] text-text-muted">
              {sourceIcon && (
                <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-primary">
                  <CliToolIcon icon={sourceIcon} size={12} />
                </span>
              )}
              <span className="truncate">
                {activeView.source} · {makeSessionLabel(activeView)} · {t("history.detail.updatedAt", { time: formatTime(activeView.updated_at, language) })}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
              <span className="ui-dev-label max-w-full truncate rounded border border-border bg-bg-secondary px-1.5 py-0.5">
                sessionId: {activeView.session_id}
              </span>
              <button
                onClick={() => copyText(activeView.session_id, "sessionId")}
                className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
                style={{ color: "var(--accent)" }}
                title={t("history.detail.copySessionId")}
              >
                <Copy size={11} />
                {t("history.detail.copyId")}
              </button>
              <button
                onClick={openSessionFile}
                aria-label={t("history.detail.openFile")}
                className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
                style={{ color: "var(--primary)" }}
                title={t("history.detail.openFileTitle")}
              >
                <FolderOpen size={11} />
                {t("history.detail.openFile")}
              </button>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={onResumeSession}
              disabled={loadingSessionDetail || !activeSession}
              aria-label={t("history.detail.resume")}
              className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact ui-history-detail-resume-action"
              title={t("history.detail.resumeTitle")}
            >
              <Terminal size={12} />
              {t("history.detail.resume")}
            </button>
            {canConvertSession ? (
              <button
                onClick={onConvertSession}
                disabled={loadingSessionDetail || !activeSession}
                aria-label={activeView?.source === "claude" ? t("history.detail.convertToCodex") : t("history.detail.convertToClaude")}
                className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
                style={{ color: "var(--accent)" }}
                title={activeView?.source === "claude" ? t("history.detail.convertToCodexTitle") : t("history.detail.convertToClaudeTitle")}
              >
                <ArrowRightLeft size={12} />
                {activeView?.source === "claude" ? t("history.detail.convertToCodexShort") : t("history.detail.convertToClaudeShort")}
              </button>
            ) : null}
            <button
              onClick={onOpenPrompt}
              aria-label={t("history.detail.openPrompt")}
              className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
              style={{ color: "var(--success)" }}
              title={t("history.detail.promptLibrary")}
            >
              <BookCopy size={12} />
              {t("history.detail.promptShort")}
            </button>
            <button
              onClick={() => onOpenDiff()}
              aria-label={t("history.detail.openDiff")}
              className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
              style={{ color: "var(--danger)" }}
              title={t("history.detail.diffView")}
            >
              <GitCompare size={12} />
              Diff
            </button>
            <button
              onClick={onOpenEditAudit}
              aria-label={t("history.edit.auditTitle")}
              className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
              style={{ color: "var(--text-secondary)" }}
              title={t("history.edit.auditTitle")}
            >
              <History size={12} />
              {t("history.edit.auditOpen")}
            </button>
            {canEditMessages && (
              <button
                onClick={toggleMessageSelectionMode}
                aria-label={t("history.edit.batchDelete")}
                aria-pressed={messageSelectionMode}
                className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
                style={{ color: messageSelectionMode ? "var(--accent)" : "var(--text-secondary)" }}
                title={t("history.edit.batchDelete")}
              >
                <ListChecks size={12} />
                {t("history.edit.batchDelete")}
              </button>
            )}
            <button
              onClick={onToggleStar}
              aria-label={activeView.starred ? t("history.detail.unstar") : t("history.detail.star")}
              className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
              style={{
                color: activeView.starred
                  ? "var(--warning)"
                  : "color-mix(in srgb, var(--warning) 78%, var(--on-surface-variant))",
              }}
              title={t("history.detail.starTitle")}
            >
              <Star size={12} fill={activeView.starred ? "currentColor" : "none"} />
              {activeView.starred ? t("history.detail.starred") : t("history.detail.starTitle")}
            </button>
          </div>
        </div>

        <MetaEditor
          aliasDraft={aliasDraft}
          tagsDraft={tagsDraft}
          tagSuggestions={tagSuggestions}
          sessionQuery={sessionQuery}
          sessionSearchRef={sessionSearchRef}
          matchCursor={matchCursor}
          matchCount={matchIndices.length}
          onAliasDraftChange={onAliasDraftChange}
          onTagsDraftChange={onTagsDraftChange}
          onSessionQueryChange={onSessionQueryChange}
          onSaveMeta={onSaveMeta}
          onJumpPrev={onJumpPrev}
          onJumpNext={onJumpNext}
        />

        <div className="ui-history-detail-tabs" role="tablist" aria-label={t("history.detail.viewsAria")}>
          {DETAIL_VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={detailView === item.id}
              data-active={detailView === item.id}
              onClick={() => onDetailViewChange(item.id)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>

        {messageSelectionMode && (
          <div className="ui-history-message-select-bar">
            <span>{t("history.edit.selectedCount", { count: selectedMessageIndices.size })}</span>
            <span className="ui-history-message-edit-buttons">
              <button
                type="button"
                className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
                onClick={exitMessageSelection}
                disabled={batchDeleting}
              >
                <X size={12} />
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
                style={{ color: "var(--danger)" }}
                onClick={() => {
                  void submitBatchDelete();
                }}
                disabled={batchDeleting || selectedMessageIndices.size === 0}
              >
                <Trash2 size={12} />
                {t("history.edit.batchDeleteSelected")}
              </button>
            </span>
          </div>
        )}
      </div>

      <div
        ref={messageListRef}
        onScroll={onMessageListScroll}
        className={`[grid-row:2] min-h-0 h-full overflow-x-hidden overflow-y-auto p-3 ${
          detailView === "transcript" ? "ui-history-transcript-chat-surface" : ""
        }`}
      >
        {loadingSessionDetail && <div className="text-xs text-text-muted">{t("history.detail.loading")}</div>}

        {!loadingSessionDetail && activeSession?.messages.length === 0 && (
          <div className="text-xs text-text-muted">{t("history.detail.noMessages")}</div>
        )}

        {!loadingSessionDetail && detailView === "transcript" && visibleMessages.length > 0 && (
          <div className="relative w-full" style={{ height: messageVirtualizer.getTotalSize() }}>
            {messageVirtualizer.getVirtualItems().map((virtualRow) => {
              const msg = visibleMessages[virtualRow.index];
              if (!msg) return null;
              const isMatched = matchSet.has(virtualRow.index);
              const isFocused = focusedMessageIndex === virtualRow.index;
              return (
                <div key={virtualRow.key} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${virtualRow.start}px)` }}>
                  <HistoryMessageCard
                    message={msg}
                    index={virtualRow.index}
                    isMatched={isMatched}
                    isFocused={isFocused}
                    query={sessionQuery}
                    messageRefs={messageRefs}
                    measureElement={messageVirtualizer.measureElement}
                    canEdit={canEditMessages}
                    isEditing={editingIndex === virtualRow.index}
                    editDraft={editDraft}
                    editSaving={editSaving}
                    onEditDraftChange={setEditDraft}
                    onStartEdit={() => {
                      void startEditMessage(virtualRow.index, msg);
                    }}
                    onCancelEdit={() => setEditingIndex(null)}
                    onSubmitEdit={() => {
                      void submitEditMessage(msg);
                    }}
                    isInserting={insertIndex === virtualRow.index}
                    insertRole={insertRole}
                    insertDraft={insertDraft}
                    insertSaving={insertSaving}
                    onInsertRoleChange={setInsertRole}
                    onInsertDraftChange={setInsertDraft}
                    onStartInsert={() => {
                      void startInsertMessage(virtualRow.index);
                    }}
                    onCancelInsert={() => setInsertIndex(null)}
                    onSubmitInsert={() => {
                      void submitInsertMessage(msg);
                    }}
                    onCopyMessage={() => copyMessageContent(msg)}
                    onDeleteMessage={() => onDeleteMessage(msg)}
                    selectionMode={messageSelectionMode}
                    isSelected={selectedMessageIndices.has(virtualRow.index)}
                    onToggleSelect={() => toggleMessageSelected(virtualRow.index)}
                  />
                </div>
              );
            })}
          </div>
        )}

        {!loadingSessionDetail && detailView === "timeline" && (
          <SessionTimelineView model={processModel} onJumpToMessage={onJumpToMessage} />
        )}

        {!loadingSessionDetail && detailView === "canvas" && (
          <SessionCanvasView
            session={activeSession}
            model={processModel}
            onJumpToMessage={onJumpToMessage}
            onOpenDiff={onOpenDiff}
          />
        )}

        {!loadingSessionDetail && detailView === "context" && <SessionContextView session={activeSession} />}

        {!loadingSessionDetail && detailView === "changes" && (
          <SessionFileChangesView
            fileChanges={activeSession?.file_changes}
            model={processModel}
            onOpenDiff={onOpenDiff}
            onJumpToMessage={onJumpToMessage}
          />
        )}

        {!loadingSessionDetail && detailView === "tools" && (
          <SessionToolDiagnosticsView
            model={processModel}
            builtinCalls={activeSession?.usage?.builtin_calls ?? []}
            mcpCalls={activeSession?.usage?.mcp_calls ?? []}
            skillCalls={activeSession?.usage?.skill_calls ?? []}
            toolEvents={activeSession?.tool_events ?? []}
            onJumpToMessage={onJumpToMessage}
          />
        )}

        {!loadingSessionDetail && detailView === "subtasks" && (
          <SessionSubtaskTreeView model={processModel} onJumpToMessage={onJumpToMessage} />
        )}

        {!loadingSessionDetail && detailView === "transcript" && hasMoreMessages && (
          <button onClick={onLoadMoreMessages} className="ui-btn mt-2.5 w-full" aria-label={t("history.detail.loadMoreMessages")}>
            {t("history.detail.loadMoreMessagesCount", { visible: visibleMessageCount, total: totalMessageCount })}
          </button>
        )}
      </div>
    </>
  );
}
