import { lazy, Suspense, useEffect, useMemo, useState, useCallback, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { X, Undo2 } from "../icons";
import { parseDiff, Diff, Hunk, tokenize, Decoration, getChangeKey } from "react-diff-view";
import type { ChangeData } from "react-diff-view";
import { debugConsoleWarn } from "../../lib/debugConsole";
import { useI18n } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { refractor, detectLanguage } from "./diffHighlight";
import { Portal } from "../ui/Portal";
import "react-diff-view/style/index.css";
import "./diffViewer.css";

const MonacoDiffFallback = lazy(() =>
  import("./MonacoDiffFallback").then((module) => ({ default: module.MonacoDiffFallback }))
);

interface DiffViewerModalProps {
  open: boolean;
  onClose: () => void;
  projectPath: string;
  filePath: string;
  fileName: string;
  status: string;
  diffText?: string;
  onRequestDiscard?: (path: string, name: string, status: string) => void;
}

interface GitDiffViewerProps {
  projectPath?: string;
  filePath: string;
  fileName: string;
  status: string;
  diffText?: string;
  onRequestDiscard?: (path: string, name: string, status: string) => void;
  onClose?: () => void;
  onReverted?: () => void;
  closeOnRevert?: boolean;
  useTerminalTheme?: boolean;
}

interface GitFileDiffPayload {
  content: string;
  canRevertHunks: boolean;
}

const TERMINAL_DIFF_ROOT_STYLE = {
  "--surface": "var(--terminal-theme-background, #0c0e10)",
  "--surface-container-low": "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 86%, var(--terminal-theme-foreground, #f8fafc) 8%)",
  "--surface-container-lowest": "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 94%, var(--terminal-theme-foreground, #f8fafc) 4%)",
  "--text-primary": "var(--terminal-theme-foreground, #f8fafc)",
  "--text-muted": "var(--file-editor-muted, var(--terminal-theme-muted, #94a3b8))",
  "--border": "var(--file-editor-border, color-mix(in srgb, var(--terminal-theme-foreground, #f8fafc) 13%, transparent))",
  backgroundColor: "var(--terminal-theme-background, #0c0e10)",
  borderColor: "var(--file-editor-border, color-mix(in srgb, var(--terminal-theme-foreground, #f8fafc) 13%, transparent))",
} as CSSProperties;

const DEFAULT_DIFF_ROOT_STYLE = {
  backgroundColor: "var(--surface)",
  borderColor: "var(--border)",
} as CSSProperties;

const TERMINAL_DIFF_TABLE_STYLE = {
  "--git-diff-bg": "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 91%, var(--terminal-theme-foreground, #f8fafc) 5%)",
  "--git-diff-gutter-bg": "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 84%, var(--terminal-theme-foreground, #f8fafc) 8%)",
  "--git-diff-border": "var(--file-editor-border, color-mix(in srgb, var(--terminal-theme-foreground, #f8fafc) 13%, transparent))",
  "--git-diff-text": "var(--terminal-theme-foreground, #f8fafc)",
  "--git-diff-muted": "var(--file-editor-muted, var(--terminal-theme-muted, #94a3b8))",
  "--git-diff-hunk-bg": "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 76%, var(--terminal-theme-accent, #60a5fa) 18%)",
  "--git-diff-hunk-text": "var(--terminal-theme-accent, #60a5fa)",
  "--git-diff-insert-bg": "color-mix(in srgb, var(--term-panel-green, #3dd68c) 15%, transparent)",
  "--git-diff-insert-gutter-bg": "color-mix(in srgb, var(--term-panel-green, #3dd68c) 22%, var(--terminal-theme-background, #0c0e10) 78%)",
  "--git-diff-insert-decoration": "color-mix(in srgb, var(--term-panel-green, #3dd68c) 34%, transparent)",
  "--git-diff-delete-bg": "color-mix(in srgb, var(--term-panel-red, #ff6b6b) 15%, transparent)",
  "--git-diff-delete-gutter-bg": "color-mix(in srgb, var(--term-panel-red, #ff6b6b) 22%, var(--terminal-theme-background, #0c0e10) 78%)",
  "--git-diff-delete-decoration": "color-mix(in srgb, var(--term-panel-red, #ff6b6b) 34%, transparent)",
  backgroundColor: "var(--surface-container-lowest)",
  borderColor: "var(--border)",
} as CSSProperties;

export function GitDiffViewer({
  projectPath,
  filePath,
  fileName,
  status,
  diffText: providedDiffText,
  onRequestDiscard,
  onClose,
  onReverted,
  closeOnRevert = false,
  useTerminalTheme = false,
}: GitDiffViewerProps) {
  const { t } = useI18n();
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const [diffText, setDiffText] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [canRevertHunks, setCanRevertHunks] = useState(false);

  useEffect(() => {
    if (providedDiffText !== undefined) {
      setDiffText(providedDiffText);
      setError(null);
      setLoading(false);
      setCanRevertHunks(false);
      return;
    }

    if (!projectPath) {
      setDiffText("");
      setError(null);
      setLoading(false);
      setCanRevertHunks(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setCanRevertHunks(false);

    invoke<GitFileDiffPayload>("git_get_file_diff", { projectPath, filePath, status })
      .then((payload) => {
        if (cancelled) return;
        setDiffText(payload.content);
        setCanRevertHunks(payload.canRevertHunks);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[DiffViewerModal] 获取 diff 失败:", err);
        setCanRevertHunks(false);
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("binary_file")) {
          setError(t("files.error.binaryFile"));
        } else if (message.includes("text_decode_failed") || message.includes("text_encoding_unknown")) {
          setError(t("files.error.encodingUnknown"));
        } else {
          setError(message);
        }
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath, filePath, status, providedDiffText, t]);

  // diff 解析放在 hooks 区（行选择 hook 依赖 hunks，不能在条件 return 之后）。
  const parsed = useMemo(() => {
    if (!diffText) return null;
    try {
      const files = parseDiff(diffText);
      if (files.length > 0) {
        const file = files[0];
        // 按文件扩展名启用语法高亮；未知语言或高亮失败时回退为无高亮 token，保证 diff 仍可渲染。
        const language = detectLanguage(fileName);
        if (language) {
          try {
            return { file, tokens: tokenize(file.hunks, { highlight: true, refractor, language }) };
          } catch (highlightErr) {
            debugConsoleWarn("[DiffViewerModal] 语法高亮失败，回退无高亮:", highlightErr);
          }
        }
        return { file, tokens: tokenize(file.hunks) };
      }
    } catch (err) {
      console.error("[DiffViewerModal] 解析 diff 失败:", err);
    }
    return null;
  }, [diffText, fileName]);

  const parsedDiff = parsed?.file ?? null;
  const tokens = parsed?.tokens ?? null;
  const fallbackEditorTheme = resolvedTheme === "dark" ? "vs-dark" : "vs";

  // 切换文件（diffText 变化）时清空行选择。
  useEffect(() => {
    setSelectedKeys([]);
  }, [diffText]);

  // 切换单个变更行的选中（仅 insert/delete 可选）。
  const toggleSelect = useCallback(({ change }: { change: ChangeData | null }) => {
    if (!change || change.type === "normal") return;
    const key = getChangeKey(change);
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }, []);

  // 仅已跟踪文件可回滚；点击后关闭本弹窗并交由上层确认（规避与 z-50 ConfirmDialog 的层级冲突）。
  const canDiscardFile = status !== "U" && status !== "??" && !!onRequestDiscard;
  const canRevertPartial = canDiscardFile && canRevertHunks;

  // Hunk 级回滚：成功后关闭弹窗（内容已变）；失败提示刷新（dry-run 兜底，未损坏文件）。
  const handleRevertHunk = async (hunkIndex: number) => {
    setReverting(true);
    try {
      await invoke("git_revert_hunk", { projectPath, diffText, hunkIndex });
      onReverted?.();
      if (closeOnRevert) onClose?.();
    } catch {
      toast.error(t("git.diff.revertHunkFailed"));
    } finally {
      setReverting(false);
    }
  };

  // 收集选中行的 (side, lineNumber)，供行级回滚。
  const collectSelectedLines = (): { side: "old" | "new"; lineNumber: number }[] => {
    const result: { side: "old" | "new"; lineNumber: number }[] = [];
    if (!parsedDiff) return result;
    for (const hunk of parsedDiff.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "normal") continue;
        if (!selectedKeys.includes(getChangeKey(change))) continue;
        if (change.type === "insert") result.push({ side: "new", lineNumber: change.lineNumber });
        else result.push({ side: "old", lineNumber: change.lineNumber });
      }
    }
    return result;
  };

  // 行级回滚：成功后关闭弹窗；失败提示刷新。
  const handleRevertLines = async () => {
    const selectedLines = collectSelectedLines();
    if (selectedLines.length === 0) return;
    setReverting(true);
    try {
      await invoke("git_revert_lines", { projectPath, diffText, selectedLines });
      onReverted?.();
      if (closeOnRevert) onClose?.();
    } catch {
      toast.error(t("git.diff.revertLinesFailed"));
    } finally {
      setReverting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden font-mono" data-theme-mode={resolvedTheme} style={useTerminalTheme ? TERMINAL_DIFF_ROOT_STYLE : DEFAULT_DIFF_ROOT_STYLE}>
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{
            backgroundColor: "var(--surface-container-low)",
            borderColor: "color-mix(in srgb, var(--border) 24%, transparent)",
          }}
        >
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-text-primary">
              Diff: {fileName}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {canDiscardFile && (
              <button
                onClick={() => {
                  if (closeOnRevert) onClose?.();
                  onRequestDiscard?.(filePath, fileName, status);
                }}
                className="ui-focus-ring flex items-center gap-1 rounded px-2 py-1 text-[12px] transition-opacity hover:opacity-80"
                style={{
                  color: "var(--danger)",
                  border: "1px solid color-mix(in srgb, var(--danger) 26%, var(--border))",
                }}
                title={t("git.diff.revertFileTitle")}
              >
                <Undo2 size={13} />
                {t("git.diff.revertFile")}
              </button>
            )}
            {onClose && (
              <button
                onClick={onClose}
                className="ui-focus-ring rounded p-1 transition-opacity hover:opacity-70"
                style={{ color: "var(--text-muted)" }}
                title={t("common.close")}
              >
                <X size={18} strokeWidth={1.5} />
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4" style={{ backgroundColor: "var(--surface)" }}>
          {loading && (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-3">
                <div
                  className="h-8 w-8 animate-spin rounded-full border-2"
                  style={{ borderColor: "var(--success)", borderTopColor: "transparent" }}
                ></div>
                <p className="text-sm text-text-muted">{t("git.diff.loading")}</p>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-3 max-w-md text-center">
                <p className="text-sm" style={{ color: "var(--danger)" }}>{error}</p>
              </div>
            </div>
          )}

          {!loading && !error && diffText && parsedDiff && tokens && (
            <div
              className="diff-viewer-container rounded-lg shadow-sm border overflow-hidden"
              style={useTerminalTheme ? TERMINAL_DIFF_TABLE_STYLE : { backgroundColor: "var(--surface-container-lowest)", borderColor: "var(--border)" }}
            >
              <Diff
                viewType="split"
                diffType={parsedDiff.type}
                hunks={parsedDiff.hunks}
                tokens={tokens}
                selectedChanges={selectedKeys}
                gutterEvents={canRevertPartial ? { onClick: toggleSelect } : undefined}
              >
                {(hunks) =>
                  hunks.flatMap((hunk, index) => [
                    <Decoration key={`deco-${hunk.content}`}>
                      <div
                        className="flex items-center justify-between gap-2 px-3 py-1"
                        style={{
                          backgroundColor: "var(--surface-container-low)",
                          borderTop: "1px solid color-mix(in srgb, var(--border) 20%, transparent)",
                        }}
                      >
                        <span className="truncate text-[11px] text-text-muted">
                          {hunk.content}
                        </span>
                        {canRevertPartial && (
                          <button
                            onClick={() => handleRevertHunk(index)}
                            disabled={reverting}
                            className="ui-focus-ring flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-opacity hover:opacity-80 disabled:opacity-40"
                            style={{ color: "var(--danger)" }}
                            title={t("git.diff.revertHunkTitle")}
                          >
                            <Undo2 size={11} />
                            {t("git.diff.revertHunk")}
                          </button>
                        )}
                      </div>
                    </Decoration>,
                    <Hunk key={hunk.content} hunk={hunk} />,
                  ])
                }
              </Diff>
            </div>
          )}

          {!loading && !error && diffText && !parsedDiff && (
            <div
              className="diff-viewer-container h-full min-h-[320px] rounded-lg border overflow-hidden"
              style={useTerminalTheme ? TERMINAL_DIFF_TABLE_STYLE : { backgroundColor: "var(--surface-container-lowest)", borderColor: "var(--border)" }}
            >
              <Suspense fallback={null}>
                <MonacoDiffFallback value={diffText} theme={fallbackEditorTheme} />
              </Suspense>
            </div>
          )}

          {!loading && !error && !diffText && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-text-muted">{t("git.diff.noContent")}</p>
            </div>
          )}
        </div>

        {!loading && !error && canDiscardFile && !canRevertHunks && parsedDiff && (
          <div
            className="border-t px-4 py-2 text-[11px]"
            style={{
              borderColor: "color-mix(in srgb, var(--border) 24%, transparent)",
              backgroundColor: "var(--surface-container-low)",
              color: "var(--text-muted)",
            }}
          >
            {t("git.diff.nonUtf8PartialRevertDisabled")}
          </div>
        )}

        {/* 行选择操作条 */}
        {canRevertPartial && parsedDiff && (
          <div
            className="flex items-center justify-between gap-3 border-t px-4 py-2 text-[11px]"
            style={{
              borderColor: "color-mix(in srgb, var(--border) 24%, transparent)",
              backgroundColor: "var(--surface-container-low)",
              color: "var(--text-muted)",
            }}
          >
            <span>{t("git.diff.selectLineHint")}</span>
            {selectedKeys.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-text-primary">{t("git.diff.selectedLines", { count: selectedKeys.length })}</span>
                <button
                  onClick={() => setSelectedKeys([])}
                  className="ui-focus-ring rounded px-2 py-0.5 transition-opacity hover:opacity-80"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("git.diff.clearSelection")}
                </button>
                <button
                  onClick={handleRevertLines}
                  disabled={reverting}
                  className="ui-focus-ring flex items-center gap-1 rounded px-2 py-0.5 transition-opacity hover:opacity-80 disabled:opacity-40"
                  style={{
                    color: "var(--danger)",
                    border: "1px solid color-mix(in srgb, var(--danger) 26%, var(--border))",
                  }}
                >
                  <Undo2 size={11} />
                  {t("git.diff.revertSelectedLines", { count: selectedKeys.length })}
                </button>
              </div>
            )}
          </div>
        )}
    </div>
  );
}

export function DiffViewerModal({ open, onClose, projectPath, filePath, fileName, status, diffText, onRequestDiscard }: DiffViewerModalProps) {
  // Esc 关闭弹窗（仅 open 时挂载监听；对齐 SettingsModal / HistoryWorkspace 的 keydown 处理模式）。
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);
  if (!open) return null;

  return (
    <Portal>
      <div
        className="fixed inset-0 flex items-center justify-center bg-black/60 p-4"
        style={{ zIndex: 100 }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className="h-[85vh] w-full max-w-6xl overflow-hidden rounded-xl border shadow-2xl"
          style={{ backgroundColor: "var(--surface)", borderColor: "var(--border)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <GitDiffViewer
            projectPath={projectPath}
            filePath={filePath}
            fileName={fileName}
            status={status}
            diffText={diffText}
            onClose={onClose}
            onRequestDiscard={onRequestDiscard}
            closeOnRevert
          />
        </div>
      </div>
    </Portal>
  );
}
