import { useEffect, useMemo, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { X, Undo2 } from "../icons";
import { parseDiff, Diff, Hunk, tokenize, Decoration, getChangeKey } from "react-diff-view";
import type { ChangeData } from "react-diff-view";
import { useGitStore } from "../../stores/gitStore";
import { useI18n } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { refractor, detectLanguage } from "./diffHighlight";
import "react-diff-view/style/index.css";
import "./diffViewer.css";

interface DiffViewerModalProps {
  open: boolean;
  onClose: () => void;
  projectPath: string;
  filePath: string;
  fileName: string;
  status: string;
  onRequestDiscard?: (path: string, name: string, status: string) => void;
}

export function DiffViewerModal({ open, onClose, projectPath, filePath, fileName, status, onRequestDiscard }: DiffViewerModalProps) {
  const { t } = useI18n();
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const [diffText, setDiffText] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const revertHunk = useGitStore((s) => s.revertHunk);
  const revertLines = useGitStore((s) => s.revertLines);
  const discarding = useGitStore((s) => s.discarding);

  useEffect(() => {
    if (!open) {
      setDiffText("");
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    invoke<string>("git_get_file_diff", { projectPath, filePath, status })
      .then((diff) => {
        if (cancelled) return;
        setDiffText(diff);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[DiffViewerModal] 获取 diff 失败:", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, projectPath, filePath, status]);

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
            console.warn("[DiffViewerModal] 语法高亮失败，回退无高亮:", highlightErr);
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

  if (!open) return null;

  // 仅已跟踪文件可回滚；点击后关闭本弹窗并交由上层确认（规避与 z-50 ConfirmDialog 的层级冲突）。
  const canDiscard = status !== "U" && status !== "??" && !!onRequestDiscard;

  // Hunk 级回滚：成功后关闭弹窗（内容已变）；失败提示刷新（dry-run 兜底，未损坏文件）。
  const handleRevertHunk = async (hunkIndex: number) => {
    try {
      await revertHunk(diffText, hunkIndex);
      onClose();
    } catch {
      toast.error(t("git.diff.revertHunkFailed"));
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
    try {
      await revertLines(diffText, selectedLines);
      onClose();
    } catch {
      toast.error(t("git.diff.revertLinesFailed"));
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/60 p-4"
      style={{ zIndex: 100 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden rounded-xl border font-mono shadow-2xl"
        data-theme-mode={resolvedTheme}
        style={{ backgroundColor: "var(--surface)", borderColor: "var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
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
            {canDiscard && (
              <button
                onClick={() => {
                  onClose();
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
            <button
              onClick={onClose}
              className="ui-focus-ring rounded p-1 transition-opacity hover:opacity-70"
              style={{ color: "var(--text-muted)" }}
              title={t("common.close")}
            >
              <X size={18} strokeWidth={1.5} />
            </button>
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
              style={{ backgroundColor: "var(--surface-container-lowest)", borderColor: "var(--border)" }}
            >
              <Diff
                viewType="split"
                diffType={parsedDiff.type}
                hunks={parsedDiff.hunks}
                tokens={tokens}
                selectedChanges={selectedKeys}
                gutterEvents={canDiscard ? { onClick: toggleSelect } : undefined}
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
                        {canDiscard && (
                          <button
                            onClick={() => handleRevertHunk(index)}
                            disabled={discarding}
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

          {!loading && !error && (!diffText || !parsedDiff) && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-text-muted">{t("git.diff.noContent")}</p>
            </div>
          )}
        </div>

        {/* 行选择操作条 */}
        {canDiscard && parsedDiff && (
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
                  disabled={discarding}
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
    </div>
  );
}
