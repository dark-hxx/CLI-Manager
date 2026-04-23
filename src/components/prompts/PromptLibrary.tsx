import { useEffect, useMemo, useState } from "react";
import { Select } from "@/components/ui/select";
import { Copy, Search, X } from "lucide-react";
import { toast } from "sonner";
import type { HistorySessionView, PromptScope } from "../../lib/types";
import { useHistoryStore } from "../../stores/historyStore";

interface PromptLibraryProps {
  open: boolean;
  sessions: HistorySessionView[];
  activeSessionKey: string | null;
  onClose: () => void;
  onJumpToPrompt: (sessionKey: string, messageIndex: number) => Promise<void>;
}

function makeSessionKey(source: string, sessionId: string, filePath: string): string {
  return `${source}:${sessionId}:${filePath}`;
}

function formatUpdatedAt(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PromptLibrary({
  open,
  sessions,
  activeSessionKey,
  onClose,
  onJumpToPrompt,
}: PromptLibraryProps) {
  const loadingPrompts = useHistoryStore((s) => s.loadingPrompts);
  const prompts = useHistoryStore((s) => s.prompts);
  const loadPrompts = useHistoryStore((s) => s.loadPrompts);

  const [scope, setScope] = useState<PromptScope>("global");
  const [query, setQuery] = useState("");
  const [projectKey, setProjectKey] = useState("");

  const projectOptions = useMemo(() => {
    const set = new Set<string>();
    for (const item of sessions) {
      if (item.project_key) {
        set.add(item.project_key);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [sessions]);

  useEffect(() => {
    if (!open) return;
    if (scope === "project" && !projectKey && projectOptions.length > 0) {
      setProjectKey(projectOptions[0]);
    }
  }, [open, scope, projectKey, projectOptions]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void loadPrompts({
        scope,
        query,
        projectKey: scope === "project" ? projectKey : null,
        sessionKey: scope === "session" ? activeSessionKey : null,
        limit: 300,
      }).catch((err) => {
        toast.error("加载 Prompt 失败", { description: String(err) });
      });
    }, 220);
    return () => clearTimeout(timer);
  }, [open, scope, query, projectKey, activeSessionKey, loadPrompts]);

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 55, backgroundColor: "rgba(0, 0, 0, 0.45)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-5xl h-[min(82vh,760px)] rounded-lg border flex flex-col overflow-hidden"
        style={{ backgroundColor: "var(--bg-primary)", borderColor: "var(--border)" }}
      >
        <div className="px-3 py-2 border-b flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
          <div>
            <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              历史 Prompt 库
            </div>
            <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              来源于已发生会话，用于复用与回放定位
            </div>
          </div>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md border w-7 h-7"
            style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
            title="关闭"
          >
            <X size={14} />
          </button>
        </div>

        <div className="p-3 border-b flex flex-wrap items-center gap-2" style={{ borderColor: "var(--border)" }}>
          <button
            onClick={() => setScope("global")}
            className="text-xs px-2.5 py-1 rounded-md border"
            style={{
              borderColor: "var(--border)",
              backgroundColor: scope === "global" ? "var(--bg-tertiary)" : "transparent",
              color: scope === "global" ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            全局
          </button>
          <button
            onClick={() => setScope("project")}
            className="text-xs px-2.5 py-1 rounded-md border"
            style={{
              borderColor: "var(--border)",
              backgroundColor: scope === "project" ? "var(--bg-tertiary)" : "transparent",
              color: scope === "project" ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            项目
          </button>
          <button
            onClick={() => setScope("session")}
            className="text-xs px-2.5 py-1 rounded-md border"
            style={{
              borderColor: "var(--border)",
              backgroundColor: scope === "session" ? "var(--bg-tertiary)" : "transparent",
              color: scope === "session" ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            会话
          </button>

          {scope === "project" && (
            <Select
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              className="h-7 min-w-[120px] rounded-md bg-bg-secondary text-xs"
            >
              {projectOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          )}

          <div
            className="ui-search-focus-shell ml-auto min-w-[220px] flex items-center gap-2 rounded-md border px-2 py-1"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "var(--bg-secondary)",
            }}
          >
            <Search size={13} style={{ color: "var(--text-muted)" }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索 Prompt"
              className="flex-1 min-w-0 bg-transparent text-xs outline-none"
              style={{ color: "var(--text-primary)" }}
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {loadingPrompts && (
            <div className="px-3 py-3 text-xs" style={{ color: "var(--text-muted)" }}>
              正在加载 Prompt...
            </div>
          )}

          {!loadingPrompts && scope === "session" && !activeSessionKey && (
            <div className="px-3 py-6 text-xs text-center" style={{ color: "var(--text-muted)" }}>
              当前未选择会话，无法查看会话级 Prompt
            </div>
          )}

          {!loadingPrompts && prompts.length === 0 && !(scope === "session" && !activeSessionKey) && (
            <div className="px-3 py-6 text-xs text-center" style={{ color: "var(--text-muted)" }}>
              没有匹配的 Prompt
            </div>
          )}

          {!loadingPrompts &&
            prompts.map((item, idx) => {
              const sessionKey = makeSessionKey(item.source, item.session_id, item.file_path);
              return (
                <div
                  key={`${sessionKey}-${item.message_index}-${idx}`}
                  className="px-3 py-3 border-b"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold truncate" style={{ color: "var(--text-primary)" }}>
                        {item.session_title}
                      </div>
                      <div className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                        {item.source} · {item.project_key} · #{item.message_index + 1} · 更新于{" "}
                        {formatUpdatedAt(item.updated_at)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(item.prompt)
                            .then(() => toast.success("Prompt 已复制"))
                            .catch((err) =>
                              toast.error("复制失败", { description: String(err) })
                            );
                        }}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border"
                        style={{
                          borderColor: "var(--border)",
                          color: "var(--text-secondary)",
                          backgroundColor: "var(--bg-secondary)",
                        }}
                      >
                        <Copy size={12} />
                        复制
                      </button>
                      <button
                        onClick={() => {
                          void onJumpToPrompt(sessionKey, item.message_index)
                            .then(() => onClose())
                            .catch((err) =>
                              toast.error("跳转失败", { description: String(err) })
                            );
                        }}
                        className="text-xs px-2 py-1 rounded-md"
                        style={{ backgroundColor: "var(--accent)", color: "#fff" }}
                      >
                        跳转
                      </button>
                    </div>
                  </div>
                  <pre
                    className="mt-2 text-xs whitespace-pre-wrap break-words rounded-md border p-2 m-0"
                    style={{
                      color: "var(--text-primary)",
                      borderColor: "var(--border)",
                      backgroundColor: "var(--bg-secondary)",
                    }}
                  >
                    {item.prompt}
                  </pre>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
